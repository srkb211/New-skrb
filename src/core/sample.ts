import { Noise2D } from './noise';
import { hashInts } from './rng';
import { PAINT_LAND, PAINT_OUTLINE } from './world';

/** すぐ試せるサンプルの下絵（ノイズで作った大陸と島々） */
export function sampleSketch(w: number, h: number, seed: number): Uint8Array {
  const n = new Noise2D(hashInts(seed, 9001));
  const paint = new Uint8Array(w * h);
  const s = Math.sqrt(w * h) / 600;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / w) * 2 - 1;
      const ny = (y / h) * 2 - 1;
      const falloff = 1 - Math.pow(Math.max(Math.abs(nx) * 0.95, Math.abs(ny) * 1.05), 2.2);
      const v = n.fbm(x / (160 * s), y / (160 * s), 3) * 0.75 + falloff * 0.62 - 0.33;
      if (v > 0) paint[y * w + x] = PAINT_LAND;
    }
  }
  // 輪郭線を付けて「手描きの下絵」らしく見せる
  const out = new Uint8Array(paint);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (paint[i] !== PAINT_LAND) continue;
      if (!paint[i - 1] || !paint[i + 1] || !paint[i - w] || !paint[i + w]) out[i] = PAINT_OUTLINE;
    }
  }
  return out;
}
