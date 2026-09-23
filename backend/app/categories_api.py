"""Category management: CRUD + archive (never delete, history is preserved)."""

import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from .schemas import CategoryIn, CategoryOut, CategoryPatch

SEED = [
    ("Food", "flexible", 60, 3),
    ("Travel", "flexible", 40, 2),
    ("Shopping", "flexible", 80, 1),
    ("Savings", "locked", 0, 10),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def seed_categories(conn: sqlite3.Connection) -> None:
    """Seed defaults only when no categories exist at all (first run)."""
    count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    if count:
        return
    conn.executemany(
        "INSERT INTO categories (name, type, flexibility, pain_weight, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        [(n, t, f, p, now_iso()) for n, t, f, p in SEED],
    )
    conn.commit()


def _row_to_out(row: sqlite3.Row) -> CategoryOut:
    return CategoryOut(**dict(row, archived=bool(row["archived"])))


def _get_or_404(conn: sqlite3.Connection, category_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Category not found")
    return row


def _check_name_free(
    conn: sqlite3.Connection, name: str, exclude_id: int | None = None
) -> None:
    sql = "SELECT id FROM categories WHERE archived = 0 AND name = ? COLLATE NOCASE"
    args: list = [name.strip()]
    if exclude_id is not None:
        sql += " AND id != ?"
        args.append(exclude_id)
    if conn.execute(sql, args).fetchone():
        raise HTTPException(409, f"An active category named '{name.strip()}' already exists")


def create_router(get_conn: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/categories", tags=["categories"])

    @router.get("", response_model=list[CategoryOut])
    def list_categories(include_archived: bool = False, conn=Depends(get_conn)):
        sql = "SELECT * FROM categories"
        if not include_archived:
            sql += " WHERE archived = 0"
        sql += " ORDER BY archived, id"
        return [_row_to_out(r) for r in conn.execute(sql)]

    @router.post("", response_model=CategoryOut, status_code=201)
    def create_category(body: CategoryIn, conn=Depends(get_conn)):
        _check_name_free(conn, body.name)
        cur = conn.execute(
            "INSERT INTO categories (name, type, flexibility, pain_weight, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (body.name.strip(), body.type, body.flexibility, body.pain_weight, now_iso()),
        )
        return _row_to_out(_get_or_404(conn, cur.lastrowid))

    @router.put("/{category_id}", response_model=CategoryOut)
    def update_category(category_id: int, body: CategoryPatch, conn=Depends(get_conn)):
        row = _get_or_404(conn, category_id)
        updates = body.model_dump(exclude_unset=True, exclude_none=True)
        if "name" in updates:
            updates["name"] = updates["name"].strip()
            _check_name_free(conn, updates["name"], exclude_id=category_id)
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE categories SET {sets} WHERE id = ?", [*updates.values(), category_id]
            )
        return _row_to_out(_get_or_404(conn, category_id))

    def set_archived(category_id: int, archived: bool, conn) -> CategoryOut:
        _get_or_404(conn, category_id)
        if archived:
            conn.execute("UPDATE categories SET archived = 1 WHERE id = ?", (category_id,))
        else:
            row = _get_or_404(conn, category_id)
            _check_name_free(conn, row["name"], exclude_id=category_id)
            conn.execute("UPDATE categories SET archived = 0 WHERE id = ?", (category_id,))
        return _row_to_out(_get_or_404(conn, category_id))

    @router.post("/{category_id}/archive", response_model=CategoryOut)
    def archive_category(category_id: int, conn=Depends(get_conn)):
        return set_archived(category_id, True, conn)

    @router.post("/{category_id}/unarchive", response_model=CategoryOut)
    def unarchive_category(category_id: int, conn=Depends(get_conn)):
        return set_archived(category_id, False, conn)

    return router
