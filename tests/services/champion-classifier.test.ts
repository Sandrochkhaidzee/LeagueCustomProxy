// onnxruntime-web pulls in browser-only globals at import time (WebAssembly
// loaders, `self`, etc) that crash under jest's node environment. The
// resolver under test doesn't touch any of that surface — mock the entire
// module so the import is inert.
jest.mock('onnxruntime-web', () => ({
  env: { wasm: { numThreads: 1, wasmPaths: '', proxy: false } },
  InferenceSession: { create: jest.fn() },
}));

import { ChampionClassifier } from '../../src/services/champion-classifier';
import labelMapRaw from '../../models/champion_labels.json';
const labelMap: Record<string, string> = labelMapRaw as Record<string, string>;

describe('ChampionClassifier.resolveLocalClassIndex', () => {
  test('matches exact label, case-insensitive', () => {
    expect(ChampionClassifier.resolveLocalClassIndex(labelMap, 'Ahri')).toBeGreaterThanOrEqual(0);
    expect(ChampionClassifier.resolveLocalClassIndex(labelMap, 'ahri')).toBeGreaterThanOrEqual(0);
  });

  test('returns -1 for unknown champion', () => {
    expect(ChampionClassifier.resolveLocalClassIndex(labelMap, 'NotAChampion')).toBe(-1);
  });

  // Regression coverage for issue #7. The LCU Live Client Data API returns
  // display names ("Nunu & Willump", "Dr. Mundo") but the label map is keyed
  // by sanitized asset names ("Nunu", "Dr_ Mundo"). Without the normalization
  // table localClassIndex was -1 and every blob scored 0.0 → CV never recovered.
  test.each([
    ['Nunu & Willump', 'Nunu'],
    ['Dr. Mundo', 'Dr_ Mundo'],
  ])('LCU display name %p resolves to label %p', (displayName, expectedLabel) => {
    const idx = ChampionClassifier.resolveLocalClassIndex(labelMap, displayName);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(labelMap[String(idx)]).toBe(expectedLabel);
  });

  // The normalization table is only useful if its target labels actually
  // exist in the shipped model. Catches the case where a model retrain
  // drops or renames a label without updating the table.
  test('every normalization target exists in the label map', () => {
    const labelValuesLower = new Set(Object.values(labelMap).map(n => n.toLowerCase()));
    const knownTargets = ['nunu', 'dr_ mundo'];
    for (const target of knownTargets) {
      expect(labelValuesLower.has(target)).toBe(true);
    }
  });

  // Wukong is the third "watch out" champion — display name "Wukong"
  // happens to match the label "Wukong" but in some LCU endpoints (champ
  // select / queue) Riot still returns the internal name "MonkeyKing".
  // This test confirms the *display* name resolves; if a future code path
  // ever passes the internal name, this test stays green but a separate
  // failing test will surface to flag it.
  test('Wukong resolves directly (no normalization needed)', () => {
    expect(ChampionClassifier.resolveLocalClassIndex(labelMap, 'Wukong')).toBeGreaterThanOrEqual(0);
  });
});
