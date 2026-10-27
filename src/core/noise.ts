import { mulberry32 } from './rng';

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** シード付き 2D シンプレックスノイズ（出力はおおよそ [-1, 1]）。 */
export class Noise2D {
  private perm = new Uint8Array(512);
  private gx = new Float32Array(512);
  private gy = new Float32Array(512);

  constructor(seed: number) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      const g = GRAD[this.perm[i] & 7];
      this.gx[i] = g[0];
      this.gy[i] = g[1];
    }
  }

  noise(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const perm = this.perm;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (this.gx[g] * x0 + this.gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (this.gx[g] * x1 + this.gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (this.gx[g] * x2 + this.gy[g] * y2);
    }
    return 70 * n;
  }

  /** フラクタル・ブラウン運動。振幅の合計で正規化して [-1,1] 程度に収める。 */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(fx, fy);
      norm += amp;
      amp *= gain;
      // オクターブごとに少し回転させて格子の方向性を消す
      const nx = fx * 1.6 - fy * 1.2;
      const ny = fx * 1.2 + fy * 1.6;
      fx = nx * (lacunarity / 2) + 17.3;
      fy = ny * (lacunarity / 2) - 9.1;
    }
    return sum / norm;
  }

  /** 尾根状ノイズ（[0,1]）。山脈の稜線表現に使う。 */
  ridged(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let weight = 1;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(fx, fy));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      const nx = fx * 1.6 - fy * 1.2;
      const ny = fx * 1.2 + fy * 1.6;
      fx = nx * (lacunarity / 2) + 31.7;
      fy = ny * (lacunarity / 2) + 5.3;
    }
    return sum / norm;
  }
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
