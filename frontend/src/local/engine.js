// In-browser replacement for the FastAPI backend. Same routes, same JSON
// shapes, same status codes — the React tabs keep calling /api/* unchanged.
// SQLite runs via sql.js (WASM); the whole DB is persisted to localStorage
// after every mutation, so the app works offline on a static host.

import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { SCHEMA, BALANCES_SQL, SEED, TABLES, SCHEMA_VERSION } from './schema.js'
import { planRebalance, capacityPaise } from './optimizer.js'

const LS_KEY = 'expense-tracker-db-v1'
const UNALLOCATED = 'Unallocated'

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail)
    this.status = status
  }
}

let dbPromise = null

function toB64(bytes) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  }
  return btoa(s)
}

function fromB64(b64) {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

async function openDb() {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl })
  let db
  const saved = localStorage.getItem(LS_KEY)
  if (saved) {
    db = new SQL.Database(fromB64(saved))
  } else {
    db = new SQL.Database()
  }
  db.run('PRAGMA foreign_keys = ON')
  db.run(SCHEMA)
  const n = db
    .exec('SELECT COUNT(*) FROM categories')[0]
    .values[0][0]
  if (n === 0) {
    for (const [name, type, flex, pain] of SEED) {
      db.run(
        'INSERT INTO categories (name, type, flexibility, pain_weight, created_at) VALUES (?, ?, ?, ?, ?)',
        [name, type, flex, pain, nowIso()]
      )
    }
    persist(db)
  }
  return db
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openDb().catch((e) => {
      dbPromise = null
      throw e
    })
  }
  return dbPromise
}

function persist(db) {
  localStorage.setItem(LS_KEY, toB64(db.export()))
}

function nowIso() {
  return new Date().toISOString().slice(0, 19) + '+00:00'
}

// ---- SQL helpers -------------------------------------------------------

function all(db, sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    const out = []
    while (stmt.step()) out.push(stmt.getAsObject())
    return out
  } finally {
    stmt.free()
  }
}

function one(db, sql, params = []) {
  return all(db, sql, params)[0] ?? null
}

function lastId(db) {
  return one(db, 'SELECT last_insert_rowid() AS id').id
}

function tx(db, fn) {
  db.run('BEGIN')
  try {
    // fn must capture everything it needs (e.g. last_insert_rowid) inside the
    // callback: persist() calls db.export(), which resets last_insert_rowid().
    const r = fn()
    db.run('COMMIT')
    persist(db)
    return r
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

function check(cond, msg) {
  if (!cond) throw new ApiError(422, msg)
}

// ---- validation (mirrors backend/app/schemas.py) ------------------------

const CATEGORY_TYPES = ['locked', 'flexible']

function validCategoryBody(b, partial) {
  if (!partial || b.name !== undefined) {
    check(typeof b.name === 'string' && b.name.trim().length >= 1 && b.name.trim().length <= 60, 'name must be 1-60 chars')
  }
  if (b.type !== undefined && (b.type === null || !CATEGORY_TYPES.includes(b.type))) {
    throw new ApiError(422, "type must be 'locked' or 'flexible'")
  }
  if (b.flexibility !== undefined) {
    if (!partial) check(b.flexibility !== undefined, 'flexibility required')
    check(Number.isInteger(b.flexibility) && b.flexibility >= 0 && b.flexibility <= 100, 'flexibility must be 0-100')
  }
  if (b.pain_weight !== undefined) {
    if (!partial) check(b.pain_weight !== undefined, 'pain_weight required')
    check(Number.isInteger(b.pain_weight) && b.pain_weight >= 1 && b.pain_weight <= 10, 'pain_weight must be 1-10')
  }
  if (!partial) {
    check(b.type !== undefined, 'type required')
    check(b.flexibility !== undefined, 'flexibility required')
    check(b.pain_weight !== undefined, 'pain_weight required')
  }
}

function validSplit(s) {
  check(
    (s.amount_paise == null) !== (s.percent == null),
    'Provide exactly one of amount_paise or percent'
  )
  if (s.amount_paise != null) {
    check(Number.isInteger(s.amount_paise) && s.amount_paise >= 0, 'amount_paise must be >= 0')
  }
  if (s.percent != null) {
    check(typeof s.percent === 'number' && s.percent > 0 && s.percent <= 100, 'percent must be in (0, 100]')
  }
}

// ---- core queries -------------------------------------------------------

function categoryBalances(db) {
  const out = {}
  for (const r of all(db, BALANCES_SQL)) out[r.id] = r
  return out
}

function totalUnallocated(db) {
  return one(
    db,
    'SELECT COALESCE(SUM(amount_paise), 0) AS n FROM income_allocations WHERE category_id IS NULL'
  ).n
}

function catOut(row) {
  return { ...row, archived: !!row.archived }
}

function getCatOr404(db, id) {
  const row = one(db, 'SELECT * FROM categories WHERE id = ?', [id])
  if (!row) throw new ApiError(404, 'Category not found')
  return row
}

function checkNameFree(db, name, excludeId = null) {
  const sql =
    'SELECT id FROM categories WHERE archived = 0 AND lower(name) = lower(?)' +
    (excludeId !== null ? ' AND id != ?' : '')
  const args = excludeId !== null ? [name, excludeId] : [name]
  if (one(db, sql, args)) {
    throw new ApiError(409, `An active category named '${name}' already exists`)
  }
}

function expenseRow(db, id) {
  const r = one(
    db,
    'SELECT e.*, c.name AS category_name FROM expenses e JOIN categories c ON c.id = e.category_id WHERE e.id = ?',
    [id]
  )
  if (!r) throw new ApiError(404, 'Expense not found')
  return r
}

function validateCategories(db, ids) {
  for (const cid of ids) {
    const row = one(db, 'SELECT archived FROM categories WHERE id = ?', [cid])
    if (!row) throw new ApiError(422, `Category ${cid} does not exist`)
    if (row.archived) throw new ApiError(422, `Category ${cid} is archived`)
  }
}

// Resolve amount/percent splits into [category_id|null, paise] pairs.
// Percents floor to paise so they can never overshoot; leftover -> Unallocated.
// Mirrors backend/app/income_api.py expand_splits.
function expandSplits(db, totalPaise, splits) {
  validateCategories(
    db,
    splits.filter((s) => s.category_id != null).map((s) => s.category_id)
  )
  const merged = new Map()
  for (const s of splits) {
    validSplit(s)
    const paise = s.amount_paise != null ? s.amount_paise : Math.floor((totalPaise * s.percent) / 100)
    const key = s.category_id ?? null
    merged.set(key, (merged.get(key) ?? 0) + paise)
  }
  let chosen = 0
  for (const v of merged.values()) chosen += v
  if (chosen > totalPaise) {
    throw new ApiError(422, `Splits sum to ${chosen} paise but income is only ${totalPaise} paise`)
  }
  merged.set(null, (merged.get(null) ?? 0) + (totalPaise - chosen))
  return [...merged.entries()].sort((a, b) => {
    if (a[0] === b[0]) return 0
    if (a[0] === null) return -1
    if (b[0] === null) return 1
    return a[0] - b[0]
  })
}

function incomeOut(db, id) {
  const head = one(db, 'SELECT * FROM income WHERE id = ?', [id])
  const rows = all(
    db,
    'SELECT a.category_id, a.amount_paise, c.name' +
      ' FROM income_allocations a LEFT JOIN categories c ON c.id = a.category_id' +
      ' WHERE a.income_id = ? ORDER BY a.category_id IS NOT NULL, a.category_id',
    [id]
  )
  return {
    id: head.id,
    amount_paise: head.amount_paise,
    note: head.note,
    income_date: head.income_date,
    created_at: head.created_at,
    splits: rows
      .filter((r) => r.category_id != null)
      .map((r) => ({
        category_id: r.category_id,
        category_name: r.name || UNALLOCATED,
        amount_paise: r.amount_paise,
      })),
    unallocated_paise: rows
      .filter((r) => r.category_id == null)
      .reduce((a, r) => a + r.amount_paise, 0),
  }
}

function templateOut(db, id) {
  const t = one(db, 'SELECT * FROM split_templates WHERE id = ?', [id])
  if (!t) throw new ApiError(404, 'Template not found')
  const items = all(
    db,
    'SELECT i.category_id, i.percent, c.name' +
      ' FROM split_template_items i LEFT JOIN categories c ON c.id = i.category_id' +
      ' WHERE i.template_id = ? ORDER BY i.category_id IS NOT NULL, i.category_id',
    [id]
  )
  return {
    id: t.id,
    name: t.name,
    created_at: t.created_at,
    items: items.map((i) => ({
      category_id: i.category_id,
      category_name: i.name || UNALLOCATED,
      percent: i.percent,
    })),
  }
}

// ---- route handlers -----------------------------------------------------

function listCategories(db, q) {
  const includeArchived = q.get('include_archived') === 'true'
  return all(
    db,
    'SELECT * FROM categories' + (includeArchived ? '' : ' WHERE archived = 0') + ' ORDER BY archived, id'
  ).map(catOut)
}

function createCategory(db, body) {
  validCategoryBody(body, false)
  const name = body.name.trim()
  checkNameFree(db, name)
  const id = tx(db, () => {
    db.run(
      'INSERT INTO categories (name, type, flexibility, pain_weight, created_at) VALUES (?, ?, ?, ?, ?)',
      [name, body.type, body.flexibility, body.pain_weight, nowIso()]
    )
    return lastId(db)
  })
  return catOut(getCatOr404(db, id))
}

function updateCategory(db, id, body) {
  getCatOr404(db, id)
  validCategoryBody(body, true)
  const updates = {}
  for (const k of ['name', 'type', 'flexibility', 'pain_weight']) {
    if (body[k] !== undefined && body[k] !== null) updates[k] = body[k]
  }
  if ('name' in updates) {
    updates.name = updates.name.trim()
    checkNameFree(db, updates.name, id)
  }
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ')
    tx(db, () => db.run(`UPDATE categories SET ${sets} WHERE id = ?`, [...Object.values(updates), id]))
  }
  return catOut(getCatOr404(db, id))
}

function setArchived(db, id, archived) {
  const row = getCatOr404(db, id)
  if (archived) {
    tx(db, () => db.run('UPDATE categories SET archived = 1 WHERE id = ?', [id]))
  } else {
    checkNameFree(db, row.name, id)
    tx(db, () => db.run('UPDATE categories SET archived = 0 WHERE id = ?', [id]))
  }
  return catOut(getCatOr404(db, id))
}

function budget(db) {
  const balances = categoryBalances(db)
  return {
    categories: Object.values(balances),
    unallocated_paise: totalUnallocated(db),
    total_income_paise: one(db, 'SELECT COALESCE(SUM(amount_paise), 0) AS n FROM income').n,
    total_spent_paise: one(db, 'SELECT COALESCE(SUM(amount_paise), 0) AS n FROM expenses').n,
  }
}

function listExpenses(db, q) {
  const limit = Math.min(parseInt(q.get('limit') || '100', 10) || 100, 500)
  return all(db, 'SELECT id FROM expenses ORDER BY expense_date DESC, id DESC LIMIT ?', [limit]).map((r) =>
    expenseRow(db, r.id)
  )
}

function addExpense(db, body) {
  check(Number.isInteger(body.amount_paise) && body.amount_paise > 0, 'amount_paise must be > 0')
  check(typeof body.expense_date === 'string' && body.expense_date.length === 10, 'expense_date required')
  const cat = one(db, 'SELECT * FROM categories WHERE id = ?', [body.category_id])
  if (!cat || cat.archived) throw new ApiError(404, 'Active category not found')

  const balances = categoryBalances(db)
  const balanceBefore = balances[cat.id] ? balances[cat.id].balance_paise : 0
  const expenseId = tx(db, () => {
    db.run(
      'INSERT INTO expenses (category_id, amount_paise, description, expense_date, created_at) VALUES (?, ?, ?, ?, ?)',
      [body.category_id, body.amount_paise, body.description ?? null, body.expense_date, nowIso()]
    )
    return lastId(db)
  })
  const deficit = Math.max(0, body.amount_paise - balanceBefore)

  let proposal = null
  if (deficit > 0) {
    const donors = Object.entries(balances)
      .filter(([cid]) => Number(cid) !== cat.id)
      .map(([, b]) => ({
        id: b.id,
        balance_paise: b.balance_paise,
        flexibility_pct: b.flexibility,
        pain: b.pain_weight,
        locked: b.type === 'locked',
      }))
    const plan = planRebalance(deficit, donors)
    const caps = Object.fromEntries(donors.map((d) => [d.id, capacityPaise(d)]))
    const names = Object.fromEntries(Object.entries(balances).map(([, b]) => [b.id, b.name]))
    proposal = {
      deficit_paise: deficit,
      feasible: plan.feasible,
      total_pain: plan.total_pain,
      pain_score: plan.pain_score,
      moves: plan.moves.map(([did, amt]) => ({
        category_id: did,
        category_name: names[did],
        amount_paise: amt,
        max_paise: caps[did],
      })),
    }
  }

  return {
    expense: expenseRow(db, expenseId),
    balance_paise: balanceBefore - body.amount_paise,
    needs_rebalance: deficit > 0,
    proposal,
  }
}

function rebalance(db, expenseId, body) {
  const exp = one(db, 'SELECT * FROM expenses WHERE id = ?', [expenseId])
  if (!exp) throw new ApiError(404, 'Expense not found')
  check(Array.isArray(body.moves) && body.moves.length >= 1, 'moves must be a non-empty list')

  const applied = []
  tx(db, () => {
    for (const move of body.moves) {
      check(Number.isInteger(move.amount_paise) && move.amount_paise > 0, 'amount_paise must be > 0')
      if (move.category_id === exp.category_id) {
        throw new ApiError(422, 'A category cannot fund itself')
      }
      const donor = one(db, 'SELECT * FROM categories WHERE id = ? AND archived = 0', [move.category_id])
      if (!donor) throw new ApiError(422, `Category ${move.category_id} not found`)
      if (donor.type === 'locked') {
        throw new ApiError(422, `'${donor.name}' is locked and cannot give money`)
      }
      const balances = categoryBalances(db)
      const bal = balances[move.category_id] ? balances[move.category_id].balance_paise : 0
      if (move.amount_paise > bal) {
        throw new ApiError(
          422,
          `'${donor.name}' has only ${bal} paise available, cannot move ${move.amount_paise}`
        )
      }
      db.run(
        'INSERT INTO transfers (expense_id, from_category_id, to_category_id, amount_paise, created_at) VALUES (?, ?, ?, ?, ?)',
        [expenseId, move.category_id, exp.category_id, move.amount_paise, nowIso()]
      )
      applied.push({ from: donor.name, amount_paise: move.amount_paise })
    }
  })
  const balances = categoryBalances(db)
  return {
    applied,
    expense_balance_paise: balances[exp.category_id] ? balances[exp.category_id].balance_paise : 0,
  }
}

function transferLog(db) {
  return all(
    db,
    'SELECT t.*, f.name AS from_name, g.name AS to_name' +
      ' FROM transfers t JOIN categories f ON f.id = t.from_category_id' +
      " JOIN categories g ON g.id = t.to_category_id ORDER BY t.id DESC"
  )
}

function addIncome(db, body) {
  check(Number.isInteger(body.amount_paise) && body.amount_paise > 0, 'amount_paise must be > 0')
  check(typeof body.income_date === 'string' && body.income_date.length === 10, 'income_date required')
  const splits = body.splits ?? []
  check(!(body.template_id != null && splits.length > 0), 'Provide either splits or template_id, not both')

  let effective = splits
  if (body.template_id != null) {
    const items = all(
      db,
      'SELECT category_id, percent FROM split_template_items WHERE template_id = ?',
      [body.template_id]
    )
    if (!items.length) throw new ApiError(422, `Template ${body.template_id} does not exist`)
    effective = items.map((r) => ({ category_id: r.category_id, percent: r.percent }))
  }
  const pairs = expandSplits(db, body.amount_paise, effective)

  const incomeId = tx(db, () => {
    db.run('INSERT INTO income (amount_paise, note, income_date, created_at) VALUES (?, ?, ?, ?)', [
      body.amount_paise,
      body.note ?? null,
      body.income_date,
      nowIso(),
    ])
    const id = lastId(db)
    for (const [cid, amt] of pairs) {
      db.run('INSERT INTO income_allocations (income_id, category_id, amount_paise) VALUES (?, ?, ?)', [
        id,
        cid,
        amt,
      ])
    }
    return id
  })
  return incomeOut(db, incomeId)
}

function listIncome(db) {
  return all(db, 'SELECT id FROM income ORDER BY id DESC').map((r) => incomeOut(db, r.id))
}

function listTemplates(db) {
  return all(db, 'SELECT id FROM split_templates ORDER BY id').map((t) => templateOut(db, t.id))
}

function createTemplate(db, body) {
  const name = (body.name ?? '').trim()
  check(name.length >= 1 && name.length <= 60, 'name must be 1-60 chars')
  check(Array.isArray(body.items) && body.items.length >= 1, 'items must be a non-empty list')
  let total = 0
  for (const it of body.items) {
    check(it.percent != null && it.amount_paise == null, 'Template items must use percent')
    validSplit(it)
    total += it.percent
  }
  check(total <= 100 + 1e-9, `Template percentages must sum to <= 100 (got ${total})`)
  if (one(db, 'SELECT 1 AS x FROM split_templates WHERE lower(name) = lower(?)', [name])) {
    throw new ApiError(409, `Template '${name}' already exists`)
  }
  validateCategories(
    db,
    body.items.filter((i) => i.category_id != null).map((i) => i.category_id)
  )
  const tid = tx(db, () => {
    db.run('INSERT INTO split_templates (name, created_at) VALUES (?, ?)', [name, nowIso()])
    const id = lastId(db)
    for (const it of body.items) {
      db.run('INSERT INTO split_template_items (template_id, category_id, percent) VALUES (?, ?, ?)', [
        id,
        it.category_id ?? null,
        it.percent,
      ])
    }
    return id
  })
  return templateOut(db, tid)
}

function deleteTemplate(db, id) {
  const found = one(db, 'SELECT id FROM split_templates WHERE id = ?', [id])
  if (!found) throw new ApiError(404, 'Template not found')
  tx(db, () => db.run('DELETE FROM split_templates WHERE id = ?', [id]))
  return null // 204
}

function exportBackup(db) {
  const tables = {}
  for (const t of TABLES) tables[t] = all(db, `SELECT * FROM ${t} ORDER BY id`)
  return {
    app: 'expense-tracker',
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso(),
    tables,
  }
}

function importBackup(db, payload) {
  if (!payload || payload.app !== 'expense-tracker') {
    throw new ApiError(422, 'Not an expense-tracker backup file')
  }
  if (payload.schema_version !== SCHEMA_VERSION) {
    throw new ApiError(422, `Unsupported schema_version ${payload.schema_version}`)
  }
  const tables = payload.tables
  if (!tables || typeof tables !== 'object' || !TABLES.every((t) => t in tables)) {
    throw new ApiError(422, `Backup must contain tables: ${TABLES.join(', ')}`)
  }
  const columns = {}
  for (const t of TABLES) {
    columns[t] = all(db, `PRAGMA table_info(${t})`).map((c) => c.name)
    if (!Array.isArray(tables[t])) throw new ApiError(422, `Table ${t} must be a list of rows`)
    for (const row of tables[t]) {
      const unknown = Object.keys(row).filter((k) => !columns[t].includes(k))
      if (unknown.length) throw new ApiError(422, `Unknown column(s) [${unknown}] in table ${t}`)
    }
  }
  try {
    tx(db, () => {
      for (const t of [...TABLES].reverse()) {
        db.run(`DELETE FROM ${t}`)
        db.run('DELETE FROM sqlite_sequence WHERE name = ?', [t])
      }
      for (const t of TABLES) {
        for (const row of tables[t]) {
          const cols = columns[t].filter((c) => c in row)
          db.run(
            `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map((c) => row[c])
          )
        }
      }
    })
  } catch (e) {
    throw new ApiError(422, `Restore failed, database untouched: ${e.message}`)
  }
  return { restored: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])) }
}

// ---- dispatch -----------------------------------------------------------

export async function handle(method, url, body) {
  const db = await getDb()
  const [path, qs] = url.split('?')
  const q = new URLSearchParams(qs || '')
  const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const M = method.toUpperCase()
  const at = (i) => (seg[i] !== undefined ? Number(seg[i]) : undefined)

  if (M === 'GET' && seg[0] === 'health') return { status: 'ok' }

  if (seg[0] === 'categories') {
    if (M === 'GET' && seg.length === 1) return listCategories(db, q)
    if (M === 'POST' && seg.length === 1) return createCategory(db, body)
    if (M === 'PUT' && seg.length === 2) return updateCategory(db, at(1), body)
    if (M === 'POST' && seg.length === 3 && seg[2] === 'archive') return setArchived(db, at(1), true)
    if (M === 'POST' && seg.length === 3 && seg[2] === 'unarchive') return setArchived(db, at(1), false)
  }

  if (seg[0] === 'budget' && M === 'GET') return budget(db)

  if (seg[0] === 'expenses') {
    if (M === 'GET' && seg.length === 1) return listExpenses(db, q)
    if (M === 'POST' && seg.length === 1) return addExpense(db, body)
    if (M === 'POST' && seg.length === 3 && seg[2] === 'rebalance') return rebalance(db, at(1), body)
  }

  if (seg[0] === 'transfers' && M === 'GET') return transferLog(db)

  if (seg[0] === 'income') {
    if (M === 'POST') return addIncome(db, body)
    if (M === 'GET') return listIncome(db)
  }

  if (seg[0] === 'split-templates') {
    if (M === 'GET' && seg.length === 1) return listTemplates(db)
    if (M === 'POST' && seg.length === 1) return createTemplate(db, body)
    if (M === 'DELETE' && seg.length === 2) return deleteTemplate(db, at(1))
  }

  if (seg[0] === 'backup' && M === 'GET') return exportBackup(db)
  if (seg[0] === 'restore' && M === 'POST') return importBackup(db, body)

  throw new ApiError(404, 'Not Found')
}
