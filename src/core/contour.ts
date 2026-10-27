import type { Pt } from './raster';

/** 辺: 0 上, 1 右, 2 下, 3 左。角: a 左上(8), b 右上(4), c 右下(2), d 左下(1) */
const SEGMENTS: Record<number, [number, number][]> = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[0, 1]],
  6: [[0, 2]],
  7: [[3, 0]],
  8: [[3, 0]],
  9: [[0, 2]],
  11: [[0, 1]],
  12: [[3, 1]],
  13: [[1, 2]],
  14: [[3, 2]],
};

/**
 * マーチングスクエア法で等値線（閉じたリング）を求める。
 * 値はセル中心 (x+0.5, y+0.5) にあるとみなし、範囲外は pad（level 未満）として扱うので必ず閉じる。
 * リングは「内側（値 > level）」が進行方向の左（cross > 0 側）になる向き。
 */
export function contourRings(
  value: (x: number, y: number) => number,
  w: number,
  h: number,
  level: number,
  pad = level - 1e-3,
): Pt[][] {
  const W = w + 2;
  const H = h + 2;
  const v = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = i - 1;
      const y = j - 1;
      v[j * W + i] = x < 0 || y < 0 || x >= w || y >= h ? pad : value(x, y);
    }
  }
  const inside = (k: number) => v[k] > level;
  // 辺キー: 横辺 (i,j)-(i+1,j) と 縦辺 (i,j)-(i,j+1)
  const hKey = (i: number, j: number) => j * W + i;
  const vKey = (i: number, j: number) => W * H + j * W + i;
  const next = new Map<number, number>();
  const pos = new Map<number, Pt>();
  const interp = (k0: number, k1: number, x0: number, y0: number, x1: number, y1: number): Pt => {
    const a = v[k0];
    const b = v[k1];
    const t = a === b ? 0.5 : Math.max(0, Math.min(1, (level - a) / (b - a)));
    return [x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5];
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const ka = j * W + i;
      const kb = ka + 1;
      const kc = ka + W + 1;
      const kd = ka + W;
      const code = (inside(ka) ? 8 : 0) | (inside(kb) ? 4 : 0) | (inside(kc) ? 2 : 0) | (inside(kd) ? 1 : 0);
      if (code === 0 || code === 15) continue;
      let segs = SEGMENTS[code];
      if (code === 5 || code === 10) {
        const center = (v[ka] + v[kb] + v[kc] + v[kd]) / 4 > level;
        if (code === 5) segs = center ? [[3, 0], [1, 2]] : [[0, 1], [3, 2]];
        else segs = center ? [[0, 1], [3, 2]] : [[3, 0], [1, 2]];
      }
      // 向きは補間点ではなく辺の中点で決める（値が閾値ちょうどだと補間点が角に重なり、向きが定まらないため）
      const edge = (e: number): { key: number; p: Pt; mid: Pt; inner: Pt } => {
        switch (e) {
          case 0:
            return { key: hKey(i, j), p: interp(ka, kb, i, j, i + 1, j), mid: [i + 0.5, j], inner: inside(ka) ? [i, j] : [i + 1, j] };
          case 1:
            return { key: vKey(i + 1, j), p: interp(kb, kc, i + 1, j, i + 1, j + 1), mid: [i + 1, j + 0.5], inner: inside(kb) ? [i + 1, j] : [i + 1, j + 1] };
          case 2:
            return { key: hKey(i, j + 1), p: interp(kd, kc, i, j + 1, i + 1, j + 1), mid: [i + 0.5, j + 1], inner: inside(kd) ? [i, j + 1] : [i + 1, j + 1] };
          default:
            return { key: vKey(i, j), p: interp(ka, kd, i, j, i, j + 1), mid: [i, j + 0.5], inner: inside(ka) ? [i, j] : [i, j + 1] };
        }
      };
      for (const [e1, e2] of segs) {
        let s = edge(e1);
        let t = edge(e2);
        const cross = (t.mid[0] - s.mid[0]) * (s.inner[1] - s.mid[1]) - (t.mid[1] - s.mid[1]) * (s.inner[0] - s.mid[0]);
        if (cross < 0) [s, t] = [t, s];
        next.set(s.key, t.key);
        pos.set(s.key, s.p);
        pos.set(t.key, t.p);
      }
    }
  }
  const rings: Pt[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const ring: Pt[] = [];
    let k: number | undefined = start;
    while (k !== undefined && !used.has(k)) {
      used.add(k);
      ring.push(pos.get(k)!);
      k = next.get(k);
    }
    if (ring.length >= 3) {
      ring.push(ring[0]);
      rings.push(ring);
    }
  }
  return rings;
}

/** 0/1 マスクを 3×3 でぼかしてから等値線を取る（ギザギザを抑える） */
export function maskRings(mask: Uint8Array, w: number, h: number): Pt[][] {
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            s += mask[y * w + x];
          } else s += mask[ny * w + nx];
          c++;
        }
      }
      // 中心を重めにして 1 セルの島も消えないようにする
      blur[y * w + x] = (s / c) * 0.6 + mask[y * w + x] * 0.4;
    }
  }
  return contourRings((x, y) => blur[y * w + x], w, h, 0.45);
}
