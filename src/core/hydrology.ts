import { MinHeap } from './heap';
import type { Pt } from './raster';

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
const DIST8 = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** 流下先が海 */
export const RECEIVER_SEA = -1;
/** 流下先がマップ外 */
export const RECEIVER_EDGE = -2;

export interface Flow {
  /** 河口側から上流へ向かう処理順（陸セルのみ） */
  order: Int32Array;
  /** 各陸セルの流下先（海・マップ外は負値） */
  receiver: Int32Array;
  /** 窪地を埋めた標高 */
  filled: Float32Array;
}

/**
 * Priority-Flood（Barnes 2014）。窪地を埋めつつ、各セルの流下先を同時に決める。
 * 最初に到達した（＝最も低い）隣接セルが流下先になる。
 */
export function priorityFlood(elev: Float32Array, land: Uint8Array, w: number, h: number): Flow {
  const n = w * h;
  const filled = new Float32Array(elev);
  const receiver = new Int32Array(n).fill(RECEIVER_SEA);
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  let count = 0;
  const heap = new MinHeap(Math.max(1024, (w + h) * 8));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) continue;
      let outlet = false;
      let rcv = RECEIVER_SEA;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        outlet = true;
        rcv = RECEIVER_EDGE;
      }
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!land[ny * w + nx]) {
          outlet = true;
          rcv = RECEIVER_SEA;
          break;
        }
      }
      if (outlet) {
        receiver[i] = rcv;
        done[i] = 1;
        heap.push(filled[i], i);
      }
    }
  }
  const EPS = 0.01;
  while (heap.size > 0) {
    const c = heap.pop();
    order[count++] = c;
    const cx = c % w;
    const cy = (c - cx) / w;
    const fc = filled[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX8[k];
      const ny = cy + DY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (done[j] || !land[j]) continue;
      done[j] = 1;
      receiver[j] = c;
      if (filled[j] <= fc + EPS) filled[j] = fc + EPS;
      heap.push(filled[j], j);
    }
  }
  return { order: order.subarray(0, count), receiver, filled };
}

/** 流量累積（各セルの集水面積＝上流セル数 × 降水量） */
export function accumulate(flow: Flow, n: number, rain?: Float32Array): Float32Array {
  const acc = new Float32Array(n);
  const { order, receiver } = flow;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    acc[i] = rain ? rain[i] : 1;
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const r = receiver[i];
    if (r >= 0) acc[r] += acc[i];
  }
  return acc;
}

/** 流下先までの距離（セル単位） */
export function receiverDistance(i: number, r: number, w: number): number {
  const dx = Math.abs((i % w) - (r % w));
  const dy = Math.abs(Math.floor(i / w) - Math.floor(r / w));
  return dx + dy === 2 ? Math.SQRT2 : 1;
}

export interface RiverPath {
  /** 上流→下流のセル中心座標 */
  points: Pt[];
  /** 各点の流量 */
  flow: number[];
  /** 合流先の河川番号（本流は -1） */
  parent: number;
  /** 河口セル（水系の識別子） */
  mouth: number;
  /** 長さ（セル単位） */
  length: number;
}

export interface Hydrology {
  flow: Flow;
  acc: Float32Array;
  rivers: RiverPath[];
  /** 湖セル（1） */
  lake: Uint8Array;
  riverThreshold: number;
}

/** 河川の閾値（集水セル数）。密度 0..1 を対数的に対応づける。 */
export function riverThresholdFor(w: number, h: number, density: number): number {
  const s = Math.sqrt(w * h) / 600;
  const d = Math.max(0, Math.min(1, density));
  return Math.max(8, Math.round(900 * Math.pow(0.07, d) * s * s));
}

export function analyzeHydrology(
  elev: Float32Array,
  land: Uint8Array,
  w: number,
  h: number,
  riverDensity: number,
): Hydrology {
  const n = w * h;
  const flow = priorityFlood(elev, land, w, h);
  const acc = accumulate(flow, n);
  const threshold = riverThresholdFor(w, h, riverDensity);
  const lake = findLakes(elev, flow.filled, land, acc, w, h, threshold);
  const rivers = extractRivers(flow, acc, land, w, threshold);
  return { flow, acc, rivers, lake, riverThreshold: threshold };
}

/** 窪地に水が溜まった部分を湖とする（十分な流入があり一定以上の広さのもの）。 */
export function findLakes(
  elev: Float32Array,
  filled: Float32Array,
  land: Uint8Array,
  acc: Float32Array,
  w: number,
  h: number,
  riverThreshold: number,
): Uint8Array {
  const n = w * h;
  const lake = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const minSize = Math.max(6, Math.round((w * h) / 9000));
  // 広すぎる窪地は湖ではなく盆地として埋める
  const maxSize = Math.max(minSize * 4, Math.round((w * h) / 1400));
  const found: { cells: number[]; score: number }[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s] || filled[s] - elev[s] < 0.5) continue;
    const cells: number[] = [];
    let maxAcc = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      if (acc[i] > maxAcc) maxAcc = acc[i];
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || !land[j] || filled[j] - elev[j] < 0.5) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (cells.length >= minSize && cells.length <= maxSize && maxAcc >= riverThreshold * 2) {
      found.push({ cells, score: cells.length * Math.sqrt(maxAcc) });
    }
  }
  // 湖が多すぎると不自然なので大きい順に上限を設ける
  found.sort((a, b) => b.score - a.score);
  const maxLakes = Math.max(3, Math.round(Math.sqrt(w * h) / 60));
  for (const f of found.slice(0, maxLakes)) for (const i of f.cells) lake[i] = 1;
  return lake;
}

/** 河口から上流へ、流量最大の支流を本流として辿りながら河川を折れ線化する。 */
export function extractRivers(
  flow: Flow,
  acc: Float32Array,
  land: Uint8Array,
  w: number,
  threshold: number,
): RiverPath[] {
  const { order, receiver } = flow;
  const n = acc.length;
  const isRiver = (i: number) => land[i] === 1 && acc[i] >= threshold;
  // 河川セルの支流（donor）リスト（CSR 形式）
  const donorCount = new Int32Array(n + 1);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const r = receiver[i];
    if (r >= 0 && isRiver(i)) donorCount[r + 1]++;
  }
  for (let i = 0; i < n; i++) donorCount[i + 1] += donorCount[i];
  const donors = new Int32Array(donorCount[n]);
  const fill = donorCount.slice(0, n);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const r = receiver[i];
    if (r >= 0 && isRiver(i)) donors[fill[r]++] = i;
  }
  const center = (i: number): Pt => [(i % w) + 0.5, Math.floor(i / w) + 0.5];
  const rivers: RiverPath[] = [];
  // 河口（流下先が海・マップ外の河川セル）
  const mouths: number[] = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (isRiver(i) && receiver[i] < 0) mouths.push(i);
  }
  mouths.sort((a, b) => acc[b] - acc[a]);
  const stack: { cell: number; parent: number; mouth: number; joinAt: Pt | null }[] = [];
  for (const m of mouths) {
    stack.push({ cell: m, parent: -1, mouth: m, joinAt: null });
    while (stack.length) {
      const { cell, parent, mouth, joinAt } = stack.pop()!;
      // cell から上流へ本流を辿る（下流→上流の順で集めて最後に反転）
      const pts: Pt[] = [];
      const fl: number[] = [];
      let c = cell;
      const id = rivers.length;
      const branches: number[] = [];
      for (;;) {
        pts.push(center(c));
        fl.push(acc[c]);
        let best = -1;
        for (let k = donorCount[c]; k < donorCount[c + 1]; k++) {
          const d = donors[k];
          if (best < 0 || acc[d] > acc[best]) best = d;
        }
        for (let k = donorCount[c]; k < donorCount[c + 1]; k++) {
          const d = donors[k];
          if (d !== best) branches.push(d, c);
        }
        if (best < 0) break;
        c = best;
      }
      pts.reverse();
      fl.reverse();
      if (joinAt) {
        pts.push(joinAt);
        fl.push(fl[fl.length - 1]);
      } else {
        // 河口は海側へ半セル延ばして海岸線に届かせる
        const r = receiver[cell];
        const last = pts[pts.length - 1];
        if (r === -1) {
          const x = cell % w;
          const y = Math.floor(cell / w);
          let sx = 0;
          let sy = 0;
          let cnt = 0;
          for (let k = 0; k < 8; k++) {
            const nx = x + DX8[k];
            const ny = y + DY8[k];
            const j = ny * w + nx;
            if (nx < 0 || ny < 0 || nx >= w || j >= n) continue;
            if (!land[j]) {
              sx += DX8[k];
              sy += DY8[k];
              cnt++;
            }
          }
          if (cnt > 0) {
            const len = Math.hypot(sx, sy) || 1;
            pts.push([last[0] + (sx / len) * 0.9, last[1] + (sy / len) * 0.9]);
            fl.push(fl[fl.length - 1]);
          }
        }
      }
      let length = 0;
      for (let k = 1; k < pts.length; k++) {
        length += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      }
      rivers.push({ points: pts, flow: fl, parent, mouth, length });
      for (let k = 0; k < branches.length; k += 2) {
        stack.push({ cell: branches[k], parent: id, mouth, joinAt: center(branches[k + 1]) });
      }
    }
  }
  return rivers;
}

export { DX8, DY8, DIST8 };
