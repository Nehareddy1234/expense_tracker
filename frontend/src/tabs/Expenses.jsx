import React, { useEffect, useState } from 'react'
import { api, fmt, toPaise, today } from '../api.js'

function PlanModal({ proposal, expense, active, run, close }) {
  const deficit = proposal.deficit_paise
  const target = active.find((c) => c.id === expense.category_id)?.name || 'category'
  const [amounts, setAmounts] = useState(
    Object.fromEntries(proposal.moves.map((m) => [m.category_id, String(m.amount_paise / 100)]))
  )
  const [busy, setBusy] = useState(false)

  if (!proposal.feasible) {
    return (
      <div className="modal-bg" onClick={close}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Not enough spare money</h3>
          <p>
            {expense.description || 'This expense'} put <b>{target}</b> short by{' '}
            <b>{fmt(deficit)}</b>, but no other envelope can cover it — flexible envelopes
            together can free only {fmt(proposal.moves.reduce((a, m) => a + m.max_paise, 0))}
            {proposal.moves.length ? '' : ' (none have spare flexible money)'}.
          </p>
          <p className="muted">
            The expense is already logged, so <b>{target}</b> will simply show as overspent.
            Add income or move money later from the Income tab.
          </p>
          <button className="plain" onClick={close}>Log it as overspend</button>
        </div>
      </div>
    )
  }

  const chosen = proposal.moves.map((m) => ({
    ...m,
    edit: Math.max(0, Math.min(toPaise(amounts[m.category_id] ?? 0) || 0, m.max_paise)),
  }))
  const covered = chosen.reduce((a, m) => a + m.edit, 0)

  const apply = async () => {
    setBusy(true)
    try {
      await run(
        () =>
          api.post(`/api/expenses/${expense.id}/rebalance`, {
            moves: chosen.filter((m) => m.edit > 0).map((m) => ({ category_id: m.category_id, amount_paise: m.edit })),
          }),
        covered >= deficit ? 'Money moved — envelopes updated.' : `Moved ${fmt(covered)}; ${target} still overspent by ${fmt(deficit - covered)}.`
      )
      close()
    } catch {} finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Cover the {fmt(deficit)} gap?</h3>
        <p className="muted">
          {expense.description || 'This expense'} cost {fmt(expense.amount_paise)} but{' '}
          <b>{target}</b> only had {fmt(expense.amount_paise - deficit)}. Lowest-pain suggestion
          (pain score {proposal.pain_score}/rupee):
        </p>
        {chosen.map((m) => (
          <div className="splitrow" key={m.category_id}>
            <select disabled value={m.category_id}>
              <option value={m.category_id}>from {m.category_name} (pain {active.find(c => c.id === m.category_id)?.pain_weight})</option>
            </select>
            <input
              inputMode="decimal"
              value={amounts[m.category_id]}
              onChange={(e) => setAmounts({ ...amounts, [m.category_id]: e.target.value })}
            />
            <span className="muted shrink">/ {fmt(m.max_paise)} max</span>
          </div>
        ))}
        <p className="muted">
          Moving {fmt(covered)} of {fmt(deficit)} needed
          {covered < deficit && ` — ${target} would still overspend by ${fmt(deficit - covered)}`}
        </p>
        <div className="row">
          <button onClick={apply} disabled={busy || covered === 0}>
            {busy ? 'Moving…' : 'Move the money'}
          </button>
          <button className="plain" onClick={close} disabled={busy}>
            No — go overspent
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Expenses({ cats, active, budget, run }) {
  const [expenses, setExpenses] = useState([])
  const [form, setForm] = useState({ category_id: '', amount: '', date: today(), description: '' })
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)

  const loadList = () => api.get('/api/expenses?limit=50').then(setExpenses)
  useEffect(() => {
    loadList().catch(() => {})
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    const amount = toPaise(form.amount)
    if (!form.category_id || !Number.isFinite(amount) || amount <= 0) return
    setBusy(true)
    try {
      const res = await run(() =>
        api.post('/api/expenses', {
          category_id: Number(form.category_id),
          amount_paise: amount,
          expense_date: form.date,
          description: form.description || null,
        })
      )
      loadList()
      setForm({ ...form, amount: '', description: '' })
      if (res.needs_rebalance) setProposal({ p: res.proposal, x: res.expense })
    } catch {} finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="card">
        <h2>Log an expense</h2>
        <form onSubmit={submit}>
          <label className="f">Category</label>
          <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">Choose…</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>{c.name} — {fmt((budget?.categories.find(b => b.id === c.id)?.balance_paise) ?? 0)} left</option>
            ))}
          </select>
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
          <label className="f">What was it? (optional)</label>
          <input placeholder="e.g. canteen lunch" value={form.description}
                 onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div style={{ marginTop: 12 }}>
            <button disabled={busy}>
              {busy ? 'Logging…' : 'Log expense'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Recent expenses</h2>
        {expenses.length === 0 && <p className="muted">Nothing logged yet.</p>}
        {expenses.map((x) => (
          <div className="listrow" key={x.id}>
            <div className="l">
              <b>{x.description || x.category_name}</b>
              <span className="muted">{x.category_name} · {x.expense_date}</span>
            </div>
            <div className="amt bad">{fmt(-x.amount_paise)}</div>
          </div>
        ))}
      </div>

      {proposal && (
        <PlanModal
          proposal={proposal.p}
          expense={proposal.x}
          active={active}
          run={run}
          close={() => { setProposal(null); loadList() }}
        />
      )}
    </>
  )
}
