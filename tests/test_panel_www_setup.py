"""Tests for panel www asset sync."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from custom_components.home_weather.panel_www_setup import (
    PANEL_JS_FILES,
    ensure_panel_www_assets,
    get_bundle_www_dir,
)


def test_ensure_panel_www_assets_copies_js_on_version_change(tmp_path, monkeypatch):
    hass = MagicMock()
    hass.config.path.return_value = str(tmp_path)

    bundle = get_bundle_www_dir()
    for name in PANEL_JS_FILES:
        assert (bundle / name).is_file(), f"missing bundle file {name}"

    ensure_panel_www_assets(hass, "1.0.26")

    target = tmp_path / "home_weather"
    for name in PANEL_JS_FILES:
        copied = target / name
        assert copied.is_file()
        assert copied.read_text(encoding="utf-8") == (bundle / name).read_text(encoding="utf-8")

    marker = target / ".panel-version"
    assert marker.read_text(encoding="utf-8") == "1.0.26"

    # Same version should not rewrite files unnecessarily (no error on second call).
    ensure_panel_www_assets(hass, "1.0.26")
    assert marker.read_text(encoding="utf-8") == "1.0.26"


def test_ensure_panel_www_assets_upgrades_on_new_version(tmp_path):
    hass = MagicMock()
    hass.config.path.return_value = str(tmp_path)

    target = tmp_path / "home_weather"
    target.mkdir(parents=True)
    (target / ".panel-version").write_text("1.0.0", encoding="utf-8")
    stale = target / "weather-panel.js"
    stale.write_text("old panel", encoding="utf-8")

    ensure_panel_www_assets(hass, "1.0.26")

    assert "old panel" not in stale.read_text(encoding="utf-8")
    assert (target / ".panel-version").read_text(encoding="utf-8") == "1.0.26"
