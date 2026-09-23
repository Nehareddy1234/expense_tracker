import React, { useEffect, useState } from 'react'
import { api, fmt, toPaise } from '../api.js'

function SetBudgets({ rows, plan, setPlan, apply, busy, close }) {
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Set your budgets</h3>
        <p className="muted">
          Type the amount you want in each envelope. Envelopes you leave above
          their target lend the difference (lowest pain first); idle Unallocated
          money tops up whatever is still missing.
        </p>
        {rows.map((c) => (
          <div className="splitrow" key={c.id}>
            <b className="grow">{c.name}{c.type === 'locked' ? ' 🔒' : ''}</b>
            <span className="muted shrink">now {fmt(c.balance_paise)}</span>
            <input
              inputMode="decimal"
              value={c.amount}
              onChange={(e) => setPlan({ ...c, amount: e.target.value }, rows)}
            />
          </div>
        ))}
        {plan && plan.moves.length > 0 && (
          <p className="muted">
            {plan.moves.map((m, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {m.from_name} → {m.to_name} {fmt(m.amount_paise)}
              </span>
            ))}
          </p>
        )}
        {plan && !plan.feasible && (
          <p className="err-text">Short by {fmt(plan.short_paise)} — add income or lower a target.</p>
        )}
        {plan && plan.feasible && plan.moves.length === 0 && (
          <p className="muted">No moves needed — targets already match the money you have.</p>
        )}
        <div className="row">
          <button
            onClick={apply}
            disabled={busy || !plan || !plan.feasible || plan.moves.length === 0}
          >
            {busy ? 'Moving…' : 'Set budgets'}
          </button>
          <button className="plain" onClick={close} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Budget({ active, budget, onGo, run }) {
  const [transfers, setTransfers] = useState([])
  const [modal, setModal] = useState(null) // {rows, plan}
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get('/api/transfers').then(setTransfers).catch(() => {})
  }, [budget])

  if (!budget) return <div className="card muted">Loading…</div>
  if (!active.length)
    return (
      <div className="card">
        <p>No envelopes yet.</p>
        <button onClick={onGo}>Create categories</button>
      </div>
    )

  const spentPct = (c) => (c.allocated_paise > 0 ? Math.min(100, (c.spent_paise / c.allocated_paise) * 100) : 0)
  const rows = budget.categories.filter((c) => !c.archived)

  const openModal = () =>
    setModal({
      rows: rows.map((c) => ({ ...c, amount: (c.balance_paise / 100).toFixed(2) })),
      plan: null,
    })

  const targetsOf = (list) =>
    list
      .map((c) => ({ c, p: toPaise(c.amount) }))
      .filter((x) => Number.isFinite(x.p) && x.p >= 0)
      .map((x) => ({ category_id: x.c.id, amount_paise: x.p }))

  const recompute = (updated, list) => {
    const next = list.map((c) => (c.id === updated.id ? updated : c))
    const targets = targetsOf(next)
    setModal({ rows: next, plan: null })
    if (targets.length) api.post('/api/budget/plan', { targets }).then((plan) => setModal((m) => (m ? { ...m, plan } : m))).catch(() => {})
  }

  const apply = async () => {
    const targets = targetsOf(modal.rows)
    if (!targets.length) return
    setBusy(true)
    try {
      await run(() => api.post('/api/budget/apply', { targets }), 'Budgets set — envelopes adjusted.')
      setModal(null)
    } catch {} finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="summary">
        <div className="card">
          <div className="v">{fmt(budget.total_income_paise)}</div>
          <div className="k">Income</div>
        </div>
        <div className="card">
          <div className="v">{fmt(budget.total_spent_paise)}</div>
          <div className="k">Spent</div>
        </div>
        <div className="card">
          <div className="v">{fmt(budget.unallocated_paise)}</div>
          <div className="k">Free</div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Envelopes</h2>
          <button className="ghost" onClick={openModal}>Set budgets</button>
        </div>
        {rows.map((c) => (
          <div className="listrow" key={c.id}>
            <div className="l">
              <b>
                {c.name}
                {c.type === 'locked' && <span className="pill lock">🔒 locked</span>}
                {c.balance_paise < 0 && <span className="pill neg">over</span>}
              </b>
              <span className="muted">
                {fmt(c.spent_paise)} of {fmt(c.allocated_paise)} spent · flex {c.flexibility}% · pain {c.pain_weight}
              </span>
              <div className="bar">
                <i className={c.balance_paise < 0 ? 'over' : ''} style={{ width: `${c.balance_paise < 0 ? 100 : spentPct(c)}%` }} />
              </div>
            </div>
            <div className={`amt ${c.balance_paise < 0 ? 'bad' : ''}`}>{fmt(c.balance_paise)}</div>
          </div>
        ))}
        <div className="listrow">
          <div className="l"><b>Unallocated</b><span className="muted">spare money, not yet assigned</span></div>
          <div className="amt">{fmt(budget.unallocated_paise)}</div>
        </div>
      </div>

      {transfers.length > 0 && (
        <div className="card">
          <h2>Recent money moves</h2>
          {transfers.slice(0, 8).map((t) => (
            <div className="listrow" key={t.id}>
              <div className="l">
                <b>{t.from_name} → {t.to_name}</b>
                <span className="muted">{new Date(t.created_at).toLocaleString()}</span>
              </div>
              <div className="amt">{fmt(t.amount_paise)}</div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <SetBudgets
          rows={modal.rows}
          plan={modal.plan}
          setPlan={recompute}
          apply={apply}
          busy={busy}
          close={() => setModal(null)}
        />
      )}
    </>
  )
}
