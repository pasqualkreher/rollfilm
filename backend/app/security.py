"""Only the Rollfilm app may use the API.

The desktop shell generates a secret per launch, hands it to this process on
stdin (run_server.py) and attaches it as ``X-Rollfilm-Token`` to every request
its windows and its main process make. Everything else - a web page in the
user's browser that found the port, another program on the machine - gets 401.
"""

from __future__ import annotations

import hmac
import json
import secrets

TOKEN_HEADER = b"x-rollfilm-token"

# None = gate open (tests, a source-tree backend started with PM_API_OPEN=1).
_api_token: bytes | None = None


def set_api_token(token: str | None) -> None:
    global _api_token
    _api_token = token.encode() if token else None


def lock_with_random_token() -> None:
    """A backend started without the shell's token: nobody can use it."""
    set_api_token(secrets.token_hex(32))


_UNAUTHORIZED = json.dumps({"detail": "Unauthorized"}).encode()


class ApiTokenMiddleware:
    """Plain ASGI rather than BaseHTTPMiddleware, so the streamed zip and
    export responses pass through untouched."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or _api_token is None:
            await self.app(scope, receive, send)
            return
        presented = b""
        for name, value in scope["headers"]:
            if name == TOKEN_HEADER:
                presented = value
                break
        if hmac.compare_digest(presented, _api_token):
            await self.app(scope, receive, send)
            return
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(_UNAUTHORIZED)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": _UNAUTHORIZED})
