async function j(rPromise) {
  let r
  try {
    r = await rPromise
  } catch (e) {
    throw new Error(`Network error: ${e.message}`)
  }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const d = (await r.json()).detail
      msg = typeof d === 'string' ? d : (d && d[0] && d[0].msg) || JSON.stringify(d)
    } catch {}
    throw new Error(msg)
  }
  return r.status === 204 ? null : r.json()
}

const JSONH = { 'Content-Type': 'application/json' }

export const api = {
  get: (p) => j(fetch(p)),
  post: (p, b) => j(fetch(p, { method: 'POST', headers: JSONH, body: JSON.stringify(b ?? null) })),
  put: (p, b) => j(fetch(p, { method: 'PUT', headers: JSONH, body: JSON.stringify(b) })),
  del: (p) => j(fetch(p, { method: 'DELETE' })),
}

export const fmt = (paise) => {
  const neg = paise < 0
  const v = Math.abs(paise) / 100
  return `${neg ? '−' : ''}₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

export const toPaise = (str) => {
  const n = parseFloat(String(str).replace(/[,₹\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}

export const today = () => new Date().toISOString().slice(0, 10)
