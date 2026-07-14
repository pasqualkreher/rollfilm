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
) -> tuple[str, str | None]:
    """Upload a single file to Immich (POST /api/assets). Returns
    ``(status, asset_id)`` where status is what Immich reports ("created" or
    "duplicate") and asset_id is the Immich asset UUID (present for both created
    and duplicate responses, so the caller can add it to an album). Raises on
    transport/HTTP errors so the caller can log per-file failures.

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
    return payload.get("status", "unknown"), payload.get("id")


def _request_json(
    base_url: str, path: str, api_key: str, method: str, body: dict | None = None
) -> object:
    """Small JSON request helper for the album endpoints. Returns the parsed
    response (or None for empty bodies). Raises RuntimeError with Immich's own
    error body on HTTP errors."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"x-api-key": api_key, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_api_url(base_url, path), data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_CHECK_TIMEOUT_S) as resp:
            raw = resp.read().decode()
        return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Immich {method} /{path} failed: HTTP {exc.code} {detail}") from exc


def find_album_id(base_url: str, api_key: str, name: str) -> str | None:
    """The id of the Immich album with this exact name, or None. Album
    mirroring maps app albums to Immich albums by name."""
    albums = _request_json(base_url, "albums", api_key, "GET") or []
    for album in albums:
        if isinstance(album, dict) and album.get("albumName") == name:
            return album["id"]
    return None


def get_or_create_album(base_url: str, api_key: str, name: str) -> str:
    """Return the id of the Immich album with this exact name, creating it if it
    doesn't exist yet. Used to mirror an app album into Immich."""
    existing = find_album_id(base_url, api_key, name)
    if existing:
        return existing
    created = _request_json(base_url, "albums", api_key, "POST", {"albumName": name})
    if not isinstance(created, dict) or "id" not in created:
        raise RuntimeError(f"Immich did not return an album id when creating {name!r}")
    return created["id"]


def delete_album(base_url: str, api_key: str, album_id: str) -> None:
    """Delete an Immich album. Only the album is removed - its assets stay in
    the Immich timeline, mirroring how deleting an app album keeps the photos."""
    _request_json(base_url, f"albums/{album_id}", api_key, "DELETE")


def rename_album(base_url: str, api_key: str, album_id: str, new_name: str) -> None:
    _request_json(base_url, f"albums/{album_id}", api_key, "PATCH", {"albumName": new_name})


def remove_assets_from_album(
    base_url: str, api_key: str, album_id: str, asset_ids: list[str]
) -> None:
    """Take assets out of an Immich album (they stay in the timeline)."""
    ids = [a for a in asset_ids if a]
    if not ids:
        return
    _request_json(base_url, f"albums/{album_id}/assets", api_key, "DELETE", {"ids": ids})


def delete_assets(base_url: str, api_key: str, asset_ids: list[str], *, force: bool = False) -> None:
    """Delete assets from Immich (DELETE /api/assets). Without ``force`` Immich
    only moves them to its own trash - but a trashed asset still counts as a
    checksum duplicate there, which would swallow a later re-upload of the same
    photo (restore from this app's Trash). Sync callers therefore pass
    force=True; the library file remains the recoverable copy.
    Raises on transport/HTTP errors (including unknown asset ids)."""
    ids = [a for a in asset_ids if a]
    if not ids:
        return
    _request_json(base_url, "assets", api_key, "DELETE", {"ids": ids, "force": force})


def find_asset_ids_by_checksums(
    base_url: str, api_key: str, checksums: list[str]
) -> dict[str, str]:
    """Map SHA-1 hex checksums to the ids of assets already on the server, via
    POST /api/assets/bulk-upload-check (its "duplicate" verdict carries the
    existing asset's id). Checksums with no match are absent from the result.
    Used to remove photos that were synced before asset ids were recorded."""
    wanted = [c for c in checksums if c]
    if not wanted:
        return {}
    payload = _request_json(
        base_url,
        "assets/bulk-upload-check",
        api_key,
        "POST",
        {"assets": [{"id": checksum, "checksum": checksum} for checksum in wanted]},
    )
    results = payload.get("results", []) if isinstance(payload, dict) else []
    found: dict[str, str] = {}
    for result in results:
        if isinstance(result, dict) and result.get("assetId") and result.get("id"):
            found[result["id"]] = result["assetId"]
    return found


def add_assets_to_album(base_url: str, api_key: str, album_id: str, asset_ids: list[str]) -> None:
    """Add the given asset ids to an Immich album (idempotent - Immich ignores
    assets already in the album)."""
    ids = [a for a in asset_ids if a]
    if not ids:
        return
    _request_json(base_url, f"albums/{album_id}/assets", api_key, "PUT", {"ids": ids})
