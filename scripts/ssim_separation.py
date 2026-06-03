"""
Phase 1 (de-risk gate) for docs/plans/2026-06-03-cv-ssim-primary-detection.md.

Question: on our CLEAN harvested crops, does the real champion's SSIM to its own
Data Dragon icon separate from a turret/minion/terrain crop's SSIM? If yes, an
absolute SSIM threshold can be the primary identity decision (the Quinntana
approach). If not, SSIM-primary won't work and we escalate.

Mirrors src/services/template-match.ts EXACTLY: luma grayscale, inscribed
circular mask (inset 0.06), single-global-window SSIM (NOT skimage's windowed
SSIM) so the number predicts in-app behavior.

Run:  python scripts/ssim_separation.py
Reuses loaders from eval_real_crops.py. Non-destructive (stdout only).
"""
import json, os, sys
from pathlib import Path
import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from eval_real_crops import (latest_ddragon_version, champion_name_to_id,
                             fetch_template_gray, load_crop_rgb, to_gray,
                             circular_mask, IMG_SIZE)

C1 = (0.01 * 255) ** 2
C2 = (0.03 * 255) ** 2


def ssim_global(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    """Single-window SSIM over the masked pixels — matches template-match.ts ssim()."""
    av = a[mask]; bv = b[mask]
    mA = av.mean(); mB = bv.mean()
    vA = ((av - mA) ** 2).mean(); vB = ((bv - mB) ** 2).mean()
    cov = ((av - mA) * (bv - mB)).mean()
    num = (2 * mA * mB + C1) * (2 * cov + C2)
    den = (mA * mA + mB * mB + C1) * (vA + vB + C2)
    return float(num / den) if den != 0 else 0.0


def tight(rgb: np.ndarray) -> np.ndarray:
    """Center-crop the harvest crop to the icon's inner extent (~1/1.4) and rescale
    to 32 — simulates a tighter blob-bbox crop, to see if framing depresses SSIM."""
    m = round(IMG_SIZE / 1.4)
    off = (IMG_SIZE - m) // 2
    sub = rgb[off:off + m, off:off + m, :].astype("uint8")
    return np.asarray(Image.fromarray(sub).resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR), dtype=np.float32)


def stats(xs):
    if not xs:
        return "n=0"
    a = np.array(sorted(xs))
    return f"n={len(a):2d}  min={a.min():.3f}  med={np.median(a):.3f}  mean={a.mean():.3f}  max={a.max():.3f}"


def resolve_dir(src):
    if "local_appdata" in src:
        return Path(os.environ["LOCALAPPDATA"]) / src["local_appdata"]
    return Path(src["unc"])


def sweep(cs, ks, label):
    print(f"  threshold sweep [{label}] (recall = champion accepted, spec = clutter rejected):")
    best = (None, -1)
    for T in [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]:
        rec = (sum(s >= T for s in cs) / len(cs)) if cs else 0
        spc = (sum(s < T for s in ks) / len(ks)) if ks else 0
        if rec + spc > best[1]:
            best = (T, rec + spc)
        print(f"    T={T:.2f}  recall={rec*100:4.0f}%  spec={spc*100:4.0f}%"
              f"  (champ>=T {sum(s>=T for s in cs)}/{len(cs)}, clut<T {sum(s<T for s in ks)}/{len(ks)})")
    print(f"    -> best balanced T={best[0]:.2f}")


def main():
    labels = json.loads((REPO_ROOT / "scripts" / "clean_crops_labels.json").read_text(encoding="utf-8"))
    version = latest_ddragon_version()
    name2id = champion_name_to_id(version)
    mask = circular_mask(IMG_SIZE)
    print(f"Data Dragon {version}\n")

    for champ, spec in labels.items():
        if champ.startswith("_"):
            continue
        d = resolve_dir(spec["source"]); min_ts = spec["source"]["min_ts"]
        files = sorted([p for p in d.glob("*.png") if p.stem.isdigit() and int(p.stem) >= min_ts],
                       key=lambda p: int(p.stem))
        champ_id = name2id.get(champ, champ)
        tpl = fetch_template_gray(version, champ_id)
        raw_scores, tight_scores = [], []
        for p in files:
            rgb = load_crop_rgb(p)
            raw_scores.append(ssim_global(to_gray(rgb), tpl, mask))
            tight_scores.append(ssim_global(to_gray(tight(rgb)), tpl, mask))

        ch, cl = set(spec["champion"]), set(spec["clutter"])
        cs = [raw_scores[i] for i in spec["champion"] if i < len(raw_scores)]
        ks = [raw_scores[i] for i in spec["clutter"] if i < len(raw_scores)]
        cst = [tight_scores[i] for i in spec["champion"] if i < len(tight_scores)]
        kst = [tight_scores[i] for i in spec["clutter"] if i < len(tight_scores)]

        print("=" * 76)
        print(f"{champ} (id={champ_id}) — {len(files)} clean crops; "
              f"{len(cs)} labeled champion, {len(ks)} labeled clutter")
        print("-" * 76)
        print("  [RAW 32px crop vs icon — app-faithful]")
        print("   CHAMPION:", stats(cs))
        print("   CLUTTER :", stats(ks))
        sweep(cs, ks, "raw")
        print("  [TIGHT center-crop vs icon — would better alignment help?]")
        print("   CHAMPION:", stats(cst))
        print("   CLUTTER :", stats(kst))
        sweep(cst, kst, "tight")

        def lab(i):
            return "CHAMP" if i in ch else ("clut " if i in cl else "  -  ")
        order = sorted(range(len(raw_scores)), key=lambda i: -raw_scores[i])
        print("  all crops sorted by RAW score (idx:score:label):")
        line = "   " + "  ".join(f"{i}:{raw_scores[i]:.2f}:{lab(i)}" for i in order)
        print(line)
        print()


if __name__ == "__main__":
    main()
