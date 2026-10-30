import { describe, expect, it } from 'vitest';
import { autoGeneratePolitical } from '../src/core/autogen';
import { mergeRegions, paintTerritory, retracePolitical } from '../src/core/edits';
import { generateTerrain } from '../src/core/generate';
import { CULTURES } from '../src/core/names';
import { derivePolitical, type PoliticalLabels } from '../src/core/political';
import { sampleSketch } from '../src/core/sample';
import { createWorld, landFromCoast, type WorldState } from '../src/core/world';

const W = 240;
const H = 160;

function setup(seed = 4): { world: WorldState; land: Uint8Array; labels: PoliticalLabels } {
  const base = createWorld(W, H, seed);
  base.paint = sampleSketch(W, H, seed);
  const terrain = generateTerrain({ paint: base.paint, w: W, h: H, seed, params: base.params, ridges: [] });
  const land = landFromCoast(terrain.coast);
  const gen = autoGeneratePolitical(land, W, H, { elevation: terrain.elevation, acc: null, riverThreshold: 0 }, { countries: 6, statesPerCountry: 3, seed }, 1);
  const world = { ...base, terrain, borders: gen.borders, countries: gen.countries, states: gen.states, nextId: gen.nextId };
  return { world, land, labels: derive(world, land) };
}

function derive(world: WorldState, land: Uint8Array): PoliticalLabels {
  return derivePolitical({ land, w: W, h: H, borders: world.borders, countries: world.countries, states: world.states, seed: world.seed, nextId: world.nextId, cultures: world.nameCultures });
}

function sameGrid(a: Int32Array, b: Int32Array, land: Uint8Array): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (land[i] && a[i] !== b[i]) diff++;
  return diff;
}

describe('区画からの境界線の作り直し', () => {
  it('作り直した境界線を読み直すと、区画が完全に一致する（何度繰り返してもずれない）', () => {
    const { world, land, labels } = setup();
    let w = world;
    let lab = labels;
    for (let round = 0; round < 3; round++) {
      w = retracePolitical(w, land, lab.country, lab.state, lab.countries, lab.states);
      const again = derive(w, land);
      expect(again.addedCountries).toBe(0);
      expect(again.addedStates).toBe(0);
      expect(sameGrid(again.country, labels.country, land)).toBe(0);
      expect(sameGrid(again.state, labels.state, land)).toBe(0);
      lab = again;
    }
  });
});

describe('領土ブラシ', () => {
  it('塗った所だけが指定した国の領土になり、ほかは変わらない', () => {
    const { world, land, labels } = setup();
    // 隣り合う 2 国を探し、A の領土に接する B の陸を塗る
    let a = -1;
    let b = -1;
    const cells: number[] = [];
    for (let i = 0; i < W * H && a < 0; i++) {
      const x = i % W;
      if (x < W - 1 && land[i] && land[i + 1] && labels.country[i] >= 0 && labels.country[i + 1] >= 0 && labels.country[i] !== labels.country[i + 1]) {
        a = labels.country[i];
        b = labels.country[i + 1];
        const cx = x + 1;
        const cy = Math.floor(i / W);
        for (let y = cy - 3; y <= cy + 3; y++) for (let xx = cx; xx <= cx + 4; xx++) {
          const j = y * W + xx;
          if (y >= 0 && y < H && xx < W && land[j] && labels.country[j] === b) cells.push(j);
        }
      }
    }
    expect(cells.length).toBeGreaterThan(5);
    const next = paintTerritory(world, land, labels, cells, { kind: 'country', index: a });
    const after = derive(next, land);
    const painted = new Set(cells);
    for (let i = 0; i < W * H; i++) {
      if (!land[i]) continue;
      if (painted.has(i)) expect(after.country[i]).toBe(a);
      else expect(after.country[i]).toBe(labels.country[i]);
    }
    // 塗った所は A の州のどれかに入る
    for (const i of cells) expect(after.countries[after.country[i]].id).toBe(after.countries[a].id);
  });

  it('新しい国を塗って作れる', () => {
    const { world, land, labels } = setup();
    const cells: number[] = [];
    let cx = -1;
    for (let i = 0; i < W * H; i++) if (land[i] && labels.country[i] >= 0) { cx = i; break; }
    // 内陸の 6×6 を塗る
    let center = -1;
    for (let i = W * 20; i < W * H - W * 20 && center < 0; i++) {
      const x = i % W;
      if (x < 10 || x > W - 10) continue;
      let ok = true;
      for (let dy = -4; dy <= 4 && ok; dy++) for (let dx = -4; dx <= 4; dx++) if (!land[i + dy * W + dx]) { ok = false; break; }
      if (ok) center = i;
    }
    void cx;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) cells.push(center + dy * W + dx);
    const next = paintTerritory(world, land, labels, cells, { kind: 'new' });
    const after = derive(next, land);
    expect(after.countries.length).toBe(labels.countries.length + 1);
    const nc = after.countries.length - 1;
    for (const i of cells) expect(after.country[i]).toBe(nc);
    expect(CULTURES.find((c) => c.key === after.countries[nc].culture)?.western).toBe(true);
  });

  it('隣の国を統合できる', () => {
    const { world, land, labels } = setup();
    const before = new Set<number>();
    for (let i = 0; i < W * H; i++) if (labels.country[i] >= 0) before.add(labels.country[i]);
    const [a, b] = [...before];
    const next = mergeRegions(world, land, labels, 'country', a, b);
    const after = derive(next, land);
    for (let i = 0; i < W * H; i++) {
      if (!land[i]) continue;
      const expected = labels.country[i] === b ? a : labels.country[i];
      expect(after.country[i]).toBe(expected);
    }
  });
});

describe('命名文化', () => {
  it('既定では西洋系の文化だけで国名を作る', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { labels } = setup(seed);
      for (const c of labels.countries) expect(CULTURES.find((x) => x.key === c.culture)?.western).toBe(true);
    }
  });
});
