import React, { useRef, useState } from 'react'
import { api } from '../api.js'

export default function Data() {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const backup = async () => {
    setBusy(true)
    try {
      const data = await api.get('/api/backup')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `expense-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (file) => {
    if (!file) return
    if (!window.confirm('Restore replaces ALL current data with this backup file. Continue?')) return
    setBusy(true)
    try {
      const payload = JSON.parse(await file.text())
      await api.post('/api/restore', payload)
      window.dispatchEvent(new Event('refresh'))
      window.location.reload()
    } catch (e) {
      window.alert(`Restore failed: ${e.message}`)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <>
      <div className="card">
        <h2>Backup &amp; restore</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Everything lives in one SQLite file, but you can also keep a JSON backup anywhere
          (Drive, WhatsApp to yourself, a pen drive).
        </p>
        <button onClick={backup} disabled={busy}>{busy ? 'Working…' : '⬇ Download JSON backup'}</button>
        <div style={{ marginTop: 10 }}>
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            ⬆ Restore from backup file
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden
                 onChange={(e) => restore(e.target.files[0])} />
        </div>
      </div>
      <div className="card">
        <h2>Install this app</h2>
        <p className="muted">
          On Android Chrome: menu (⋮) → “Add to Home screen”. On iPhone Safari: Share →
          “Add to Home Screen”. It then opens full-screen like a normal app.
        </p>
        <p className="muted">
          API docs for power users: <a href="/docs">/docs</a>
        </p>
      </div>
    </>
  )
}
