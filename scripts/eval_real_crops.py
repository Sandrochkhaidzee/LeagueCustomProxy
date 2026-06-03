"""
Evaluate two champion-identification methods on REAL harvested minimap crops.

Why this exists: synthetic accuracy metrics (see eval_cv_models.py) are known to
MISLEAD — the model and the SSIM templates both look great on clean/augmented
icons but degrade badly on the real minimap (fog-of-war darkening, team-color
rings, JPEG-ish compression, sub-pixel scaling). This harness measures both
methods on the real labeled crops the app's harvest mode collects, which is the
only honest signal for "which method actually identifies champions in-game".

The two methods compared:
  1. Classifier (ONNX): the shipped models/champion_classifier.onnx (172-class,
     32x32x3 RGB input -> 172 logits) + models/champion_labels.json. argmax over
     all 172 classes -> predicted champion. We ALSO report a "restricted"
     accuracy where argmax is taken over ONLY the champions present in the
     harvest (the candidate pool) — a fairer comparison to the template method's
     best-of-N, which only ever picks from that pool.
  2. Template matching (SSIM): fetch each candidate champion's icon from Data
     Dragon, circular-crop + grayscale + resize to 32x32, and SSIM every crop
     against all candidate templates. Highest SSIM wins. This mirrors
     src/services/template-match.ts (grayscale SSIM, best-of-N). We also report
     the mean winning SSIM to show how weak real matches are (expect ~0.3).

Data layout (harvest mode):
  %LOCALAPPDATA%\\com.proxchat.app\\harvest\\<ChampionName>\\<timestamp>.png
The folder name is the GROUND-TRUTH champion, sanitized to ASCII alphanumerics +
underscores (non-alphanumeric -> '_'), e.g. "Nunu___Willump", "DrMundo". We map
those back to Data Dragon ids by sanitizing each Data Dragon display name the
same way and matching.

Usage:
    python scripts/eval_real_crops.py
    python scripts/eval_real_crops.py --harvest /path/to/harvest --limit 50

Non-destructive: writes only to stdout, never touches models/.
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

# Repo-root-relative model paths (resolve regardless of cwd).
REPO_ROOT = Path(__file__).resolve().parent.parent
CLASSIFIER_ONNX = REPO_ROOT / "models" / "champion_classifier.onnx"
CLASSIFIER_LABELS = REPO_ROOT / "models" / "champion_labels.json"

IMG_SIZE = 32
DDRAGON = "https://ddragon.leagueoflegends.com"
# SSIM circular-mask inset matches template-match.ts circularMaskIndices default
# (drop the colored border ring at the very edge).
MASK_INSET_FRAC = 0.06


# ---------------------------------------------------------------------------
# Name sanitization — must match the app's harvest folder sanitization exactly:
# replace every run/char that is not [A-Za-z0-9] with a single '_' per char.
# The harvest code sanitizes char-by-char (each non-alphanumeric -> '_'), so
# "Nunu & Willump" -> "Nunu___Willump" (space, '&', space => three underscores).
# We replicate that per-character behaviour (NOT collapsing runs).
# ---------------------------------------------------------------------------
def sanitize(name: str) -> str:
    """ASCII-fold then map each non-alphanumeric char to '_' (1:1)."""
    # Strip accents/non-ASCII the way a typical ASCII sanitizer would: drop
    # combining marks. Data Dragon display names are largely ASCII already
    # (e.g. "Kai'Sa", "Cho'Gath", "Nunu & Willump").
    import unicodedata
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Za-z0-9]", "_", folded)


# ---------------------------------------------------------------------------
# Data Dragon
# ---------------------------------------------------------------------------
def _http_get(url: str, binary: bool = False):
    """GET a URL using requests if present, else urllib (stdlib fallback)."""
    try:
        import requests
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        return r.content if binary else r.text
    except ImportError:
        import urllib.request
        with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310
            data = resp.read()
        return data if binary else data.decode("utf-8")


def latest_ddragon_version() -> str:
    versions = json.loads(_http_get(f"{DDRAGON}/api/versions.json"))
    return versions[0]


def champion_name_to_id(version: str) -> dict:
    """Map sanitized(display name) -> Data Dragon id (e.g. 'Nunu___Willump' -> 'Nunu')."""
    data = json.loads(_http_get(f"{DDRAGON}/cdn/{version}/data/en_US/champion.json"))["data"]
    mapping = {}
    for entry in data.values():
        mapping[sanitize(entry["name"])] = entry["id"]
        # Also index by sanitized id, as a fallback (some folder names may have
        # been derived from the id rather than the display name).
        mapping.setdefault(sanitize(entry["id"]), entry["id"])
    return mapping


def fetch_template_gray(version: str, champ_id: str) -> np.ndarray:
    """Fetch a champion icon, circular-crop, grayscale, resize to 32x32.

    Returns a float32 array of shape (32, 32). Circular crop blacks out the
    corners so the team-color ring / square background doesn't dominate SSIM —
    the same idea as circularMaskIndices in template-match.ts (here we also rely
    on the shared mask at compare time, but cropping keeps the template clean).
    """
    from PIL import Image
    import io
    raw = _http_get(f"{DDRAGON}/cdn/{version}/img/champion/{champ_id}.png", binary=True)
    img = Image.open(io.BytesIO(raw)).convert("L").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


# ---------------------------------------------------------------------------
# Crop loading / preprocessing
# ---------------------------------------------------------------------------
def load_crop_rgb(path: Path) -> np.ndarray:
    """Load a harvest crop as float32 RGB (32,32,3), values in [0,255]."""
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


def to_gray(rgb: np.ndarray) -> np.ndarray:
    """Luma grayscale (same weights as template-match.ts toGrayscale)."""
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def circular_mask(size: int, inset_frac: float = MASK_INSET_FRAC) -> np.ndarray:
    """Boolean (size,size) mask of the inscribed circle (matches template-match.ts)."""
    c = (size - 1) / 2.0
    r = c * (1 - inset_frac)
    yy, xx = np.mgrid[0:size, 0:size]
    return ((xx - c) ** 2 + (yy - c) ** 2) <= (r * r)


# ---------------------------------------------------------------------------
# Methods
# ---------------------------------------------------------------------------
def classifier_logits(onnx_path: Path, crops_rgb: np.ndarray) -> np.ndarray:
    """Run the ONNX classifier on a batch of RGB crops -> logits (N, 172).

    Input layout: NCHW, float32, values normalized to [0,1] (the trainer divides
    by 255 — see preprocess in eval_cv_models.py / train_champion_classifier.py).
    """
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    batch = (crops_rgb / 255.0).transpose(0, 3, 1, 2).astype(np.float32)  # NHWC->NCHW
    return sess.run(None, {iname: batch})[0]


def ssim_gray(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    """Masked grayscale SSIM via skimage, restricted to the circular interior.

    skimage computes SSIM over the full image; to honor the circular mask we
    zero out the corners on both images first. For tiny 32x32 icons a global
    SSIM is a good approximation (matches the single-window ssim() in
    template-match.ts). data_range=255 for 8-bit grayscale.
    """
    from skimage.metrics import structural_similarity
    am = np.where(mask, a, 0.0)
    bm = np.where(mask, b, 0.0)
    return float(structural_similarity(am, bm, data_range=255.0))


def best_template_match(crop_gray, templates, mask):
    """(name, score) for the highest-SSIM candidate template (best-of-N)."""
    best_name, best_score = None, -np.inf
    for name, tpl in templates.items():
        s = ssim_gray(crop_gray, tpl, mask)
        if s > best_score:
            best_name, best_score = name, s
    return best_name, best_score


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def discover_crops(harvest_dir: Path, limit=None):
    """Return {sanitized_champion_folder: [png Path, ...]} from the harvest dir."""
    crops = {}
    if not harvest_dir.is_dir():
        return crops
    for champ_dir in sorted(p for p in harvest_dir.iterdir() if p.is_dir()):
        pngs = sorted(champ_dir.glob("*.png"))
        if limit is not None:
            pngs = pngs[:limit]
        if pngs:
            crops[champ_dir.name] = pngs
    return crops


def default_harvest_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA", "")
    return Path(local) / "com.proxchat.app" / "harvest"


def print_empty_guidance(harvest_dir: Path):
    print(f"No harvested crops found under: {harvest_dir}\n")
    print("Harvest mode collects real labeled minimap crops while you play. To")
    print("enable it and gather data:")
    print("  1. Open the app with Debug enabled.")
    print("  2. In the dev console set:")
    print("       localStorage.setItem('lolproxchat.harvest', 'true')")
    print("  3. Play (or spectate) a game of League - crops are saved to:")
    print(f"       {default_harvest_dir()}")
    print("     as <ChampionName>/<timestamp>.png (32x32 RGB).")
    print("  4. Re-run:  python scripts/eval_real_crops.py")
    print("\nOr point --harvest at a folder that already contains <Champion>/*.png crops.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harvest", type=str, default=None,
                    help="Harvest folder (default: %%LOCALAPPDATA%%/com.proxchat.app/harvest)")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap number of crops per champion (optional).")
    args = ap.parse_args()

    harvest_dir = Path(args.harvest) if args.harvest else default_harvest_dir()
    print(f"Harvest dir: {harvest_dir}")

    crops_by_champ = discover_crops(harvest_dir, args.limit)
    if not crops_by_champ:
        print_empty_guidance(harvest_dir)
        return

    n_total = sum(len(v) for v in crops_by_champ.values())
    candidate_folders = sorted(crops_by_champ.keys())  # sanitized names = candidate pool
    print(f"Found {n_total} crops across {len(candidate_folders)} champions "
          f"(candidate pool).")
    print(f"Candidate pool: {', '.join(candidate_folders)}\n")

    # --- Data Dragon: version, name->id, templates for the candidate pool ----
    print("Fetching Data Dragon version + champion list...")
    version = latest_ddragon_version()
    name2id = champion_name_to_id(version)
    print(f"Data Dragon version: {version}")

    # --- Load classifier labels and map them through Data Dragon ids ----------
    # The classifier labels ("Dr_ Mundo", "Nunu") live in a DIFFERENT name space
    # than the harvest folders ("DrMundo", "Nunu___Willump"), so sanitize-equality
    # between the two is unreliable. The reliable bridge is the Data Dragon id:
    # resolve BOTH the harvest folder and each classifier label to a ddragon id,
    # then join on that. name2id already indexes sanitize(displayName) and
    # sanitize(id) -> id, which covers both naming styles.
    labels = json.loads(CLASSIFIER_LABELS.read_text(encoding="utf-8"))  # {"0":"Aatrox",...}
    idx_to_name = {int(k): v for k, v in labels.items()}
    # classifier label index -> ddragon id (None if it can't be resolved).
    idx_to_ddragon = {i: name2id.get(sanitize(n)) for i, n in idx_to_name.items()}
    # ddragon id -> classifier label index (for correctness checks + pool cols).
    ddragon_to_idx = {ddid: i for i, ddid in idx_to_ddragon.items() if ddid}

    templates = {}          # folder name -> grayscale template (32x32)
    folder_to_ddragon = {}  # folder name -> resolved ddragon id
    unmapped = []           # folders we couldn't resolve to a ddragon id at all
    fetch_failed = []       # resolved to an id but icon fetch failed
    for folder in candidate_folders:
        champ_id = name2id.get(folder)
        if champ_id is None:
            unmapped.append(folder)
            continue
        folder_to_ddragon[folder] = champ_id
        try:
            templates[folder] = fetch_template_gray(version, champ_id)
        except Exception as e:  # noqa: BLE001
            print(f"  WARN: failed to fetch template for {folder} ({champ_id}): {e}")
            fetch_failed.append(folder)
    if unmapped:
        print(f"  WARN: {len(unmapped)} champion folder(s) could not be mapped to "
              f"a Data Dragon champion and are EXCLUDED from both methods' pool: "
              f"{', '.join(unmapped)}")
    if fetch_failed:
        print(f"  WARN: {len(fetch_failed)} champion folder(s) resolved but their "
              f"icon failed to download; excluded from the TEMPLATE pool only: "
              f"{', '.join(fetch_failed)}")
    print(f"Fetched {len(templates)} candidate templates.\n")

    # Candidate-pool logit columns for the classifier's "restricted" accuracy.
    # Join harvest folder -> ddragon id -> classifier label index. This is the
    # robust path that survives the "Dr_ Mundo" vs "DrMundo" mismatch.
    pool_cols = []
    folder_to_pool_idx = {}  # folder -> classifier label index
    for folder, ddid in folder_to_ddragon.items():
        idx = ddragon_to_idx.get(ddid)
        if idx is not None:
            folder_to_pool_idx[folder] = idx
            pool_cols.append(idx)
    pool_cols = sorted(set(pool_cols))

    mask = circular_mask(IMG_SIZE)

    # --- Per-crop evaluation -------------------------------------------------
    # Aggregate counters.
    cls_full_correct = 0
    cls_restricted_correct = 0
    cls_restricted_total = 0   # crops whose true champ is representable in the pool cols
    tpl_correct = 0
    tpl_total = 0
    tpl_score_sum = 0.0

    # Per-champion breakdown: champ -> [correct, total] for each method.
    per_champ = defaultdict(lambda: {
        "cls_full": [0, 0], "cls_restr": [0, 0], "tpl": [0, 0]})

    print("Evaluating crops (classifier + template SSIM)...")
    for folder in candidate_folders:
        paths = crops_by_champ[folder]
        # Batch-load + classifier-infer this champion's crops.
        rgb = np.stack([load_crop_rgb(p) for p in paths])  # (n,32,32,3)
        logits = classifier_logits(CLASSIFIER_ONNX, rgb)   # (n,172)

        true_pool_idx = folder_to_pool_idx.get(folder)  # classifier label idx or None
        true_ddid = folder_to_ddragon.get(folder)       # ground-truth ddragon id

        for i, path in enumerate(paths):
            # --- Classifier (full 172) ---
            # Correct iff the predicted class resolves to the SAME ddragon id as
            # the harvest folder (robust across the two naming styles). If the
            # folder didn't resolve to an id, fall back to sanitize-equality.
            pred_idx = int(logits[i].argmax())
            pred_ddid = idx_to_ddragon.get(pred_idx)
            if true_ddid is not None:
                full_ok = (pred_ddid == true_ddid)
            else:
                full_ok = (sanitize(idx_to_name[pred_idx]) == folder)
            cls_full_correct += full_ok
            per_champ[folder]["cls_full"][1] += 1
            per_champ[folder]["cls_full"][0] += full_ok

            # --- Classifier (restricted to candidate pool columns) ---
            if pool_cols and true_pool_idx is not None:
                restr = logits[i, pool_cols]
                # The winning column's underlying classifier index == the
                # ground-truth label index iff this crop is classified correctly
                # within the pool.
                pred_restr_idx = pool_cols[int(restr.argmax())]
                restr_ok = (pred_restr_idx == true_pool_idx)
                cls_restricted_correct += restr_ok
                cls_restricted_total += 1
                per_champ[folder]["cls_restr"][1] += 1
                per_champ[folder]["cls_restr"][0] += restr_ok

            # --- Template SSIM (best-of-N over candidate templates) ---
            if templates:
                cg = to_gray(rgb[i])
                pred_tpl, score = best_template_match(cg, templates, mask)
                tpl_ok = (pred_tpl == folder)
                tpl_correct += tpl_ok
                tpl_total += 1
                tpl_score_sum += score
                per_champ[folder]["tpl"][1] += 1
                per_champ[folder]["tpl"][0] += tpl_ok
        # progress dot per champion
        sys.stdout.write(".")
        sys.stdout.flush()
    print("\n")

    # --- Summary table -------------------------------------------------------
    def pct(c, t):
        return f"{100.0 * c / t:5.1f}%" if t else "   n/a"

    print("=" * 78)
    print(f"{'method':<26}{'top-1 (full 172)':>18}{'top-1 (pool)':>16}"
          f"{'mean score':>12}{'n':>6}")
    print("-" * 78)
    print(f"{'Classifier (ONNX)':<26}"
          f"{pct(cls_full_correct, n_total):>18}"
          f"{pct(cls_restricted_correct, cls_restricted_total):>16}"
          f"{'   n/a':>12}{n_total:>6}")
    mean_tpl = (tpl_score_sum / tpl_total) if tpl_total else 0.0
    print(f"{'Template (SSIM best-of-N)':<26}"
          f"{'   n/a':>18}"
          f"{pct(tpl_correct, tpl_total):>16}"
          f"{mean_tpl:>12.3f}{tpl_total:>6}")
    print("=" * 78)
    print("Notes:")
    print("  - Classifier 'full 172' = argmax over all classes; 'pool' = argmax")
    print("    restricted to the harvested champions (fair vs template best-of-N).")
    print("  - Template has no notion of 172 classes; it only ever picks from the")
    print(f"    {len(templates)}-champion pool, so only a 'pool' column applies.")
    print("  - Mean score is the winning SSIM. Real matches are weak (often ~0.3).")
    print()

    # --- Per-champion breakdown ---------------------------------------------
    print("Per-champion accuracy (correct/total):")
    print(f"{'champion (ddragon id)':<34}{'cls full':>12}{'cls pool':>12}{'template':>12}")
    print("-" * 70)
    for folder in candidate_folders:
        d = per_champ[folder]
        cf, ct = d["cls_full"]
        rf, rt = d["cls_restr"]
        tf, tt = d["tpl"]
        ddid = folder_to_ddragon.get(folder, "?")
        label = f"{folder} ({ddid})"
        if len(label) > 33:
            label = label[:30] + "..."
        print(f"{label:<34}"
              f"{(pct(cf, ct) + f' {cf}/{ct}'):>12}"
              f"{(pct(rf, rt) + f' {rf}/{rt}'):>12}"
              f"{(pct(tf, tt) + f' {tf}/{tt}'):>12}")
    print("-" * 70)
    print("Tip: scan the per-champion rows for classes the classifier botches but")
    print("template fixes (e.g. Teemo) — that's the real-data signal worth acting on.")


if __name__ == "__main__":
    main()
