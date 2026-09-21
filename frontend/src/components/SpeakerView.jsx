import { useEffect, useMemo, useState } from 'react'

const UNATTRIBUTED = '未标注说话人'
const NONE_KEY = '__none__'
const keyOf = (s) => (s.name === null ? NONE_KEY : s.name)
const labelOf = (s) => (s.name === null ? UNATTRIBUTED : s.name)

/**
 * 说话人分析视图：按 "说话人：内容" 发言段落统计每位说话人的文本长度、
 * 各编码覆盖字符数与覆盖率（数据来自 GET /api/documents/{id}/speakers，
 * 同一编码重叠标注已在后端合并去重并裁剪到发言段落）。
 *  - 顶部说话人筛选复选框控制矩阵行的显示（新出现的说话人默认显示）
 *  - 单元格显示覆盖字符数与覆盖率，按覆盖率相对最大值深浅着色；
 *    点击非零单元格列出覆盖片段，点击片段经 onLocateSegment 切回正文定位
 *  - 点击「文本长度」列出该说话人的全部发言段落，同样可切回正文定位
 *  - 无法识别说话人的文本归入「未标注说话人」一行
 */
export default function SpeakerView({ stats, loading, error, onLocateSegment }) {
  const [hidden, setHidden] = useState(() => new Set())
  const [selected, setSelected] = useState(null)
  // selected: {kind: 'cell', speakerKey, codeId} | {kind: 'turns', speakerKey}

  const speakers = stats?.speakers ?? []
  const codes = stats?.codes ?? []
  const visible = speakers.filter((s) => !hidden.has(keyOf(s)))

  const speakerByKey = useMemo(() => {
    const m = new Map()
    for (const s of speakers) m.set(keyOf(s), s)
    return m
  }, [speakers])

  // 标注增删导致统计刷新后，若选中的说话人 / 编码覆盖已不存在则清空明细
  useEffect(() => {
    if (!selected) return
    const sp = speakerByKey.get(selected.speakerKey)
    if (!sp) {
      setSelected(null)
      return
    }
    if (
      selected.kind === 'cell' &&
      !sp.codes.some((c) => c.code_id === selected.codeId)
    ) {
      setSelected(null)
    }
  }, [speakerByKey, selected])

  const maxCoverage = useMemo(() => {
    let m = 0
    for (const s of speakers) {
      for (const c of s.codes) {
        if (c.coverage > m) m = c.coverage
      }
    }
    return m
  }, [speakers])

  function toggle(key) {
    const willHide = !hidden.has(key)
    setHidden((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    // 隐藏正在查看明细的说话人时一并收起明细
    if (willHide) {
      setSelected((cur) => (cur && cur.speakerKey === key ? null : cur))
    }
  }

  const codeName = (id) => codes.find((c) => c.id === id)?.name ?? `#${id}`
  const codeColor = (id) => codes.find((c) => c.id === id)?.color ?? '#999'

  const selSpeaker = selected ? speakerByKey.get(selected.speakerKey) : null
  const selCell =
    selected?.kind === 'cell'
      ? selSpeaker?.codes.find((c) => c.code_id === selected.codeId) ?? null
      : null

  function cellBg(coverage) {
    if (!coverage || maxCoverage === 0) return '#fff'
    const alpha = 0.12 + 0.72 * (coverage / maxCoverage)
    return `rgba(37, 99, 235, ${alpha.toFixed(3)})`
  }

  const noLabels = speakers.length > 0 && speakers.every((s) => s.name === null)

  return (
    <div className="speaker-panel">
      <div className="speaker-toolbar">
        {speakers.length > 0 && (
          <div className="speaker-filter" role="group" aria-label="说话人筛选">
            <span className="speaker-filter-label">说话人筛选：</span>
            {speakers.map((s) => {
              const key = keyOf(s)
              const checked = !hidden.has(key)
              return (
                <label key={key} className={checked ? '' : 'dimmed'}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(key)}
                  />
                  <span className={s.name === null ? 'speaker-name none' : 'speaker-name'}>
                    {labelOf(s)}
                  </span>
                  <span className="speaker-filter-stat">
                    {s.turn_count} 段 · {s.char_count} 字
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <p className="hint">
          口径：按行首「说话人：」识别发言段落，文本长度不计标签与首尾空白；
          同一编码重叠标注先合并再裁剪到发言段落，共享字符不重复计数；
          覆盖率 = 覆盖字符数 ÷ 文本长度。
        </p>
      </div>

      {loading && <div className="cooc-status">说话人统计加载中…</div>}
      {!loading && error && <div className="cooc-status error">{error}</div>}

      {!loading && !error && speakers.length === 0 && (
        <div className="cooc-status">文档中没有可统计的文本。</div>
      )}
      {!loading && !error && noLabels && (
        <div className="cooc-status">
          未识别到「说话人：」格式的发言段落，全部文本归入{UNATTRIBUTED}。
        </div>
      )}
      {!loading && !error && speakers.length > 0 && visible.length === 0 && (
        <div className="cooc-status">所有说话人均被筛选隐藏，请在上方重新勾选。</div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="cooc-matrix-wrap">
          <table className="cooc-matrix speaker-matrix">
            <thead>
              <tr>
                <th className="corner" aria-label="说话人 × 编码覆盖矩阵">
                  说话人
                </th>
                <th className="speaker-meta-col">发言段数</th>
                <th className="speaker-meta-col">文本长度</th>
                {codes.map((c) => (
                  <th key={c.id} title={c.name}>
                    <span className="dot" style={{ background: c.color }} />
                    <span className="th-name">{c.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const key = keyOf(s)
                const coveredBy = new Map(s.codes.map((c) => [c.code_id, c]))
                const turnsSelected =
                  selected?.kind === 'turns' && selected.speakerKey === key
                return (
                  <tr key={key}>
                    <th scope="row" title={labelOf(s)}>
                      <span className={s.name === null ? 'th-name none' : 'th-name'}>
                        {labelOf(s)}
                      </span>
                    </th>
                    <td className="speaker-num">{s.turn_count}</td>
                    <td className="speaker-num">
                      <button
                        type="button"
                        className={`speaker-stat-btn${turnsSelected ? ' selected' : ''}`}
                        title={`查看 ${labelOf(s)} 的 ${s.turn_count} 个发言段落`}
                        onClick={() =>
                          setSelected(
                            turnsSelected ? null : { kind: 'turns', speakerKey: key }
                          )
                        }
                      >
                        {s.char_count}
                      </button>
                    </td>
                    {codes.map((code) => {
                      const entry = coveredBy.get(code.id)
                      const n = entry?.char_count ?? 0
                      const cov = entry?.coverage ?? 0
                      const isSel =
                        selected?.kind === 'cell' &&
                        selected.speakerKey === key &&
                        selected.codeId === code.id
                      return (
                        <td key={code.id} className="cooc-cell-td">
                          <button
                            type="button"
                            disabled={n === 0}
                            className={[
                              'cooc-cell',
                              'speaker-cell',
                              n > 0 ? 'clickable' : '',
                              isSel ? 'selected' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            style={{ background: cellBg(cov) }}
                            title={
                              n > 0
                                ? `${labelOf(s)} × ${code.name}：${n} 字符，覆盖率 ${(cov * 100).toFixed(1)}%`
                                : `${labelOf(s)} × ${code.name}：无覆盖`
                            }
                            onClick={() =>
                              n > 0 &&
                              setSelected(
                                isSel
                                  ? null
                                  : { kind: 'cell', speakerKey: key, codeId: code.id }
                              )
                            }
                          >
                            {n > 0 ? (
                              <>
                                <span className="speaker-cell-n">{n}</span>
                                <span className="speaker-cell-pct">
                                  {(cov * 100).toFixed(1)}%
                                </span>
                              </>
                            ) : (
                              '0'
                            )}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="cooc-detail" aria-live="polite">
        {!selected && !loading && !error && speakers.length > 0 && (
          <div className="cooc-status subtle">
            点击非零单元格查看覆盖片段，或点击「文本长度」查看发言段落；点击条目切回正文定位。
          </div>
        )}
        {selected?.kind === 'turns' && selSpeaker && (
          <>
            <div className="cooc-detail-head">
              <strong>{labelOf(selSpeaker)}</strong>
              <span className="cooc-stat">
                {selSpeaker.turn_count} 个发言段落 · 文本长度 {selSpeaker.char_count} 字
              </span>
              <button className="link-btn" onClick={() => setSelected(null)}>
                清除选择
              </button>
            </div>
            <ul className="cooc-segment-list">
              {selSpeaker.turns.map((t, i) => (
                <li key={`${t.start}-${t.end}`}>
                  <button
                    type="button"
                    className="cooc-segment"
                    title="点击切回正文并定位"
                    onClick={() => onLocateSegment(t)}
                  >
                    <code>[{t.start}, {t.end})</code>
                    <span className="cooc-seg-text">「{t.text}」</span>
                    <em>第 {i + 1} 段 · 点击定位</em>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {selected?.kind === 'cell' && selSpeaker && selCell && (
          <>
            <div className="cooc-detail-head">
              <strong>{labelOf(selSpeaker)}</strong>
              <span className="cooc-x">×</span>
              <span className="dot" style={{ background: codeColor(selected.codeId) }} />
              <strong>{codeName(selected.codeId)}</strong>
              <span className="cooc-stat">
                覆盖 {selCell.char_count} 字符 · 覆盖率{' '}
                {(selCell.coverage * 100).toFixed(1)}% · {selCell.segments.length} 段
              </span>
              <button className="link-btn" onClick={() => setSelected(null)}>
                清除选择
              </button>
            </div>
            <ul className="cooc-segment-list">
              {selCell.segments.map((seg) => (
                <li key={`${seg.start}-${seg.end}`}>
                  <button
                    type="button"
                    className="cooc-segment"
                    title="点击切回正文并定位"
                    onClick={() => onLocateSegment(seg)}
                  >
                    <code>[{seg.start}, {seg.end})</code>
                    <span className="cooc-seg-text">「{seg.text}」</span>
                    <em>{seg.end - seg.start} 字 · 点击定位</em>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
