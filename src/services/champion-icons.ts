// Fetches the actual icons of the (up to) 10 champions in the current match
// from Riot's Data Dragon CDN and turns each into a circular template for
// per-game template matching (see template-match.ts). We know the exact
// champions at game start from the LCU, so this is a tiny, bounded fetch.
//
// Why Data Dragon: stable, documented, no auth. The champion *square* portrait
// (`img/champion/<Id>.png`, 120×120) circular-cropped is a close match for the
// in-game circular minimap icon and is brightness-robust under NCC. If real
// minimap fidelity needs improving we can swap to Community Dragon's circular
// `champion-icons/<key>.png` — the URL is the only thing that changes.

const DDRAGON = 'https://ddragon.leagueoflegends.com';

/**
 * Build a lowercased display-name → Data-Dragon-id map from a Data Dragon
 * `champion.json` payload. Pure + testable. The LCU returns display names
 * ("Nunu & Willump", "Dr. Mundo", "Wukong") while the icon URL needs the id
 * ("Nunu", "DrMundo", "MonkeyKing"); champion.json carries both.
 */
export function buildNameToId(championJson: { data?: Record<string, { id?: string; name?: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  const data = championJson.data ?? {};
  for (const entry of Object.values(data)) {
    if (entry.name && entry.id) out[entry.name.toLowerCase()] = entry.id;
  }
  return out;
}

/**
 * Resolve an LCU champion display name to its Data Dragon id. Pure + testable.
 * Falls back to a de-punctuated exact-id guess (strip spaces/'.'/'&') for the
 * rare champion missing from the name map.
 */
export function championNameToId(displayName: string, nameToId: Record<string, string>): string | null {
  const direct = nameToId[displayName.toLowerCase().trim()];
  if (direct) return direct;
  // Last-ditch: Data Dragon ids are the name with spaces/punctuation removed
  // and internal-cased (e.g. "Dr. Mundo" → "DrMundo"), which holds for most.
  const guess = displayName.replace(/[^a-zA-Z0-9]/g, '');
  return guess.length ? guess : null;
}

export interface ChampionTemplate {
  name: string;        // LCU display name (key used elsewhere)
  rgba: Uint8ClampedArray; // size×size circular icon, RGBA
  size: number;
}

let cachedVersion: string | null = null;
let cachedNameToId: Record<string, string> | null = null;

async function getLatestVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const resp = await fetch(`${DDRAGON}/api/versions.json`);
  const versions: string[] = await resp.json();
  cachedVersion = versions[0];
  return cachedVersion;
}

async function getNameToId(version: string): Promise<Record<string, string>> {
  if (cachedNameToId) return cachedNameToId;
  const resp = await fetch(`${DDRAGON}/cdn/${version}/data/en_US/champion.json`);
  cachedNameToId = buildNameToId(await resp.json());
  return cachedNameToId;
}

/**
 * Load a circular RGBA template for each given champion display name, scaled
 * to `size`. Best-effort: a champion whose icon fails to fetch is skipped
 * (the caller falls back to the classifier for that one). Browser-only
 * (uses Image + canvas).
 */
export async function loadChampionTemplates(displayNames: string[], size = 32): Promise<ChampionTemplate[]> {
  const version = await getLatestVersion();
  const nameToId = await getNameToId(version);
  const unique = Array.from(new Set(displayNames));

  const results = await Promise.all(unique.map(async (name): Promise<ChampionTemplate | null> => {
    const id = championNameToId(name, nameToId);
    if (!id) return null;
    try {
      const rgba = await fetchIconAsCircularRgba(`${DDRAGON}/cdn/${version}/img/champion/${id}.png`, size);
      return { name, rgba, size };
    } catch {
      console.warn('[ChampionIcons] failed to load icon for', name, '(' + id + ')');
      return null;
    }
  }));

  return results.filter((t): t is ChampionTemplate => t !== null);
}

/**
 * Fetch a PNG, draw it scaled into a size×size canvas, apply a circular alpha
 * mask, and return the RGBA bytes. Browser-only.
 */
function fetchIconAsCircularRgba(url: string, size: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no 2d context')); return; }
        // Circular clip so corners/ring don't pollute the template.
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);
        resolve(ctx.getImageData(0, 0, size, size).data);
      } catch (e) {
        reject(e as Error);
      }
    };
    img.onerror = () => reject(new Error('image load error: ' + url));
    img.src = url;
  });
}
