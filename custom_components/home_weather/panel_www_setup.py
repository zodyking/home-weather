"""Sync Home Weather panel assets into config/www for /local/ serving."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

PANEL_WWW_SUBPATH = "home_weather"
PANEL_JS_FILES = (
    "weather-panel.js",
    "hurricane-tracker.js",
    "blitzortung-client.js",
    "zone-editor.js",
    "space-map.js",
    "countries.geo.json",
)
VERSION_MARKER = ".panel-version"


def get_bundle_www_dir() -> Path:
    """Return integration www bundle path."""
    return Path(__file__).parent / "www"


def get_panel_www_dir(hass: HomeAssistant) -> Path:
    """Return config/www/home_weather path (served at /local/home_weather/)."""
    return Path(hass.config.path("www")) / PANEL_WWW_SUBPATH


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.is_dir():
        return
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            if target.exists():
                _copy_tree(item, target)
            else:
                shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def ensure_panel_www_assets(hass: HomeAssistant, version: str) -> None:
    """Copy bundled panel JS and icons into config/www when the version changes."""
    bundle_dir = get_bundle_www_dir()
    target_dir = get_panel_www_dir(hass)
    marker = target_dir / VERSION_MARKER
    current = marker.read_text(encoding="utf-8").strip() if marker.exists() else ""

    if current == version:
        return

    target_dir.mkdir(parents=True, exist_ok=True)

    for name in PANEL_JS_FILES:
        src = bundle_dir / name
        if src.is_file():
            shutil.copy2(src, target_dir / name)

    icons_src = bundle_dir / "icons"
    if icons_src.is_dir():
        _copy_tree(icons_src, target_dir / "icons")

    marker.write_text(version, encoding="utf-8")
    _LOGGER.info(
        "Updated Home Weather panel assets in config/www/%s (v%s)",
        PANEL_WWW_SUBPATH,
        version,
    )
