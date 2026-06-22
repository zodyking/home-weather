"""Unit tests for NWS alert message formatting."""
from __future__ import annotations

from custom_components.home_weather.tts_notifications import (
    format_nws_alert_description,
    format_nws_alert_for_tts,
    parse_nws_alert_description,
)

RIP_CURRENT = """
* WHAT...Dangerous rip currents expected.

* WHERE...Kings (Brooklyn), Southwest Suffolk, Southern Queens and Southern Nassau Counties.

* WHEN...From Monday afternoon through Monday evening.

* IMPACTS...Life threatening rip currents are likely for all people entering the surf zone.
"""


def test_parse_nws_alert_description_structured_fields():
    result = parse_nws_alert_description(RIP_CURRENT)
    assert result["what"] == "Dangerous rip currents expected."
    assert "Kings (Brooklyn)" in result["where"]
    assert "Monday afternoon" in result["when"]
    assert "Life threatening rip currents" in result["impacts"]


def test_format_nws_alert_description_strips_bullets_and_ellipses():
    result = format_nws_alert_description(RIP_CURRENT)
    assert "*" not in result
    assert "..." not in result
    assert "What:" not in result
    assert "Where:" not in result
    assert "When:" not in result
    assert "Dangerous rip currents expected." in result


def test_format_nws_alert_for_tts_natural_speech():
    result = format_nws_alert_for_tts(
        {"event": "Rip Current Statement", "description": RIP_CURRENT}
    )
    assert result.startswith("National Weather Service Rip Current Statement.")
    assert "What:" not in result
    assert "Where:" not in result
    assert "When:" not in result
    assert "Dangerous rip currents expected." in result
    assert "This affects" in result or "Affecting" in result
    assert "In effect" in result
    assert "*" not in result


def test_format_nws_alert_description_empty_input():
    assert format_nws_alert_description("") == ""
    assert parse_nws_alert_description("")["what"] is None
    assert format_nws_alert_for_tts({"event": "Test Alert"}) == (
        "National Weather Service Test Alert."
    )
