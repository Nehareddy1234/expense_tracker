"""FastAPI app: JSON API under /api, built frontend served from docs/ (Step 6)."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from . import backup_api, categories_api, config, db, expenses_api, income_api


def create_app(database_path: str | None = None) -> FastAPI:
    path = database_path or config.db_path()

    def get_conn():
        """One short-lived connection per request; safe across threadpool workers."""
        conn = db.connect(path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = db.connect(path)
        db.init_db(conn)
        categories_api.seed_categories(conn)
        conn.close()
        yield

    app = FastAPI(title="Expense Tracker", lifespan=lifespan)
    app.state.db_path = path
    app.state.get_conn = get_conn

    app.include_router(categories_api.create_router(get_conn))
    app.include_router(income_api.create_router(get_conn))
    app.include_router(expenses_api.create_router(get_conn))
    app.include_router(backup_api.create_router(get_conn))

    @app.get("/api/health", dependencies=[Depends(get_conn)])
    def health():
        return {"status": "ok"}

    # Serve the built React app once it exists (npm run build -> docs/); API
    # routes are registered first so /api/* always wins.
    static_dir = Path(config.ROOT) / "docs"
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()
