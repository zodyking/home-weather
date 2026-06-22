"""Unit tests for tornado geospatial helpers."""
from __future__ import annotations

from custom_components.home_weather.tornado_geo import (
    distance_to_polygon,
    normalize_geojson_geometry,
    point_in_polygon,
    polygon_centroid,
)

SAMPLE_POLYGON = {
    "type": "Polygon",
    "coordinates": [
        [
            [-96.5, 35.0],
            [-96.0, 35.5],
            [-95.5, 35.0],
            [-96.0, 34.5],
            [-96.5, 35.0],
        ]
    ],
}

SAMPLE_MULTIPOLYGON = {
    "type": "MultiPolygon",
    "coordinates": [
        [
            [
                [-96.5, 35.0],
                [-96.0, 35.5],
                [-95.5, 35.0],
                [-96.5, 35.0],
            ]
        ],
        [
            [
                [-94.0, 34.0],
                [-93.5, 34.5],
                [-93.0, 34.0],
                [-94.0, 34.0],
            ]
        ],
    ],
}


def test_point_inside_polygon():
    assert point_in_polygon(35.1, -96.1, SAMPLE_POLYGON) is True


def test_point_not_inside_polygon():
    assert point_in_polygon(36.0, -96.0, SAMPLE_POLYGON) is False


def test_multipolygon_contains_point():
    assert point_in_polygon(34.1, -93.5, SAMPLE_MULTIPOLYGON) is True


def test_distance_to_polygon_inside_is_zero():
    assert distance_to_polygon(35.1, -96.1, SAMPLE_POLYGON) == 0.0


def test_distance_to_polygon_outside_is_positive():
    dist = distance_to_polygon(36.5, -96.0, SAMPLE_POLYGON)
    assert dist is not None
    assert dist > 50


def test_polygon_centroid():
    centroid = polygon_centroid(SAMPLE_POLYGON)
    assert centroid is not None
    assert 34.5 < centroid["lat"] < 35.5
    assert -97.0 < centroid["lon"] < -95.0


def test_normalize_geojson_geometry_polygon():
    normalized = normalize_geojson_geometry(SAMPLE_POLYGON)
    assert normalized is not None
    assert normalized["type"] == "Polygon"


def test_normalize_geojson_geometry_multipolygon():
    normalized = normalize_geojson_geometry(SAMPLE_MULTIPOLYGON)
    assert normalized is not None
    assert normalized["type"] == "MultiPolygon"


def test_normalize_geojson_geometry_rejects_invalid():
    assert normalize_geojson_geometry(None) is None
    assert normalize_geojson_geometry({"type": "Point", "coordinates": [0, 0]}) is None
    assert normalize_geojson_geometry({"type": "Polygon", "coordinates": []}) is None
