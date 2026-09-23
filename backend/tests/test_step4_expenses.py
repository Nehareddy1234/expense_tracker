import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def cat_id(client, name):
    return next(c["id"] for c in client.get("/api/categories").json() if c["name"] == name)


def fund(client, name, paise):
    cid = cat_id(client, name)
    client.post("/api/income", json={
        "amount_paise": paise, "income_date": "2026-09-01",
        "splits": [{"category_id": cid, "amount_paise": paise}]})


def balance(client, name):
    b = client.get("/api/budget").json()["categories"]
    return next(c["balance_paise"] for c in b if c["name"] == name)


def test_expense_within_balance_no_plan(client):
    fund(client, "Food", 100000)
    r = client.post("/api/expenses", json={
        "category_id": cat_id(client, "Food"), "amount_paise": 40000,
        "description": "canteen", "expense_date": "2026-09-02"})
    assert r.status_code == 201
    out = r.json()
    assert out["needs_rebalance"] is False and out["proposal"] is None
    assert out["balance_paise"] == 60000
    assert balance(client, "Food") == 60000


def test_overspend_is_never_blocked(client):
    fund(client, "Food", 10000)
    r = client.post("/api/expenses", json={
        "category_id": cat_id(client, "Food"), "amount_paise": 50000,
        "expense_date": "2026-09-02"})
    out = r.json()
    assert r.status_code == 201                      # logged regardless
    assert out["needs_rebalance"] is True
    assert out["expense"]["amount_paise"] == 50000   # full amount stored
    assert balance(client, "Food") == -40000         # overspent until rebalanced


def test_expense_validation(client):
    assert client.post("/api/expenses", json={
        "category_id": 9999, "amount_paise": 100,
        "expense_date": "2026-09-02"}).status_code == 404
    assert client.post("/api/expenses", json={
        "category_id": cat_id(client, "Food"), "amount_paise": 0,
        "expense_date": "2026-09-02"}).status_code == 422


def test_budget_totals(client):
    fund(client, "Shopping", 50000)
    client.post("/api/expenses", json={
        "category_id": cat_id(client, "Shopping"), "amount_paise": 20000,
        "expense_date": "2026-09-03"})
    b = client.get("/api/budget").json()
    assert b["total_income_paise"] == 50000
    assert b["total_spent_paise"] == 20000
    shopping = next(c for c in b["categories"] if c["name"] == "Shopping")
    assert shopping == {**shopping, "allocated_paise": 50000, "spent_paise": 20000,
                        "balance_paise": 30000}


def test_expense_list_shows_names(client):
    fund(client, "Travel", 30000)
    client.post("/api/expenses", json={
        "category_id": cat_id(client, "Travel"), "amount_paise": 5000,
        "description": "bus pass", "expense_date": "2026-09-04"})
    rows = client.get("/api/expenses").json()
    assert rows[0]["category_name"] == "Travel" and rows[0]["description"] == "bus pass"
