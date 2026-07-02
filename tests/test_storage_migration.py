"""Unit tests for config storage migration to monitoring blocks."""
from __future__ import annotations

from custom_components.home_weather.config_migration import migrate_config
from custom_components.home_weather.const import DEFAULT_CONFIG


def test_migration_seeds_hurricane_monitoring_from_tropical_alerts():
    raw = {
        "tropical_alerts": {
            "max_distance_miles": 300,
            "min_threat_level": "watch",
        },
    }
    merged = migrate_config(raw)
    assert merged["hurricane_monitoring"]["max_distance_miles"] == 300
    assert merged["hurricane_monitoring"]["min_threat_level"] == "watch"
    assert merged["hurricane_monitoring"]["enabled"] is True


def test_migration_seeds_tornado_monitoring_from_tornado_alerts():
    raw = {
        "tornado_alerts": {
            "only_affecting_home": False,
            "max_distance_miles": 50,
        },
    }
    merged = migrate_config(raw)
    assert merged["tornado_monitoring"]["only_affecting_home"] is False
    assert merged["tornado_monitoring"]["max_distance_miles"] == 50


def test_migration_seeds_earthquake_monitoring_from_legacy_earthquakes():
    raw = {
        "earthquakes": {
            "enabled": False,
            "min_magnitude": 3.0,
            "radius_miles": 200,
        },
    }
    merged = migrate_config(raw)
    assert merged["earthquake_monitoring"]["enabled"] is False
    assert merged["earthquake_monitoring"]["min_magnitude"] == 3.0
    assert merged["earthquake_monitoring"]["radius_miles"] == 200


def test_migration_seeds_lightning_monitoring_from_legacy_lightning():
    raw = {
        "lightning": {
            "show_on_map": False,
            "geofield_radius_miles": 75,
        },
    }
    merged = migrate_config(raw)
    assert merged["lightning_monitoring"]["show_on_map"] is False
    assert merged["lightning_monitoring"]["geofield_radius_miles"] == 75
    assert merged["lightning_monitoring"]["enabled"] is True


def test_migration_preserves_explicit_monitoring_blocks():
    raw = {
        "hurricane_monitoring": {"enabled": False, "max_distance_miles": 100, "min_threat_level": "high"},
        "lightning_monitoring": {"enabled": False, "show_on_map": True},
    }
    merged = migrate_config(raw)
    assert merged["hurricane_monitoring"]["enabled"] is False
    assert merged["hurricane_monitoring"]["min_threat_level"] == "high"
    assert merged["lightning_monitoring"]["enabled"] is False


def test_migration_merges_all_default_keys():
    merged = migrate_config({})
    for key in DEFAULT_CONFIG:
        assert key in merged


def test_migration_seeds_alert_thresholds_into_monitoring():
    """Legacy per-alert thresholds move into the monitoring blocks."""
    raw = {
        "earthquake_monitoring": {"enabled": True},
        "earthquake_alerts": {"min_magnitude": 5.5},
        "volcano_monitoring": {"enabled": True},
        "volcano_alerts": {"min_alert_level": "warning"},
        "hurricane_monitoring": {"enabled": True},
        "tropical_alerts": {"outlook_min_probability": 70},
    }
    merged = migrate_config(raw)
    assert merged["earthquake_monitoring"]["min_magnitude"] == 5.5
    assert merged["volcano_monitoring"]["min_alert_level"] == "warning"
    assert merged["hurricane_monitoring"]["outlook_min_probability"] == 70


def test_migration_defaults_alert_zone_mode_from_zone_mode():
    raw = {
        "earthquake_monitoring": {"enabled": True, "zone_mode": "all"},
        "volcano_monitoring": {"enabled": True},
    }
    merged = migrate_config(raw)
    # Adopts the sensor zone_mode when alert_zone_mode is absent.
    assert merged["earthquake_monitoring"]["alert_zone_mode"] == "all"
    assert merged["volcano_monitoring"]["alert_zone_mode"] == "zone"


def test_migration_preserves_explicit_alert_zone_mode():
    raw = {
        "earthquake_monitoring": {"enabled": True, "zone_mode": "zone", "alert_zone_mode": "all"},
    }
    merged = migrate_config(raw)
    assert merged["earthquake_monitoring"]["alert_zone_mode"] == "all"


def test_migration_explicit_monitoring_threshold_wins_over_alert():
    raw = {
        "earthquake_monitoring": {"enabled": True, "min_magnitude": 2.0},
        "earthquake_alerts": {"min_magnitude": 6.0},
    }
    merged = migrate_config(raw)
    assert merged["earthquake_monitoring"]["min_magnitude"] == 2.0
