"""User-set envelope budgets: plan + apply (Unallocated first, then surplus donors)."""

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.optimizer import plan_budget_set


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def cat_id(client, name):
    return next(c["id"] for c in client.get("/api/categories").json() if c["name"] == name)


def balances(client):
    return {c["name"]: c["balance_paise"] for c in client.get("/api/budget").json()["categories"]}


def targets(client, **by_name):
    body = {"targets": [
        {"category_id": cat_id(client, n), "amount_paise": p} for n, p in by_name.items()
    ]}
    return body


def test_set_budgets_funded_from_unallocated(client):
    client.post("/api/income", json={"amount_paise": 200000, "income_date": "2026-09-01"})
    p = client.post("/api/budget/plan", json=targets(client, Food=100000, Travel=50000)).json()
    assert p["feasible"] and p["short_paise"] == 0
    moves = {(m["from_name"], m["to_name"]): m["amount_paise"] for m in p["moves"]}
    assert moves == {("Unallocated", "Food"): 100000, ("Unallocated", "Travel"): 50000}

    r = client.post("/api/budget/apply", json=targets(client, Food=100000, Travel=50000))
    assert r.status_code == 200
    b = balances(client)
    assert b["Food"] == 100000 and b["Travel"] == 50000 and b["Shopping"] == 0
    budget = client.get("/api/budget").json()
    assert budget["unallocated_paise"] == 50000
    # Ledger invariant: the income's allocations still sum to the income amount.
    inc = client.get("/api/income").json()[0]
    assert sum(s["amount_paise"] for s in inc["splits"]) + inc["unallocated_paise"] == 200000
    # Unallocated funding must not pollute the transfer log.
    assert client.get("/api/transfers").json() == []


def test_surplus_envelope_donates_and_is_logged(client):
    for name, paise in [("Food", 50000), ("Shopping", 60000)]:
        cid = cat_id(client, name)
        client.post("/api/income", json={
            "amount_paise": paise, "income_date": "2026-09-01",
            "splits": [{"category_id": cid, "amount_paise": paise}]})

    p = client.post("/api/budget/plan", json=targets(client, Food=100000, Shopping=10000)).json()
    assert p["feasible"]
    assert [(m["from_name"], m["to_name"], m["amount_paise"]) for m in p["moves"]] == [
        ("Shopping", "Food", 50000)]

    assert client.post("/api/budget/apply", json=targets(client, Food=100000, Shopping=10000)).status_code == 200
    b = balances(client)
    assert b["Food"] == 100000 and b["Shopping"] == 10000
    log = client.get("/api/transfers").json()
    assert len(log) == 1 and log[0]["expense_id"] is None      # manual move, not expense-driven


def test_infeasible_targets_reported_and_blocked(client):
    cid = cat_id(client, "Food")
    client.post("/api/income", json={
        "amount_paise": 10000, "income_date": "2026-09-01",
        "splits": [{"category_id": cid, "amount_paise": 10000}]})
    p = client.post("/api/budget/plan", json=targets(client, Food=100000)).json()
    assert not p["feasible"] and p["short_paise"] == 90000

    r = client.post("/api/budget/apply", json=targets(client, Food=100000))
    assert r.status_code == 422
    assert balances(client)["Food"] == 10000                   # untouched


def test_unknown_category_rejected(client):
    r = client.post("/api/budget/plan", json={"targets": [{"category_id": 999, "amount_paise": 1}]})
    assert r.status_code == 422


def test_plan_prefers_explicit_surplus_then_unallocated():
    balances_ = {
        1: {"balance_paise": 0, "pain_weight": 3},       # Food: needs money
        2: {"balance_paise": 40000, "pain_weight": 2},   # Travel: surplus 20000, pain 2
        3: {"balance_paise": 40000, "pain_weight": 1},   # Shopping: surplus 10000, pain 1
    }
    # Food needs 45000: donor surpluses first (lowest pain), Unallocated tops up.
    moves, short = plan_budget_set({1: 45000, 2: 20000, 3: 30000}, balances_, 15000)
    assert short == 0
    assert [(m.from_category_id, m.to_category_id, m.amount_paise) for m in moves] == [
        (3, 1, 10000), (2, 1, 20000), (None, 1, 15000)]
