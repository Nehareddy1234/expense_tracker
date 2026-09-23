import React, { useEffect, useState } from 'react'
import { api, fmt, toPaise, today } from '../api.js'

const emptyRow = () => ({ category_id: '', value: '' })

export default function Income({ active, run }) {
  const [history, setHistory] = useState([])
  const [templates, setTemplates] = useState([])
  const [form, setForm] = useState({ amount: '', date: today(), note: '' })
  const [mode, setMode] = useState('percent')
  const [rows, setRows] = useState([emptyRow(), emptyRow()])
  const [tplName, setTplName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    Promise.all([api.get('/api/income'), api.get('/api/split-templates')]).then(([h, t]) => {
      setHistory(h)
      setTemplates(t)
    })
  useEffect(() => {
    load().catch(() => {})
  }, [])

  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const total = toPaise(form.amount) || 0
  const usedPaise = rows.reduce((a, r) => {
    if (!r.value) return a
    return a + (mode === 'amount' ? toPaise(r.value) || 0 : Math.floor((total * parseFloat(r.value)) / 100) || 0)
  }, 0)
  const leftover = total - usedPaise
  const rowsOk = rows.every((r) => r.category_id && r.value)

  const applyTemplate = async (tid) => {
    if (!tid) return
    const t = templates.find((x) => x.id === Number(tid))
    setRows(t.items.map((i) => ({ category_id: i.category_id ?? 'none', value: String(i.percent) })))
    setMode('percent')
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await run(() =>
        api.post('/api/income', {
          amount_paise: total,
          income_date: form.date,
          note: form.note || null,
          splits: rows
            .filter((r) => r.category_id && Number(r.value) > 0)
            .map((r) => ({
              category_id: r.category_id === 'none' ? null : Number(r.category_id),
              ...(mode === 'amount' ? { amount_paise: toPaise(r.value) } : { percent: parseFloat(r.value) }),
            })),
        })
      )
      load()
      setForm({ ...form, amount: '', note: '' })
      setRows([emptyRow(), emptyRow()])
    } catch {} finally {
      setBusy(false)
    }
  }

  const saveTemplate = async () => {
    if (!tplName.trim() || mode !== 'percent') return
    try {
      await run(() =>
        api.post('/api/split-templates', {
          name: tplName.trim(),
          items: rows
            .filter((r) => r.category_id && parseFloat(r.value) > 0)
            .map((r) => ({
              category_id: r.category_id === 'none' ? null : Number(r.category_id),
              percent: parseFloat(r.value),
            })),
        })
      )
      setTplName('')
      load()
    } catch {}
  }

  return (
    <>
      <div className="card">
        <h2>Add pocket money</h2>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="f">Amount (₹)</label>
            <input inputMode="decimal" placeholder="0.00" value={form.amount}
                   onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="f">Date</label>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
        </div>
        <label className="f">Note</label>
        <input placeholder="e.g. September allowance" value={form.note}
               onChange={(e) => setForm({ ...form, note: e.target.value })} />

        {templates.length > 0 && (
          <>
            <label className="f">Load a saved split</label>
            <select defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="" disabled>Choose template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {t.items.map((i) => `${i.category_name} ${i.percent}%`).join(', ')}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="row" style={{ margin: '12px 0 6px' }}>
          <label className="f" style={{ margin: 0, flex: 1 }}>Split across envelopes</label>
          <div className="shrink">
            <button type="button" className={mode === 'percent' ? '' : 'plain'} onClick={() => setMode('percent')}>%</button>
            {' '}
            <button type="button" className={mode === 'amount' ? '' : 'plain'} onClick={() => setMode('amount')}>₹</button>
          </div>
        </div>
        {rows.map((r, i) => (
          <div className="splitrow" key={i}>
            <select value={r.category_id} onChange={(e) => setRow(i, { category_id: e.target.value })}>
              <option value="">Category…</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.type === 'locked' ? ' 🔒' : ''}</option>
              ))}
              <option value="none">Unallocated</option>
            </select>
            <input inputMode="decimal" placeholder={mode === 'percent' ? '%' : '₹'} value={r.value}
                   onChange={(e) => setRow(i, { value: e.target.value })} />
            <button type="button" className="rm ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>−</button>
          </div>
        ))}
        <button type="button" className="mini ghost" onClick={() => setRows([...rows, emptyRow()])}>
          + add line
        </button>

        {total > 0 && (
          <p className={`muted ${leftover < 0 ? 'bad' : ''}`}>
            Split {fmt(usedPaise)} of {fmt(total)} ·{' '}
            {leftover < 0
              ? `over by ${fmt(-leftover)} — reduce some lines`
              : `${fmt(leftover)} will stay Unallocated`}
          </p>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={submit} disabled={busy || !total || leftover < 0}>
            {busy ? 'Adding…' : 'Add income'}
          </button>
        </div>
        {mode === 'percent' && rowsOk && (
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Save this split as template…" value={tplName}
                   onChange={(e) => setTplName(e.target.value)} />
            <button type="button" className="mini ghost shrink" onClick={saveTemplate} disabled={!tplName.trim()}>
              Save
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Income history</h2>
        {history.length === 0 && <p className="muted">No income logged yet.</p>}
        {history.map((x) => (
          <div className="listrow" key={x.id}>
            <div className="l">
              <b>{x.note || x.income_date}</b>
              <span className="muted">
                {x.splits.map((s) => `${s.category_name} ${fmt(s.amount_paise)}`).join(' · ')}
                {x.unallocated_paise > 0 && ` · Unallocated ${fmt(x.unallocated_paise)}`}
              </span>
            </div>
            <div className="amt good">{fmt(x.amount_paise)}</div>
          </div>
        ))}
      </div>
    </>
  )
}
