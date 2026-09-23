# Expense Tracker (personal, mobile-first PWA)

A single-user envelope budget for a student: get pocket money, split it into
category envelopes, log expenses in INR, and when one envelope runs short the
app computes the least-painful way to cover the gap from your other envelopes.

One FastAPI process serves the JSON API **and** the built React UI. Data lives
in one SQLite file. No Docker, no Postgres, no external services.

## Run it

```powershell
cd Expense_tracker
python -m venv .venv                 # once
.venv\Scripts\activate
pip install -r requirements.txt      # once
python -m uvicorn backend.app.main:app --reload
```

Open **http://127.0.0.1:8000** on the phone/laptop. Interactive API docs live
at **http://127.0.0.1:8000/docs**. The database file is created automatically at
`data/expenses.db`; override with the `EXPENSE_DB_PATH` environment variable.

### Frontend only (dev, hot reload)

```powershell
cd frontend
npm install
npm run dev        # Vite dev server on :5173, proxies /api to :8000
npm run build      # production build -> ../static, served by FastAPI
```

### Tests

```powershell
.venv\Scripts\python -m pytest       # 36 tests: optimizer units + API integration
```

## How it works

**Envelope model.** Every category has a balance = allocated + received via
rebalancing − given via rebalancing − spent. Money is integer **paise**
everywhere (₹1 = 100 paise); the UI converts for display.

**Categories** are user-defined with `type` (locked or flexible),
`flexibility` 0–100% (how much of its balance it may lend) and `pain_weight`
1–10 (how much you dislike touching it). Categories are **archived, never
deleted**, so history survives. On first run: Food, Travel, Shopping,
Savings (Savings is locked).

**Income** is split across envelopes by amount or percentage; the split must
not exceed the income and any leftover lands in **Unallocated**. Splits can be
saved as reusable percentage **templates**.

**Expenses are never blocked** — the money is already spent, so logging always
succeeds. If the expense exceeds the category balance, the response carries a
proposed reallocation plan and the UI shows it in plain language. Accept it,
edit the amounts, or decline (the envelope then shows as overspent). If no
feasible plan exists, the UI says so and offers to log it as an overspend.
Every applied move is written to the `transfers` table with a timestamp.

**Optimizer** (`backend/app/optimizer.py`, pure function, scipy `linprog`):

```
minimize    sum(x_i * pain_i)            # total regret of lending
subject to  sum(x_i) >= deficit          # cover the gap
            0 <= x_i <= balance_i * flexibility_i / 100
            x_i = 0 for locked categories
```

Solved with HiGHS, floored to whole paise, and the ≤ n-paise rounding remainder
is given to the least-painful donors with room. Returns the moves, the total
pain (`sum x_i*pain_i`), an average pain score per rupee moved, and a
`feasible` flag.

## Backup / restore

Data → “Download JSON backup” saves every table to one file; “Restore”
replaces the current database with it (atomic — a bad file leaves the DB
untouched). Same thing via API: `GET /api/backup`, `POST /api/restore`.

## Install as an app (PWA)

Open the site in Chrome (Android) → menu → *Add to Home screen*; Safari
(iPhone) → Share → *Add to Home Screen*. Runs standalone; the service worker
caches the app shell (your data stays server-side, always fetched live).

## Layout

```
backend/app/
  config.py         # EXPENSE_DB_PATH
  db.py             # schema (auto-created), balance SQL
  optimizer.py      # pure linprog reallocation model
  categories_api.py # CRUD + archive + seed
  income_api.py     # income splits + templates
  expenses_api.py   # logging, budget summary, rebalance, transfer log
  backup_api.py     # JSON export/import
  main.py           # create_app() wiring everything
frontend/           # Vite + React, builds into ../static
backend/tests/      # pytest, one file per step
```
