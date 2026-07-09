from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import albums, images, import_, maintenance, search, settings, tags
from app.db.session import engine
from app.services.embeddings import ensure_embeddings_table

app = FastAPI(title="Photo Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(images.router)
app.include_router(albums.router)
app.include_router(import_.router)
app.include_router(search.router)
app.include_router(maintenance.router)
app.include_router(settings.router)
app.include_router(tags.router)


@app.on_event("startup")
def on_startup() -> None:
    # Table schema lives in Alembic migrations; the sqlite-vec virtual table
    # is bootstrapped here since it isn't a normal SQLAlchemy-managed table.
    ensure_embeddings_table(engine)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
