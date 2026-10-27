import { mapScale } from './coast';
import { distanceTransform } from './distance';
import { accumulate, findLakes, priorityFlood, receiverDistance, riverThresholdFor } from './hydrology';
import { Noise2D, clamp, smoothstep } from './noise';
import { rasterizePolyline } from './raster';
import { hashInts } from './rng';
import type { GenParams, Stroke } from './world';

/**
 * 標高グリッドを生成する。
 * 海岸からの距離・大陸規模のうねり・山脈帯（尾根ノイズ）・山脈ガイド線を合成し、
 * 河川侵食で谷を刻んだのち、小さな窪地を埋める。
 */
export function generateElevation(
  land: Uint8Array,
  w: number,
  h: number,
  seed: number,
  params: GenParams,
  ridges: readonly Stroke[],
): Float32Array {
  const n = w * h;
  const s = mapScale(w, h);
  const toSea = distanceTransform((i) => land[i] === 0, w, h);
  const toLand = distanceTransform((i) => land[i] !== 0, w, h);

  let guide: Float32Array | null = null;
  if (ridges.length > 0) {
    const mask = new Uint8Array(n);
    for (const r of ridges) rasterizePolyline(r.points, w, h, (i) => (mask[i] = 1));
    guide = distanceTransform((i) => mask[i] === 1, w, h);
  }

  const cont = new Noise2D(hashInts(seed, 201));
  const belt = new Noise2D(hashInts(seed, 202));
  const ridge = new Noise2D(hashInts(seed, 203));
  const detail = new Noise2D(hashInts(seed, 204));
  const sea = new Noise2D(hashInts(seed, 205));
  const hills = new Noise2D(hashInts(seed, 206));
  const f5 = 1 / (55 * s);
  const f1 = 1 / (190 * s);
  const f2 = 1 / (115 * s);
  const f3 = 1 / (42 * s);
  const f4 = 1 / (11 * s);
  const mountains = clamp(params.mountains, 0, 1);
  const guideWidth = 9 * s;

  const elev = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) {
        const t = toLand[i] / (55 * s);
        const nz = sea.fbm(x * f2, y * f2, 3);
        const depth =
          15 +
          160 * smoothstep(0, 0.22, t) +
          3800 * smoothstep(0.12, 1.1, t + nz * 0.15) +
          nz * 120;
        elev[i] = -Math.max(5, depth);
        continue;
      }
      const inland = 1 - Math.exp(-toSea[i] / (24 * s));
      const c = cont.fbm(x * f1, y * f1, 4) * 0.5 + 0.5;
      let m = smoothstep(0.08, 0.5, belt.fbm(x * f2, y * f2, 3) + (mountains - 0.5) * 0.7);
      m *= 0.3 + 0.7 * inland;
      if (guide) {
        const g = Math.exp(-((guide[i] / guideWidth) ** 2));
        m = Math.max(m, g * (0.75 + 0.25 * mountains));
      }
      const r = ridge.ridged(x * f3, y * f3, 5);
      const hl = hills.fbm(x * f5, y * f5, 4);
      const base = 0.012 + inland * (0.07 + 0.24 * c * c + 0.07 * hl);
      const mount = m * (0.18 + 0.82 * r) * (0.5 + 0.5 * inland);
      const det = detail.fbm(x * f4, y * f4, 3) * (0.012 + 0.05 * m);
      let v = base + mount * 0.9 + det;
      if (v > 0.8) v = 0.8 + 0.2 * Math.tanh((v - 0.8) / 0.2);
      elev[i] = 1 + params.maxElevation * Math.pow(Math.max(0, v), 1.55);
    }
  }

  erode(elev, land, w, h, clamp(params.erosion, 0, 1), s);
  fillMinorDepressions(elev, land, w, h, params.riverDensity);
  return elev;
}

/** 陰的ストリームパワー則による河川侵食（Braun & Willett 2013 の簡略版）。 */
export function erode(
  elev: Float32Array,
  land: Uint8Array,
  w: number,
  h: number,
  strength: number,
  s: number,
): void {
  if (strength <= 0) return;
  const n = w * h;
  const iterations = 2 + Math.round(strength * 3);
  const K = 0.0035 * (0.3 + strength);
  const norm = 1 / (s * s);
  for (let it = 0; it < iterations; it++) {
    const flow = priorityFlood(elev, land, w, h);
    const acc = accumulate(flow, n);
    const { order, receiver } = flow;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const r = receiver[i];
      const hr = r >= 0 ? elev[r] : 0;
      if (elev[i] <= hr) continue;
      const dist = r >= 0 ? receiverDistance(i, r, w) : 1;
      const F = (K * Math.sqrt(acc[i] * norm)) / dist;
      elev[i] = (elev[i] + F * hr) / (1 + F);
    }
    // 斜面の拡散（尖りすぎを抑える）
    diffuse(elev, land, w, h, 0.12);
  }
  for (let i = 0; i < n; i++) if (land[i] && elev[i] < 1) elev[i] = 1;
}

function diffuse(elev: Float32Array, land: Uint8Array, w: number, h: number, k: number): void {
  const src = new Float32Array(elev);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!land[i]) continue;
      let sum = 0;
      let cnt = 0;
      const nb = [i - 1, i + 1, i - w, i + w];
      for (const j of nb) {
        if (land[j]) {
          sum += src[j];
          cnt++;
        }
      }
      if (cnt > 0) elev[i] = src[i] + k * (sum / cnt - src[i]);
    }
  }
}

/** 湖として残すもの以外の窪地を埋めて、川が途切れないようにする。 */
export function fillMinorDepressions(
  elev: Float32Array,
  land: Uint8Array,
  w: number,
  h: number,
  riverDensity: number,
): void {
  const flow = priorityFlood(elev, land, w, h);
  const acc = accumulate(flow, w * h);
  const lakes = findLakes(elev, flow.filled, land, acc, w, h, riverThresholdFor(w, h, riverDensity));
  for (let i = 0; i < elev.length; i++) {
    if (land[i] && !lakes[i] && flow.filled[i] > elev[i]) elev[i] = flow.filled[i];
  }
}

/** 部分再生成：重み weight(0..1) で新旧の場を合成する。 */
export function blendField(oldF: Float32Array, newF: Float32Array, weight: Float32Array): Float32Array {
  const out = new Float32Array(oldF.length);
  for (let i = 0; i < out.length; i++) {
    const t = weight[i];
    out[i] = t <= 0 ? oldF[i] : t >= 1 ? newF[i] : oldF[i] + (newF[i] - oldF[i]) * t;
  }
  return out;
}
