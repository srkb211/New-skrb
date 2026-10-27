import { unzlibSync, zlibSync } from 'fflate';
import { extractChunk, insertChunk, isPng, MAP_CHUNK } from './png';
import { DEFAULT_PARAMS, type WorldState } from './world';

const MAGIC = 'FATL';
const FORMAT_VERSION = 1;

interface BlobMeta {
  name: 'paint' | 'coast' | 'elevation';
  type: 'u8' | 'i16' | 'f32' | 'i32d';
  length: number;
  scale: number;
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
  blobs: BlobMeta[];
}

/** 量子化。陸海の判定（正か否か）が変わらないよう符号を保つ。 */
function quantize(src: Float32Array, scale: number): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let q = Math.max(-32767, Math.min(32767, Math.round(src[i] * scale)));
    if (src[i] > 0 && q <= 0) q = 1;
    else if (src[i] <= 0 && q > 0) q = 0;
    out[i] = q;
  }
  return out;
}

const roundPts = <T extends { points: [number, number][] }>(list: T[]): T[] =>
  list.map((s) => ({ ...s, points: s.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number]) }));

/** ワールドをバイナリ（zlib 圧縮）に変換する */
export function encodeWorld(world: WorldState): Uint8Array {
  const blobs: { meta: BlobMeta; bytes: Uint8Array }[] = [];
  blobs.push({ meta: { name: 'paint', type: 'u8', length: world.paint.length, scale: 1 }, bytes: world.paint });
  if (world.terrain) {
    // 海岸線の場は 1/100 セル単位に量子化。
    // 標高は生成時に 1cm 単位へ丸めてあるので、整数化＋行内差分にして可逆かつ小さく保存する
    const coast = quantize(world.terrain.coast, 100);
    blobs.push({ meta: { name: 'coast', type: 'i16', length: coast.length, scale: 100 }, bytes: i16ToBytes(coast) });
    blobs.push({
      meta: { name: 'elevation', type: 'i32d', length: world.terrain.elevation.length, scale: 100 },
      bytes: deltaI32ToBytes(world.terrain.elevation, 100, world.width),
    });
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

function i16ToBytes(a: Int16Array): Uint8Array {
  const out = new Uint8Array(a.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) v.setInt16(i * 2, a[i], true);
  return out;
}

export function decodeWorld(bytes: Uint8Array): WorldState {
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('地図データの形式が正しくありません');
  }
  if (bytes[4] > FORMAT_VERSION) throw new Error('新しいバージョンで保存された地図です。アプリを更新してください');
  const body = unzlibSync(bytes.subarray(5));
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const jsonLen = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + jsonLen))) as Meta;
  if (meta.format !== 'fantasy-atlas') throw new Error('地図データの形式が正しくありません');
  const n = meta.width * meta.height;
  let o = 4 + jsonLen;
  const arrays: Partial<Record<BlobMeta['name'], Uint8Array | Float32Array>> = {};
  for (const b of meta.blobs) {
    if (b.length !== n) throw new Error('地図データが壊れています');
    if (b.type === 'u8') {
      arrays[b.name] = body.slice(o, o + b.length);
      o += b.length;
    } else if (b.type === 'f32') {
      const f = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) f[i] = view.getFloat32(o + i * 4, true);
      arrays[b.name] = f;
      o += b.length * 4;
    } else if (b.type === 'i32d') {
      const f = new Float32Array(b.length);
      let acc = 0;
      for (let i = 0; i < b.length; i++) {
        if (i % meta.width === 0) acc = 0;
        acc += view.getInt32(o + i * 4, true);
        f[i] = acc / b.scale;
      }
      arrays[b.name] = f;
      o += b.length * 4;
    } else {
      const f = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) f[i] = view.getInt16(o + i * 2, true) / b.scale;
      arrays[b.name] = f;
      o += b.length * 2;
    }
  }
  const paint = (arrays.paint as Uint8Array | undefined) ?? new Uint8Array(n);
  const coast = arrays.coast as Float32Array | undefined;
  const elevation = arrays.elevation as Float32Array | undefined;
  return {
    title: meta.title ?? '無題の世界',
    width: meta.width,
    height: meta.height,
    kmPerCell: meta.kmPerCell ?? 2,
    seed: meta.seed ?? 1,
    params: { ...DEFAULT_PARAMS, ...meta.params },
    paint,
    ridges: meta.ridges ?? [],
    borders: meta.borders ?? [],
    terrain: coast && elevation ? { coast, elevation } : null,
    terrainStale: meta.terrainStale ?? false,
    countries: meta.countries ?? [],
    states: meta.states ?? [],
    nextId: meta.nextId ?? 1,
  };
}

/** 地図画像（PNG）にワールドデータを埋め込む */
export function embedWorldInPng(png: Uint8Array, world: WorldState): Uint8Array {
  return insertChunk(png, MAP_CHUNK, encodeWorld(world));
}

/** PNG から埋め込まれたワールドデータを取り出す（無ければ null） */
export function extractWorldFromPng(bytes: Uint8Array): WorldState | null {
  if (!isPng(bytes)) return null;
  const chunk = extractChunk(bytes, MAP_CHUNK);
  return chunk ? decodeWorld(chunk) : null;
}
