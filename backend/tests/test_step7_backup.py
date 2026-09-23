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


def seed_state(client):
    cid = cat_id(client, "Food")
    client.post("/api/income", json={
        "amount_paise": 100000, "income_date": "2026-09-01",
        "splits": [{"category_id": cid, "percent": 80}]})
    client.post("/api/split-templates", json={
        "name": "Monthly", "items": [{"category_id": cid, "percent": 70}]})
    r = client.post("/api/expenses", json={
        "category_id": cid, "amount_paise": 20000, "description": "groceries",
        "expense_date": "2026-09-02"}).json()
    return r


def test_backup_roundtrip(client):
    seed_state(client)
    snapshot = client.get("/api/backup").json()
    assert snapshot["app"] == "expense-tracker" and snapshot["schema_version"] == 1
    assert len(snapshot["tables"]["categories"]) == 4

    # Wipe by restoring an empty backup, then restore the snapshot.
    empty = {**snapshot, "tables": {t: [] for t in snapshot["tables"]}}
    client.post("/api/restore", json=empty)
    assert client.get("/api/budget").json()["categories"] == []
    assert client.get("/api/income").json() == []

    r = client.post("/api/restore", json=snapshot)
    assert r.status_code == 200
    assert r.json()["restored"]["categories"] == 4
    budget = client.get("/api/budget").json()
    food = next(c for c in budget["categories"] if c["name"] == "Food")
    assert food["balance_paise"] == 80000 - 20000
    assert budget["total_income_paise"] == 100000
    assert client.get("/api/expenses").json()[0]["description"] == "groceries"
    assert client.get("/api/split-templates").json()[0]["name"] == "Monthly"


def test_restore_rejects_garbage(client):
    assert client.post("/api/restore", json={"app": "photos"}).status_code == 422
    assert client.post("/api/restore", json={
        "app": "expense-tracker", "schema_version": 99, "tables": {}}).status_code == 422
    assert client.post("/api/restore", json={
        "app": "expense-tracker", "schema_version": 1, "tables": {"categories": []}}).status_code == 422
    bad = client.get("/api/backup").json()
    bad["tables"]["categories"] = [{"id": 1, "name": "X", "evil_col": 1}]
    assert client.post("/api/restore", json=bad).status_code == 422


def test_restore_failure_leaves_database_intact(client):
    seed_state(client)
    good = client.get("/api/backup").json()
    bad = client.get("/api/backup").json()
    # income_allocations referencing a nonexistent category -> FK failure mid-restore
    bad["tables"]["income_allocations"].append(
        {"id": 999, "income_id": 1, "category_id": 777, "amount_paise": 1})
    assert client.post("/api/restore", json=bad).status_code == 422
    assert client.get("/api/backup").json()["tables"] == good["tables"]
