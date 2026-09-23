import pytest
from fastapi.testclient import TestClient

from backend.app.db import connect, init_db
from backend.app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_schema_created_and_idempotent(tmp_path):
    conn = connect(str(tmp_path / "x.db"))
    init_db(conn)
    init_db(conn)  # re-running must not fail
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "categories",
        "income",
        "income_allocations",
        "split_templates",
        "split_template_items",
        "expenses",
        "transfers",
    } <= tables


def test_allocation_cascade_and_check_constraints(tmp_path):
    conn = connect(str(tmp_path / "x.db"))
    init_db(conn)
    conn.execute(
        "INSERT INTO income (amount_paise, income_date, created_at) VALUES (500000, '2026-09-21', 'now')"
    )
    income_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO income_allocations (income_id, category_id, amount_paise) VALUES (?, NULL, 500000)",
        (income_id,),
    )
    conn.commit()
    conn.execute("DELETE FROM income WHERE id = ?", (income_id,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM income_allocations").fetchone()[0] == 0
    with pytest.raises(Exception):  # CHECK amount_paise > 0
        conn.execute(
            "INSERT INTO expenses (category_id, amount_paise, expense_date, created_at) VALUES (1, 0, '2026-09-21', 'now')"
        )
