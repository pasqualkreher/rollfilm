"""Minimal Immich API client (asset upload + connection check).

Uses only the standard library so the integration works without adding a
runtime HTTP dependency / rebuilding the backend image. Immich's asset upload
is a plain multipart/form-data POST with an ``x-api-key`` header, which is
small enough to hand-roll here.
"""

import json
import mimetypes
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

_UPLOAD_TIMEOUT_S = 120
_CHECK_TIMEOUT_S = 15


def _ensure_aware(dt: datetime) -> datetime:
    """Immich requires an ISO-8601 datetime *with* a timezone offset. EXIF
    capture times are naive (no zone), so assume UTC for those rather than let
    Immich reject the upload with a validation error."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _api_url(base_url: str, path: str) -> str:
    """Join the user-entered server URL with an API path, tolerating a trailing
    slash and/or an already-included ``/api`` suffix."""
    root = base_url.strip().rstrip("/")
    if root.endswith("/api"):
        root = root[: -len("/api")]
    return f"{root}/api/{path.lstrip('/')}"


def _encode_multipart(
    fields: dict[str, str], file_field: str, filename: str, file_bytes: bytes, content_type: str
) -> tuple[bytes, str]:
    boundary = "----photomanager" + uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        parts.append(b"")
        parts.append(str(value).encode())
    parts.append(f"--{boundary}".encode())
    parts.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
    )
    parts.append(f"Content-Type: {content_type}".encode())
    parts.append(b"")
    parts.append(file_bytes)
    parts.append(f"--{boundary}--".encode())
    parts.append(b"")
    return b"\r\n".join(parts), boundary


def check_connection(base_url: str, api_key: str) -> tuple[bool, str]:
    """Validate the server URL + API key by hitting the authenticated
    ``/api/users/me`` endpoint. Returns (ok, human-readable message)."""
    req = urllib.request.Request(
        _api_url(base_url, "users/me"),
        headers={"x-api-key": api_key, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=_CHECK_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode())
        who = data.get("email") or data.get("name") or "Immich user"
        return True, f"Connected as {who}."
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return False, "Server reached, but the API key was rejected."
        return False, f"Server returned HTTP {exc.code}."
    except urllib.error.URLError as exc:
        return False, f"Could not reach the server: {exc.reason}."
    except Exception as exc:  # noqa: BLE001 - surface anything else as a message
        return False, f"Connection failed: {exc}"


def upload_asset(
    base_url: str,
    api_key: str,
    file_path: Path,
    file_created_at: datetime | None = None,
) -> str:
    """Upload a single file to Immich (POST /api/assets). Returns the status
    Immich reports ("created" or "duplicate"). Raises on transport/HTTP errors
    so the caller can log per-file failures.

    Sends exactly the fields in the current AssetMediaCreateDto (assetData,
    fileCreatedAt, fileModifiedAt required); Immich does its own server-side
    duplicate detection by checksum, so no device asset id is needed."""
    file_bytes = file_path.read_bytes()
    stat = file_path.stat()
    created = _ensure_aware(file_created_at or datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc))
    modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"

    fields = {
        "fileCreatedAt": created.isoformat(),
        "fileModifiedAt": modified.isoformat(),
        "isFavorite": "false",
    }
    body, boundary = _encode_multipart(fields, "assetData", file_path.name, file_bytes, content_type)

    req = urllib.request.Request(
        _api_url(base_url, "assets"),
        data=body,
        headers={
            "x-api-key": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_UPLOAD_TIMEOUT_S) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        # Surface Immich's own error body (e.g. which field failed validation)
        # instead of a bare "HTTP 400", so failures are actually diagnosable.
        detail = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Immich rejected {file_path.name}: HTTP {exc.code} {detail}") from exc
    return payload.get("status", "unknown")
