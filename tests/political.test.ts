import { describe, expect, it } from 'vitest';
import { computeStats, derivePolitical } from '../src/core/political';
import { autoGeneratePolitical } from '../src/core/autogen';
import type { BorderStroke, CountryRecord } from '../src/core/world';

function disk(w: number, h: number, cx: number, cy: number, r: number, land = new Uint8Array(w * h)) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) land[y * w + x] = 1;
  return land;
}

describe('derivePolitical', () => {
  const w = 80;
  const h = 60;

  it('国境線で陸地が 2 国に分かれ、面積の合計が陸地と一致する', () => {
    const land = disk(w, h, 40, 30, 25);
    const borders: BorderStroke[] = [{ id: 1, kind: 'national', points: [[40.3, 0], [40.3, 60]] }];
    const res = derivePolitical({ land, w, h, borders, countries: [], states: [], seed: 1, nextId: 10 });
    expect(res.countries.length).toBe(2);
    expect(res.addedCountries).toBe(2);
    let landCells = 0;
    for (const v of land) landCells += v;
    const stats = computeStats(res, w, h, 2);
    const total = stats.countries.reduce((s, c) => s + c.cells, 0);
    expect(total).toBe(landCells);
    expect(stats.countries[0].area).toBe(stats.countries[0].cells * 4);
    // 互いに隣接し、共有境界の長さはほぼ直径
    const len = stats.countries[0].neighbors.get(1)!;
    expect(len).toBeGreaterThan(80);
    expect(len).toBeLessThan(120);
    expect(stats.countries[1].neighbors.get(0)).toBeCloseTo(len, 5);
    // 境界線上のセルも吸収され、陸に未割当は無い
    for (let i = 0; i < w * h; i++) if (land[i]) expect(res.country[i]).toBeGreaterThanOrEqual(0);
  });

  it('既存の国は代表点で同一性を保つ', () => {
    const land = disk(w, h, 40, 30, 25);
    const borders: BorderStroke[] = [{ id: 1, kind: 'national', points: [[40.3, 0], [40.3, 60]] }];
    const countries: CountryRecord[] = [
      { id: 5, name: 'ヒガシ', gov: '王国', color: '#fff', culture: 'west', subdivision: '州', capital: 'A', anchors: [[60, 30]] },
    ];
    const res = derivePolitical({ land, w, h, borders, countries, states: [], seed: 1, nextId: 10 });
    expect(res.countries[0].name).toBe('ヒガシ');
    expect(res.country[30 * w + 55]).toBe(0);
    expect(res.country[30 * w + 25]).toBe(1);
  });

  it('途切れた国境線は区画を分けない', () => {
    const land = disk(w, h, 40, 30, 25);
    const borders: BorderStroke[] = [{ id: 1, kind: 'national', points: [[40.3, 10], [40.3, 40]] }];
    const res = derivePolitical({ land, w, h, borders, countries: [], states: [], seed: 1, nextId: 10 });
    expect(res.countries.length).toBe(1);
  });

  it('小島は最寄りの国に属する', () => {
    const land = disk(w, h, 30, 30, 20);
    land[30 * w + 60] = 1;
    land[30 * w + 61] = 1;
    const res = derivePolitical({ land, w, h, borders: [], countries: [], states: [], seed: 1, nextId: 10 });
    expect(res.countries.length).toBe(1);
    expect(res.country[30 * w + 60]).toBe(0);
  });

  it('州境は国の内部を分け、州は国をまたがない', () => {
    const land = disk(w, h, 40, 30, 25);
    const borders: BorderStroke[] = [
      { id: 1, kind: 'national', points: [[40.3, 0], [40.3, 60]] },
      { id: 2, kind: 'state', points: [[0, 30.3], [80, 30.3]] },
    ];
    const res = derivePolitical({ land, w, h, borders, countries: [], states: [], seed: 1, nextId: 10 });
    expect(res.countries.length).toBe(2);
    expect(res.states.length).toBe(4);
    const stateCountry = new Map<number, number>();
    for (let i = 0; i < w * h; i++) {
      if (res.state[i] < 0) continue;
      const c = stateCountry.get(res.state[i]);
      if (c === undefined) stateCountry.set(res.state[i], res.country[i]);
      else expect(c).toBe(res.country[i]);
    }
  });
});

describe('autoGeneratePolitical', () => {
  it('生成した境界線から再計算した区画が生成結果とほぼ一致する', () => {
    const w = 160;
    const h = 120;
    const land = disk(w, h, 70, 60, 50);
    disk(w, h, 140, 30, 12, land);
    const gen = autoGeneratePolitical(land, w, h, { elevation: null, acc: null, riverThreshold: 0 }, { countries: 5, statesPerCountry: 3, seed: 7 }, 1);
    expect(gen.countries.length).toBeGreaterThanOrEqual(5);
    const res = derivePolitical({ land, w, h, borders: gen.borders, countries: gen.countries, states: gen.states, seed: 7, nextId: gen.nextId });
    expect(res.addedCountries).toBe(0);
    let same = 0;
    let total = 0;
    for (let i = 0; i < w * h; i++) {
      if (!land[i]) continue;
      total++;
      if (res.country[i] === gen.countryGrid[i]) same++;
    }
    expect(same / total).toBeGreaterThan(0.97);
    const names = new Set(res.countries.map((c) => c.name));
    expect(names.size).toBe(res.countries.length);
  });
});

describe('regenerateCountryStates', () => {
  it('選んだ国の州だけを作り直す', async () => {
    const { regenerateCountryStates } = await import('../src/core/edits');
    const { createWorld } = await import('../src/core/world');
    const w = 160;
    const h = 120;
    const land = disk(w, h, 80, 60, 50);
    const gen = autoGeneratePolitical(land, w, h, { elevation: null, acc: null, riverThreshold: 0 }, { countries: 3, statesPerCountry: 2, seed: 3 }, 1);
    const world = { ...createWorld(w, h, 3), borders: gen.borders, countries: gen.countries, states: gen.states, nextId: gen.nextId };
    const derive = (wd: typeof world) => derivePolitical({ land, w, h, borders: wd.borders, countries: wd.countries, states: wd.states, seed: 3, nextId: wd.nextId });
    const before = derive(world);
    const countStates = (lab: ReturnType<typeof derive>, ci: number) => {
      const set = new Set<number>();
      for (let i = 0; i < w * h; i++) if (lab.country[i] === ci && lab.state[i] >= 0) set.add(lab.state[i]);
      return set.size;
    };
    const others = [1, 2].map((c) => countStates(before, c));
    const next = regenerateCountryStates(world, land, before, 0, 6, { elevation: null, acc: null, riverThreshold: 0 }, 11);
    const after = derive(next);
    expect(after.addedCountries).toBe(0);
    expect(countStates(after, 0)).toBe(6);
    expect([1, 2].map((c) => countStates(after, c))).toEqual(others);
    // 国の領域は変わらない
    for (let i = 0; i < w * h; i++) expect(after.country[i]).toBe(before.country[i]);
  });
});

describe('国境線の扱い（意図どおりの形）', () => {
  const w = 80;
  const h = 60;
  const derive = (land: Uint8Array, borders: BorderStroke[], countries: CountryRecord[] = []) =>
    derivePolitical({ land, w, h, borders, countries, states: [], seed: 1, nextId: 100 });

  it('区画の境目は描いた線に沿い、どちらかに 1 セルずれない', () => {
    const land = new Uint8Array(w * h).fill(1);
    // セルの角を通る縦線 x=40：x<40 が西、x>=40 が東
    const r = derive(land, [{ id: 1, kind: 'national', points: [[40, 0], [40, 60]] }]);
    for (let y = 0; y < h; y++) {
      expect(r.country[y * w + 39]).toBe(r.country[30 * w + 10]);
      expect(r.country[y * w + 40]).toBe(r.country[30 * w + 70]);
    }
    // 斜めの線でも、セル中心が線のどちら側にあるかで決まる
    const d = derive(land, [{ id: 1, kind: 'national', points: [[10, 0], [70, 60]] }]);
    const upper = d.country[5 * w + 60];
    let wrong = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const side = (60 * (y + 0.5 - 0) - 60 * (x + 0.5 - 10)); // cross((60,60),(p-a))
        if (Math.abs(side) < 1e-9) continue;
        const expectUpper = side < 0;
        if ((d.country[y * w + x] === upper) !== expectUpper) wrong++;
      }
    expect(wrong).toBe(0);
  });

  it('国境線で囲んだ小さな国も消えずに国になる（細い切れ端は除く）', () => {
    const land = disk(w, h, 40, 30, 25);
    const loop: [number, number][] = [];
    for (let k = 0; k <= 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      loop.push([30 + Math.cos(a) * 3.5, 30 + Math.sin(a) * 3.5]);
    }
    const r = derive(land, [{ id: 1, kind: 'national', points: loop }]);
    expect(r.countries.length).toBe(2);
    expect(r.country[30 * w + 30]).not.toBe(r.country[30 * w + 50]);
    // 2 本の平行線の間の細い帯は国にならない
    const thin = derive(land, [
      { id: 1, kind: 'national', points: [[40, 0], [40, 60]] },
      { id: 2, kind: 'national', points: [[41.5, 0], [41.5, 60]] },
    ]);
    expect(thin.countries.length).toBe(2);
  });

  it('海の上に引いた国境線で、小島の所属を決められる', () => {
    const land = new Uint8Array(w * h);
    for (let y = 10; y < 50; y++) for (let x = 5; x < 70; x++) land[y * w + x] = 1;
    land[55 * w + 30] = 1;
    land[55 * w + 31] = 1;
    // 本土を x=34 で東西に分け、その線を海の上で西へ曲げる（小島は西の国に近いが線の東側）
    const border: BorderStroke = { id: 1, kind: 'national', points: [[34, 0], [34, 50], [24, 60]] };
    const r = derive(land, [border]);
    const west = r.country[30 * w + 10];
    const east = r.country[30 * w + 60];
    expect(west).not.toBe(east);
    expect(r.country[55 * w + 30]).toBe(east);
  });
});
