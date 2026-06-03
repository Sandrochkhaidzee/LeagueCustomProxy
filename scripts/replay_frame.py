"""
Offline replay of the live detection+annulus pipeline on full native minimap
frames (harvested under harvest/_frames_<champ>/ by the debug build).

Reproduces tracking.ts EXACTLY: classifyPixel (color-detect.ts) -> dilate (1-pass
4-conn) -> findBlobs (4-conn components, count>=10) -> filterIconBlobs
(size/aspect/pixels/fill) -> getAnnulus on the RAW (un-dilated) teal mask
(center<0.55r, ring 0.70-1.05r, r=max(bw,bh)/2). iconDiam = round(W*0.087).

Lets us see what the champion ring blob ACTUALLY scores at native resolution and
calibrate RING_TEAL_MIN/ANNULUS_MIN + band geometry against real frames — no
repeated playtests. Annotates each frame with teal candidates + their annulus.

Run:  python scripts/replay_frame.py <frames_dir> [--n 8] [--ring-band 0.70,1.05] [--center 0.55]
"""
import sys, glob, os
from collections import deque
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

RING_TEAL_MIN = 0.10
ANNULUS_MIN = 0.05


def hsv(rgb):
    r, g, b = rgb[..., 0] / 255, rgb[..., 1] / 255, rgb[..., 2] / 255
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b); d = mx - mn
    h = np.zeros_like(mx)
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where((mx == r) & (d != 0), 60 * (((g - b) / d) % 6), h)
        h = np.where((mx == g) & (d != 0), 60 * ((b - r) / d + 2), h)
        h = np.where((mx == b) & (d != 0), 60 * ((r - g) / d + 4), h)
    h = np.where(h < 0, h + 360, h)
    s = np.where(mx == 0, 0, d / np.where(mx == 0, 1, mx))
    return h, s, mx


def classify(rgb):
    h, s, v = hsv(rgb)
    teal = (v >= 0.2) & (h >= 150) & (h <= 215) & (s >= 0.10) & (v >= 0.35)
    red = (v >= 0.2) & ((h <= 18) | (h >= 342)) & (s >= 0.4) & (v >= 0.3)
    m = np.zeros(rgb.shape[:2], np.uint8); m[teal] = 1; m[red & ~teal] = 2
    return m


def dilate(mask):  # 1-pass, fill empty interior cell with first nonzero 4-neighbor (up||dn||lt||rt)
    res = mask.copy()
    up = np.zeros_like(mask); up[1:] = mask[:-1]
    dn = np.zeros_like(mask); dn[:-1] = mask[1:]
    lt = np.zeros_like(mask); lt[:, 1:] = mask[:, :-1]
    rt = np.zeros_like(mask); rt[:, :-1] = mask[:, 1:]
    nb = np.where(up != 0, up, np.where(dn != 0, dn, np.where(lt != 0, lt, rt)))
    empty = mask == 0
    res[empty] = nb[empty]
    res[0, :] = mask[0, :]; res[-1, :] = mask[-1, :]; res[:, 0] = mask[:, 0]; res[:, -1] = mask[:, -1]
    return res


def find_blobs(mask):
    h, w = mask.shape; visited = np.zeros_like(mask, bool); blobs = []
    for y0 in range(h):
        for x0 in range(w):
            if visited[y0, x0] or mask[y0, x0] == 0:
                continue
            val = mask[y0, x0]; q = deque([(x0, y0)]); visited[y0, x0] = True; xs = []; ys = []
            while q:
                x, y = q.popleft(); xs.append(x); ys.append(y)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not visited[ny, nx] and mask[ny, nx] == val:
                        visited[ny, nx] = True; q.append((nx, ny))
            n = len(xs)
            if n >= 10:
                minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
                bbox = (maxx - minx + 1) * (maxy - miny + 1)
                blobs.append(dict(color="teal" if val == 1 else "red", pixels=n,
                    cx=round(sum(xs) / n), cy=round(sum(ys) / n), minX=minx, maxX=maxx, minY=miny, maxY=maxy,
                    fillRatio=n / bbox if bbox else 1))
    return blobs


def filter_icon(blobs, diam):
    if diam < 5:
        return blobs
    mn, mx = diam * 0.6, diam * 1.6; out = []
    for b in blobs:
        bw = b["maxX"] - b["minX"] + 1; bh = b["maxY"] - b["minY"] + 1
        if bw < mn or bw > mx or bh < mn or bh > mx: continue
        if not (0.6 <= bw / bh <= 1.7): continue
        if b["pixels"] < 15: continue
        if not (0.08 <= b["fillRatio"] <= 0.40): continue
        out.append(b)
    return out


def annulus(raw_teal, cx, cy, r, center_f=0.55, ring=(0.70, 1.05)):
    h, w = raw_teal.shape
    yy, xx = np.mgrid[0:h, 0:w]; d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    cen = d2 <= (center_f * r) ** 2
    rng = (d2 >= (ring[0] * r) ** 2) & (d2 <= (ring[1] * r) ** 2)
    rt = raw_teal[rng].mean() if rng.any() else 0.0
    ct = raw_teal[cen].mean() if cen.any() else 0.0
    return float(rt), float(ct), float(rt - ct)


def main():
    args = sys.argv[1:]
    d = Path(args[0])
    n = int(args[args.index("--n") + 1]) if "--n" in args else 8
    center_f = float(args[args.index("--center") + 1]) if "--center" in args else 0.55
    ring = tuple(float(x) for x in args[args.index("--ring-band") + 1].split(",")) if "--ring-band" in args else (0.70, 1.05)
    global RING_TEAL_MIN, ANNULUS_MIN
    if "--ring-min" in args: RING_TEAL_MIN = float(args[args.index("--ring-min") + 1])
    if "--ann-min" in args: ANNULUS_MIN = float(args[args.index("--ann-min") + 1])
    files = sorted([f for f in glob.glob(str(d / "*.png")) if not Path(f).name.startswith("_annot_")],
                   key=lambda p: int(Path(p).stem) if Path(p).stem.isdigit() else 0)
    if not files:
        print("no frames in", d); return
    step = max(1, len(files) // n); files = files[::step][:n]
    print(f"{len(files)} frames; center_f={center_f} ring_band={ring}  gate: ringTeal>={RING_TEAL_MIN} & score>={ANNULUS_MIN}")
    try: font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 12)
    except: font = ImageFont.load_default()
    for fp in files:
        rgb = np.asarray(Image.open(fp).convert("RGB"), dtype=np.float32)
        H, W = rgb.shape[:2]; diam = round(W * 0.087)
        m = classify(rgb); raw_teal = (m == 1)
        blobs = filter_icon(find_blobs(dilate(m)), diam)
        teal = [b for b in blobs if b["color"] == "teal"]
        print(f"\n{Path(fp).name}  {W}x{H} diam={diam}  teal-candidates={len(teal)}")
        vis = Image.open(fp).convert("RGB").resize((W * 2, H * 2), Image.NEAREST); dr = ImageDraw.Draw(vis)
        for b in sorted(teal, key=lambda b: -annulus(raw_teal, b["cx"], b["cy"], max(b["maxX"]-b["minX"]+1, b["maxY"]-b["minY"]+1)/2, center_f, ring)[2]):
            r = max(b["maxX"] - b["minX"] + 1, b["maxY"] - b["minY"] + 1) / 2
            rt, ct, sc = annulus(raw_teal, b["cx"], b["cy"], r, center_f, ring)
            pas = rt >= RING_TEAL_MIN and sc >= ANNULUS_MIN
            print(f"   ({b['cx']:3d},{b['cy']:3d}) r={r:4.1f} fill={b['fillRatio']:.2f} px={b['pixels']:3d}  ringTeal={rt:.2f} cenTeal={ct:.2f} score={sc:+.2f}  {'PASS' if pas else 'fail'}")
            col = (0, 255, 0) if pas else (255, 80, 80)
            dr.rectangle([b["minX"]*2, b["minY"]*2, b["maxX"]*2, b["maxY"]*2], outline=col, width=2)
            dr.text((b["minX"]*2, b["minY"]*2 - 13), f"{sc:+.2f}", fill=col, font=font)
        out = str(d / ("_annot_" + Path(fp).stem + ".png")); vis.save(out)
    print("\nannotated frames saved as _annot_*.png in", d)


if __name__ == "__main__":
    main()
