#!/usr/bin/env python3
"""Convert NWS alert sound files from MP3 to WAV for Home Assistant media_source playback.

Requires ffmpeg on PATH.

Usage:
  python scripts/convert_alert_sounds.py path/to/sounds
  python scripts/convert_alert_sounds.py path/to/weather-warning.mp3
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def convert_file(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-acodec",
        "pcm_s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(dest),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert alert sounds to WAV")
    parser.add_argument(
        "paths",
        nargs="+",
        help="File or directory containing .mp3/.ogg alert sounds",
    )
    args = parser.parse_args()

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found on PATH", file=sys.stderr)
        return 1

    sources: list[Path] = []
    for raw in args.paths:
        path = Path(raw)
        if path.is_dir():
            sources.extend(
                p for p in path.iterdir()
                if p.is_file() and p.suffix.lower() in {".mp3", ".ogg", ".flac"}
            )
        elif path.is_file():
            sources.append(path)

    if not sources:
        print("No audio files found to convert", file=sys.stderr)
        return 1

    for src in sources:
        dest = src.with_suffix(".wav")
        print(f"Converting {src.name} -> {dest.name}")
        try:
            convert_file(src, dest)
        except subprocess.CalledProcessError as err:
            print(f"Failed to convert {src}: {err.stderr.decode(errors='ignore')}", file=sys.stderr)
            return 1

    print(f"Converted {len(sources)} file(s). Copy .wav files to config/media/home_weather/sounds/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
