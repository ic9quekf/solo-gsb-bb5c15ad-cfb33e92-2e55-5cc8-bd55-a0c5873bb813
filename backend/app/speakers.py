"""说话人发言段落解析与编码覆盖统计的纯函数逻辑。

解析规则：
  1. 行首出现 "名字：" 或 "名字:" 即视为一个发言段落的起点。标签需为
     1~30 个字符、不含换行 / 冒号 / 句读标点，且至少含一个字母或汉字
     （排除 "14:00" 这类纯数字时间行）。
  2. 发言段落从标签行起，延伸到下一个发言段落起点（或文末），段落之间
     不留缝隙；段落内去掉 "说话人：" 标签与首尾空白后的部分为发言内容，
     说话人的文本长度按发言内容字符数累计。
  3. 首个标签之前的文本无法识别说话人，归入 "未标注说话人"。

统计口径（与编码共现一致）：
  - 同一编码的重叠 / 相邻标注先各自合并，再与说话人的发言内容区间求交集，
    保证共享字符不被重复计数；
  - 覆盖率 = 编码覆盖字符数 / 说话人文本长度。
"""

from __future__ import annotations

import re
from typing import Iterable

from .cooccurrence import intersect_intervals, normalize_intervals

# 行首 "名字：" 或 "名字:" 视为发言起点；标签 1~30 字符且不含换行与冒号
LABEL_RE = re.compile(r"^([^\n：:]{1,30})[：:]", re.MULTILINE)

# 标签中出现句读标点则视为普通句子而非说话人标签
_LABEL_PUNCT = frozenset("，。！？；、,.!?;…")
# 标签至少包含一个字母或汉字（排除纯数字，如 "14:00" 这类时间行）
_LABEL_WORD_RE = re.compile(r"[^\W\d_]", re.UNICODE)

UNATTRIBUTED_NAME = "未标注说话人"
TURN_EXCERPT_CHARS = 80


def _is_speaker_label(label: str) -> bool:
    label = label.strip()
    if not label:
        return False
    if any(ch in _LABEL_PUNCT for ch in label):
        return False
    return bool(_LABEL_WORD_RE.search(label))


def _trim_span(content: str, start: int, end: int) -> tuple[int, int]:
    """把 [start, end) 两端的首尾空白去掉，返回收缩后的区间。"""
    while start < end and content[start].isspace():
        start += 1
    while end > start and content[end - 1].isspace():
        end -= 1
    return start, end


def parse_turns(content: str) -> list[dict]:
    """把全文切分为发言段落，返回按起点升序的 turn 列表。

    每个 turn：
      - speaker：说话人名（标签文本，已去首尾空白）
      - [start, end)：整个发言段落（含标签行），到下一段落起点或文末
      - [content_start, content_end)：去掉标签与首尾空白后的发言内容
    """
    labels: list[tuple[int, int, str]] = []
    for m in LABEL_RE.finditer(content):
        name = m.group(1).strip()
        if _is_speaker_label(name):
            labels.append((m.start(1), m.end(0), name))
    turns: list[dict] = []
    for i, (start, after_colon, name) in enumerate(labels):
        end = labels[i + 1][0] if i + 1 < len(labels) else len(content)
        cs, ce = _trim_span(content, after_colon, end)
        turns.append(
            {
                "speaker": name,
                "start": start,
                "end": end,
                "content_start": cs,
                "content_end": ce,
            }
        )
    return turns


def _excerpt(content: str, start: int, end: int) -> str:
    text = content[start:end]
    if len(text) > TURN_EXCERPT_CHARS:
        return text[:TURN_EXCERPT_CHARS] + "…"
    return text


def build_speaker_analysis(
    document_id: int,
    content: str,
    codings: Iterable[dict],
    codes: Iterable[dict],
) -> dict:
    """汇总说话人分析：每位说话人的文本长度、各编码覆盖字符数与覆盖率。

    返回 {"document_id", "codes", "speakers"}；speakers 按首次出现排序，
    未标注说话人（name 为 None）若存在文本则一并列出。每个说话人：
      - turn_count / char_count：发言段数 / 文本长度（发言内容字符数）
      - turns：各发言段落的区间与摘录（供前端定位）
      - codes：覆盖为正的编码统计（覆盖字符数、覆盖率、合并裁剪后的片段）
    """
    turns = parse_turns(content)
    code_list = list(codes)

    # 发言内容区间按说话人分组（None 表示未标注说话人），保持首次出现顺序
    order: list[str | None] = []
    content_ivs: dict[str | None, list[tuple[int, int]]] = {}
    turn_map: dict[str | None, list[dict]] = {}

    def bucket(name: str | None) -> None:
        if name not in content_ivs:
            content_ivs[name] = []
            turn_map[name] = []
            order.append(name)

    # 首个标签之前的文本无法识别说话人
    first_label = turns[0]["start"] if turns else len(content)
    pre_s, pre_e = _trim_span(content, 0, first_label)
    if pre_e > pre_s:
        bucket(None)
        content_ivs[None].append((pre_s, pre_e))
        turn_map[None].append(
            {"start": 0, "end": first_label, "text": _excerpt(content, pre_s, pre_e)}
        )

    for t in turns:
        bucket(t["speaker"])
        if t["content_end"] > t["content_start"]:
            content_ivs[t["speaker"]].append((t["content_start"], t["content_end"]))
        turn_map[t["speaker"]].append(
            {
                "start": t["start"],
                "end": t["end"],
                "text": _excerpt(content, t["content_start"], t["content_end"]),
            }
        )

    # 同一编码的重叠 / 相邻标注先各自合并
    raw: dict[int, list[tuple[int, int]]] = {}
    for c in codings:
        raw.setdefault(c["code_id"], []).append((c["start"], c["end"]))
    code_ivs = {code_id: normalize_intervals(ivs) for code_id, ivs in raw.items()}

    speakers: list[dict] = []
    for name in order:
        ivs = content_ivs[name]
        char_count = sum(e - s for s, e in ivs)
        entries: list[dict] = []
        for code in code_list:
            merged = code_ivs.get(code["id"])
            if not merged:
                continue
            # 裁剪到发言段落：合并后的编码区间 ∩ 发言内容区间
            shared = intersect_intervals(merged, ivs)
            if not shared:
                continue
            covered = sum(e - s for s, e in shared)
            entries.append(
                {
                    "code_id": code["id"],
                    "char_count": covered,
                    "coverage": round(covered / char_count, 4) if char_count else 0.0,
                    "segments": [
                        {"start": s, "end": e, "text": content[s:e]}
                        for s, e in shared
                    ],
                }
            )
        speakers.append(
            {
                "name": name,  # None → 前端显示「未标注说话人」
                "turn_count": len(turn_map[name]),
                "char_count": char_count,
                "turns": turn_map[name],
                "codes": entries,
            }
        )
    return {
        "document_id": document_id,
        "codes": code_list,
        "speakers": speakers,
    }
