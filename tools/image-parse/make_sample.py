#!/usr/bin/env python3
"""Generate samples/sample.png — a mixed zh/en poster with title / subtitle /
body / button / logo blocks, used to exercise the image-parse service.

Deterministic (no randomness) so the artefact in the repo stays stable.
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples", "sample.png")

W, H = 900, 1200

CAND_CJK = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]
CAND_CJK_LIGHT = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]
CAND_LATIN = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]


def pick(paths, index=0):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, 20, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


def font(paths, size, index=0):
    f = pick(paths, index)
    try:
        return f.font_variant(size=size)
    except Exception:
        return ImageFont.load_default()


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def main():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # ---- logo (top-left, no text: coloured mark) ----
    rounded(d, (60, 60, 200, 200), radius=28, fill=(37, 99, 235))
    d.ellipse((95, 100, 165, 170), fill=(255, 255, 255))
    d.rectangle((118, 122, 142, 148), fill=(37, 99, 235))

    # ---- title (large, centred, bold-ish) ----
    f_title = font(CAND_CJK, 58)
    title = "智能画布工作台"
    tw = d.textlength(title, font=f_title)
    d.text(((W - tw) / 2, 300), title, font=f_title, fill=(17, 24, 39))

    # ---- subtitle (medium, centred) ----
    f_sub = font(CAND_LATIN, 30)
    sub = "AI Canvas Workbench"
    sw = d.textlength(sub, font=f_sub)
    d.text(((W - sw) / 2, 392), sub, font=f_sub, fill=(107, 114, 128))

    # ---- body (left aligned, mixed zh/en, several lines) ----
    f_body = font(CAND_CJK_LIGHT, 23)
    body_lines = [
        "本服务提供版面分析与 OCR 能力。",
        "It returns typed regions with bounding boxes.",
        "每个区域包含 bbox、文本与字体估计。",
        "Feed it a screenshot, get structured layout.",
    ]
    y = 520
    for line in body_lines:
        d.text((80, y), line, font=f_body, fill=(55, 65, 81))
        y += 42

    # ---- button (filled pill + white text) ----
    btn_box = (80, 760, 340, 830)
    rounded(d, btn_box, radius=18, fill=(37, 99, 235))
    f_btn = font(CAND_CJK, 26)
    btn = "开始创作 Start"
    bw = d.textlength(btn, font=f_btn)
    d.text((80 + (260 - bw) / 2, 782), btn, font=f_btn, fill=(255, 255, 255))

    # ---- a coloured image-ish block (bottom) so an `image` region can appear ----
    rounded(d, (80, 900, 820, 1120), radius=20, fill=(16, 185, 129))

    img.save(OUT, "PNG")
    print(f"wrote {OUT} ({W}x{H})")


if __name__ == "__main__":
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    main()
