"""Send a file straight to object storage in parts, to URLs the control plane signed.

The control plane opens a multipart upload and signs one URL per part
(``partSizeBytes`` each, the last one shorter); this module PUTs each part's
bytes from disk and returns the part ETags the control plane needs to close
the upload. Nothing holds more than a few parts in memory at once.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Final

import httpx

if TYPE_CHECKING:
    from pathlib import Path

PART_CONCURRENCY: Final = 4
PART_ATTEMPTS: Final = 3
PART_TIMEOUT_SECONDS: Final = 600.0


class DirectUploadError(Exception):
    """A part could not be stored."""


def _read_part(path: Path, offset: int, length: int) -> bytes:
    with path.open("rb") as handle:
        handle.seek(offset)
        return handle.read(length)


async def put_parts(
    http: httpx.AsyncClient,
    path: Path,
    size_bytes: int,
    parts: list[dict[str, Any]],
    part_size_bytes: int,
    *,
    concurrency: int = PART_CONCURRENCY,
    attempts: int = PART_ATTEMPTS,
    retry_delay_seconds: float = 1.0,
) -> list[dict[str, Any]]:
    """PUT every part of ``path`` to its signed URL; returns ``[{partNumber, etag}]``."""
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def send(part: dict[str, Any]) -> dict[str, Any]:
        number = int(part["partNumber"])
        offset = (number - 1) * part_size_bytes
        length = max(0, min(part_size_bytes, size_bytes - offset))
        async with semaphore:
            body = await asyncio.to_thread(_read_part, path, offset, length)
            last_error: Exception | None = None
            for attempt in range(1, attempts + 1):
                try:
                    response = await http.put(
                        str(part["url"]), content=body, timeout=PART_TIMEOUT_SECONDS
                    )
                    if response.status_code >= 400:
                        raise DirectUploadError(
                            f"storage answered {response.status_code}: {response.text[:300]}"
                        )
                    etag = response.headers.get("etag")
                    if not etag:
                        raise DirectUploadError("storage answered without an ETag")
                    return {"partNumber": number, "etag": etag}
                except (httpx.HTTPError, DirectUploadError) as error:
                    last_error = error
                    if attempt < attempts:
                        await asyncio.sleep(retry_delay_seconds * attempt)
            raise DirectUploadError(f"part {number} failed: {last_error}")

    try:
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(send(part)) for part in parts]
    except* (DirectUploadError, OSError) as failures:
        first = failures.exceptions[0]
        raise (
            first if isinstance(first, DirectUploadError) else DirectUploadError(str(first))
        ) from None
    return [task.result() for task in tasks]
