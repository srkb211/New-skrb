import { describe, expect, it } from 'vitest';
import {
  BIOME_INDEX,
  CLIMATE_VERSION,
  classifyBiome,
  classifyKoppen,
  climateCellAt,
  climateCellInfo,
  climateCsv,
  computeClimate,
  DEFAULT_BIOME,
  DEFAULT_CLIMATE_PARAMS,
  DEFAULT_KOPPEN,
  KOPPEN_CODES,
  summerMonths,
  validateClimate,
  type ClimateInput,
} from '../src/core/climate';
import { DEFAULT_GEO_FRAME, latitudeAt, latitudeLines } from '../src/core/geoframe';
import { decodeWorldChecked, encodeWorld } from '../src/core/serialize';
import { createWorld } from '../src/core/world';

const W = 120;
const H = 80;

/** 中央に大きな陸地がある世界（標高は関数で与える） */
function world(elev: (x: number, y: number) => number = () => 50, margin = 12): { land: Uint8Array; elevation: Float32Array } {
  const land = new Uint8Array(W * H);
  const elevation = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const isLand = x >= margin && x < W - margin && y >= margin && y < H - margin;
      land[i] = isLand ? 1 : 0;
      elevation[i] = isLand ? elev(x, y) : -2000;
    }
  return { land, elevation };
}

function input(over: Partial<ClimateInput> = {}): ClimateInput {
  const { land, elevation } = world();
  return {
    w: W,
    h: H,
    kmPerCell: 20,
    land,
    elevation,
    frame: { ...DEFAULT_GEO_FRAME, centerLat: 40, kmPerDegree: 111 },
    params: { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2 },
    ...over,
  };
}

const at = (c: ReturnType<typeof computeClimate>, x: number, y: number) => climateCellAt(c, x, y);

describe('緯度相当の座標系', () => {
  it('地図の Y ではなく世界設定から緯度相当を求める', () => {
    const f = { ...DEFAULT_GEO_FRAME, centerLat: 10, kmPerDegree: 100 };
    expect(latitudeAt(f, 100, 100, 10, 50, 50)).toBeCloseTo(10);
    // 北相当が地図の上：上に行くほど高緯度
    expect(latitudeAt(f, 100, 100, 10, 50, 0)).toBeCloseTo(15);
    // 北相当を地図の右に回すと、Y を動かしても緯度は変わらない
    const east = { ...f, northAngle: 90 };
    expect(latitudeAt(east, 100, 100, 10, 50, 0)).toBeCloseTo(10);
    expect(latitudeAt(east, 100, 100, 10, 100, 50)).toBeCloseTo(15);
    expect(latitudeLines(f, 100, 100, 10, 5).map((l) => l.lat)).toEqual([5, 10, 15]);
  });

  it('北相当の向きを変えると気温の勾配の向きも変わる', () => {
    const up = computeClimate(input({ frame: { ...DEFAULT_GEO_FRAME, centerLat: 40, kmPerDegree: 30 } }));
    const right = computeClimate(input({ frame: { ...DEFAULT_GEO_FRAME, centerLat: 40, kmPerDegree: 30, northAngle: 90 } }));
    // 上が北なら上の方が寒い
    expect(up.tMean[at(up, 60, 20)]).toBeLessThan(up.tMean[at(up, 60, 60)]);
    // 右が北なら右の方が寒く、上下ではほぼ同じ
    expect(right.tMean[at(right, 95, 40)]).toBeLessThan(right.tMean[at(right, 25, 40)]);
    expect(Math.abs(right.tMean[at(right, 60, 20)] - right.tMean[at(right, 60, 60)])).toBeLessThan(3);
  });
});

describe('computeClimate', () => {
  it('同じ入力・シードなら同じ結果になり、バージョンを記録する', () => {
    const a = computeClimate(input());
    const b = computeClimate(input());
    expect(Array.from(a.tMean)).toEqual(Array.from(b.tMean));
    expect(Array.from(a.precip)).toEqual(Array.from(b.precip));
    expect(Array.from(a.biome)).toEqual(Array.from(b.biome));
    expect(a.meta.version).toBe(CLIMATE_VERSION);
    expect(a.meta.algorithm).toContain('climate');
    const c = computeClimate(input({ params: { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2, seed: 999 } }));
    expect(Array.from(c.tMean)).not.toEqual(Array.from(a.tMean));
  });

  it('標高が高いほど気温減率に従って寒くなる', () => {
    const { land, elevation } = world((x) => (x >= 55 && x < 65 ? 3000 : 50));
    const c = computeClimate(input({ land, elevation, params: { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2, variability: 0 } }));
    const low = c.tMean[at(c, 50, 40)];
    const high = c.tMean[at(c, 60, 40)];
    expect(low - high).toBeGreaterThan(6.5 * 2.95 * 0.8);
    expect(low - high).toBeLessThan(6.5 * 2.95 * 1.25);
  });

  it('内陸ほど気温の年較差が大きい（大陸度）', () => {
    const c = computeClimate(input({ params: { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2, variability: 0 } }));
    const coast = at(c, 13, 40);
    const inland = at(c, 60, 40);
    expect(c.tWarm[inland] - c.tCold[inland]).toBeGreaterThan(c.tWarm[coast] - c.tCold[coast] + 3);
  });

  it('風上の斜面は湿り、山脈の風下は乾く（雨陰）', () => {
    // 西風固定。x=50〜60 が山脈
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2, variability: 0, windMode: 'fixed' as const, windFrom: 270 };
    const ridge = world((x) => (x >= 50 && x < 60 ? 2500 * (1 - Math.abs(x - 55) / 6) : 100));
    const flat = world(() => 100);
    const c = computeClimate(input({ ...ridge, params }));
    const f = computeClimate(input({ ...flat, params }));
    const windward = c.precip[at(c, 52, 40)];
    const lee = c.precip[at(c, 66, 40)];
    expect(windward).toBeGreaterThan(lee * 1.5);
    // 山脈が無い場合より風上斜面は湿り、風下は乾く
    expect(windward).toBeGreaterThan(f.precip[at(f, 52, 40)]);
    expect(lee).toBeLessThan(f.precip[at(f, 66, 40)] * 0.8);
  });

  it('陸のすべての地点に気候区分とバイオームが付き、検証で問題が出ない', () => {
    const c = computeClimate(input());
    const issues = validateClimate(c).filter((i) => i.level === 'error');
    expect(issues).toEqual([]);
    for (let i = 0; i < c.koppen.length; i++) {
      if (c.land[i] >= 0.5) {
        expect(c.koppen[i]).toBeGreaterThan(0);
        expect(c.biome[i]).toBeGreaterThan(0);
      } else expect(c.koppen[i]).toBe(0);
    }
  });

  it('緯度相当が ±90° を超える設定は検証で報告する', () => {
    const c = computeClimate(input({ frame: { ...DEFAULT_GEO_FRAME, centerLat: 85, kmPerDegree: 20 } }));
    expect(c.meta.issues.some((i) => i.code === 'latitude-range')).toBe(true);
  });

  it('範囲外のパラメータは丸めて報告する', () => {
    const c = computeClimate(input({ params: { ...DEFAULT_CLIMATE_PARAMS, gridFactor: 2, lapseRate: 99, precipScale: Number.NaN } }));
    expect(c.meta.params.lapseRate).toBe(15);
    expect(c.meta.issues.filter((i) => i.code.startsWith('param')).length).toBe(2);
  });
});

describe('validateClimate', () => {
  it('欠損値・無効値・範囲外・不整合を検出する', () => {
    const c = computeClimate(input());
    c.tMean[0] = Number.NaN;
    c.precip[1] = -5;
    c.tWarm[2] = c.tCold[2] - 10;
    c.koppen[3] = 200;
    c.highSun = c.highSun.slice(0, 10);
    const codes = validateClimate(c).map((i) => i.code);
    expect(codes).toContain('invalid');
    expect(codes).toContain('precip-range');
    expect(codes).toContain('temp-order');
    expect(codes).toContain('class-code');
    expect(codes).toContain('missing');
  });
});

describe('classifyKoppen', () => {
  const mc = (t: number[], p: number[], northern = true) => ({ t, p, summer: summerMonths(northern) });
  const k = (t: number[], p: number[], th = DEFAULT_KOPPEN, northern = true) => KOPPEN_CODES[classifyKoppen(mc(t, p, northern), th)];

  it('代表的な気候を判定できる', () => {
    // シンガポール風
    expect(k(Array(12).fill(27), Array(12).fill(200))).toBe('Af');
    // カイロ風
    expect(k([14, 15, 17, 21, 24, 27, 28, 28, 26, 23, 19, 15], [5, 4, 4, 1, 1, 0, 0, 0, 0, 1, 3, 5])).toBe('BWh');
    // ロンドン風
    expect(k([5, 5, 7, 9, 12, 15, 17, 17, 14, 11, 8, 6], [55, 40, 42, 44, 49, 45, 45, 50, 49, 69, 59, 55])).toBe('Cfb');
    // ローマ風
    expect(k([8, 9, 11, 14, 18, 22, 25, 25, 21, 17, 12, 9], [70, 75, 60, 65, 40, 20, 15, 30, 70, 110, 110, 80])).toBe('Csa');
    // モスクワ風
    expect(k([-8, -7, -2, 6, 13, 17, 19, 17, 11, 5, -1, -5], [52, 41, 35, 37, 49, 80, 85, 82, 68, 71, 55, 52])).toBe('Dfb');
    // ツンドラ
    expect(k([-25, -26, -24, -16, -5, 2, 5, 4, 0, -8, -17, -22], [5, 5, 5, 5, 5, 10, 25, 25, 15, 10, 6, 5])).toBe('ET');
  });

  it('分類条件を変更できる（C/D 境界）', () => {
    const t = [-1, 0, 4, 9, 14, 18, 20, 19, 15, 10, 5, 1];
    const p = Array(12).fill(60);
    expect(k(t, p)).toBe('Cfb');
    expect(k(t, p, { ...DEFAULT_KOPPEN, cdBoundary: 0 })).toBe('Dfb');
  });

  it('南半球では夏冬が入れ替わる', () => {
    const t = [25, 25, 23, 19, 15, 12, 11, 12, 14, 17, 20, 23];
    const p = [10, 10, 15, 40, 90, 110, 100, 80, 50, 25, 15, 10];
    expect(k(t, p, DEFAULT_KOPPEN, false)).toBe('Csa');
  });
});

describe('classifyBiome', () => {
  it('気候区分と降水量からバイオームを決める', () => {
    const code = (s: string) => KOPPEN_CODES.indexOf(s as (typeof KOPPEN_CODES)[number]);
    expect(classifyBiome(code('Af'), 27, 2500, 50, 3, DEFAULT_BIOME)).toBe(BIOME_INDEX.tropical_rainforest);
    expect(classifyBiome(code('BWh'), 25, 50, 50, 25, DEFAULT_BIOME)).toBe(BIOME_INDEX.hot_desert);
    expect(classifyBiome(code('Dfc'), -5, 450, 50, 62, DEFAULT_BIOME)).toBe(BIOME_INDEX.taiga);
    expect(classifyBiome(code('ET'), -10, 200, 50, 70, DEFAULT_BIOME)).toBe(BIOME_INDEX.tundra);
    expect(classifyBiome(code('ET'), -2, 800, 3500, 35, DEFAULT_BIOME)).toBe(BIOME_INDEX.alpine);
    expect(classifyBiome(code('Cfb'), 10, 300, 50, 45, DEFAULT_BIOME)).toBe(BIOME_INDEX.grassland);
    expect(classifyBiome(code('Cfb'), 10, 300, 50, 45, { ...DEFAULT_BIOME, grasslandMaxPrecip: 200 })).toBe(BIOME_INDEX.deciduous);
  });
});

describe('保存と書き出し', () => {
  it('気候データは単位どおりの精度で可逆に保存され、メタデータも残る', () => {
    const c = computeClimate(input());
    const wd = { ...createWorld(W, H, 3), kmPerCell: 20, climate: c };
    const { world: back, issues } = decodeWorldChecked(encodeWorld(wd));
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    const b = back.climate!;
    expect(b.meta.version).toBe(c.meta.version);
    expect(b.meta.frame).toEqual(c.meta.frame);
    expect(Array.from(b.tMean)).toEqual(Array.from(c.tMean));
    expect(Array.from(b.precip)).toEqual(Array.from(c.precip));
    expect(Array.from(b.highSun)).toEqual(Array.from(c.highSun));
    expect(Array.from(b.koppen)).toEqual(Array.from(c.koppen));
    expect(Array.from(b.biome)).toEqual(Array.from(c.biome));
  });

  it('セル ID・位置・各値を CSV に書き出せる', () => {
    const c = computeClimate(input());
    const csv = climateCsv(c, W, H, 20);
    const lines = csv.trim().split('\n');
    expect(lines[1]).toContain('version=');
    const header = lines.find((l) => l.startsWith('cell_id'))!.split(',');
    expect(header).toEqual(expect.arrayContaining(['cell_id', 'x_km', 'y_km', 'lat_equiv', 't_mean_c', 'precip_mm', 't_range_c', 'precip_seasonality', 'koppen', 'biome']));
    const id = at(c, 60, 40);
    const info = climateCellInfo(c, W, H, 20, id);
    expect(info.x).toBe(61);
    expect(info.monthlyP.reduce((a, b) => a + b, 0)).toBeCloseTo(info.precip, -1);
    expect(lines.some((l) => l.startsWith(`${id},`))).toBe(true);
  });
});
