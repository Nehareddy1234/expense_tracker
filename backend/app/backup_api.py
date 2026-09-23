"""Whole-database JSON export/import: the app's entire state is these tables."""

import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

TABLES = [
    "categories",
    "income",
    "income_allocations",
    "split_templates",
    "split_template_items",
    "expenses",
    "transfers",
]

# Delete children before parents (FK-safe). The implicit transaction started
# by the first DELETE is committed (or rolled back on error) by get_conn.
DELETE_ORDER = list(reversed(TABLES))
SCHEMA_VERSION = 1


def create_router(get_conn: Callable) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["backup"])

    @router.get("/backup")
    def export_all(conn=Depends(get_conn)):
        data = {
            t: [dict(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY id")]
            for t in TABLES
        }
        return {
            "app": "expense-tracker",
            "schema_version": SCHEMA_VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "tables": data,
        }

    @router.post("/restore")
    def import_all(payload: dict, conn=Depends(get_conn)):
        if payload.get("app") != "expense-tracker":
            raise HTTPException(422, "Not an expense-tracker backup file")
        if payload.get("schema_version") != SCHEMA_VERSION:
            raise HTTPException(
                422, f"Unsupported schema_version {payload.get('schema_version')}"
            )
        tables = payload.get("tables")
        if not isinstance(tables, dict) or not set(TABLES) <= set(tables):
            raise HTTPException(422, f"Backup must contain tables: {TABLES}")

        columns = {
            t: [c["name"] for c in conn.execute(f"PRAGMA table_info({t})")] for t in TABLES
        }
        for t in TABLES:
            if not isinstance(tables[t], list):
                raise HTTPException(422, f"Table {t} must be a list of rows")
            for row in tables[t]:
                unknown = set(row) - set(columns[t])
                if unknown:
                    raise HTTPException(422, f"Unknown column(s) {unknown} in table {t}")

        try:
            for t in DELETE_ORDER:
                conn.execute(f"DELETE FROM {t}")
                conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (t,))
            for t in TABLES:
                for row in tables[t]:
                    cols = [c for c in columns[t] if c in row]
                    conn.execute(
                        f"INSERT INTO {t} ({', '.join(cols)})"
                        f" VALUES ({', '.join('?' * len(cols))})",
                        [row[c] for c in cols],
                    )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(422, f"Restore failed, database untouched: {exc}") from exc

        return {"restored": {t: len(tables[t]) for t in TABLES}}

    return router
