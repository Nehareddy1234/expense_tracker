"""Income (pocket money) entry: split across envelopes by amount or percentage.

Leftover after the split always lands in an explicit 'Unallocated' row
(category_id NULL), so each income's allocations sum to its amount by design.
"""

import sqlite3
from collections.abc import Callable
from math import floor

from fastapi import APIRouter, Depends, HTTPException

from .categories_api import now_iso
from .schemas import IncomeIn, IncomeOut, SplitIn, SplitOut, TemplateIn, TemplateOut

UNALLOCATED = "Unallocated"


def _validate_categories(conn: sqlite3.Connection, category_ids: set[int]) -> None:
    for cid in category_ids:
        row = conn.execute(
            "SELECT archived FROM categories WHERE id = ?", (cid,)
        ).fetchone()
        if row is None:
            raise HTTPException(422, f"Category {cid} does not exist")
        if row["archived"]:
            raise HTTPException(422, f"Category {cid} is archived")


def expand_splits(
    conn: sqlite3.Connection, total_paise: int, splits: list[SplitIn]
) -> list[tuple[int | None, int]]:
    """Resolve amount/percent splits into (category_id, paise) pairs.

    Percentages floor to paise so they can never overshoot; the leftover goes
    to Unallocated. Raises 422 when the split exceeds the income amount.
    """
    _validate_categories(conn, {s.category_id for s in splits if s.category_id is not None})
    merged: dict[int | None, int] = {}
    for s in splits:
        paise = s.amount_paise if s.amount_paise is not None else floor(total_paise * s.percent / 100)
        merged[s.category_id] = merged.get(s.category_id, 0) + paise
    chosen = sum(merged.values())
    if chosen > total_paise:
        raise HTTPException(
            422, f"Splits sum to {chosen} paise but income is only {total_paise} paise"
        )
    merged[None] = merged.get(None, 0) + (total_paise - chosen)
    return sorted(merged.items(), key=lambda kv: (kv[0] is not None, kv[0]))


def _template_splits(conn: sqlite3.Connection, template_id: int) -> list[SplitIn]:
    rows = conn.execute(
        "SELECT category_id, percent FROM split_template_items WHERE template_id = ?",
        (template_id,),
    ).fetchall()
    if not rows:
        raise HTTPException(422, f"Template {template_id} does not exist")
    return [SplitIn(category_id=r["category_id"], percent=r["percent"]) for r in rows]


def create_router(get_conn: Callable) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["income"])

    def income_out(conn: sqlite3.Connection, income_id: int) -> IncomeOut:
        head = conn.execute("SELECT * FROM income WHERE id = ?", (income_id,)).fetchone()
        rows = conn.execute(
            "SELECT a.category_id, a.amount_paise, c.name"
            " FROM income_allocations a LEFT JOIN categories c ON c.id = a.category_id"
            " WHERE a.income_id = ? ORDER BY a.category_id IS NOT NULL, a.category_id",
            (income_id,),
        ).fetchall()
        splits = [
            SplitOut(
                category_id=r["category_id"],
                category_name=r["name"] or UNALLOCATED,
                amount_paise=r["amount_paise"],
            )
            for r in rows
        ]
        unalloc = sum(s.amount_paise for s in splits if s.category_id is None)
        return IncomeOut(
            id=head["id"],
            amount_paise=head["amount_paise"],
            note=head["note"],
            income_date=head["income_date"],
            created_at=head["created_at"],
            splits=[s for s in splits if s.category_id is not None],
            unallocated_paise=unalloc,
        )

    @router.post("/income", response_model=IncomeOut, status_code=201)
    def add_income(body: IncomeIn, conn=Depends(get_conn)):
        if body.template_id is not None:
            splits = _template_splits(conn, body.template_id)
        else:
            splits = body.splits
        pairs = expand_splits(conn, body.amount_paise, splits)
        cur = conn.execute(
            "INSERT INTO income (amount_paise, note, income_date, created_at)"
            " VALUES (?, ?, ?, ?)",
            (body.amount_paise, body.note, body.income_date.isoformat(), now_iso()),
        )
        income_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO income_allocations (income_id, category_id, amount_paise)"
            " VALUES (?, ?, ?)",
            [(income_id, cid, amt) for cid, amt in pairs],
        )
        return income_out(conn, income_id)

    @router.get("/income", response_model=list[IncomeOut])
    def list_income(conn=Depends(get_conn)):
        ids = [r["id"] for r in conn.execute("SELECT id FROM income ORDER BY id DESC")]
        return [income_out(conn, i) for i in ids]

    @router.get("/split-templates", response_model=list[TemplateOut])
    def list_templates(conn=Depends(get_conn)):
        out = []
        for t in conn.execute("SELECT * FROM split_templates ORDER BY id"):
            items = conn.execute(
                "SELECT i.category_id, i.percent, c.name"
                " FROM split_template_items i LEFT JOIN categories c ON c.id = i.category_id"
                " WHERE i.template_id = ? ORDER BY i.category_id IS NOT NULL, i.category_id",
                (t["id"],),
            ).fetchall()
            out.append(
                TemplateOut(
                    id=t["id"],
                    name=t["name"],
                    created_at=t["created_at"],
                    items=[
                        {
                            "category_id": i["category_id"],
                            "category_name": i["name"] or UNALLOCATED,
                            "percent": i["percent"],
                        }
                        for i in items
                    ],
                )
            )
        return out

    @router.post("/split-templates", response_model=TemplateOut, status_code=201)
    def create_template(body: TemplateIn, conn=Depends(get_conn)):
        if conn.execute(
            "SELECT 1 FROM split_templates WHERE name = ? COLLATE NOCASE", (body.name.strip(),)
        ).fetchone():
            raise HTTPException(409, f"Template '{body.name.strip()}' already exists")
        _validate_categories(conn, {i.category_id for i in body.items if i.category_id})
        cur = conn.execute(
            "INSERT INTO split_templates (name, created_at) VALUES (?, ?)",
            (body.name.strip(), now_iso()),
        )
        conn.executemany(
            "INSERT INTO split_template_items (template_id, category_id, percent)"
            " VALUES (?, ?, ?)",
            [(cur.lastrowid, i.category_id, i.percent) for i in body.items],
        )
        tid = cur.lastrowid
        rows = conn.execute(
            "SELECT i.category_id, i.percent, c.name"
            " FROM split_template_items i LEFT JOIN categories c ON c.id = i.category_id"
            " WHERE i.template_id = ?",
            (tid,),
        ).fetchall()
        return TemplateOut(
            id=tid,
            name=body.name.strip(),
            created_at=conn.execute(
                "SELECT created_at FROM split_templates WHERE id = ?", (tid,)
            ).fetchone()["created_at"],
            items=[
                {
                    "category_id": r["category_id"],
                    "category_name": r["name"] or UNALLOCATED,
                    "percent": r["percent"],
                }
                for r in rows
            ],
        )

    @router.delete("/split-templates/{template_id}", status_code=204)
    def delete_template(template_id: int, conn=Depends(get_conn)):
        cur = conn.execute("DELETE FROM split_templates WHERE id = ?", (template_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Template not found")

    return router
