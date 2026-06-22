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

SVR_WARNING = """
SVROKX The National Weather Service in Upton NY has issued a

* Severe Thunderstorm Warning for Southwest Suffolk and Southern Nassau Counties.

* Until 345 PM EDT.

* At 259 PM EDT, a severe thunderstorm was located near Levittown, moving east at 35 mph.

HAZARD...60 mph wind gusts and penny size hail.

&&
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


def test_parse_svr_warning_skips_vtec_preamble():
    result = parse_nws_alert_description(SVR_WARNING)
    assert result["what"] is not None
    assert "has issued a" not in (result["what"] or "")
    assert "SVROKX" not in (result["what"] or "")
    assert "Severe Thunderstorm Warning" in (result["what"] or "")
    assert result["additional"] is not None
    assert "259 PM EDT" in result["additional"]


def test_format_svr_warning_tts_uses_substantive_text():
    result = format_nws_alert_for_tts(
        {
            "event": "Severe Thunderstorm Warning",
            "description": SVR_WARNING,
            "headline": (
                "Severe Thunderstorm Warning issued June 22 at 2:59 PM EDT "
                "until 3:45 PM EDT by NWS Upton NY"
            ),
        }
    )
    assert "has issued a" not in result
    assert "SVROKX" not in result
    assert "Severe Thunderstorm Warning" in result
    assert "259 PM EDT" in result or "Levittown" in result
