#!/usr/bin/env python3
"""Crop a Playwright visual diff to its CHANGED ROWS, expected over actual.

A baseline is a SENTENCE, not a picture. At `maxDiffPixels: 0` a one-word
change and a real regression look identical in the failure list, and a
1440x11000 screenshot is unreadable whole — so every regenerated baseline has
to be explained first, and this is what makes that cheap. It finds the diff's
red bands, crops both images to each, and stacks them with a magenta rule
between.

⭐ It earns its keep. On 2026-09-04 one of these strips showed a fix scoped too
WIDE — a date/count pairing correct for one coverage grade and wrong for
another — which nothing else would have caught, and the fix was narrowed before
the baseline moved.

Usage:  python3 scripts/crop-visual-diffs.py test-results /tmp/crops

⚠️ Crop ONE width and theme per baseline family. The text is the same at 320 and
1440, and 64 failures are usually 8 changes.
"""
import sys, os, glob
from PIL import Image

BAND_PAD = 26          # rows of context above/below a changed band
MERGE_GAP = 40         # bands closer than this merge into one strip
MAX_BANDS = 6

def bands(diff):
    px = diff.convert("RGB")
    w, h = px.size
    data = px.load()
    step = max(1, w // 220)          # sample columns; a diff row is wide
    hot = []
    for y in range(h):
        for x in range(0, w, step):
            r, g, b = data[x, y]
            if r > 90 and g < 90 and b < 90:   # playwright paints diffs red
                hot.append(y)
                break
    if not hot:
        return []
    out, start, prev = [], hot[0], hot[0]
    for y in hot[1:]:
        if y - prev > MERGE_GAP:
            out.append((start, prev))
            start = y
        prev = y
    out.append((start, prev))
    out.sort(key=lambda b: b[1] - b[0], reverse=True)
    return out[:MAX_BANDS]

def main(results, outdir):
    os.makedirs(outdir, exist_ok=True)
    made = []
    for d in sorted(glob.glob(os.path.join(results, "**", "*-diff.png"), recursive=True)):
        base = d[: -len("-diff.png")]
        a, e = base + "-actual.png", base + "-expected.png"
        if not (os.path.exists(a) and os.path.exists(e)):
            continue
        name = os.path.basename(os.path.dirname(d)) or os.path.basename(base)
        di, ai, ei = Image.open(d), Image.open(a), Image.open(e)
        for i, (y0, y1) in enumerate(bands(di)):
            top = max(0, y0 - BAND_PAD)
            bot = min(ai.size[1], y1 + BAND_PAD)
            ec = ei.crop((0, top, ei.size[0], min(ei.size[1], bot)))
            ac = ai.crop((0, top, ai.size[0], bot))
            w = max(ec.size[0], ac.size[0])
            canvas = Image.new("RGB", (w, ec.size[1] + ac.size[1] + 8), (255, 0, 255))
            canvas.paste(ec, (0, 0))
            canvas.paste(ac, (0, ec.size[1] + 8))
            p = os.path.join(outdir, f"{name}-band{i}-y{top}.png")
            canvas.save(p)
            made.append((p, top, bot))
    for p, t, b in made:
        print(f"{p}  rows {t}-{b}")
    print(f"\n{len(made)} strips (expected on top, actual below, magenta rule between)")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
