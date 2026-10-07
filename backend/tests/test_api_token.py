"""Only the Rollfilm app may use the API: requests without the per-launch
token are refused, preflights and streamed responses still work."""

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import security
from app.security import ApiTokenMiddleware

TOKEN = "s3cret-token"


def _app() -> FastAPI:
    # Same stack as app.main: the gate inside, CORS outside.
    app = FastAPI()
    app.add_middleware(ApiTokenMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/stream")
    def stream():
        return StreamingResponse(iter([b"a" * 1000, b"b" * 1000]), media_type="application/octet-stream")

    return app


@pytest.fixture
def client():
    security.set_api_token(TOKEN)
    yield TestClient(_app())
    security.set_api_token(None)


def test_missing_token_is_refused(client):
    res = client.get("/health")
    assert res.status_code == 401
    assert res.json() == {"detail": "Unauthorized"}


def test_wrong_token_is_refused(client):
    assert client.get("/health", headers={"X-Rollfilm-Token": "nope"}).status_code == 401
    assert client.get("/health", headers={"X-Rollfilm-Token": ""}).status_code == 401


def test_right_token_passes(client):
    res = client.get("/health", headers={"X-Rollfilm-Token": TOKEN})
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_token_in_query_is_not_enough(client):
    assert client.get(f"/health?token={TOKEN}").status_code == 401


def test_refusal_carries_cors_headers(client):
    # A cross-origin caller sees a clean 401, not an opaque CORS failure.
    res = client.get("/health", headers={"Origin": "https://example.com"})
    assert res.status_code == 401
    assert res.headers["access-control-allow-origin"] == "*"


def test_preflight_is_answered_by_cors(client):
    res = client.options(
        "/health",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
    )
    assert res.status_code == 200


def test_streaming_response_passes_through(client):
    res = client.get("/stream", headers={"X-Rollfilm-Token": TOKEN})
    assert res.status_code == 200
    assert res.content == b"a" * 1000 + b"b" * 1000


def test_locked_backend_refuses_everyone():
    security.lock_with_random_token()
    try:
        assert TestClient(_app()).get("/health", headers={"X-Rollfilm-Token": TOKEN}).status_code == 401
    finally:
        security.set_api_token(None)


def test_open_gate_when_no_token():
    security.set_api_token(None)
    assert TestClient(_app()).get("/health").status_code == 200


def test_real_app_has_the_gate_inside_cors():
    from app.main import app

    classes = [m.cls for m in app.user_middleware]
    assert classes.index(CORSMiddleware) < classes.index(ApiTokenMiddleware)
