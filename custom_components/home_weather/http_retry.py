"""Resilient HTTP client with retry logic and caching for Home Weather.

Provides exponential backoff retry logic for external API calls to handle
transient network failures gracefully.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiohttp import ClientSession, ClientError, ClientResponseError
from aiohttp.client import ClientTimeout

_LOGGER = logging.getLogger(__name__)

# Default retry configuration
DEFAULT_RETRIES = 3
DEFAULT_TIMEOUT = 30
DEFAULT_BACKOFF_BASE = 1.0  # seconds
DEFAULT_BACKOFF_MAX = 8.0  # seconds


class FetchError(Exception):
    """Raised when all retry attempts fail."""

    def __init__(self, message: str, last_error: Exception | None = None):
        super().__init__(message)
        self.last_error = last_error


async def fetch_with_retry(
    session: ClientSession,
    url: str,
    *,
    retries: int = DEFAULT_RETRIES,
    timeout: int = DEFAULT_TIMEOUT,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    response_type: str = "json",
    fallback: Any = None,
    source_name: str = "",
) -> tuple[Any, bool]:
    """Fetch a URL with retry logic and exponential backoff.

    Args:
        session: aiohttp ClientSession to use
        url: URL to fetch
        retries: Number of retry attempts (default: 3)
        timeout: Request timeout in seconds (default: 30)
        headers: Optional HTTP headers
        params: Optional query parameters
        response_type: "json" or "text" (default: "json")
        fallback: Value to return if all retries fail (default: None)
        source_name: Name for logging (e.g., "USGS earthquake")

    Returns:
        Tuple of (data, from_fallback) where from_fallback indicates if
        the fallback value was used due to fetch failure.
    """
    last_error: Exception | None = None
    log_name = source_name or url

    for attempt in range(retries):
        try:
            client_timeout = ClientTimeout(total=timeout)
            async with session.get(
                url,
                headers=headers,
                params=params,
                timeout=client_timeout,
            ) as resp:
                if resp.status == 200:
                    if response_type == "text":
                        data = await resp.text()
                    else:
                        data = await resp.json()
                    if attempt > 0:
                        _LOGGER.info(
                            "%s fetch succeeded on attempt %d", log_name, attempt + 1
                        )
                    return data, False

                # Non-200 status - log and retry
                _LOGGER.warning(
                    "%s returned HTTP %d (attempt %d/%d)",
                    log_name, resp.status, attempt + 1, retries
                )
                last_error = ClientResponseError(
                    resp.request_info,
                    resp.history,
                    status=resp.status,
                )

        except asyncio.TimeoutError as err:
            _LOGGER.warning(
                "%s timed out after %ds (attempt %d/%d)",
                log_name, timeout, attempt + 1, retries
            )
            last_error = err

        except ClientError as err:
            _LOGGER.warning(
                "%s fetch failed: %s (attempt %d/%d)",
                log_name, err, attempt + 1, retries
            )
            last_error = err

        except Exception as err:
            _LOGGER.warning(
                "%s unexpected error: %s (attempt %d/%d)",
                log_name, err, attempt + 1, retries
            )
            last_error = err

        # Exponential backoff before retry (except on last attempt)
        if attempt < retries - 1:
            delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
            _LOGGER.debug("%s retrying in %.1fs...", log_name, delay)
            await asyncio.sleep(delay)

    # All retries exhausted
    if fallback is not None:
        _LOGGER.warning(
            "%s all %d attempts failed, using fallback value", log_name, retries
        )
        return fallback, True

    raise FetchError(
        f"{log_name} fetch failed after {retries} attempts",
        last_error=last_error,
    )


async def fetch_json_with_retry(
    session: ClientSession,
    url: str,
    *,
    retries: int = DEFAULT_RETRIES,
    timeout: int = DEFAULT_TIMEOUT,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    fallback: Any = None,
    source_name: str = "",
) -> tuple[Any, bool]:
    """Convenience wrapper for JSON fetches with retry."""
    return await fetch_with_retry(
        session,
        url,
        retries=retries,
        timeout=timeout,
        headers=headers,
        params=params,
        response_type="json",
        fallback=fallback,
        source_name=source_name,
    )


async def fetch_text_with_retry(
    session: ClientSession,
    url: str,
    *,
    retries: int = DEFAULT_RETRIES,
    timeout: int = DEFAULT_TIMEOUT,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    fallback: str = "",
    source_name: str = "",
) -> tuple[str, bool]:
    """Convenience wrapper for text fetches with retry."""
    return await fetch_with_retry(
        session,
        url,
        retries=retries,
        timeout=timeout,
        headers=headers,
        params=params,
        response_type="text",
        fallback=fallback,
        source_name=source_name,
    )
