"""SQLite data layer. All money is stored as integer paise (1 INR = 100 paise)."""

import sqlite3
from pathlib import Path

SCHEMA = """
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

-- One row per category share of an income event. category_id NULL = "Unallocated".
-- Rows for one income always sum to income.amount_paise.
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

-- Reusable percentage split. category_id NULL = "Unallocated" share.
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

-- Accepted reallocations: money moved from one envelope to another,
-- optionally triggered by an expense that exceeded its balance.
CREATE TABLE IF NOT EXISTS transfers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id       INTEGER REFERENCES expenses(id),
    from_category_id INTEGER NOT NULL REFERENCES categories(id),
    to_category_id   INTEGER NOT NULL REFERENCES categories(id),
    amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
    created_at       TEXT    NOT NULL
);
"""


def connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI runs a request's dependency and endpoint
    # on different threadpool threads. The connection is still used by one
    # thread at a time (per request, sequentially), so this is safe.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


# Envelope balance: allocated + transferred-in - transferred-out - spent.
BALANCES_SQL = """
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
"""


def category_balances(conn: sqlite3.Connection) -> dict[int, dict]:
    """Active-category envelope balances keyed by category id."""
    return {row["id"]: dict(row) for row in conn.execute(BALANCES_SQL)}


def total_unallocated(conn: sqlite3.Connection) -> int:
    """Income shares parked in 'Unallocated', minus any that were later moved out
    (transfers never draw from Unallocated today, so this is a plain sum)."""
    return conn.execute(
        "SELECT COALESCE(SUM(amount_paise), 0) FROM income_allocations"
        " WHERE category_id IS NULL"
    ).fetchone()[0]
