import pytest
from fastapi.testclient import TestClient

from backend.app.db import connect, init_db
from backend.app.income_api import expand_splits
from backend.app.main import create_app
from backend.app.schemas import SplitIn


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def cat_id(client, name):
    return next(c["id"] for c in client.get("/api/categories").json() if c["name"] == name)


def test_split_by_amount_leftover_goes_to_unallocated(client):
    food, travel = cat_id(client, "Food"), cat_id(client, "Travel")
    r = client.post(
        "/api/income",
        json={
            "amount_paise": 100000,
            "income_date": "2026-09-01",
            "note": "sept pocket money",
            "splits": [
                {"category_id": food, "amount_paise": 50000},
                {"category_id": travel, "amount_paise": 20000},
            ],
        },
    )
    assert r.status_code == 201
    out = r.json()
    assert out["unallocated_paise"] == 30000  # leftover
    assert sum(s["amount_paise"] for s in out["splits"]) + out["unallocated_paise"] == 100000
    assert [s["category_name"] for s in out["splits"]] == ["Food", "Travel"]


def test_split_by_percent_floors_and_never_overshoots(client):
    food = cat_id(client, "Food")
    r = client.post(
        "/api/income",
        json={
            "amount_paise": 99999,
            "income_date": "2026-09-01",
            "splits": [{"category_id": food, "percent": 33.3}],
        },
    )
    out = r.json()
    assert out["splits"][0]["amount_paise"] == 33299  # floor(99999 * 33.3 / 100)
    assert out["unallocated_paise"] == 99999 - 33299


def test_split_must_not_exceed_income(client):
    food = cat_id(client, "Food")
    r = client.post(
        "/api/income",
        json={
            "amount_paise": 10000,
            "income_date": "2026-09-01",
            "splits": [{"category_id": food, "amount_paise": 10001}],
        },
    )
    assert r.status_code == 422
    assert client.get("/api/income").json() == []  # nothing persisted


def test_split_validation_rejects_bad_input(client):
    food = cat_id(client, "Food")
    arch = client.post("/api/categories", json={
        "name": "Old", "type": "flexible", "flexibility": 10, "pain_weight": 5}).json()["id"]
    client.post(f"/api/categories/{arch}/archive")
    base = {"amount_paise": 10000, "income_date": "2026-09-01"}
    assert client.post("/api/income", json={**base, "splits": [
        {"category_id": food, "amount_paise": 5000, "percent": 50}]}).status_code == 422
    assert client.post("/api/income", json={**base, "splits": [
        {"category_id": 999999, "amount_paise": 100}]}).status_code == 422
    assert client.post("/api/income", json={**base, "splits": [
        {"category_id": arch, "amount_paise": 100}]}).status_code == 422
    assert client.post("/api/income", json={**base, "amount_paise": 0}).status_code == 422


def test_explicit_unallocated_split_row_allowed(client):
    food = cat_id(client, "Food")
    r = client.post("/api/income", json={
        "amount_paise": 10000, "income_date": "2026-09-01",
        "splits": [{"category_id": None, "amount_paise": 4000},
                   {"category_id": food, "amount_paise": 6000}]})
    assert r.json()["unallocated_paise"] == 4000


def test_expand_splits_unit_sum_invariant():
    conn = connect(":memory:")
    init_db(conn)
    conn.execute("INSERT INTO categories (name, type, flexibility, pain_weight, created_at)"
                 " VALUES ('A', 'flexible', 50, 1, 'now')")
    pairs = expand_splits(conn, 100001, [
        SplitIn(category_id=1, percent=10.5), SplitIn(category_id=1, percent=4.5)])
    assert sum(a for _, a in pairs) == 100001          # rows always sum to total
    assert pairs == [(None, 100001 - 15000), (1, 15000)]  # merged + leftover
    conn.close()


def test_templates_reusable(client):
    food, travel, sav = (cat_id(client, n) for n in ("Food", "Travel", "Savings"))
    r = client.post("/api/split-templates", json={
        "name": "Monthly",
        "items": [{"category_id": food, "percent": 40},
                  {"category_id": travel, "percent": 20},
                  {"category_id": sav, "percent": 30}]})
    assert r.status_code == 201
    tid = r.json()["id"]
    assert client.post("/api/split-templates", json={
        "name": "monthly", "items": [{"category_id": food, "percent": 100}]}).status_code == 409
    assert client.post("/api/split-templates", json={
        "name": "TooMuch", "items": [{"percent": 60}, {"percent": 60}]}).status_code == 422

    r = client.post("/api/income", json={
        "amount_paise": 200000, "income_date": "2026-09-05", "template_id": tid})
    out = r.json()
    got = {s["category_name"]: s["amount_paise"] for s in out["splits"]}
    assert got == {"Food": 80000, "Travel": 40000, "Savings": 60000}
    assert out["unallocated_paise"] == 20000

    # splits + template_id together is ambiguous
    assert client.post("/api/income", json={
        "amount_paise": 100, "income_date": "2026-09-05", "template_id": tid,
        "splits": [{"category_id": food, "percent": 10}]}).status_code == 422

    assert client.delete(f"/api/split-templates/{tid}").status_code == 204
    assert client.post("/api/income", json={
        "amount_paise": 100, "income_date": "2026-09-05", "template_id": tid}).status_code == 422
