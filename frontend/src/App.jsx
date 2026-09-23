import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import Budget from './tabs/Budget.jsx'
import Expenses from './tabs/Expenses.jsx'
import Income from './tabs/Income.jsx'
import Categories from './tabs/Categories.jsx'
import Data from './tabs/Data.jsx'

const TABS = [
  ['budget', 'Budget', '🧾'],
  ['expenses', 'Spend', '💸'],
  ['income', 'Income', '💰'],
  ['categories', 'Envelopes', '🗂'],
  ['data', 'Data', '⚙️'],
]

export default function App() {
  const [tab, setTab] = useState('budget')
  const [cats, setCats] = useState([])
  const [budget, setBudget] = useState(null)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  const reload = useCallback(async () => {
    const [c, b] = await Promise.all([
      api.get('/api/categories?include_archived=true'),
      api.get('/api/budget'),
    ])
    setCats(c)
    setBudget(b)
  }, [])

  useEffect(() => {
    reload().catch((e) => setError(e.message))
    const h = () => reload().catch(() => {})
    window.addEventListener('refresh', h)
    return () => window.removeEventListener('refresh', h)
  }, [reload])

  useEffect(() => {
    if (!error && !toast) return
    const t = setTimeout(() => { setError(null); setToast(null) }, 4200)
    return () => clearTimeout(t)
  }, [error, toast])

  // run(action, toastMsg): perform a mutation, then refresh shared state.
  const run = useCallback(
    async (action, msg) => {
      setError(null)
      try {
        const r = await action()
        await reload()
        if (msg) setToast(msg)
        return r
      } catch (e) {
        setError(e.message)
        throw e
      }
    },
    [reload]
  )

  const active = cats.filter((c) => !c.archived)
  const shared = { cats, active, budget, run }

  return (
    <div className="app">
      <div className="topbar">
        <h1>Expense Tracker</h1>
        <span className="sub">envelopes · INR</span>
      </div>
      {error && <div className="banner err">{error}</div>}
      {!error && toast && <div className="banner">{toast}</div>}

      {tab === 'budget' && <Budget {...shared} onGo={() => setTab('categories')} />}
      {tab === 'expenses' && <Expenses {...shared} />}
      {tab === 'income' && <Income {...shared} />}
      {tab === 'categories' && <Categories {...shared} />}
      {tab === 'data' && <Data />}

      <nav className="tabs">
        {TABS.map(([id, label, ico]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <span className="ico">{ico}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
