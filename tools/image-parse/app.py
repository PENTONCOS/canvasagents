#!/usr/bin/env python3
"""
image-parse — local layout-analysis + OCR HTTP service.

Contract (FROZEN — do not rename fields):
    GET  /health -> {"ok":true,"engine":"vision"|"paddle"|"tesseract","version":"0.1.0"}
    POST /parse  body {"image"?: b64, "path"?: str, "url"?: str,
                       "options"?: {"lang"?: "zh-Hans"|"en-US", "maxRegions"?: int}}
                 200 -> {"ok":true,"width":W,"height":H,"engine":E,"regions":[...],"warnings":[]}
                 region = {"id","type","bbox":{"x","y","w","h"},"text","confidence",
                           "font":{"sizePx","weight","align","familyGuess"}}

Backends (in priority order):
    1. vision    — macOS Vision via pyobjc (zero model download, native CJK)
    2. swift     — bundled `vision_ocr.swift` compiled with swiftc, called as subprocess
    3. tesseract — system `tesseract` binary, if present
    paddle       — OPTIONAL hook only (import failure => silently disabled)

Type/weight/family are HEURISTIC estimates (probabilistic), never pixel-exact.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

VERSION = "0.1.0"
DEFAULT_PORT = 17410
HERE = os.path.dirname(os.path.abspath(__file__))
SWIFT_BIN = os.path.join(HERE, "vision_ocr")

ALLOWED_TYPES = {"title", "subtitle", "body", "button", "label", "logo", "image", "unknown"}
CJK_RE = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]")

# --------------------------------------------------------------------------- #
# Backend availability probes
# --------------------------------------------------------------------------- #

def _probe_vision() -> bool:
    try:
        import Vision  # noqa: F401
        import Quartz  # noqa: F401
        return True
    except Exception:
        return False


def _probe_swift() -> bool:
    return os.path.isfile(SWIFT_BIN) and os.access(SWIFT_BIN, os.X_OK)


def _probe_tesseract() -> bool:
    return shutil.which("tesseract") is not None


def _probe_paddle() -> bool:
    """Optional hook. Import failure => disabled, never raises."""
    try:
        import paddleocr  # noqa: F401
        return True
    except Exception:
        return False


def choose_engine(preferred: Optional[str] = None) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    have = {
        "vision": _probe_vision(),
        "swift": _probe_swift(),
        "tesseract": _probe_tesseract(),
        "paddle": _probe_paddle(),
    }
    if preferred and preferred in have and have[preferred]:
        return preferred, warnings
    if preferred and preferred not in have:
        warnings.append(f"unknown engine requested: {preferred}")
    # priority chain (vision is the primary backend per spec)
    if have["vision"]:
        return "vision", warnings
    if have["swift"]:
        warnings.append("vision(pyobjc) unavailable -> falling back to swift CLI")
        return "swift", warnings
    if have["tesseract"]:
        warnings.append("vision/swift unavailable -> falling back to tesseract")
        return "tesseract", warnings
    return "none", warnings


# --------------------------------------------------------------------------- #
# Image loading: bytes -> (PIL.Image, width, height)
# --------------------------------------------------------------------------- #

def _load_pil(data: bytes):
    from PIL import Image
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def _encode_png(img) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _ensure_png_bytes(data: bytes) -> bytes:
    """Vision handlers prefer a known raster; normalise to PNG when PIL can read it."""
    try:
        img = _load_pil(data)
        return _encode_png(img)
    except Exception:
        return data


# --------------------------------------------------------------------------- #
# Raw observation model: one OCR line, px coords, origin top-left
# --------------------------------------------------------------------------- #

class Obs:
    __slots__ = ("text", "confidence", "x", "y", "w", "h")

    def __init__(self, text: str, confidence: float, x: float, y: float, w: float, h: float):
        self.text = text
        self.confidence = confidence
        self.x = x
        self.y = y
        self.w = w
        self.h = h


# --------------------------------------------------------------------------- #
# Backend: macOS Vision via pyobjc
# --------------------------------------------------------------------------- #

def vision_ocr(png_bytes: bytes, lang: List[str]) -> Tuple[int, int, List[Obs]]:
    import Quartz
    import Vision

    src = Quartz.CGImageSourceCreateWithData(png_bytes, None)
    if src is None:
        raise RuntimeError("CGImageSourceCreateWithData returned None")
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        raise RuntimeError("CGImageSourceCreateImageAtIndex returned None")
    width = int(Quartz.CGImageGetWidth(cg))
    height = int(Quartz.CGImageGetHeight(cg))

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(True)
    if lang:
        req.setRecognitionLanguages_(lang)

    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"Vision performRequests failed: {err}")

    obs: List[Obs] = []
    for o in (req.results() or []):
        cands = o.topCandidates_(1)
        if not cands:
            continue
        top = cands[0]
        text = str(top.string())
        conf = float(top.confidence())
        bb = o.boundingBox()  # normalized, origin BOTTOM-left
        x = float(bb.origin.x) * width
        # convert to top-left origin
        y = (1.0 - float(bb.origin.y) - float(bb.size.height)) * height
        w = float(bb.size.width) * width
        h = float(bb.size.height) * height
        obs.append(Obs(text, conf, x, y, w, h))
    return width, height, obs


# --------------------------------------------------------------------------- #
# Backend: bundled Swift CLI (subprocess)
# --------------------------------------------------------------------------- #

def swift_ocr(png_bytes: bytes, lang: List[str]) -> Tuple[int, int, List[Obs]]:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(png_bytes)
        tmp = f.name
    try:
        cmd = [SWIFT_BIN, tmp]
        if lang:
            cmd.append(",".join(lang))
        p = subprocess.run(cmd, capture_output=True, timeout=120)
        if p.returncode != 0:
            raise RuntimeError(f"swift CLI failed rc={p.returncode}: {p.stderr.decode('utf-8', 'replace')[:400]}")
        payload = json.loads(p.stdout.decode("utf-8"))
        obs = [
            Obs(str(o.get("text", "")), float(o.get("confidence", 0.0)),
                float(o["x"]), float(o["y"]), float(o["w"]), float(o["h"]))
            for o in payload.get("observations", [])
        ]
        return int(payload["width"]), int(payload["height"]), obs
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Backend: system tesseract (TSV, grouped into lines)
# --------------------------------------------------------------------------- #

def tesseract_ocr(png_bytes: bytes, lang: List[str]) -> Tuple[int, int, List[Obs]]:
    if not _probe_tesseract():
        raise RuntimeError("tesseract not installed")
    img = _load_pil(png_bytes)
    width, height = img.size

    tess_lang = "eng"
    if lang and any(l.lower().startswith("zh") for l in lang):
        # best effort; requires chi_sim traineddata to be installed
        tess_lang = "chi_sim+eng"

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(png_bytes)
        tmp = f.name
    try:
        p = subprocess.run(["tesseract", tmp, "stdout", "-l", tess_lang, "tsv"],
                           capture_output=True, timeout=120)
        if p.returncode != 0:
            raise RuntimeError(f"tesseract failed: {p.stderr.decode('utf-8', 'replace')[:400]}")
        lines: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        for row in p.stdout.decode("utf-8", "replace").splitlines()[1:]:
            cols = row.split("\t")
            if len(cols) < 12:
                continue
            level, page, block, par, line = cols[0], cols[1], cols[2], cols[3], cols[4]
            if level != "5":  # word level
                continue
            try:
                conf = float(cols[10])
                x, y, w, h = int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9])
            except ValueError:
                continue
            text = cols[11].strip()
            if not text or conf < 0:
                continue
            key = (block, par, line)
            e = lines.get(key)
            if e is None:
                lines[key] = {"words": [text], "x0": x, "y0": y, "x1": x + w, "y1": y + h,
                              "conf": [conf]}
            else:
                e["words"].append(text)
                e["x0"] = min(e["x0"], x)
                e["y0"] = min(e["y0"], y)
                e["x1"] = max(e["x1"], x + w)
                e["y1"] = max(e["y1"], y + h)
                e["conf"].append(conf)
        obs: List[Obs] = []
        for e in lines.values():
            obs.append(Obs(" ".join(e["words"]), sum(e["conf"]) / len(e["conf"]) / 100.0,
                           e["x0"], e["y0"], e["x1"] - e["x0"], e["y1"] - e["y0"]))
        return width, height, obs
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Non-text blob detection (logo / image) — grid + union-find on Pillow pixels
# --------------------------------------------------------------------------- #

def detect_blobs(img, max_cells: int = 220) -> List[Dict[str, float]]:
    """Return candidate non-text regions as bboxes whose interior ink is NOT background.

    Pure-Pillow heuristic (no numpy): downsample to a coarse grid, mark cells whose
    mean colour deviates from the canvas background, union-find connected components.
    """
    try:
        rgb = img.convert("RGB")
    except Exception:
        return []
    W, H = rgb.size
    if W == 0 or H == 0:
        return []
    long_side = max(W, H)
    cell = max(2, long_side // max_cells)
    gw, gh = max(1, W // cell), max(1, H // cell)
    small = rgb.resize((gw, gh))

    # background = most common quantised colour (usually white canvas)
    px = list(small.getdata())
    counts: Dict[Tuple[int, int, int], int] = {}
    for r, g, b in px:
        k = (r // 16 * 16, g // 16 * 16, b // 16 * 16)
        counts[k] = counts.get(k, 0) + 1
    bg = max(counts.items(), key=lambda kv: kv[1])[0]

    def is_ink(r, g, b) -> bool:
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 90

    ink = [[is_ink(*px[y * gw + x]) for x in range(gw)] for y in range(gh)]

    parent = list(range(gw * gh))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(gh):
        for x in range(gw):
            if not ink[y][x]:
                continue
            i = y * gw + x
            if x + 1 < gw and ink[y][x + 1]:
                union(i, i + 1)
            if y + 1 < gh and ink[y + 1][x]:
                union(i, i + gw)

    comps: Dict[int, List[int]] = {}
    for y in range(gh):
        for x in range(gw):
            if ink[y][x]:
                comps.setdefault(find(y * gw + x), []).append(y * gw + x)

    blobs: List[Dict[str, float]] = []
    min_cells = max(4, int(gw * gh * 0.002))
    for cells in comps.values():
        if len(cells) < min_cells:
            continue
        xs = [c % gw for c in cells]
        ys = [c // gw for c in cells]
        x0, x1 = min(xs) * cell, (max(xs) + 1) * cell
        y0, y1 = min(ys) * cell, (max(ys) + 1) * cell
        blobs.append({"x": float(x0), "y": float(y0),
                      "w": float(min(x1, W) - x0), "h": float(min(y1, H) - y0),
                      "cells": float(len(cells))})
    blobs.sort(key=lambda b: (b["y"], b["x"]))
    return blobs


def _overlap_ratio(a: Dict[str, float], b: Dict[str, float]) -> float:
    ax0, ay0, ax1, ay1 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx0, by0, bx1, by1 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    return inter / max(1.0, a["w"] * a["h"])


# --------------------------------------------------------------------------- #
# Heuristic classifier (documented in README)
# --------------------------------------------------------------------------- #

def _local_background_is_filled(img, bbox: Dict[str, float], W: int, H: int) -> bool:
    """True when the text sits on a coloured (non-canvas) fill -> button-ish."""
    try:
        rgb = img.convert("RGB")
    except Exception:
        return False
    from PIL import Image  # noqa
    # sample a ring just outside the text bbox
    pad = max(2.0, bbox["h"] * 0.35)
    x0 = int(max(0, bbox["x"] - pad))
    y0 = int(max(0, bbox["y"] - pad))
    x1 = int(min(W, bbox["x"] + bbox["w"] + pad))
    y1 = int(min(H, bbox["y"] + bbox["h"] + pad))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return False
    ring = rgb.crop((x0, y0, x1, y1))
    px = list(ring.getdata())
    # reference: canvas corner colour
    try:
        corner = rgb.getpixel((1, 1))
    except Exception:
        corner = (255, 255, 255)
    non_bg = sum(1 for r, g, b in px
                 if abs(r - corner[0]) + abs(g - corner[1]) + abs(b - corner[2]) > 60)
    return (non_bg / max(1, len(px))) > 0.55


def classify(obs: Obs, W: int, H: int, img, h_max: float) -> Dict[str, Any]:
    """Heuristic region typing. Rules documented in README.

    Inputs: normalised height (fh), height relative to the tallest line on the
    page (ratio), horizontal centring, vertical zone, text length, and whether
    the glyphs sit on a filled (non-canvas) background.
    """
    fh = obs.h / H
    cx = obs.x + obs.w / 2.0
    centered = abs(cx - W / 2.0) < 0.07 * W
    top_zone = obs.y < 0.35 * H
    text = obs.text.strip()
    n = len(text)
    ratio = obs.h / max(1.0, h_max)
    filled_bg = _local_background_is_filled(img, {"x": obs.x, "y": obs.y, "w": obs.w, "h": obs.h}, W, H)

    if filled_bg and n <= 24 and fh < 0.06:
        rtype = "button"
    elif ratio >= 0.72 and n <= 24 and (centered or top_zone):
        rtype = "title"
    elif ratio >= 0.42 and n <= 40 and (centered or top_zone):
        rtype = "subtitle"
    elif n <= 12 and (centered or fh >= 0.018):
        rtype = "label"
    else:
        rtype = "body"

    # font size: Vision bbox height ≈ ascent+descent; ~0.72 rounds to cap/x-height
    size_px = int(round(obs.h * 0.72))
    if rtype in ("title", "button"):
        weight = "bold"
    elif rtype == "subtitle":
        weight = "bold" if ratio >= 0.6 else "regular"
    else:
        weight = "regular"

    if abs(cx - W / 2.0) < 0.05 * W:
        align = "center"
    elif obs.x + obs.w > 0.92 * W and obs.x > 0.5 * W:
        align = "right"
    else:
        align = "left"

    family = "PingFang SC" if CJK_RE.search(text) else "Helvetica Neue"

    return {
        "type": rtype,
        "confidence": round(float(obs.confidence), 4),
        "font": {"sizePx": size_px, "weight": weight, "align": align, "familyGuess": family},
    }


def _classify_blob(bbox: Dict[str, float], W: int, H: int) -> str:
    area = bbox["w"] * bbox["h"]
    frac = area / max(1.0, W * H)
    ar = bbox["w"] / max(1.0, bbox["h"])
    if frac < 0.06 and 0.25 <= ar <= 4.0:
        return "logo"
    return "image"


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #

def parse_image(data: bytes, lang: List[str], max_regions: Optional[int],
                engine: str) -> Dict[str, Any]:
    warnings: List[str] = []
    img = _load_pil(data)
    W, H = img.size
    png = _encode_png(img)

    if engine == "vision":
        w2, h2, obs = vision_ocr(png, lang)
    elif engine == "swift":
        w2, h2, obs = swift_ocr(png, lang)
    elif engine == "tesseract":
        w2, h2, obs = tesseract_ocr(png, lang)
    elif engine == "paddle":
        raise RuntimeError("paddle backend is an optional hook only and is not implemented")
    else:
        raise RuntimeError("no OCR engine available")

    if w2 and h2:
        W, H = w2, h2

    regions: List[Dict[str, Any]] = []
    h_max = max([o.h for o in obs], default=1.0)
    for o in obs:
        c = classify(o, W, H, img, h_max)
        regions.append({
            "id": "",  # assigned after sort
            "type": c["type"],
            "bbox": {"x": round(o.x, 1), "y": round(o.y, 1), "w": round(o.w, 1), "h": round(o.h, 1)},
            "text": o.text,
            "confidence": c["confidence"],
            "font": c["font"],
            "_blob": False,
        })

    # non-text blobs (logo / image)
    text_boxes = [r["bbox"] for r in regions]
    for b in detect_blobs(img):
        # A blob that is substantially overlapped by (or contains) recognised text
        # is an OCR background (e.g. a button pill), not a standalone logo/image.
        covered = max((_overlap_ratio(b, t) for t in text_boxes), default=0.0)
        contains_text = any(
            (t["x"] + t["w"] / 2.0) >= b["x"] and (t["x"] + t["w"] / 2.0) <= b["x"] + b["w"]
            and (t["y"] + t["h"] / 2.0) >= b["y"] and (t["y"] + t["h"] / 2.0) <= b["y"] + b["h"]
            for t in text_boxes
        )
        if covered > 0.25 or contains_text:
            continue
        btype = _classify_blob(b, W, H)
        regions.append({
            "id": "",
            "type": btype,
            "bbox": {"x": round(b["x"], 1), "y": round(b["y"], 1),
                     "w": round(b["w"], 1), "h": round(b["h"], 1)},
            "text": "",
            "confidence": 0.5,
            "font": {"sizePx": 0, "weight": "regular", "align": "left", "familyGuess": ""},
            "_blob": True,
        })

    regions.sort(key=lambda r: (r["bbox"]["y"], r["bbox"]["x"]))
    if max_regions is not None and max_regions > 0:
        regions = regions[:max_regions]
        if len(regions) < len(obs) + 1:
            warnings.append(f"regions truncated to maxRegions={max_regions}")

    for i, r in enumerate(regions, 1):
        r["id"] = f"r{i}"
        r.pop("_blob", None)

    return {"ok": True, "width": W, "height": H, "engine": engine,
            "regions": regions, "warnings": warnings}


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #

class ParseOptions(BaseModel):
    lang: Optional[str] = None
    maxRegions: Optional[int] = None


class ParseRequest(BaseModel):
    image: Optional[str] = None
    path: Optional[str] = None
    url: Optional[str] = None
    options: Optional[ParseOptions] = None


app = FastAPI(title="image-parse", version=VERSION)
_ENGINE, _BOOT_WARNINGS = choose_engine()


@app.get("/health")
def health():
    return {"ok": _ENGINE != "none", "engine": _ENGINE, "version": VERSION}


@app.post("/parse")
def parse(req: ParseRequest):
    lang_opt = (req.options.lang if req.options else None) or "zh-Hans"
    if lang_opt not in ("zh-Hans", "en-US"):
        return JSONResponse(status_code=200, content={
            "ok": False, "error": f"unsupported lang: {lang_opt}", "warnings": []})
    langs = ["zh-Hans", "en-US"] if lang_opt == "zh-Hans" else ["en-US"]
    max_regions = req.options.maxRegions if req.options else None

    engine, boot_warnings = choose_engine(_ENGINE if _ENGINE != "none" else None)
    if engine == "none":
        return JSONResponse(status_code=200, content={
            "ok": False,
            "error": "no OCR engine available (vision/swift/tesseract all unavailable)",
            "warnings": boot_warnings})

    try:
        if req.image:
            data = base64.b64decode(req.image, validate=False)
        elif req.path:
            with open(req.path, "rb") as f:
                data = f.read()
        elif req.url:
            with urllib.request.urlopen(req.url, timeout=30) as resp:
                data = resp.read()
        else:
            return JSONResponse(status_code=200, content={
                "ok": False, "error": "one of image|path|url is required", "warnings": []})
    except (binascii.Error, OSError, ValueError) as e:
        return JSONResponse(status_code=200, content={
            "ok": False, "error": f"failed to load image: {e}", "warnings": []})

    try:
        out = parse_image(data, langs, max_regions, engine)
        out["warnings"] = boot_warnings + out.get("warnings", [])
        return out
    except Exception as e:  # never 500 — contract says ok:false + error
        return JSONResponse(status_code=200, content={
            "ok": False, "error": f"parse failed ({engine}): {e}", "warnings": boot_warnings})


def main():
    import argparse
    ap = argparse.ArgumentParser(description="image-parse local OCR/layout service")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--engine", default=None,
                    help="force engine: vision|swift|tesseract (default: auto)")
    args = ap.parse_args()

    engine, warns = choose_engine(args.engine)
    if engine == "none":
        print("[image-parse] WARNING: no OCR engine available", file=sys.stderr)
    for w in warns:
        print(f"[image-parse] {w}", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
