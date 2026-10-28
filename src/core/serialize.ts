import { unzlibSync, zlibSync } from 'fflate';
import { validateClimate, withClimateDefaults, type ClimateData, type ClimateMeta, type ValidationIssue } from './climate';
import { DEFAULT_GEO_FRAME } from './geoframe';
import { extractChunk, insertChunk, isPng, MAP_CHUNK } from './png';
import { DEFAULT_PARAMS, type WorldState } from './world';

const MAGIC = 'FATL';
/** 2: 気候・世界設定・地物名・生成メタデータを追加 */
const FORMAT_VERSION = 2;

type BlobName =
  | 'paint'
  | 'coast'
  | 'elevation'
  | 'climate.tMean'
  | 'climate.tWarm'
  | 'climate.tCold'
  | 'climate.precip'
  | 'climate.highSun'
  | 'climate.land'
  | 'climate.elevation'
  | 'climate.koppen'
  | 'climate.biome';

interface BlobMeta {
  name: BlobName;
  type: 'u8' | 'i16' | 'f32' | 'i32d';
  length: number;
  scale: number;
  /** i32d（行内差分）の行の長さ */
  rowLength?: number;
  /** 値の単位（人が読むための記録） */
  unit?: string;
}

interface Meta {
  format: 'fantasy-atlas';
  version: number;
  title: string;
  width: number;
  height: number;
  kmPerCell: number;
  seed: number;
  params: WorldState['params'];
  ridges: WorldState['ridges'];
  borders: WorldState['borders'];
  countries: WorldState['countries'];
  states: WorldState['states'];
  nextId: number;
  terrainStale: boolean;
  savedAt: string;
  featureNames?: WorldState['featureNames'];
  geoFrame?: WorldState['geoFrame'];
  climateParams?: WorldState['climateParams'];
  terrainMeta?: NonNullable<WorldState['terrain']>['meta'];
  climateMeta?: ClimateMeta;
  blobs: BlobMeta[];
}

/** 量子化。keepSign なら陸海の判定（正か否か）が変わらないよう符号を保つ。 */
function quantize(src: Float32Array, scale: number, keepSign = false): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let q = Math.max(-32767, Math.min(32767, Math.round(src[i] * scale)));
    if (keepSign) {
      if (src[i] > 0 && q <= 0) q = 1;
      else if (src[i] <= 0 && q > 0) q = 0;
    }
    out[i] = q;
  }
  return out;
}

const roundPts = <T extends { points: [number, number][] }>(list: T[]): T[] =>
  list.map((s) => ({ ...s, points: s.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number]) }));

function i16ToBytes(a: Int16Array): Uint8Array {
  const out = new Uint8Array(a.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) v.setInt16(i * 2, a[i], true);
  return out;
}

/** 整数化して行ごとに差分をとる（なだらかな標高はほぼ小さな値になり、よく圧縮される） */
function deltaI32ToBytes(a: Float32Array, scale: number, w: number): Uint8Array {
  const out = new Uint8Array(a.length * 4);
  const v = new DataView(out.buffer);
  let prev = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % w === 0) prev = 0;
    const q = Math.round(a[i] * scale);
    v.setInt32(i * 4, q - prev, true);
    prev = q;
  }
  return out;
}

/** ワールドをバイナリ（zlib 圧縮）に変換する */
export function encodeWorld(world: WorldState): Uint8Array {
  const blobs: { meta: BlobMeta; bytes: Uint8Array }[] = [];
  const add = (meta: BlobMeta, bytes: Uint8Array) => blobs.push({ meta, bytes });
  add({ name: 'paint', type: 'u8', length: world.paint.length, scale: 1 }, world.paint);
  if (world.terrain) {
    // 海岸線の場は 1/100 セル単位に量子化。
    // 標高は生成時に 1cm 単位へ丸めてあるので、整数化＋行内差分にして可逆かつ小さく保存する
    const coast = quantize(world.terrain.coast, 100, true);
    add({ name: 'coast', type: 'i16', length: coast.length, scale: 100, unit: 'cell' }, i16ToBytes(coast));
    add(
      { name: 'elevation', type: 'i32d', length: world.terrain.elevation.length, scale: 100, rowLength: world.width, unit: 'm' },
      deltaI32ToBytes(world.terrain.elevation, 100, world.width),
    );
  }
  const c = world.climate;
  if (c) {
    const len = c.meta.width * c.meta.height;
    const i16 = (name: BlobName, a: Float32Array, scale: number, unit: string) =>
      add({ name, type: 'i16', length: len, scale, unit }, i16ToBytes(quantize(a, scale)));
    i16('climate.tMean', c.tMean, 100, '°C');
    i16('climate.tWarm', c.tWarm, 100, '°C');
    i16('climate.tCold', c.tCold, 100, '°C');
    i16('climate.precip', c.precip, 1, 'mm/年');
    i16('climate.highSun', c.highSun, 10000, '割合');
    i16('climate.land', c.land, 10000, '割合');
    i16('climate.elevation', c.elevation, 1, 'm');
    add({ name: 'climate.koppen', type: 'u8', length: len, scale: 1, unit: 'KOPPEN_CODES の添字' }, c.koppen);
    add({ name: 'climate.biome', type: 'u8', length: len, scale: 1, unit: 'BIOMES の添字' }, c.biome);
  }
  const meta: Meta = {
    format: 'fantasy-atlas',
    version: FORMAT_VERSION,
    title: world.title,
    width: world.width,
    height: world.height,
    kmPerCell: world.kmPerCell,
    seed: world.seed,
    params: world.params,
    ridges: roundPts(world.ridges),
    borders: roundPts(world.borders),
    countries: world.countries,
    states: world.states,
    nextId: world.nextId,
    terrainStale: world.terrainStale,
    savedAt: new Date().toISOString(),
    featureNames: world.featureNames,
    geoFrame: world.geoFrame,
    climateParams: world.climateParams,
    terrainMeta: world.terrain?.meta,
    climateMeta: c?.meta,
    blobs: blobs.map((b) => b.meta),
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  let total = 4 + json.length;
  for (const b of blobs) total += b.bytes.length;
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  let o = 4 + json.length;
  for (const b of blobs) {
    body.set(b.bytes, o);
    o += b.bytes.length;
  }
  const packed = zlibSync(body, { level: 6 });
  const out = new Uint8Array(5 + packed.length);
  for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
  out[4] = FORMAT_VERSION;
  out.set(packed, 5);
  return out;
}

export interface DecodeResult {
  world: WorldState;
  /** 読み込み時に見つかった問題（欠損・無効値・不整合など） */
  issues: ValidationIssue[];
}

export function decodeWorld(bytes: Uint8Array): WorldState {
  return decodeWorldChecked(bytes).world;
}

export function decodeWorldChecked(bytes: Uint8Array): DecodeResult {
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('地図データの形式が正しくありません');
  }
  if (bytes[4] > FORMAT_VERSION) throw new Error('新しいバージョンで保存された地図です。アプリを更新してください');
  const body = unzlibSync(bytes.subarray(5));
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const jsonLen = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + jsonLen))) as Meta;
  if (meta.format !== 'fantasy-atlas') throw new Error('地図データの形式が正しくありません');
  const issues: ValidationIssue[] = [];
  const n = meta.width * meta.height;
  const climateLen = meta.climateMeta ? meta.climateMeta.width * meta.climateMeta.height : 0;
  let o = 4 + jsonLen;
  const arrays: Partial<Record<BlobName, Uint8Array | Float32Array>> = {};
  for (const b of meta.blobs) {
    const expected = b.name.startsWith('climate.') ? climateLen : n;
    const bytesPer = b.type === 'u8' ? 1 : b.type === 'i16' ? 2 : 4;
    if (o + b.length * bytesPer > body.length) throw new Error('地図データが途中で切れています');
    if (b.length !== expected) {
      issues.push({ level: 'error', code: 'blob-length', message: `${b.name} の大きさが合わないため読み込みませんでした（${b.length}/${expected}）` });
      o += b.length * bytesPer;
      continue;
    }
    if (b.type === 'u8') {
      arrays[b.name] = body.slice(o, o + b.length);
    } else if (b.type === 'f32') {
      const f = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) f[i] = view.getFloat32(o + i * 4, true);
      arrays[b.name] = f;
    } else if (b.type === 'i32d') {
      const f = new Float32Array(b.length);
      const row = b.rowLength ?? meta.width;
      let acc = 0;
      for (let i = 0; i < b.length; i++) {
        if (i % row === 0) acc = 0;
        acc += view.getInt32(o + i * 4, true);
        f[i] = acc / b.scale;
      }
      arrays[b.name] = f;
    } else {
      const f = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) f[i] = view.getInt16(o + i * 2, true) / b.scale;
      arrays[b.name] = f;
    }
    o += b.length * bytesPer;
  }
  const paint = (arrays.paint as Uint8Array | undefined) ?? new Uint8Array(n);
  if (!arrays.paint) issues.push({ level: 'warning', code: 'missing', message: '下絵のデータが無いため白紙として読み込みました' });
  const coast = arrays.coast as Float32Array | undefined;
  const elevation = arrays.elevation as Float32Array | undefined;
  let terrain: WorldState['terrain'] = null;
  if (coast && elevation) {
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(elevation[i]) || !Number.isFinite(coast[i])) {
        bad++;
        elevation[i] = Number.isFinite(elevation[i]) ? elevation[i] : 0;
        coast[i] = Number.isFinite(coast[i]) ? coast[i] : -1;
      }
    }
    if (bad) issues.push({ level: 'error', code: 'terrain-invalid', message: '地形データに無効な値があり、補正しました', count: bad });
    terrain = { coast, elevation, meta: meta.terrainMeta };
  } else if (coast || elevation) {
    issues.push({ level: 'error', code: 'missing', message: '地形データの一部が欠けているため、地形は読み込みませんでした' });
  }
  let climate: ClimateData | null = null;
  if (meta.climateMeta) {
    const need: BlobName[] = ['climate.tMean', 'climate.tWarm', 'climate.tCold', 'climate.precip', 'climate.highSun', 'climate.land', 'climate.elevation', 'climate.koppen', 'climate.biome'];
    const missing = need.filter((k) => !arrays[k]);
    if (missing.length) {
      issues.push({ level: 'error', code: 'missing', message: `気候データが欠けているため読み込みませんでした（${missing.join(', ')}）` });
    } else {
      climate = {
        meta: { ...meta.climateMeta, params: withClimateDefaults(meta.climateMeta.params) },
        tMean: arrays['climate.tMean'] as Float32Array,
        tWarm: arrays['climate.tWarm'] as Float32Array,
        tCold: arrays['climate.tCold'] as Float32Array,
        precip: arrays['climate.precip'] as Float32Array,
        highSun: arrays['climate.highSun'] as Float32Array,
        land: arrays['climate.land'] as Float32Array,
        elevation: arrays['climate.elevation'] as Float32Array,
        koppen: arrays['climate.koppen'] as Uint8Array,
        biome: arrays['climate.biome'] as Uint8Array,
      };
      issues.push(...validateClimate(climate));
    }
  }
  const world: WorldState = {
    title: meta.title ?? '無題の世界',
    width: meta.width,
    height: meta.height,
    kmPerCell: meta.kmPerCell ?? 2,
    seed: meta.seed ?? 1,
    params: { ...DEFAULT_PARAMS, ...meta.params },
    paint,
    ridges: meta.ridges ?? [],
    borders: meta.borders ?? [],
    terrain,
    terrainStale: meta.terrainStale ?? false,
    countries: meta.countries ?? [],
    states: meta.states ?? [],
    nextId: meta.nextId ?? 1,
    featureNames: meta.featureNames ?? [],
    geoFrame: { ...DEFAULT_GEO_FRAME, ...(meta.geoFrame ?? {}) },
    climateParams: withClimateDefaults(meta.climateParams ?? { seed: meta.seed ?? 1 }),
    climate,
  };
  return { world, issues };
}

/** 地図画像（PNG）にワールドデータを埋め込む */
export function embedWorldInPng(png: Uint8Array, world: WorldState): Uint8Array {
  return insertChunk(png, MAP_CHUNK, encodeWorld(world));
}

/** PNG から埋め込まれたワールドデータを取り出す（無ければ null） */
export function extractWorldFromPng(bytes: Uint8Array): WorldState | null {
  return extractWorldFromPngChecked(bytes)?.world ?? null;
}

export function extractWorldFromPngChecked(bytes: Uint8Array): DecodeResult | null {
  if (!isPng(bytes)) return null;
  const chunk = extractChunk(bytes, MAP_CHUNK);
  return chunk ? decodeWorldChecked(chunk) : null;
}
