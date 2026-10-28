import { generateCoastField, mapScale, sanitizeCoast } from './coast';
import { signedDistance } from './distance';
import { analyzeHydrology, type Hydrology } from './hydrology';
import { classifyLandforms, type Landforms } from './landforms';
import { smoothstep } from './noise';
import { blendField, fillMinorDepressions, generateElevation } from './terrain';
import { landFromCoast, landFromPaint, TERRAIN_ALGORITHM, TERRAIN_VERSION, type GenParams, type Stroke, type TerrainLayers } from './world';

export interface TerrainJob {
  paint: Uint8Array;
  w: number;
  h: number;
  seed: number;
  params: GenParams;
  ridges: Stroke[];
}

export interface PartialJob extends TerrainJob {
  old: TerrainLayers;
  /** 再生成する範囲（1） */
  selection: Uint8Array;
  /** all: 海岸線と地形 / elevation: 地形のみ（海岸線は保持） */
  mode: 'all' | 'elevation';
  /** この操作で使う乱数シード（同じなら同じ地形） */
  variationSeed: number;
}

/** 下絵全体から地形を生成する */
export function generateTerrain(job: TerrainJob): TerrainLayers {
  const { paint, w, h, seed, params, ridges } = job;
  const coast = generateCoastField(landFromPaint(paint, w, h), w, h, seed, params);
  const land = landFromCoast(coast);
  const elevation = generateElevation(land, w, h, seed, params, ridges);
  quantizeElevation(elevation);
  return {
    coast,
    elevation,
    meta: { algorithm: TERRAIN_ALGORITHM, version: TERRAIN_VERSION, seed, generatedAt: new Date().toISOString(), edits: 0 },
  };
}

/**
 * 標高を 1cm 単位に丸める。保存時は同じ値で可逆に書き出せるので、
 * 保存前と読み込み後で河川などの解析結果が一致する。
 */
export function quantizeElevation(e: Float32Array): void {
  for (let i = 0; i < e.length; i++) e[i] = Math.round(e[i] * 100) / 100;
}

/** 選択範囲の境界をぼかした重み（内側 1、外側 0） */
export function featherWeights(selection: Uint8Array, w: number, h: number, feather: number): Float32Array {
  const sd = signedDistance(selection, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = smoothstep(-feather * 0.5, feather * 0.5, sd[i]);
  return out;
}

/** 選択範囲だけを作り直し、周囲と滑らかにつなぐ */
export function regeneratePartial(job: PartialJob): TerrainLayers {
  const { paint, w, h, params, ridges, old, selection, mode, variationSeed } = job;
  const feather = Math.max(4, 10 * mapScale(w, h));
  const weight = featherWeights(selection, w, h, feather);
  let coast = old.coast;
  if (mode === 'all') {
    const fresh = generateCoastField(landFromPaint(paint, w, h), w, h, variationSeed, params);
    coast = blendField(old.coast, fresh, weight);
    sanitizeCoast(coast, w, h, Math.max(3, Math.round(4 * mapScale(w, h) ** 2)));
  }
  const land = landFromCoast(coast);
  const oldLand = landFromCoast(old.coast);
  const freshElev = generateElevation(land, w, h, variationSeed, params, ridges);
  const elevation = blendField(old.elevation, freshElev, weight);
  for (let i = 0; i < elevation.length; i++) {
    if (land[i] !== oldLand[i]) elevation[i] = freshElev[i];
    else if (land[i] && elevation[i] < 1) elevation[i] = 1;
    else if (!land[i] && elevation[i] > -1) elevation[i] = -1;
  }
  fillMinorDepressions(elevation, land, w, h, params.riverDensity);
  quantizeElevation(elevation);
  const base = old.meta ?? { algorithm: TERRAIN_ALGORITHM, version: TERRAIN_VERSION, seed: job.seed, generatedAt: '', edits: 0 };
  return {
    coast,
    elevation,
    meta: { ...base, version: TERRAIN_VERSION, generatedAt: new Date().toISOString(), edits: base.edits + 1 },
  };
}

export interface TerrainAnalysis {
  land: Uint8Array;
  hydrology: Hydrology;
  landforms: Landforms;
}

export function analyzeTerrain(t: TerrainLayers, w: number, h: number, params: GenParams): TerrainAnalysis {
  const land = landFromCoast(t.coast);
  const hydrology = analyzeHydrology(t.elevation, land, w, h, params.riverDensity);
  const landforms = classifyLandforms(t.elevation, land, hydrology, w, h);
  return { land, hydrology, landforms };
}
