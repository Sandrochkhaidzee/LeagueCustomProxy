#!/usr/bin/env node
/**
 * Prints a Markdown summary of how the champion-icon manifest changed versus the
 * committed version (HEAD) — used to populate the body of the automated retrain
 * PR opened by .github/workflows/icon-watch.yml.
 *
 * Compares `git show HEAD:models/champion-icons-manifest.json` (old) against the
 * working-tree manifest (new). On the first run (no committed manifest yet) it
 * reports the full set as the initial baseline.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MANIFEST = 'models/champion-icons-manifest.json';

const neu = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const old = (() => {
  const r = spawnSync('git', ['show', `HEAD:${MANIFEST}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
})();

const champCount = (m) => (m?.champions ? Object.keys(m.champions).length : 0);
const iconCount = (m) =>
  m?.champions ? Object.values(m.champions).reduce((s, c) => s + Object.keys(c).length, 0) : 0;

const out = [];
out.push(`**Patch:** \`${neu.version}\` · **${champCount(neu)} champions** · **${iconCount(neu)} icons**`);
out.push('');

if (!old) {
  out.push('First committed manifest (baseline) — the classifier is trained on the full current icon set.');
} else {
  const oc = old.champions ?? {};
  const nc = neu.champions ?? {};
  const added = Object.keys(nc).filter((k) => !(k in oc)).sort();
  const removed = Object.keys(oc).filter((k) => !(k in nc)).sort();
  const changed = [];
  for (const name of Object.keys(nc)) {
    if (!(name in oc)) continue;
    const a = oc[name];
    const b = nc[name];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let skinDelta = 0;
    let reworked = 0;
    for (const k of keys) {
      if (!(k in a) || !(k in b)) skinDelta++;
      else if (a[k] !== b[k]) reworked++;
    }
    if (skinDelta || reworked) changed.push(`${name} (${skinDelta} skin±, ${reworked} reworked)`);
  }
  out.push(`- **New champions:** ${added.length ? added.join(', ') : 'none'}`);
  out.push(`- **Removed champions:** ${removed.length ? removed.join(', ') : 'none'}`);
  out.push(`- **Changed (added/removed/reworked skins):** ${changed.length ? `${changed.length} champions` : 'none'}`);
  if (changed.length) {
    out.push('');
    out.push('<details><summary>Per-champion changes</summary>');
    out.push('');
    for (const c of changed) out.push(`- ${c}`);
    out.push('</details>');
  }
}

out.push('');
out.push('---');
out.push('');
out.push(
  '⚠️ **Validate tracking in a real game before merging** — the classifier is load-bearing for tracking quality, and per-class accuracy varies by icon.',
);
out.push('');
out.push(
  'After merge: bump `version` in `src-tauri/Cargo.toml`, add a `CHANGELOG.md` entry, then push a `v*` tag — that triggers `release.yml`, which builds the Windows exe and creates a **draft** release for you to publish.',
);

console.log(out.join('\n'));
