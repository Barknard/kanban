#!/usr/bin/env python3
"""Generate Simple Kanban's PWA icon set from the animated logo.

The brand mark is an animated GIF, which no platform accepts as an app icon, so a
single representative frame is exported at each required size.

Run from the repo root:  python tools/make-icons.py
"""
import os
import pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "simple-kanban-logo.gif"
BG = (15, 15, 30, 255)  # --gm-bg from the stylesheet, so the icon matches the app

# The logo's starbursts peak mid-animation; frame 0 is comparatively flat.
FRAME = 9


def base() -> Image.Image:
    im = Image.open(SRC)
    im.seek(min(FRAME, im.n_frames - 1))
    return im.convert("RGB")


def render(size: int, scale: float = 1.0) -> Image.Image:
    """`scale` < 1 insets the art for the maskable variant's safe zone."""
    canvas = Image.new("RGBA", (size, size), BG)
    inner = int(size * scale)
    art = base().resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(art, (offset, offset))
    return canvas


def main() -> None:
    outputs = {
        "icon-192.png": render(192),
        "icon-512.png": render(512),
        "apple-touch-icon.png": render(180),
        # Launchers crop maskable icons to a circle inside the middle 80%.
        "icon-maskable-512.png": render(512, scale=0.62),
        "favicon.png": render(64),
    }
    for name, img in outputs.items():
        path = ROOT / name
        img.convert("RGB").save(path, optimize=True)
        print(f"  {name:26} {os.path.getsize(path) / 1024:6.1f} KB")


if __name__ == "__main__":
    main()
