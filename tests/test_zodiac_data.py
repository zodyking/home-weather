"""Tests for zodiac forecast helpers."""
from __future__ import annotations

from datetime import date

from custom_components.home_weather.zodiac_data import (
    SEXAGENARY_CYCLE,
    build_chinese_zodiac_guidance,
    build_western_zodiac_guidance,
    build_zodiac_forecast_section,
    chinese_zodiac_year,
    western_sun_sign,
)


def test_sexagenary_cycle_has_60_unique_combinations():
    assert len(SEXAGENARY_CYCLE) == 60
    combos = {(c["element"], c["animal"]) for c in SEXAGENARY_CYCLE}
    assert len(combos) == 60


def test_western_sun_sign_leo_mid_summer():
    sign = western_sun_sign(date(2026, 7, 24))
    assert sign["name"] == "Leo"
    assert sign["theme"] == "expression"
    assert "leadership" in sign["focus"]


def test_chinese_year_includes_element_and_polarity():
    # 2026 (after LNY Feb 17) is the Fire Horse, a Yang year.
    combo = chinese_zodiac_year(date(2026, 7, 24))
    assert combo["animal"] == "Horse"
    assert combo["element"] == "Fire"
    assert combo["polarity"] == "Yang"
    assert combo["combination"] == "Fire Horse"


def test_chinese_year_known_reference_metal_rat_2020():
    combo = chinese_zodiac_year(date(2020, 6, 1))
    assert combo["combination"] == "Metal Rat"
    assert combo["polarity"] == "Yang"


def test_chinese_year_respects_lunar_new_year_boundary():
    # Before LNY 2026 we are still in the 2025 lunar year: Wood Snake (Yin).
    before = chinese_zodiac_year(date(2026, 1, 15))
    assert before["combination"] == "Wood Snake"
    assert before["polarity"] == "Yin"


def test_chinese_guidance_mentions_element_animal_polarity_and_caution():
    msg = build_chinese_zodiac_guidance(date(2026, 7, 24))
    assert "Fire Horse" in msg
    assert "Yang year" in msg
    assert "This year," in msg
    assert "Be mindful of" in msg


def test_western_guidance_mentions_theme_and_focus():
    msg = build_western_zodiac_guidance(date(2026, 7, 24))
    assert "Leo" in msg
    assert "expression" in msg
    assert "Work toward" in msg


def test_build_zodiac_forecast_section_western_only():
    msg = build_zodiac_forecast_section(
        {"include_western_zodiac": True, "include_chinese_zodiac": False},
        date(2026, 7, 24),
    )
    assert msg is not None
    assert "western zodiac" in msg
    assert "Leo" in msg
    assert "Chinese zodiac" not in msg


def test_build_zodiac_forecast_section_chinese_only():
    msg = build_zodiac_forecast_section(
        {"include_western_zodiac": False, "include_chinese_zodiac": True},
        date(2026, 7, 24),
    )
    assert msg is not None
    assert "Chinese zodiac" in msg
    assert "Fire Horse" in msg
    assert "western zodiac" not in msg


def test_build_zodiac_forecast_section_disabled():
    assert build_zodiac_forecast_section({}, date(2026, 7, 24)) is None
