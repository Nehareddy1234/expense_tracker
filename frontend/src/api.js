// Same surface as before (api.get/post/put/del on /api/* paths), but requests
// are served by the in-browser SQLite engine instead of fetch/uvicorn.

import { handle, ApiError } from './local/engine.js'

async function j(method, path, body) {
  try {
    return await handle(method, path, body)
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new Error(`Local DB error: ${e.message}`)
  }
}

export const api = {
  get: (p) => j('GET', p),
  post: (p, b) => j('POST', p, b ?? null),
  put: (p, b) => j('PUT', p, b),
  del: (p) => j('DELETE', p),
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
