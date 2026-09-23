import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Single configurable location for the whole app's data (SQLite file).
DEFAULT_DB_PATH = str(ROOT / "data" / "expenses.db")


def db_path() -> str:
    return os.environ.get("EXPENSE_DB_PATH", DEFAULT_DB_PATH)
