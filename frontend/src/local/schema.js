// Ported 1:1 from backend/app/db.py — keep the two in sync.
// All money is integer paise (1 INR = 100 paise).

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN ('locked', 'flexible')),
    flexibility INTEGER NOT NULL CHECK (flexibility BETWEEN 0 AND 100),
    pain_weight INTEGER NOT NULL CHECK (pain_weight BETWEEN 1 AND 10),
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS income (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    note        TEXT,
    income_date TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS income_allocations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    income_id    INTEGER NOT NULL REFERENCES income(id) ON DELETE CASCADE,
    category_id  INTEGER REFERENCES categories(id),
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0)
);

CREATE TABLE IF NOT EXISTS split_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS split_template_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES split_templates(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id),
    percent     REAL    NOT NULL CHECK (percent > 0 AND percent <= 100)
);

CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    description  TEXT,
    expense_date TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id       INTEGER REFERENCES expenses(id),
    from_category_id INTEGER NOT NULL REFERENCES categories(id),
    to_category_id   INTEGER NOT NULL REFERENCES categories(id),
    amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
    created_at       TEXT    NOT NULL
);
`

// Envelope balance: allocated + transferred-in - transferred-out - spent.
export const BALANCES_SQL = `
SELECT c.id, c.name, c.type, c.flexibility, c.pain_weight,
       COALESCE(a.allocated, 0)
     + COALESCE(tin.amount, 0)
     - COALESCE(tout.amount, 0)
     - COALESCE(e.spent, 0)               AS balance_paise,
       COALESCE(a.allocated, 0)           AS allocated_paise,
       COALESCE(e.spent, 0)               AS spent_paise
FROM categories c
LEFT JOIN (SELECT category_id, SUM(amount_paise) AS allocated
           FROM income_allocations GROUP BY category_id) a   ON a.category_id = c.id
LEFT JOIN (SELECT to_category_id AS category_id, SUM(amount_paise) AS amount
           FROM transfers GROUP BY to_category_id) tin       ON tin.category_id = c.id
LEFT JOIN (SELECT from_category_id AS category_id, SUM(amount_paise) AS amount
           FROM transfers GROUP BY from_category_id) tout    ON tout.category_id = c.id
LEFT JOIN (SELECT category_id, SUM(amount_paise) AS spent
           FROM expenses GROUP BY category_id) e             ON e.category_id = c.id
WHERE c.archived = 0
`

export const SEED = [
  ['Food', 'flexible', 60, 3],
  ['Travel', 'flexible', 40, 2],
  ['Shopping', 'flexible', 80, 1],
  ['Savings', 'locked', 0, 10],
]

// Backup/restore table order (parents first); deletes run reversed (children first).
export const TABLES = [
  'categories',
  'income',
  'income_allocations',
  'split_templates',
  'split_template_items',
  'expenses',
  'transfers',
]

export const SCHEMA_VERSION = 1
