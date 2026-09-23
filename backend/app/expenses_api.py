"""Expense logging + budget summary + applying reallocations.

Logging is never blocked: the money is already spent, so the expense is
always stored at full value. When it exceeds the category balance we attach a
proposed reallocation plan to the response; the user can accept it, edit it,
or decline (leaving the envelope overspent).
"""

import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException

from . import db
from .categories_api import now_iso
from .optimizer import Donor, plan_budget_set, plan_rebalance
from .schemas import BudgetSetIn, ExpenseIn, ExpenseOut, RebalanceIn


def _expense_row(conn: sqlite3.Connection, expense_id: int) -> ExpenseOut:
    r = conn.execute(
        "SELECT e.*, c.name AS category_name FROM expenses e"
        " JOIN categories c ON c.id = e.category_id WHERE e.id = ?",
        (expense_id,),
    ).fetchone()
    return ExpenseOut(**dict(r))


def create_router(get_conn: Callable) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["budget"])

    @router.get("/budget")
    def budget(conn=Depends(get_conn)):
        balances = db.category_balances(conn)
        unalloc = db.total_unallocated(conn)
        total_income = conn.execute(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM income"
        ).fetchone()[0]
        total_spent = conn.execute(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM expenses"
        ).fetchone()[0]
        return {
            "categories": list(balances.values()),
            "unallocated_paise": unalloc,
            "total_income_paise": total_income,
            "total_spent_paise": total_spent,
        }

    @router.get("/expenses", response_model=list[ExpenseOut])
    def list_expenses(limit: int = 100, conn=Depends(get_conn)):
        ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM expenses ORDER BY expense_date DESC, id DESC LIMIT ?",
                (min(limit, 500),),
            )
        ]
        return [_expense_row(conn, i) for i in ids]

    @router.post("/expenses", status_code=201)
    def add_expense(body: ExpenseIn, conn=Depends(get_conn)):
        cat = conn.execute(
            "SELECT * FROM categories WHERE id = ?", (body.category_id,)
        ).fetchone()
        if cat is None or cat["archived"]:
            raise HTTPException(404, "Active category not found")

        balances = db.category_balances(conn)
        balance_before = balances[cat["id"]]["balance_paise"] if cat["id"] in balances else 0
        cur = conn.execute(
            "INSERT INTO expenses (category_id, amount_paise, description, expense_date, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                body.category_id,
                body.amount_paise,
                body.description,
                body.expense_date.isoformat(),
                now_iso(),
            ),
        )
        expense_id = cur.lastrowid
        deficit = max(0, body.amount_paise - balance_before)

        proposal = None
        if deficit > 0:
            donors = [
                Donor(
                    id=cid,
                    balance_paise=b["balance_paise"],
                    flexibility_pct=b["flexibility"],
                    pain=b["pain_weight"],
                    locked=b["type"] == "locked",
                )
                for cid, b in balances.items()
                if cid != cat["id"]
            ]
            plan = plan_rebalance(deficit, donors)
            names = {cid: b["name"] for cid, b in balances.items()}
            proposal = {
                "deficit_paise": deficit,
                "feasible": plan.feasible,
                "total_pain": plan.total_pain,
                "pain_score": plan.pain_score,
                "moves": [
                    {
                        "category_id": did,
                        "category_name": names[did],
                        "amount_paise": amt,
                        "max_paise": next(
                            d.capacity_paise for d in donors if d.id == did
                        ),
                    }
                    for did, amt in plan.moves
                ],
            }

        return {
            "expense": _expense_row(conn, expense_id),
            "balance_paise": balance_before - body.amount_paise,
            "needs_rebalance": deficit > 0,
            "proposal": proposal,
        }

    @router.post("/expenses/{expense_id}/rebalance")
    def rebalance(expense_id: int, body: RebalanceIn, conn=Depends(get_conn)):
        exp = conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if exp is None:
            raise HTTPException(404, "Expense not found")

        applied = []
        for move in body.moves:
            if move.category_id == exp["category_id"]:
                raise HTTPException(422, "A category cannot fund itself")
            donor = conn.execute(
                "SELECT * FROM categories WHERE id = ? AND archived = 0", (move.category_id,)
            ).fetchone()
            if donor is None:
                raise HTTPException(422, f"Category {move.category_id} not found")
            if donor["type"] == "locked":
                raise HTTPException(422, f"'{donor['name']}' is locked and cannot give money")
            balances = db.category_balances(conn)
            bal = balances[move.category_id]["balance_paise"]
            if move.amount_paise > bal:
                raise HTTPException(
                    422,
                    f"'{donor['name']}' has only {bal} paise available,"
                    f" cannot move {move.amount_paise}",
                )
            conn.execute(
                "INSERT INTO transfers (expense_id, from_category_id, to_category_id,"
                " amount_paise, created_at) VALUES (?, ?, ?, ?, ?)",
                (expense_id, move.category_id, exp["category_id"], move.amount_paise, now_iso()),
            )
            applied.append({"from": donor["name"], "amount_paise": move.amount_paise})

        balances = db.category_balances(conn)
        return {
            "applied": applied,
            "expense_balance_paise": balances[exp["category_id"]]["balance_paise"],
        }

    @router.get("/transfers")
    def transfer_log(conn=Depends(get_conn)):
        rows = conn.execute(
            "SELECT t.*, f.name AS from_name, g.name AS to_name"
            " FROM transfers t"
            " JOIN categories f ON f.id = t.from_category_id"
            " JOIN categories g ON g.id = t.to_category_id"
            " ORDER BY t.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def _budget_targets(conn, body: BudgetSetIn) -> dict[int, int]:
        targets: dict[int, int] = {}
        for t in body.targets:
            row = conn.execute(
                "SELECT id FROM categories WHERE id = ? AND archived = 0", (t.category_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(422, f"Category {t.category_id} not found")
            targets[t.category_id] = t.amount_paise
        return targets

    def _budget_plan(conn, body: BudgetSetIn):
        targets = _budget_targets(conn, body)
        balances = db.category_balances(conn)
        moves, short = plan_budget_set(targets, balances, db.total_unallocated(conn))
        names = {cid: b["name"] for cid, b in balances.items()}
        return moves, short, names, balances

    @router.post("/budget/plan")
    def budget_plan(body: BudgetSetIn, conn=Depends(get_conn)):
        moves, short, names, _ = _budget_plan(conn, body)
        return {
            "feasible": short == 0,
            "short_paise": short,
            "moves": [
                {
                    "from_category_id": m.from_category_id,
                    "from_name": "Unallocated" if m.from_category_id is None else names[m.from_category_id],
                    "to_category_id": m.to_category_id,
                    "to_name": names[m.to_category_id],
                    "amount_paise": m.amount_paise,
                }
                for m in moves
            ],
        }

    @router.post("/budget/apply")
    def budget_apply(body: BudgetSetIn, conn=Depends(get_conn)):
        moves, short, _, _ = _budget_plan(conn, body)
        if short > 0:
            raise HTTPException(
                422,
                f"Targets need {short} paise more than is available — add income or lower a target",
            )
        for m in moves:
            if m.from_category_id is None:
                # Fund from the Unallocated pool by re-tagging its ledger rows.
                remaining = m.amount_paise
                rows = conn.execute(
                    "SELECT id, income_id, amount_paise FROM income_allocations"
                    " WHERE category_id IS NULL AND amount_paise > 0 ORDER BY id DESC"
                ).fetchall()
                for row in rows:
                    if remaining <= 0:
                        break
                    take = min(row["amount_paise"], remaining)
                    conn.execute(
                        "UPDATE income_allocations SET amount_paise = amount_paise - ? WHERE id = ?",
                        (take, row["id"]),
                    )
                    conn.execute(
                        "INSERT INTO income_allocations (income_id, category_id, amount_paise)"
                        " VALUES (?, ?, ?)",
                        (row["income_id"], m.to_category_id, take),
                    )
                    remaining -= take
            else:
                balances = db.category_balances(conn)
                bal = balances[m.from_category_id]["balance_paise"]
                if m.amount_paise > bal:
                    raise HTTPException(
                        422, f"Cannot move {m.amount_paise} paise out of a {bal} paise envelope"
                    )
                conn.execute(
                    "INSERT INTO transfers (expense_id, from_category_id, to_category_id,"
                    " amount_paise, created_at) VALUES (NULL, ?, ?, ?, ?)",
                    (m.from_category_id, m.to_category_id, m.amount_paise, now_iso()),
                )
        balances = db.category_balances(conn)
        return {
            "applied": len(moves),
            "categories": list(balances.values()),
            "unallocated_paise": db.total_unallocated(conn),
        }

    return router
