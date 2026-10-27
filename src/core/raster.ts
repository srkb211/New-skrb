/** ラスタ操作：線分の走査、ブラシ、塗りつぶし、連結成分、ポリゴン塗り。 */

export type Pt = [number, number];

/**
 * 線分が通過するセルを 4 連結で列挙する（Amanatides & Woo）。
 * 座標はセル単位で、セル (i,j) は [i,i+1)×[j,j+1) を占める。
 */
export function traverseSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (cx: number, cy: number) => void,
): void {
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (cx + 1 - x0) / dx : stepX < 0 ? (x0 - cx) / -dx : Infinity;
  let tMaxY = stepY > 0 ? (cy + 1 - y0) / dy : stepY < 0 ? (y0 - cy) / -dy : Infinity;
  visit(cx, cy);
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      tMaxY += tDeltaY;
    }
    visit(cx, cy);
  }
}

/** 折れ線を 4 連結の 1 セル幅で塗る。 */
export function rasterizePolyline(
  points: readonly Pt[],
  w: number,
  h: number,
  set: (i: number) => void,
): void {
  const visit = (cx: number, cy: number) => {
    if (cx >= 0 && cy >= 0 && cx < w && cy < h) set(cy * w + cx);
  };
  if (points.length === 1) {
    visit(Math.floor(points[0][0]), Math.floor(points[0][1]));
    return;
  }
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    traverseSegment(a[0], a[1], b[0], b[1], visit);
  }
}

/** 点 (px,py) を中心とする半径 r の円内のセルを列挙する（最低でも中心セル）。 */
export function stampDisk(
  px: number,
  py: number,
  r: number,
  w: number,
  h: number,
  set: (i: number) => void,
): void {
  const x0 = Math.max(0, Math.floor(px - r));
  const x1 = Math.min(w - 1, Math.floor(px + r));
  const y0 = Math.max(0, Math.floor(py - r));
  const y1 = Math.min(h - 1, Math.floor(py + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - px;
      const dy = y + 0.5 - py;
      if (dx * dx + dy * dy <= r2) set(y * w + x);
    }
  }
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  if (cx >= 0 && cy >= 0 && cx < w && cy < h) set(cy * w + cx);
}

/** 太さのある折れ線（ブラシストローク）。 */
export function stampPolyline(
  points: readonly Pt[],
  r: number,
  w: number,
  h: number,
  set: (i: number) => void,
): void {
  if (points.length === 0) return;
  stampDisk(points[0][0], points[0][1], r, w, h, set);
  const step = Math.max(0.35, r * 0.5);
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1];
    const [bx, by] = points[k];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      stampDisk(ax + (bx - ax) * t, ay + (by - ay) * t, r, w, h, set);
    }
  }
  // 細い線でも隙間ができないよう芯線を 4 連結で通す
  rasterizePolyline(points, w, h, set);
}

/** 4 連結の塗りつぶし。到達したセル番号を返す。 */
export function floodFill(
  w: number,
  h: number,
  start: number,
  passable: (i: number) => boolean,
): Int32Array {
  const n = w * h;
  if (start < 0 || start >= n || !passable(start)) return new Int32Array(0);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const out: number[] = [];
  let sp = 0;
  stack[sp++] = start;
  seen[start] = 1;
  while (sp > 0) {
    const i = stack[--sp];
    out.push(i);
    const x = i % w;
    if (x > 0 && !seen[i - 1] && passable(i - 1)) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !seen[i + 1] && passable(i + 1)) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= w && !seen[i - w] && passable(i - w)) { seen[i - w] = 1; stack[sp++] = i - w; }
    if (i < n - w && !seen[i + w] && passable(i + w)) { seen[i + w] = 1; stack[sp++] = i + w; }
  }
  return Int32Array.from(out);
}

export interface Components {
  labels: Int32Array;
  count: number;
  sizes: number[];
}

/** 連結成分のラベリング。通行不可のセルは -1。 */
export function labelComponents(
  w: number,
  h: number,
  passable: (i: number) => boolean,
  connectivity: 4 | 8 = 4,
  sameGroup?: (a: number, b: number) => boolean,
): Components {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (labels[s] !== -1 || !passable(s)) continue;
    const id = count++;
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (connectivity === 4 && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (labels[j] !== -1 || !passable(j)) continue;
          if (sameGroup && !sameGroup(i, j)) continue;
          labels[j] = id;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(size);
  }
  return { labels, count, sizes };
}

/** 閉じた多角形の内部セル（セル中心で判定、偶奇規則）を列挙する。 */
export function fillPolygon(
  poly: readonly Pt[],
  w: number,
  h: number,
  set: (i: number) => void,
): void {
  if (poly.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      const [ax, ay] = poly[m];
      const [bx, by] = poly[k];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) set(y * w + x);
    }
  }
}

/** 4 近傍の番号を列挙（範囲外は除く）。 */
export function forNeighbors4(i: number, w: number, h: number, fn: (j: number) => void): void {
  const x = i % w;
  if (x > 0) fn(i - 1);
  if (x < w - 1) fn(i + 1);
  if (i >= w) fn(i - w);
  if (i < w * h - w) fn(i + w);
}
