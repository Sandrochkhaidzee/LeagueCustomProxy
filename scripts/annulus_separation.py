"""
Phase 1b validation: does an ANNULUS signature separate champion from clutter?

A champion minimap icon = an ally-colored RING enclosing a non-ally portrait.
So: high ally-color fraction in the outer ring band, LOW ally-color fraction in
the center. Minions are solid ally dots (ally in the center too); terrain has
little ally anywhere; turrets are shields. This tests the user's "circle with
contrasting content inside" idea on the clean crops — no appearance matching.

Ports color-detect.ts classifyMinimapPixel (teal/ally) EXACTLY (HSV hue 150-215,
sat>=0.10, val>=0.35, reject v<0.2). Run: python scripts/annulus_separation.py
"""
import json, os, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path.cwd() / "scripts"))
from eval_real_crops import load_crop_rgb, IMG_SIZE

TEAL_HUE_MIN, TEAL_HUE_MAX = 150.0, 215.0
TEAL_SAT_MIN, TEAL_VAL_MIN = 0.10, 0.35


def teal_mask(rgb: np.ndarray) -> np.ndarray:
    """Boolean (H,W) ally-color mask, matching color-detect.ts classifyMinimapPixel==1."""
    r, g, b = rgb[..., 0] / 255.0, rgb[..., 1] / 255.0, rgb[..., 2] / 255.0
    mx = np.max(rgb / 255.0, axis=-1)
    mn = np.min(rgb / 255.0, axis=-1)
    d = mx - mn
    h = np.zeros_like(mx)
    with np.errstate(divide="ignore", invalid="ignore"):
        ig = (mx == g) & (d != 0)
        ib = (mx == b) & (d != 0)
        ir = (mx == r) & (d != 0)
        h = np.where(ir, 60 * (((g - b) / d) % 6), h)
        h = np.where(ig, 60 * ((b - r) / d + 2), h)
        h = np.where(ib, 60 * ((r - g) / d + 4), h)
    h = np.where(h < 0, h + 360, h)
    s = np.where(mx == 0, 0, d / np.where(mx == 0, 1, mx))
    v = mx
    return (v >= 0.2) & (h >= TEAL_HUE_MIN) & (h <= TEAL_HUE_MAX) & (s >= TEAL_SAT_MIN) & (v >= TEAL_VAL_MIN)


# Radial bands as fraction of the crop half-width (c). Icon ring sits ~0.72 of
# half (harvest crop = 1.4x icon); portrait interior is the inner disc.
c = (IMG_SIZE - 1) / 2.0
yy, xx = np.mgrid[0:IMG_SIZE, 0:IMG_SIZE]
rad = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / c
CENTER = rad < 0.45
RING = (rad >= 0.58) & (rad <= 0.85)


def annulus_features(rgb: np.ndarray):
    m = teal_mask(rgb)
    ring_frac = m[RING].mean()
    center_frac = m[CENTER].mean()
    return ring_frac, center_frac, ring_frac - center_frac


def stats(xs):
    if not xs:
        return "n=0"
    a = np.array(sorted(xs))
    return f"n={len(a):2d} min={a.min():.3f} med={np.median(a):.3f} mean={a.mean():.3f} max={a.max():.3f}"


def resolve(src):
    return Path(os.environ["LOCALAPPDATA"]) / src["local_appdata"] if "local_appdata" in src else Path(src["unc"])


def sweep(cs, ks, name):
    print(f"  {name} threshold sweep (recall=champion accepted, spec=clutter rejected):")
    best = (None, -1)
    for T in np.round(np.arange(0.0, 0.61, 0.05), 2):
        rec = (sum(s >= T for s in cs) / len(cs)) if cs else 0
        spc = (sum(s < T for s in ks) / len(ks)) if ks else 0
        if rec + spc > best[1]:
            best = (T, rec + spc, rec, spc)
        print(f"    T={T:.2f} recall={rec*100:4.0f}% spec={spc*100:4.0f}%")
    print(f"    -> best balanced T={best[0]:.2f} (recall {best[2]*100:.0f}%, spec {best[3]*100:.0f}%)")


def main():
    labels = json.loads((Path.cwd() / "scripts/clean_crops_labels.json").read_text(encoding="utf-8"))
    for champ, spec in labels.items():
        if champ.startswith("_"):
            continue
        d = resolve(spec["source"]); mt = spec["source"]["min_ts"]
        files = sorted([p for p in d.glob("*.png") if p.stem.isdigit() and int(p.stem) >= mt], key=lambda p: int(p.stem))
        feats = [annulus_features(load_crop_rgb(p)) for p in files]
        ring = [f[0] for f in feats]; cen = [f[1] for f in feats]; ann = [f[2] for f in feats]
        ci, ki = spec["champion"], spec["clutter"]
        print("=" * 72)
        print(f"{champ} — {len(files)} clean crops; {len(ci)} champion, {len(ki)} clutter")
        for nm, arr in [("ring_ally_frac", ring), ("center_ally_frac", cen), ("annulus(ring-center)", ann)]:
            cs = [arr[i] for i in ci if i < len(arr)]
            ks = [arr[i] for i in ki if i < len(arr)]
            print(f"  [{nm}]  CHAMP {stats(cs)}")
            print(f"  {'':>{len(nm)+4}} CLUT  {stats(ks)}")
        cs = [ann[i] for i in ci if i < len(ann)]; ks = [ann[i] for i in ki if i < len(ann)]
        sweep(cs, ks, "annulus")
        cs2 = [ring[i] for i in ci if i < len(ring)]; ks2 = [ring[i] for i in ki if i < len(ring)]
        sweep(cs2, ks2, "ring_frac")
        # eyeball
        lab = lambda i: "CHAMP" if i in set(ci) else ("clut " if i in set(ki) else "  -  ")
        order = sorted(range(len(ann)), key=lambda i: -ann[i])
        print("  crops by annulus score (idx:ring/center:label):")
        print("   " + "  ".join(f"{i}:{ring[i]:.2f}/{cen[i]:.2f}:{lab(i)}" for i in order))
        print()


if __name__ == "__main__":
    main()
