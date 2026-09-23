import React, { useEffect, useState } from 'react'
import { api, fmt } from '../api.js'

export default function Budget({ active, budget, onGo }) {
  const [transfers, setTransfers] = useState([])
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
        <h2>Envelopes</h2>
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
    </>
  )
}
