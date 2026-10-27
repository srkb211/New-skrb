import { zlibSync } from 'fflate';

/** PNG にマップデータを埋め込むための独自チャンク（補助・私用・コピー可） */
export const MAP_CHUNK = 'fmAp';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  type: string;
  data: Uint8Array;
  /** ファイル内のチャンク開始位置 */
  offset: number;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error('PNG ファイルではありません');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (p + 12 + len > bytes.length) throw new Error('PNG が途中で切れています');
    chunks.push({ type, data: bytes.subarray(p + 8, p + 8 + len), offset: p });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** IEND の直前にチャンクを挿入する（同種の既存チャンクは置き換える）。 */
export function insertChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const chunks = readChunks(png);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === type) continue;
    if (c.type === 'IEND') parts.push(makeChunk(type, data));
    parts.push(png.subarray(c.offset, c.offset + 12 + c.data.length));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function extractChunk(png: Uint8Array, type: string): Uint8Array | null {
  for (const c of readChunks(png)) if (c.type === type) return c.data;
  return null;
}

/** RGBA ピクセルから PNG を作る（テストやワーカー用の簡易エンコーダ）。 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array(SIGNATURE),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', zlibSync(raw, { level: 6 })),
    makeChunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
