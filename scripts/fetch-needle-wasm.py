#!/usr/bin/env python3
"""Fetch the official Cactus Needle browser runtime for browser execution."""
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "needle"
PLATFORM = "https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm"
WHISTLE = "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact"
FILES = ("needle.js", "needle.wasm", "needle.h")


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    print(f"Downloading {destination.relative_to(ROOT)}", flush=True)
    with urlopen(url) as response, partial.open("wb") as output:
        total = int(response.headers.get("Content-Length", "0"))
        copied = 0
        while block := response.read(1024 * 256):
            output.write(block)
            copied += len(block)
            if total:
                print(f"  {copied * 100 // total}%", end="\r", flush=True)
    partial.replace(destination)
    print(f"  saved ({destination.stat().st_size:,} bytes)")


def main() -> None:
    for name in FILES:
        download(f"{PLATFORM}/{name}", PUBLIC / name)
    download(WHISTLE, PUBLIC / "whistle.cact")


if __name__ == "__main__":
    main()
