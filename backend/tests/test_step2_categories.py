import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def get_cat(client, name):
    cats = client.get("/api/categories", params={"include_archived": True}).json()
    return next(c for c in cats if c["name"] == name)


def test_seed_on_first_run(client):
    cats = client.get("/api/categories").json()
    assert [c["name"] for c in cats] == ["Food", "Travel", "Shopping", "Savings"]
    savings = get_cat(client, "Savings")
    assert savings["type"] == "locked"
    assert savings["pain_weight"] == 10


def test_no_reseed_after_archive(tmp_path):
    path = str(tmp_path / "test.db")
    with TestClient(create_app(path)) as c:
        cid = get_cat(c, "Food")["id"]
        assert c.post(f"/api/categories/{cid}/archive").status_code == 200
    # Restart: seeding must not resurrect the archived default.
    with TestClient(create_app(path)) as c:
        assert all(x["name"] != "Food" for x in c.get("/api/categories").json())


def test_create_duplicate_and_validation(client):
    body = {"name": "Movies", "type": "flexible", "flexibility": 50, "pain_weight": 4}
    r = client.post("/api/categories", json=body)
    assert r.status_code == 201
    assert r.json()["archived"] is False
    assert client.post("/api/categories", json={**body, "name": "movies"}).status_code == 409
    assert client.post("/api/categories", json={**body, "flexibility": 101}).status_code == 422
    assert client.post("/api/categories", json={**body, "pain_weight": 0}).status_code == 422
    assert client.post("/api/categories", json={**body, "type": "semi-locked"}).status_code == 422


def test_update(client):
    cid = get_cat(client, "Shopping")["id"]
    r = client.put(f"/api/categories/{cid}", json={"name": "Clothes", "type": "locked"})
    assert r.status_code == 200
    assert r.json()["name"] == "Clothes" and r.json()["type"] == "locked"
    assert client.put("/api/categories/9999", json={"name": "X"}).status_code == 404


def test_archive_preserves_history_and_frees_name(client):
    cid = get_cat(client, "Travel")["id"]
    conn = sqlite3.connect(str(client.app.state.db_path))
    conn.execute(
        "INSERT INTO expenses (category_id, amount_paise, expense_date, created_at)"
        " VALUES (?, 150000, '2026-09-20', '2026-09-20T10:00:00+00:00')",
        (cid,),
    )
    conn.commit()
    conn.close()

    assert client.post(f"/api/categories/{cid}/archive").json()["archived"] is True
    assert all(c["name"] != "Travel" for c in client.get("/api/categories").json())
    archived = [c for c in client.get("/api/categories", params={"include_archived": True}).json()
                if c["name"] == "Travel"]
    assert archived and archived[0]["id"] == cid
    # History untouched.
    conn = sqlite3.connect(str(client.app.state.db_path))
    assert conn.execute("SELECT SUM(amount_paise) FROM expenses WHERE category_id = ?", (cid,)).fetchone()[0] == 150000
    conn.close()
    # Name is reusable once archived...
    r = client.post("/api/categories", json={"name": "Travel", "type": "flexible",
                                             "flexibility": 30, "pain_weight": 2})
    assert r.status_code == 201
    # ...but unarchiving then collides.
    assert client.post(f"/api/categories/{cid}/unarchive").status_code == 409
    new_id = r.json()["id"]
    assert client.delete(f"/api/categories/{new_id}").status_code == 405  # no delete route
    assert client.post(f"/api/categories/{new_id}/archive").status_code == 200
    assert client.post(f"/api/categories/{cid}/unarchive").json()["archived"] is False
