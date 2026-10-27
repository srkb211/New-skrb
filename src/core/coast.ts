import { signedDistance } from './distance';
import { Noise2D } from './noise';
import { hashInts } from './rng';
import { labelComponents } from './raster';
import type { GenParams } from './world';

/** マップサイズに対する長さの基準（600 セル四方を 1 とする） */
export function mapScale(w: number, h: number): number {
  return Math.sqrt(w * h) / 600;
}

/**
 * 下絵の陸地マスクから、複雑でリアルな海岸線を持つ連続場を作る。
 * 符号付き距離にドメインワープした fBm を加えることで、
 * 描いた形を保ちつつ湾・半島・沖合の小島が生まれる。
 */
export function generateCoastField(
  baseLand: Uint8Array,
  w: number,
  h: number,
  seed: number,
  params: GenParams,
): Float32Array {
  const sd = signedDistance(baseLand, w, h);
  const s = mapScale(w, h);
  const rough = Math.max(0, Math.min(1, params.roughness));
  const amp = (3 + 24 * rough) * s;
  const warpAmp = (6 + 30 * rough) * s;
  const f = 1 / (38 * s);
  const fw = 1 / (70 * s);
  const n = new Noise2D(hashInts(seed, 101));
  const wx = new Noise2D(hashInts(seed, 102));
  const wy = new Noise2D(hashInts(seed, 103));
  const out = new Float32Array(w * h);
  const reach = amp * 2.2 + 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = sd[i];
      if (d > reach || d < -reach) {
        out[i] = d;
        continue;
      }
      const px = x + warpAmp * wx.fbm(x * fw, y * fw, 3);
      const py = y + warpAmp * wy.fbm(x * fw, y * fw, 3);
      const v = n.fbm(px * f, py * f, 6, 2, 0.6);
      out[i] = d + amp * v * 2;
    }
  }
  sanitizeCoast(out, w, h, Math.max(3, Math.round(4 * s * s)));
  return out;
}

/** 極小の島と極小の内水面を取り除く。 */
export function sanitizeCoast(field: Float32Array, w: number, h: number, minSize: number): void {
  const land = labelComponents(w, h, (i) => field[i] > 0, 4);
  for (let i = 0; i < field.length; i++) {
    const l = land.labels[i];
    if (l >= 0 && land.sizes[l] < minSize) field[i] = -0.05;
  }
  const sea = labelComponents(w, h, (i) => field[i] <= 0, 4);
  for (let i = 0; i < field.length; i++) {
    const l = sea.labels[i];
    if (l >= 0 && sea.sizes[l] < minSize) field[i] = 0.05;
  }
}
