import type { Pt } from './raster';

/**
 * ラベル格子の境界を「弧（arc）」に分解し、弧を共有しながら各ラベルの多角形を組み立てる。
 * 隣り合う区画が同じ弧を使うため、簡略化しても隙間や重なりが生じない（TopoJSON と同じ考え方）。
 *
 * 向きの約束：弧を進む向き d に対し、cross(d, セル中心 − 点) > 0 の側を left とする。
 * この約束では外周リングの符号付き面積（靴ひも公式）が正になる。
 */
export interface Arc {
  /** 格子の角（セル単位の整数座標）の列 */
  points: Pt[];
  left: number;
  right: number;
}

export interface Ring {
  /** 弧番号と向き（反転なら true） */
  arcs: { arc: number; reversed: boolean }[];
  /** 生の（階段状の）座標での符号付き面積 */
  area: number;
}

export interface RegionPolygon {
  label: number;
  /** 外周リングと、その穴 */
  parts: { outer: Ring; holes: Ring[] }[];
}

export interface Topology {
  arcs: Arc[];
  regions: Map<number, RegionPolygon>;
}

const UP = 0;
const DOWN = 1;
const LEFT = 2;
const RIGHT = 3;
const DXS = [0, 0, -1, 1];
const DYS = [-1, 1, 0, 0];

export function buildTopology(labels: Int32Array, w: number, h: number): Topology {
  const cw = w + 1;
  const lab = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]);

  // 角 (x,y) から方向 dir に出る辺の左右ラベル。辺が無い（範囲外）なら null。
  const sides = (x: number, y: number, dir: number): [number, number] | null => {
    switch (dir) {
      case UP:
        if (y < 1) return null;
        return [lab(x, y - 1), lab(x - 1, y - 1)];
      case DOWN:
        if (y >= h) return null;
        return [lab(x - 1, y), lab(x, y)];
      case LEFT:
        if (x < 1) return null;
        return [lab(x - 1, y - 1), lab(x - 1, y)];
      default:
        if (x >= w) return null;
        return [lab(x, y), lab(x, y - 1)];
    }
  };
  // 辺の通し番号（縦辺: (x,y)-(x,y+1)、横辺: (x,y)-(x+1,y)）
  const vCount = cw * h;
  const edgeId = (x: number, y: number, dir: number): number => {
    switch (dir) {
      case UP:
        return (y - 1) * cw + x;
      case DOWN:
        return y * cw + x;
      case LEFT:
        return vCount + y * w + (x - 1);
      default:
        return vCount + y * w + x;
    }
  };
  const isBoundary = (x: number, y: number, dir: number) => {
    const s = sides(x, y, dir);
    return s !== null && s[0] !== s[1];
  };
  const degreeAt = (x: number, y: number) => {
    let d = 0;
    for (let dir = 0; dir < 4; dir++) if (isBoundary(x, y, dir)) d++;
    return d;
  };

  const visited = new Uint8Array(vCount + w * (h + 1));
  const arcs: Arc[] = [];

  const walk = (sx: number, sy: number, firstDir: number) => {
    const [left, right] = sides(sx, sy, firstDir)!;
    const pts: Pt[] = [[sx, sy]];
    let x = sx;
    let y = sy;
    let dir = firstDir;
    for (;;) {
      visited[edgeId(x, y, dir)] = 1;
      x += DXS[dir];
      y += DYS[dir];
      pts.push([x, y]);
      if ((x === sx && y === sy) || degreeAt(x, y) >= 3) break;
      const back = dir ^ 1;
      let next = -1;
      for (let d = 0; d < 4; d++) {
        if (d !== back && isBoundary(x, y, d)) {
          next = d;
          break;
        }
      }
      if (next < 0) break;
      dir = next;
    }
    arcs.push({ points: compressCollinear(pts), left, right });
  };

  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      if (degreeAt(x, y) < 3) continue;
      for (let dir = 0; dir < 4; dir++) {
        if (isBoundary(x, y, dir) && !visited[edgeId(x, y, dir)]) walk(x, y, dir);
      }
    }
  }
  // 節点を持たない閉じた境界（島など）
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      for (const dir of [DOWN, RIGHT]) {
        if (isBoundary(x, y, dir) && !visited[edgeId(x, y, dir)]) walk(x, y, dir);
      }
    }
  }

  return { arcs, regions: assembleRegions(arcs) };
}

/** 一直線に並ぶ中間点を除く（形は変わらない） */
function compressCollinear(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1];
    const b = pts[k];
    const c = pts[k + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross !== 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const key = (p: Pt) => p[0] * 100003 + p[1];

function oriented(arc: Arc, reversed: boolean): Pt[] {
  return reversed ? [...arc.points].reverse() : arc.points;
}

function assembleRegions(arcs: Arc[]): Map<number, RegionPolygon> {
  // ラベルごとに「そのラベルが左側に来る向き」の弧を集める
  const byLabel = new Map<number, { arc: number; reversed: boolean }[]>();
  const add = (label: number, arc: number, reversed: boolean) => {
    if (label < 0) return;
    let list = byLabel.get(label);
    if (!list) byLabel.set(label, (list = []));
    list.push({ arc, reversed });
  };
  arcs.forEach((a, k) => {
    add(a.left, k, false);
    add(a.right, k, true);
  });
  const regions = new Map<number, RegionPolygon>();
  for (const [label, list] of byLabel) {
    const starts = new Map<number, number[]>();
    list.forEach((o, idx) => {
      const p = oriented(arcs[o.arc], o.reversed)[0];
      const k = key(p);
      let s = starts.get(k);
      if (!s) starts.set(k, (s = []));
      s.push(idx);
    });
    const used = new Uint8Array(list.length);
    const rings: Ring[] = [];
    for (let i0 = 0; i0 < list.length; i0++) {
      if (used[i0]) continue;
      const ring: Ring = { arcs: [], area: 0 };
      let cur = i0;
      const startPt = oriented(arcs[list[i0].arc], list[i0].reversed)[0];
      for (let guard = 0; guard < list.length + 1; guard++) {
        used[cur] = 1;
        ring.arcs.push(list[cur]);
        const pts = oriented(arcs[list[cur].arc], list[cur].reversed);
        const end = pts[pts.length - 1];
        if (end[0] === startPt[0] && end[1] === startPt[1]) break;
        const prev = pts[pts.length - 2];
        const din: Pt = [end[0] - prev[0], end[1] - prev[1]];
        const cands = (starts.get(key(end)) ?? []).filter((c) => !used[c]);
        if (cands.length === 0) break;
        let best = cands[0];
        let bestRank = Infinity;
        for (const c of cands) {
          const q = oriented(arcs[list[c].arc], list[c].reversed);
          const dout: Pt = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
          const cr = din[0] * dout[1] - din[1] * dout[0];
          const dot = din[0] * dout[0] + din[1] * dout[1];
          // 左側（ラベル側）へ最も鋭く曲がる弧を選ぶ＝斜め接触のセルを別の環にする
          const rank = cr > 0 ? 0 : cr === 0 && dot > 0 ? 1 : 2;
          if (rank < bestRank) {
            bestRank = rank;
            best = c;
          }
        }
        cur = best;
      }
      ring.area = ringArea(ringPoints(ring, arcs));
      rings.push(ring);
    }
    const outers = rings.filter((r) => r.area > 0);
    const holes = rings.filter((r) => r.area < 0);
    const parts = outers.map((outer) => ({ outer, holes: [] as Ring[], pts: ringPoints(outer, arcs) }));
    for (const hole of holes) {
      const hp = ringPoints(hole, arcs);
      // 穴の最初の辺の中点から、ラベル側（左）へ少し寄せた点で包含判定
      const a = hp[0];
      const b = hp[1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const probe: Pt = [(a[0] + b[0]) / 2 - (dy / len) * 0.25, (a[1] + b[1]) / 2 + (dx / len) * 0.25];
      let host: (typeof parts)[number] | null = null;
      for (const p of parts) {
        if (pointInRing(probe, p.pts) && (!host || p.outer.area < host.outer.area)) host = p;
      }
      (host ?? parts[0])?.holes.push(hole);
    }
    regions.set(label, { label, parts: parts.map(({ outer, holes: hs }) => ({ outer, holes: hs })) });
  }
  return regions;
}

export function ringPoints(ring: Ring, arcs: readonly { points: Pt[] }[]): Pt[] {
  const out: Pt[] = [];
  for (const { arc, reversed } of ring.arcs) {
    const pts = reversed ? [...arcs[arc].points].reverse() : arcs[arc].points;
    for (let k = out.length === 0 ? 0 : 1; k < pts.length; k++) out.push(pts[k]);
  }
  return out;
}

export function ringArea(pts: Pt[]): number {
  let s = 0;
  for (let k = 0; k < pts.length - 1; k++) s += pts[k][0] * pts[k + 1][1] - pts[k + 1][0] * pts[k][1];
  return s / 2;
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polylineLength(pts: readonly Pt[]): number {
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return len;
}

/** Douglas–Peucker 法（端点は保持。閉じた折れ線は最遠点で 2 分割して処理） */
export function simplify(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return [...pts];
  const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) {
    let far = 1;
    let best = -1;
    for (let k = 1; k < pts.length - 1; k++) {
      const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    const a = simplifyOpen(pts.slice(0, far + 1), tol);
    const b = simplifyOpen(pts.slice(far), tol);
    const out = [...a, ...b.slice(1)];
    return out.length >= 4 ? out : [...pts];
  }
  return simplifyOpen(pts, tol);
}

function simplifyOpen(pts: readonly Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n <= 2) return [...pts];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = pts[k];
      let d2: number;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = k;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

/** Chaikin 法による平滑化（端点は保持） */
export function chaikin(pts: readonly Pt[], iterations = 2, closed = false): Pt[] {
  let cur = [...pts];
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const next: Pt[] = [];
    if (!closed) next.push(cur[0]);
    const n = cur.length;
    const segs = closed ? n - 1 : n - 1;
    for (let k = 0; k < segs; k++) {
      const a = cur[k];
      const b = cur[k + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(cur[n - 1]);
    else next.push(next[0]);
    cur = next;
  }
  return cur;
}
