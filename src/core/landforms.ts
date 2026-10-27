import { distanceTransform } from './distance';
import type { Hydrology } from './hydrology';
import { labelComponents, type Pt } from './raster';
import type { FeatureKind } from './names';

/** 地形区分 */
export const LF_SEA = 0;
export const LF_LAKE = 1;
export const LF_PLAIN = 2;
export const LF_HILLS = 3;
export const LF_PLATEAU = 4;
export const LF_MOUNTAIN = 5;
export const LF_ALPINE = 6;

export const LANDFORM_LABEL = ['海', '湖', '平野', '丘陵', '高原', '山地', '高山'];

export interface Feature {
  kind: FeatureKind;
  /** 命名用の代表セル */
  key: number;
  /** ラベル位置（セル座標） */
  x: number;
  y: number;
  /** ラベルの回転角（ラジアン） */
  angle: number;
  /** ラベルの広がり（セル） */
  extent: number;
  /** 面積（セル数） */
  size: number;
  /** 標高（山頂）または最高標高 (m) */
  elevation: number;
  /** 河川の長さ（セル） */
  length: number;
  /** 河川番号（hydrology.rivers の添字） */
  river: number;
}

export interface Landforms {
  classes: Uint8Array;
  features: Feature[];
  thresholds: { plain: number; mountain: number; alpine: number };
  maxElevation: number;
}

/** 半径 r の窓内の起伏（最大 − 最小）を分離可能フィルタで求める。 */
export function localRelief(elev: Float32Array, land: Uint8Array, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const val = new Float32Array(n);
  for (let i = 0; i < n; i++) val[i] = land[i] ? elev[i] : 0;
  const tmpMax = new Float32Array(n);
  const tmpMin = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = -Infinity;
      let mn = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const v = val[y * w + k];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      tmpMax[y * w + x] = mx;
      tmpMin[y * w + x] = mn;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = -Infinity;
      let mn = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        const a = tmpMax[k * w + x];
        const b = tmpMin[k * w + x];
        if (a > mx) mx = a;
        if (b < mn) mn = b;
      }
      out[y * w + x] = mx - mn;
    }
  }
  return out;
}

export function classifyLandforms(
  elev: Float32Array,
  land: Uint8Array,
  hyd: Hydrology,
  w: number,
  h: number,
): Landforms {
  const n = w * h;
  let maxE = 0;
  for (let i = 0; i < n; i++) if (land[i] && elev[i] > maxE) maxE = elev[i];
  const s = Math.sqrt(w * h) / 600;
  const relief = localRelief(elev, land, w, h, Math.max(2, Math.round(3 * s)));
  const plainTh = Math.min(260, Math.max(80, maxE * 0.08));
  const mountTh = Math.min(1400, Math.max(500, maxE * 0.3));
  const alpineTh = Math.max(mountTh * 1.6, Math.min(2800, maxE * 0.68));
  const reliefPlain = Math.max(60, mountTh * 0.18);
  const reliefMount = Math.max(250, mountTh * 0.45);
  const classes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) classes[i] = LF_SEA;
    else if (hyd.lake[i]) classes[i] = LF_LAKE;
    else {
      const e = elev[i];
      const r = relief[i];
      if (e >= alpineTh) classes[i] = LF_ALPINE;
      else if (e >= mountTh || (r >= reliefMount && e >= mountTh * 0.6)) classes[i] = LF_MOUNTAIN;
      else if (e < plainTh && r < reliefPlain * 1.5) classes[i] = LF_PLAIN;
      else if (e >= mountTh * 0.45 && r < reliefPlain * 1.8) classes[i] = LF_PLATEAU;
      else classes[i] = LF_HILLS;
    }
  }
  const features: Feature[] = [];
  extractAreaFeatures(classes, elev, land, w, h, s, features);
  extractRiverFeatures(hyd, w, features);
  return {
    classes,
    features,
    thresholds: { plain: plainTh, mountain: mountTh, alpine: alpineTh },
    maxElevation: maxE,
  };
}

function blankFeature(kind: FeatureKind): Feature {
  return { kind, key: 0, x: 0, y: 0, angle: 0, extent: 0, size: 0, elevation: 0, length: 0, river: -1 };
}

function extractAreaFeatures(
  classes: Uint8Array,
  elev: Float32Array,
  land: Uint8Array,
  w: number,
  h: number,
  s: number,
  out: Feature[],
): void {
  const n = w * h;
  // 山脈・山地
  const isMount = (i: number) => classes[i] === LF_MOUNTAIN || classes[i] === LF_ALPINE;
  const mounts = labelComponents(w, h, isMount, 8);
  const minRange = Math.max(12, Math.round(70 * s * s));
  const stats = componentStats(mounts.labels, mounts.count, w, h);
  for (let c = 0; c < mounts.count; c++) {
    if (mounts.sizes[c] < minRange) continue;
    const st = stats[c];
    let peak = -1;
    for (const i of st.cells) if (peak < 0 || elev[i] > elev[peak]) peak = i;
    const elong = Math.sqrt(st.l1 / Math.max(1e-6, st.l2));
    const f = blankFeature(elong > 2.1 && mounts.sizes[c] > minRange * 2 ? 'range' : 'massif');
    f.key = st.cells[0];
    f.x = st.cx;
    f.y = st.cy;
    f.angle = normalizeAngle(st.angle);
    f.extent = 4 * Math.sqrt(st.l1);
    f.size = mounts.sizes[c];
    f.elevation = elev[peak];
    out.push(f);
    const p = blankFeature('peak');
    p.key = peak;
    p.x = (peak % w) + 0.5;
    p.y = Math.floor(peak / w) + 0.5;
    p.elevation = elev[peak];
    p.size = 1;
    out.push(p);
  }
  // 平野・盆地・高原
  const area = (cls: number, kindFor: (touchesSea: boolean) => FeatureKind, minSize: number) => {
    const comps = labelComponents(w, h, (i) => classes[i] === cls, 8);
    const dist = distanceTransform((i) => classes[i] !== cls, w, h);
    const best = new Int32Array(comps.count).fill(-1);
    const touches = new Uint8Array(comps.count);
    const maxElev = new Float32Array(comps.count);
    for (let i = 0; i < n; i++) {
      const c = comps.labels[i];
      if (c < 0) continue;
      if (best[c] < 0 || dist[i] > dist[best[c]]) best[c] = i;
      if (elev[i] > maxElev[c]) maxElev[c] = elev[i];
      if (!touches[c]) {
        const x = i % w;
        if (
          (x > 0 && !land[i - 1]) ||
          (x < w - 1 && !land[i + 1]) ||
          (i >= w && !land[i - w]) ||
          (i < n - w && !land[i + w])
        ) {
          touches[c] = 1;
        }
      }
    }
    for (let c = 0; c < comps.count; c++) {
      if (comps.sizes[c] < minSize) continue;
      const i = best[c];
      const f = blankFeature(kindFor(touches[c] === 1));
      f.key = i;
      f.x = (i % w) + 0.5;
      f.y = Math.floor(i / w) + 0.5;
      f.extent = dist[i] * 2;
      f.size = comps.sizes[c];
      f.elevation = maxElev[c];
      out.push(f);
    }
  };
  const minArea = Math.max(20, Math.round(160 * s * s));
  area(LF_PLAIN, (sea) => (sea ? 'plain' : 'basin'), minArea);
  area(LF_PLATEAU, () => 'plateau', minArea);
  area(LF_LAKE, () => 'lake', 1);
}

function extractRiverFeatures(hyd: Hydrology, w: number, out: Feature[]): void {
  const rivers = hyd.rivers;
  const candidates: number[] = [];
  for (let k = 0; k < rivers.length; k++) {
    const r = rivers[k];
    const q = r.flow[r.flow.length - 1];
    const major = r.parent < 0 ? q >= hyd.riverThreshold * 6 : q >= hyd.riverThreshold * 25;
    if (major && r.points.length >= 12) candidates.push(k);
  }
  candidates.sort((a, b) => rivers[b].flow[rivers[b].flow.length - 1] - rivers[a].flow[rivers[a].flow.length - 1]);
  for (const k of candidates.slice(0, 40)) {
    const r = rivers[k];
    const mid = Math.floor(r.points.length * 0.45);
    const a = r.points[Math.max(0, mid - 4)];
    const b = r.points[Math.min(r.points.length - 1, mid + 4)];
    const f = blankFeature('river');
    const last = r.points[r.points.length - 1];
    f.key = Math.floor(last[1]) * w + Math.floor(last[0]);
    f.x = r.points[mid][0];
    f.y = r.points[mid][1];
    f.angle = normalizeAngle(Math.atan2(b[1] - a[1], b[0] - a[0]));
    f.length = totalLength(r.points);
    f.size = r.flow[r.flow.length - 1];
    f.river = k;
    out.push(f);
  }
}

function totalLength(pts: Pt[]): number {
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return len;
}

/** 文字が逆さにならないよう角度を (-π/2, π/2] に収める */
export function normalizeAngle(a: number): number {
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

interface CompStat {
  cells: number[];
  cx: number;
  cy: number;
  angle: number;
  l1: number;
  l2: number;
}

/** 連結成分ごとの重心と主軸（PCA） */
export function componentStats(labels: Int32Array, count: number, w: number, h: number): CompStat[] {
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const sxx = new Float64Array(count);
  const syy = new Float64Array(count);
  const sxy = new Float64Array(count);
  const cells: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < w * h; i++) {
    const c = labels[i];
    if (c < 0) continue;
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    sx[c] += x;
    sy[c] += y;
    sxx[c] += x * x;
    syy[c] += y * y;
    sxy[c] += x * y;
    cells[c].push(i);
  }
  const out: CompStat[] = [];
  for (let c = 0; c < count; c++) {
    const m = cells[c].length || 1;
    const cx = sx[c] / m;
    const cy = sy[c] / m;
    const vxx = sxx[c] / m - cx * cx;
    const vyy = syy[c] / m - cy * cy;
    const vxy = sxy[c] / m - cx * cy;
    const tr = vxx + vyy;
    const det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    out.push({
      cells: cells[c],
      cx,
      cy,
      angle: 0.5 * Math.atan2(2 * vxy, vxx - vyy),
      l1: tr / 2 + disc,
      l2: Math.max(1e-6, tr / 2 - disc),
    });
  }
  return out;
}
