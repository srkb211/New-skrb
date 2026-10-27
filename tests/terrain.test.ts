import { describe, expect, it } from 'vitest';
import { analyzeTerrain, generateTerrain, regeneratePartial } from '../src/core/generate';
import { DEFAULT_PARAMS, landFromCoast } from '../src/core/world';

function paintDisk(w: number, h: number) {
  const paint = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - w / 2) ** 2 + (y - h / 2) ** 2 < (h * 0.35) ** 2) paint[y * w + x] = 1;
  return paint;
}

describe('terrain generation', () => {
  const w = 200;
  const h = 140;
  const paint = paintDisk(w, h);
  const job = { paint, w, h, seed: 5, params: { ...DEFAULT_PARAMS }, ridges: [] };
  const t = generateTerrain(job);

  it('同じシードなら同じ結果になる（決定的）', () => {
    const t2 = generateTerrain(job);
    expect(Array.from(t2.elevation)).toEqual(Array.from(t.elevation));
  });

  it('陸は標高が正、海は負で、描いた形をおおむね保つ', () => {
    const land = landFromCoast(t.coast);
    let agree = 0;
    let total = 0;
    for (let i = 0; i < w * h; i++) {
      if (land[i]) expect(t.elevation[i]).toBeGreaterThan(0);
      else expect(t.elevation[i]).toBeLessThan(0);
      total++;
      if (land[i] === paint[i]) agree++;
    }
    expect(agree / total).toBeGreaterThan(0.85);
  });

  it('川はすべて海かマップ端まで流れ下る', () => {
    const a = analyzeTerrain(t, w, h, DEFAULT_PARAMS);
    expect(a.hydrology.rivers.length).toBeGreaterThan(0);
    const { receiver } = a.hydrology.flow;
    for (const r of a.hydrology.rivers) {
      if (r.parent >= 0) continue;
      const mouth = r.mouth;
      expect(receiver[mouth]).toBeLessThan(0);
    }
    // 流下をたどると必ず終端に着く（循環しない）
    for (let i = 0; i < w * h; i += 37) {
      if (!a.land[i]) continue;
      let c = i;
      let steps = 0;
      while (receiver[c] >= 0 && steps < w * h) {
        c = receiver[c];
        steps++;
      }
      expect(receiver[c]).toBeLessThan(0);
    }
  });

  it('保存して読み込んでも河川の解析結果が変わらない', async () => {
    const { createWorld } = await import('../src/core/world');
    const { encodeWorld, decodeWorld } = await import('../src/core/serialize');
    const world = { ...createWorld(w, h, 5), paint, terrain: t };
    const back = decodeWorld(encodeWorld(world));
    expect(Array.from(back.terrain!.elevation)).toEqual(Array.from(t.elevation));
    const a1 = analyzeTerrain(t, w, h, DEFAULT_PARAMS);
    const a2 = analyzeTerrain(back.terrain!, w, h, DEFAULT_PARAMS);
    expect(a2.hydrology.rivers.length).toBe(a1.hydrology.rivers.length);
    expect(Array.from(a2.hydrology.lake)).toEqual(Array.from(a1.hydrology.lake));
  });

  it('部分再生成は選択範囲の外を変えない', () => {
    const selection = new Uint8Array(w * h);
    for (let y = 20; y < 60; y++) for (let x = 20; x < 80; x++) selection[y * w + x] = 1;
    const p = regeneratePartial({ ...job, old: t, selection, mode: 'all', variationSeed: 999 });
    let changedInside = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const far = x > 110 || y > 90;
        if (far) {
          expect(p.coast[i]).toBe(t.coast[i]);
        } else if (selection[i] && p.elevation[i] !== t.elevation[i]) changedInside++;
      }
    expect(changedInside).toBeGreaterThan(100);
  });
});
