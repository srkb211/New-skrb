import { withClimateDefaults, type ClimateData, type ClimateParams } from './climate';
import { DEFAULT_GEO_FRAME, type GeoFrame } from './geoframe';
import type { FeatureKind } from './names';
import type { Pt } from './raster';

/** 下絵ペイントの値 */
export const PAINT_SEA = 0;
export const PAINT_LAND = 1;
export const PAINT_OUTLINE = 2;

export interface GenParams {
  /** 海岸線の複雑さ 0..1 */
  roughness: number;
  /** 山地の多さ 0..1 */
  mountains: number;
  /** 最高標高の目安 (m) */
  maxElevation: number;
  /** 侵食の強さ 0..1（谷の刻まれ方） */
  erosion: number;
  /** 河川の密度 0..1 */
  riverDensity: number;
}

export const DEFAULT_PARAMS: GenParams = {
  roughness: 0.55,
  mountains: 0.5,
  maxElevation: 4200,
  erosion: 0.5,
  riverDensity: 0.5,
};

export interface Stroke {
  id: number;
  points: Pt[];
}

export type BorderKind = 'national' | 'state';

export interface BorderStroke extends Stroke {
  kind: BorderKind;
}

export interface CountryRecord {
  id: number;
  /** 短い国名（地図ラベル用） */
  name: string;
  /** 政体（王国、共和国など） */
  gov: string;
  color: string;
  /** 命名文化のキー */
  culture: string;
  /** 下位区分の呼称（州・県・省など） */
  subdivision: string;
  /** 首都名 */
  capital: string;
  /** この国に属する領域を示す代表点（セル座標）。最初の点を首都位置とする。 */
  anchors: Pt[];
}

export interface StateRecord {
  id: number;
  name: string;
  /** 州都名 */
  seat: string;
  anchors: Pt[];
}

/** 生成データに記録する生成方式とバージョン */
export interface GeneratorMeta {
  algorithm: string;
  version: string;
  seed: number;
  generatedAt: string;
  /** 部分再生成などで手を加えた回数 */
  edits: number;
}

export const TERRAIN_ALGORITHM = 'fantasy-atlas/terrain-fbm-streampower';
export const TERRAIN_VERSION = '1.0.0';

export interface TerrainLayers {
  /** 海岸線の連続場（正が陸） */
  coast: Float32Array;
  /** 標高 (m)。海は負の水深 */
  elevation: Float32Array;
  meta?: GeneratorMeta;
}

/** 地物（山脈・川など）の名前の手動上書き。代表点の近くの同種の地物に適用する */
export interface FeatureNameOverride {
  kind: FeatureKind;
  x: number;
  y: number;
  name: string;
}

export interface WorldState {
  title: string;
  width: number;
  height: number;
  /** 1 セルあたりの距離 (km) */
  kmPerCell: number;
  seed: number;
  params: GenParams;
  /** 下絵: 0 海, 1 陸, 2 輪郭線 */
  paint: Uint8Array;
  /** 山脈ガイド線 */
  ridges: Stroke[];
  borders: BorderStroke[];
  terrain: TerrainLayers | null;
  /** 地形生成後に下絵が編集されたか */
  terrainStale: boolean;
  countries: CountryRecord[];
  states: StateRecord[];
  nextId: number;
  /** 地物名の手動上書き */
  featureNames: FeatureNameOverride[];
  /** 世界設定：地図座標と気候計算用の緯度相当座標の対応 */
  geoFrame: GeoFrame;
  /** 気候の計算パラメータと分類条件 */
  climateParams: ClimateParams;
  /** 計算済みの気候（地形と同じく履歴・保存の対象） */
  climate: ClimateData | null;
}

export function createWorld(width: number, height: number, seed: number): WorldState {
  return {
    title: '無題の世界',
    width,
    height,
    kmPerCell: 2,
    seed,
    params: { ...DEFAULT_PARAMS },
    paint: new Uint8Array(width * height),
    ridges: [],
    borders: [],
    terrain: null,
    terrainStale: false,
    countries: [],
    states: [],
    nextId: 1,
    featureNames: [],
    geoFrame: { ...DEFAULT_GEO_FRAME },
    climateParams: withClimateDefaults({ seed }),
    climate: null,
  };
}

/** 下絵から陸地マスクを作る。輪郭線は隣に陸があれば陸とみなす。 */
export function landFromPaint(paint: Uint8Array, w: number, h: number): Uint8Array {
  const land = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = paint[i];
      if (v === PAINT_LAND) {
        land[i] = 1;
      } else if (v === PAINT_OUTLINE) {
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (paint[ny * w + nx] === PAINT_LAND) {
              near = true;
              break;
            }
          }
        }
        land[i] = near ? 1 : 0;
      }
    }
  }
  return land;
}

export function landFromCoast(coast: Float32Array): Uint8Array {
  const land = new Uint8Array(coast.length);
  for (let i = 0; i < coast.length; i++) land[i] = coast[i] > 0 ? 1 : 0;
  return land;
}

/** 現在の陸地マスク（生成済みなら生成結果、未生成なら下絵）。 */
export function currentLand(world: WorldState): Uint8Array {
  return world.terrain
    ? landFromCoast(world.terrain.coast)
    : landFromPaint(world.paint, world.width, world.height);
}
