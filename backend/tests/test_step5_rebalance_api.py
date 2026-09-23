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


def balances(client):
    return {c["name"]: c["balance_paise"] for c in client.get("/api/budget").json()["categories"]}


def make_overspend(client):
    fund(client, "Food", 5000)
    fund(client, "Shopping", 60000)   # flex 80, pain 1 -> cap 48000
    fund(client, "Travel", 30000)     # flex 40, pain 2 -> cap 12000
    fund(client, "Savings", 50000)    # locked
    r = client.post("/api/expenses", json={
        "category_id": cat_id(client, "Food"), "amount_paise": 45000,
        "description": "concert", "expense_date": "2026-09-02"})
    return r.json()


def test_overspend_returns_plan_and_accept_fixes_balances(client):
    out = make_overspend(client)
    p = out["proposal"]
    assert out["needs_rebalance"] and p["feasible"]
    assert p["deficit_paise"] == 40000                  # 45000 - 5000
    moves = {m["category_name"]: m["amount_paise"] for m in p["moves"]}
    assert sum(moves.values()) == 40000
    assert moves == {"Shopping": 40000}                # cheapest pain funds the whole gap
    assert "Travel" not in moves and "Savings" not in moves

    eid = out["expense"]["id"]
    body = {"moves": [{"category_id": m["category_id"], "amount_paise": m["amount_paise"]}
                      for m in p["moves"]]}
    r = client.post(f"/api/expenses/{eid}/rebalance", json=body)
    assert r.status_code == 200
    b = balances(client)
    assert b["Food"] == 0                 # fully covered: -40000 + 40000
    assert b["Shopping"] == 60000 - 40000
    assert b["Savings"] == 50000          # locked envelope untouched


def test_edited_partial_move_leaves_partial_overspend(client):
    out = make_overspend(client)
    eid = out["expense"]["id"]
    shopper = next(m for m in out["proposal"]["moves"])
    r = client.post(f"/api/expenses/{eid}/rebalance", json={
        "moves": [{"category_id": shopper["category_id"], "amount_paise": 10000}]})
    assert r.status_code == 200
    assert balances(client)["Food"] == -30000
    assert balances(client)["Shopping"] == 50000


def test_decline_keeps_overspend_logged(client):
    out = make_overspend(client)
    assert balances(client)["Food"] == -40000           # user declines: unchanged
    assert client.get("/api/transfers").json() == []    # nothing moved, nothing logged


def test_rebalance_rejects_locked_overdraw_and_self(client):
    out = make_overspend(client)
    eid = out["expense"]["id"]
    food, savings, shopping = (cat_id(client, n) for n in ("Food", "Savings", "Shopping"))
    assert client.post(f"/api/expenses/{eid}/rebalance", json={
        "moves": [{"category_id": savings, "amount_paise": 1000}]}).status_code == 422
    # Moving a donor's full balance is legal; over-drawing it is not.
    assert client.post(f"/api/expenses/{eid}/rebalance", json={
        "moves": [{"category_id": shopping, "amount_paise": 60001}]}).status_code == 422
    assert client.post(f"/api/expenses/{eid}/rebalance", json={
        "moves": [{"category_id": food, "amount_paise": 1000}]}).status_code == 422
    assert client.post(f"/api/expenses/{eid}/rebalance", json={"moves": []}).status_code == 422
    assert client.get("/api/transfers").json() == []    # rejected calls logged nothing


def test_transfers_are_logged_with_timestamps(client):
    out = make_overspend(client)
    eid = out["expense"]["id"]
    m = out["proposal"]["moves"][0]
    client.post(f"/api/expenses/{eid}/rebalance", json={
        "moves": [{"category_id": m["category_id"], "amount_paise": 25000}]})
    rows = client.get("/api/transfers").json()
    assert len(rows) == 1
    row = rows[0]
    assert row["expense_id"] == eid and row["amount_paise"] == 25000
    assert row["from_name"] == "Shopping" and row["to_name"] == "Food"
    assert len(row["created_at"]) >= 19  # ISO-8601 timestamp recorded


def test_infeasible_overspend_reports_unfeasible(client):
    fund(client, "Food", 100)
    for name in ("Shopping", "Travel", "Savings"):
        pass  # seeded categories hold no money
    out = client.post("/api/expenses", json={
        "category_id": cat_id(client, "Food"), "amount_paise": 999999,
        "expense_date": "2026-09-02"}).json()
    assert out["needs_rebalance"] and out["proposal"]["feasible"] is False
    assert out["proposal"]["moves"] == []
    assert balances(client)["Food"] == 100 - 999999     # still logged as overspend
