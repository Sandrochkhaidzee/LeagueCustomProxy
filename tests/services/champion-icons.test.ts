import { buildNameToId, championNameToId } from '../../src/services/champion-icons';

// Minimal Data Dragon champion.json shape: data keyed by id, each has id+name.
const championJson = {
  data: {
    Teemo: { id: 'Teemo', name: 'Teemo' },
    Nunu: { id: 'Nunu', name: 'Nunu & Willump' },
    DrMundo: { id: 'DrMundo', name: 'Dr. Mundo' },
    MonkeyKing: { id: 'MonkeyKing', name: 'Wukong' },
    Ahri: { id: 'Ahri', name: 'Ahri' },
  },
};

describe('buildNameToId', () => {
  test('maps lowercased display names to Data Dragon ids', () => {
    const m = buildNameToId(championJson);
    expect(m['teemo']).toBe('Teemo');
    expect(m['nunu & willump']).toBe('Nunu');
    expect(m['dr. mundo']).toBe('DrMundo');
    expect(m['wukong']).toBe('MonkeyKing');
  });
  test('tolerates empty/malformed payloads', () => {
    expect(buildNameToId({})).toEqual({});
    expect(buildNameToId({ data: {} })).toEqual({});
  });
});

describe('championNameToId', () => {
  const m = buildNameToId(championJson);

  test('resolves the tricky display names that broke the classifier', () => {
    expect(championNameToId('Nunu & Willump', m)).toBe('Nunu');
    expect(championNameToId('Dr. Mundo', m)).toBe('DrMundo');
    expect(championNameToId('Wukong', m)).toBe('MonkeyKing');
  });
  test('is case/whitespace tolerant', () => {
    expect(championNameToId('  teemo ', m)).toBe('Teemo');
  });
  test('falls back to a de-punctuated guess for an unknown name', () => {
    // Not in the map → strip non-alphanumerics. (Real DDragon ids mostly follow this.)
    expect(championNameToId('Some New Champ', {})).toBe('SomeNewChamp');
    expect(championNameToId("Kai'Sa", {})).toBe('KaiSa');
  });
});
