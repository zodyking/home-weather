"""Unit tests for AI rewrite helpers."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from custom_components.home_weather.tts_notifications import (
    _build_ai_rewrite_instructions,
    _extract_ai_task_text,
    apply_ai_rewrite,
)


def test_extract_ai_task_text_from_data_string():
    assert _extract_ai_task_text({"data": "Hello world"}) == "Hello world"


def test_extract_ai_task_text_from_structured_data():
    assert _extract_ai_task_text({"data": {"text": "Structured reply"}}) == (
        "Structured reply"
    )


def test_extract_ai_task_text_legacy_keys():
    assert _extract_ai_task_text({"output": "Legacy output"}) == "Legacy output"
    assert _extract_ai_task_text({"text": "Legacy text"}) == "Legacy text"


def test_extract_ai_task_text_empty():
    assert _extract_ai_task_text({}) is None
    assert _extract_ai_task_text({"data": "   "}) is None


def test_build_ai_rewrite_instructions_includes_prompt_and_message():
    result = _build_ai_rewrite_instructions(
        "You are a meteorologist.",
        "Good morning, it is sunny.",
    )
    assert "You are a meteorologist." in result
    assert "Good morning, it is sunny." in result
    assert "Original message:" in result
    assert "no markdown" in result


def test_build_ai_rewrite_instructions_default_prompt():
    result = _build_ai_rewrite_instructions("", "Test message.")
    assert "Test message." in result
    assert "meteorologist" in result.lower()


def test_apply_ai_rewrite_calls_generate_data_with_correct_payload():
    hass = MagicMock()
    hass.services.async_call = AsyncMock(
        return_value={"data": "Rewritten forecast for today."}
    )
    hass.bus = MagicMock()
    hass.bus.async_fire = MagicMock()

    tts_config = {
        "use_ai_rewrite": True,
        "ai_task_entity": "ai_task.openai",
        "ai_rewrite_prompt": "Be conversational.",
    }
    result = asyncio.run(
        apply_ai_rewrite(hass, tts_config, "Original forecast.")
    )

    assert result == "Rewritten forecast for today."
    hass.services.async_call.assert_awaited_once()
    call_args = hass.services.async_call.await_args
    assert call_args.args[0:2] == ("ai_task", "generate_data")
    payload = call_args.args[2]
    assert payload["entity_id"] == "ai_task.openai"
    assert payload["task_name"] == "home_weather_tts_rewrite"
    assert "instructions" in payload
    assert "task_type" not in payload
    assert "input_data" not in payload
    assert "Original forecast." in payload["instructions"]


def test_apply_ai_rewrite_skipped_when_disabled():
    hass = MagicMock()
    hass.services.async_call = AsyncMock()

    result = asyncio.run(
        apply_ai_rewrite(
            hass,
            {"use_ai_rewrite": False, "ai_task_entity": "ai_task.openai"},
            "Keep me.",
        )
    )

    assert result == "Keep me."
    hass.services.async_call.assert_not_awaited()


def test_apply_ai_rewrite_falls_back_on_failure():
    hass = MagicMock()
    hass.services.async_call = AsyncMock(side_effect=RuntimeError("AI unavailable"))

    result = asyncio.run(
        apply_ai_rewrite(
            hass,
            {
                "use_ai_rewrite": True,
                "ai_task_entity": "ai_task.openai",
                "ai_rewrite_prompt": "Rewrite.",
            },
            "Original.",
        )
    )

    assert result == "Original."
