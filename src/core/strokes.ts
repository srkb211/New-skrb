import { distanceTransform } from './distance';
import { floodFill, rasterizePolyline, type Pt } from './raster';
import { simplify } from './topology';
import { PAINT_LAND, PAINT_OUTLINE, PAINT_SEA, type Stroke } from './world';

/** 手描きの点列を整える（近すぎる点の除去と間引き） */
export function cleanStroke(points: readonly Pt[], minStep: number, tol: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) out.push([p[0], p[1]]);
  }
  const lastIn = points[points.length - 1];
  const lastOut = out[out.length - 1];
  if (lastIn && lastOut && (lastIn[0] !== lastOut[0] || lastIn[1] !== lastOut[1])) out.push([lastIn[0], lastIn[1]]);
  return out.length > 2 ? simplify(out, tol) : out;
}

/**
 * 境界線の端点を、近くの海岸または既存の境界線まで延ばす。
 * 端点がわずかに届いていないだけで区画が閉じない、という失敗を防ぐ。
 */
export function snapBorderStroke(
  points: Pt[],
  land: Uint8Array,
  otherBorders: readonly Stroke[],
  w: number,
  h: number,
  radius: number,
): Pt[] {
  if (points.length < 2) return points;
  const barrier = new Uint8Array(w * h);
  for (const b of otherBorders) rasterizePolyline(b.points, w, h, (i) => (barrier[i] = 1));
  const cellOf = (p: Pt) => {
    const x = Math.floor(p[0]);
    const y = Math.floor(p[1]);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const isTarget = (i: number) => i < 0 || !land[i] || barrier[i] === 1;
  const snapEnd = (end: Pt, prev: Pt): Pt | null => {
    const c = cellOf(end);
    if (isTarget(c)) return null;
    // まず進行方向へ延長してみる
    const dx = end[0] - prev[0];
    const dy = end[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      for (let t = 0.5; t <= radius * 1.5; t += 0.5) {
        const p: Pt = [end[0] + (dx / len) * t, end[1] + (dy / len) * t];
        const i = cellOf(p);
        if (isTarget(i)) {
          if (i < 0) return [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))];
          return [(i % w) + 0.5, Math.floor(i / w) + 0.5];
        }
      }
    }
    // だめなら半径内で最も近い目標セル
    const cx = Math.floor(end[0]);
    const cy = Math.floor(end[1]);
    let best: Pt | null = null;
    let bestD = radius * radius;
    const r = Math.ceil(radius);
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!isTarget(i)) continue;
        const d = (x + 0.5 - end[0]) ** 2 + (y + 0.5 - end[1]) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = [x + 0.5, y + 0.5];
        }
      }
    }
    return best;
  };
  const out = [...points];
  const s = snapEnd(points[0], points[1]);
  const e = snapEnd(points[points.length - 1], points[points.length - 2]);
  if (s) out.unshift(s);
  if (e) out.push(e);
  return out;
}

/** 円内の点を消し、残りを分割する（境界消し・山脈消し用） */
export function eraseFromStrokes<T extends Stroke>(
  strokes: readonly T[],
  center: Pt,
  radius: number,
  newId: () => number,
): { strokes: T[]; changed: boolean } {
  const r2 = radius * radius;
  const out: T[] = [];
  let changed = false;
  for (const s of strokes) {
    // 線分を細かく刻んでから円内を除く
    const dense: Pt[] = [];
    for (let k = 0; k < s.points.length; k++) {
      const p = s.points[k];
      if (k > 0) {
        const q = s.points[k - 1];
        const len = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const steps = Math.ceil(len / Math.max(0.5, radius * 0.5));
        for (let t = 1; t < steps; t++) dense.push([q[0] + ((p[0] - q[0]) * t) / steps, q[1] + ((p[1] - q[1]) * t) / steps]);
      }
      dense.push(p);
    }
    const hit = dense.some((p) => (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 <= r2);
    if (!hit) {
      out.push(s);
      continue;
    }
    changed = true;
    let cur: Pt[] = [];
    let first = true;
    const flush = () => {
      if (cur.length >= 2) {
        out.push({ ...s, id: first ? s.id : newId(), points: simplify(cur, 0.15) });
        first = false;
      }
      cur = [];
    };
    for (const p of dense) {
      if ((p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 <= r2) flush();
      else cur.push(p);
    }
    flush();
  }
  return { strokes: changed ? out : [...strokes], changed };
}

/** 線分群のうち、円に触れるものがあるか */
export function strokesHit(strokes: readonly Stroke[], center: Pt, radius: number): boolean {
  for (const s of strokes) {
    for (let k = 0; k < s.points.length; k++) {
      const p = s.points[k];
      if (k === 0) {
        if (Math.hypot(p[0] - center[0], p[1] - center[1]) <= radius) return true;
        continue;
      }
      const q = s.points[k - 1];
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((center[0] - q[0]) * dx + (center[1] - q[1]) * dy) / l2));
      if (Math.hypot(q[0] + t * dx - center[0], q[1] + t * dy - center[1]) <= radius) return true;
    }
  }
  return false;
}

/**
 * 塗りつぶし（隙間閉じ付き）。
 * 輪郭線の小さな切れ目は gap セル分だけ塞いでから塗り、その後で輪郭線のきわまで広げる。
 */
export function fillPaint(
  paint: Uint8Array,
  w: number,
  h: number,
  start: number,
  target: typeof PAINT_LAND | typeof PAINT_SEA,
  gap: number,
): Uint8Array | null {
  const v0 = paint[start];
  if (v0 === target) return null;
  const same = (i: number) => paint[i] === v0;
  let region: Int32Array;
  if (gap > 0) {
    const dist = distanceTransform((i) => paint[i] !== v0, w, h);
    const open = (i: number) => same(i) && dist[i] > gap;
    if (open(start)) {
      const core = floodFill(w, h, start, open);
      // 塞いだ分だけ外へ広げる（元と同じ値のセルに限る）
      const mark = new Uint8Array(w * h);
      let frontier: number[] = [];
      for (const i of core) {
        mark[i] = 1;
        frontier.push(i);
      }
      for (let step = 0; step < Math.ceil(gap) + 1; step++) {
        const nextF: number[] = [];
        for (const i of frontier) {
          const x = i % w;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
            if (j < 0 || j >= w * h || mark[j] || !same(j)) continue;
            mark[j] = 1;
            nextF.push(j);
          }
        }
        frontier = nextF;
      }
      const cells: number[] = [];
      for (let i = 0; i < w * h; i++) if (mark[i]) cells.push(i);
      region = Int32Array.from(cells);
    } else {
      region = floodFill(w, h, start, same);
    }
  } else {
    region = floodFill(w, h, start, same);
  }
  const out = new Uint8Array(paint);
  for (const i of region) out[i] = target;
  return out;
}

/** 輪郭線を消す（周囲に陸があれば陸、なければ海に戻す） */
export function eraseOutline(paint: Uint8Array, w: number, h: number, cells: Iterable<number>): void {
  for (const i of cells) {
    if (paint[i] !== PAINT_OUTLINE) continue;
    const x = i % w;
    let landN = 0;
    let seaN = 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h) continue;
      if (paint[j] === PAINT_LAND) landN++;
      else if (paint[j] === PAINT_SEA) seaN++;
    }
    paint[i] = landN > seaN ? PAINT_LAND : PAINT_SEA;
  }
}
