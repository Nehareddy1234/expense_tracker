# Expense Tracker (personal, mobile-first PWA)

A single-user envelope budget for a student: get pocket money, split it into
category envelopes, log expenses in INR, and when one envelope runs short the
app computes the least-painful way to cover the gap from your other envelopes.

The app is **fully client-side**: SQLite runs in the browser via WebAssembly
(sql.js) and the whole database is persisted to the browser's storage. It is
hosted on GitHub Pages as static files — no server, no Docker, no external
services. An optional FastAPI mode (same UI, server-side SQLite file) is kept
for local/desktop use and is what the pytest suite exercises.

## Live app

Deployed from the `docs/` folder via GitHub Pages (Settings → Pages →
*Deploy from a branch* → `main` / `/docs`). Every `npm run build` + push
updates the site.

**Your data lives in that browser only.** Clearing site data or switching
device/browser loses it — use *Data → Download JSON backup* regularly and
restore it anywhere.

## Run it (local dev / build)

```powershell
cd Expense_tracker\frontend
npm install
npm run dev        # Vite dev server, app runs entirely in the browser
npm run build      # -> ../docs (the GitHub Pages folder; commit it to deploy)
```

## Run it (optional FastAPI mode)

Serves the same built UI from `docs/` plus a server-side JSON API backed by
one SQLite file:

```powershell
cd Expense_tracker
python -m venv .venv                 # once
.venv\Scripts\activate
pip install -r requirements.txt      # once
python -m uvicorn backend.app.main:app --reload
```

Open **http://127.0.0.1:8000**. API docs at **/docs**. The database file is
created automatically at `data/expenses.db`; override with the
`EXPENSE_DB_PATH` environment variable. (The built UI itself always talks to
the in-browser engine; the API is used by tests and power users.)

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

**Optimizer.** The reallocation model:

```
minimize    sum(x_i * pain_i)            # total regret of lending
subject to  sum(x_i) >= deficit          # cover the gap
            0 <= x_i <= balance_i * flexibility_i / 100
            x_i = 0 for locked categories
```

The backend (`backend/app/optimizer.py`) solves it with scipy `linprog`
(HiGHS), floors to whole paise and hands the rounding remainder to the
least-painful donors with room. The browser port (`frontend/src/local/optimizer.js`)
uses the fact that this LP is solved exactly by greedy fill in ascending-pain
order. Both return the moves, total pain, average pain per rupee moved, and a
`feasible` flag.

## Backup / restore

Data → “Download JSON backup” saves every table to one file; “Restore”
replaces the current database with it (atomic — a bad file leaves the DB
untouched). Same tables and format in both modes, so a backup from the FastAPI
mode restores into the browser and vice versa.

## Install as an app (PWA)

Open the site in Chrome (Android) → menu → *Add to Home screen*; Safari
(iPhone) → Share → *Add to Home Screen*. Runs standalone, fully offline: the
service worker caches the shell and all data lives on-device.

## Layout

```
docs/                 # built UI, served by GitHub Pages (commit to deploy)
frontend/
  src/local/
    schema.js         # SQLite schema + balance SQL (mirror of backend/app/db.py)
    engine.js         # in-browser /api/* implementation over sql.js + localStorage
    optimizer.js      # greedy least-pain rebalancing (mirror of backend optimizer)
  src/                # React tabs (Budget/Spend/Income/Envelopes/Data)
  public/             # manifest, service worker, icons, .nojekyll
backend/app/
  config.py           # EXPENSE_DB_PATH
  db.py               # schema (auto-created), balance SQL
  optimizer.py        # pure linprog reallocation model
  categories_api.py   # CRUD + archive + seed
  income_api.py       # income splits + templates
  expenses_api.py     # logging, budget summary, rebalance, transfer log
  backup_api.py       # JSON export/import
  main.py             # create_app() wiring everything
backend/tests/        # pytest, one file per step
```
