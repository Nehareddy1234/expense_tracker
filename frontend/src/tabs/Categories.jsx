import React, { useState } from 'react'
import { api, fmt } from '../api.js'

function CatRow({ c, budget, run }) {
  const [edit, setEdit] = useState(false)
  const [f, setF] = useState({ name: c.name, type: c.type, flexibility: c.flexibility, pain_weight: c.pain_weight })
  const bal = budget?.categories.find((b) => b.id === c.id)
  const save = () =>
    run(() => api.put(`/api/categories/${c.id}`, f), 'Category updated')
      .then(() => setEdit(false))
      .catch(() => {})

  if (edit)
    return (
      <div className="listrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <label className="f">Name</label>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label className="f">Type</label>
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="flexible">flexible</option>
              <option value="locked">locked</option>
            </select>
          </div>
          <div>
            <label className="f">Flex %</label>
            <input inputMode="numeric" value={f.flexibility}
                   onChange={(e) => setF({ ...f, flexibility: Number(e.target.value) })} />
          </div>
          <div>
            <label className="f">Pain 1-10</label>
            <input inputMode="numeric" value={f.pain_weight}
                   onChange={(e) => setF({ ...f, pain_weight: Number(e.target.value) })} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={save}>Save</button>
          <button className="plain" onClick={() => setEdit(false)}>Cancel</button>
        </div>
      </div>
    )

  return (
    <div className="listrow">
      <div className="l">
        <b>
          {c.name}
          {c.type === 'locked' && <span className="pill lock">🔒</span>}
          <span className="pill">{c.flexibility}% flex</span>
          <span className="pill">pain {c.pain_weight}</span>
        </b>
        <span className="muted">
          balance {bal ? fmt(bal.balance_paise) : fmt(0)} · {c.type} envelope
        </span>
      </div>
      <div className="row shrink" style={{ gap: 6 }}>
        <button className="mini ghost" onClick={() => setEdit(true)}>Edit</button>
        <button className="mini danger" onClick={() => run(() => api.post(`/api/categories/${c.id}/archive`), `Archived ${c.name}`)}>
          Archive
        </button>
      </div>
    </div>
  )
}

export default function Categories({ cats, budget, run }) {
  const [f, setF] = useState({ name: '', type: 'flexible', flexibility: 50, pain_weight: 5 })
  const active = cats.filter((c) => !c.archived)
  const archived = cats.filter((c) => c.archived)

  const add = (e) => {
    e.preventDefault()
    if (!f.name.trim()) return
    run(() => api.post('/api/categories', { ...f, name: f.name.trim() }), `Added ${f.name.trim()}`)
      .then(() => setF({ ...f, name: '' }))
      .catch(() => {})
  }

  return (
    <>
      <div className="card">
        <h2>New envelope</h2>
        <form onSubmit={add}>
          <label className="f">Name</label>
          <input value={f.name} placeholder="e.g. Movies" onChange={(e) => setF({ ...f, name: e.target.value })} />
          <div className="row" style={{ marginTop: 8 }}>
            <div>
              <label className="f">Type</label>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                <option value="flexible">flexible</option>
                <option value="locked">locked</option>
              </select>
            </div>
            <div>
              <label className="f">Flexibility %</label>
              <input inputMode="numeric" value={f.flexibility}
                     onChange={(e) => setF({ ...f, flexibility: Number(e.target.value) })} />
            </div>
            <div>
              <label className="f">Pain 1-10</label>
              <input inputMode="numeric" value={f.pain_weight}
                     onChange={(e) => setF({ ...f, pain_weight: Number(e.target.value) })} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button disabled={!f.name.trim()}>Add category</button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Flexibility = max share of its balance this envelope may lend when covering an overspend.
            Pain = how much you dislike touching it (low pain gets used first). Locked never lends.
          </p>
        </form>
      </div>

      <div className="card">
        <h2>Active ({active.length})</h2>
        {active.map((c) => <CatRow key={c.id} c={c} budget={budget} run={run} />)}
      </div>

      {archived.length > 0 && (
        <div className="card">
          <h2>Archived ({archived.length})</h2>
          <p className="muted" style={{ marginTop: 0 }}>History is kept forever; archived envelopes just hide.</p>
          {archived.map((c) => (
            <div className="listrow" key={c.id}>
              <div className="l">
                <b>{c.name}</b>
                <span className="muted">locked out of new spending</span>
              </div>
              <button className="mini ghost" onClick={() => run(() => api.post(`/api/categories/${c.id}/unarchive`), `Restored ${c.name}`)}>
                Unarchive
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
