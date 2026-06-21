"""Unit tests for NWS alert message formatting."""
from __future__ import annotations

from custom_components.home_weather.tts_notifications import (
    format_nws_alert_description,
    format_nws_alert_for_tts,
)

RIP_CURRENT = """
* WHAT...Dangerous rip currents expected.

* WHERE...Kings (Brooklyn), Southwest Suffolk, Southern Queens and Southern Nassau Counties.

* WHEN...From Monday afternoon through Monday evening.

* IMPACTS...Life threatening rip currents are likely for all people entering the surf zone.
"""


def test_format_nws_alert_description_strips_bullets_and_ellipses():
    result = format_nws_alert_description(RIP_CURRENT)
    assert "*" not in result
    assert "..." not in result
    assert "What: Dangerous rip currents expected." in result
    assert "Where: Kings (Brooklyn)" in result
    assert "When: From Monday afternoon through Monday evening." in result
    assert "Impacts: Life threatening rip currents" in result


def test_format_nws_alert_for_tts_includes_event_and_readable_body():
    result = format_nws_alert_for_tts(
        {"event": "Rip Current Statement", "description": RIP_CURRENT}
    )
    assert result.startswith("National Weather Service Rip Current Statement.")
    assert "What: Dangerous rip currents expected." in result
    assert "*" not in result


def test_format_nws_alert_description_empty_input():
    assert format_nws_alert_description("") == ""
    assert format_nws_alert_for_tts({"event": "Test Alert"}) == (
        "National Weather Service Test Alert."
    )
