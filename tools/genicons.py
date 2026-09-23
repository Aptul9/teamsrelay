#!/usr/bin/env python3
"""Genera le icone della PWA TeamsRelay (180/192/512 px): "T" bianca con doppia freccia su viola.

Uso:  python genicons.py webapp/static
Senza Python locale:
  docker run --rm -v "$PWD:/w" -w /w python:3.12-slim \
    sh -c "pip install -q pillow && python tools/genicons.py webapp/static"
"""
import os
import sys

from PIL import Image, ImageDraw


def lerp(a, b, t):
    return int(a + (b - a) * t)


def make(size):
    S = size * 4  # supersampling per bordi morbidi
    im = Image.new("RGB", (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    top, bot = (0x6b, 0x70, 0xdd), (0x45, 0x48, 0xa6)  # gradiente viola verticale
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=(lerp(top[0], bot[0], t), lerp(top[1], bot[1], t), lerp(top[2], bot[2], t)))
    W = (255, 255, 255)
    # "T" la cui barra orizzontale e' una doppia freccia (relay)
    barH, barX0, barX1, stemW, stemBot, barCy = 0.095, 0.255, 0.745, 0.105, 0.735, 0.345
    y0, y1 = int((barCy - barH / 2) * S), int((barCy + barH / 2) * S)
    x0, x1 = int(barX0 * S), int(barX1 * S)
    d.rounded_rectangle([x0, y0, x1, y1], radius=(y1 - y0) // 2, fill=W)
    sx0, sx1 = int((0.5 - stemW / 2) * S), int((0.5 + stemW / 2) * S)
    d.rounded_rectangle([sx0, y0, sx1, int(stemBot * S)], radius=(sx1 - sx0) // 2, fill=W)
    cy, ah, tip = (y0 + y1) // 2, int(0.088 * S), int(0.05 * S)
    d.polygon([(x0 - tip, cy), (x0 + ah, cy - ah), (x0 + ah, cy + ah)], fill=W)
    d.polygon([(x1 + tip, cy), (x1 - ah, cy - ah), (x1 - ah, cy + ah)], fill=W)
    return im.resize((size, size), Image.LANCZOS)


out = sys.argv[1] if len(sys.argv) > 1 else "webapp/static"
os.makedirs(out, exist_ok=True)
for s in (180, 192, 512):
    make(s).save(os.path.join(out, f"icon-{s}.png"))
print("icone generate in", out)
