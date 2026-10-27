/** 地図向けの落ち着いた塗り分け色 */
export const COUNTRY_PALETTE = [
  '#e8c39e', '#b9d3a0', '#efd27a', '#d9a9c4', '#a9c6dd', '#c7b5df',
  '#f2ae8e', '#c3d98a', '#d8bf9a', '#a8d5c4', '#e7a5a5', '#d3c48a',
  '#b7c0e8', '#e0b8d8', '#9fcfa8', '#f0c4a8',
];

/** 隣接する国同士が同じ色にならないよう、未使用色から選ぶ。 */
export function pickColor(usedByNeighbors: Iterable<string>, preferIndex = 0): string {
  const used = new Set(usedByNeighbors);
  for (let k = 0; k < COUNTRY_PALETTE.length; k++) {
    const c = COUNTRY_PALETTE[(preferIndex + k) % COUNTRY_PALETTE.length];
    if (!used.has(c)) return c;
  }
  return COUNTRY_PALETTE[preferIndex % COUNTRY_PALETTE.length];
}

/** 隣接グラフに対する貪欲彩色（次数の大きい順）。 */
export function colorGraph(ids: number[], neighbors: Map<number, Set<number>>, offset = 0): Map<number, string> {
  const order = [...ids].sort((a, b) => (neighbors.get(b)?.size ?? 0) - (neighbors.get(a)?.size ?? 0));
  const out = new Map<number, string>();
  order.forEach((id, k) => {
    const used: string[] = [];
    for (const nb of neighbors.get(id) ?? []) {
      const c = out.get(nb);
      if (c) used.push(c);
    }
    out.set(id, pickColor(used, (k * 5 + offset) % COUNTRY_PALETTE.length));
  });
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 州の塗り分け用：国の色を明度方向にずらす */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (amount >= 0) return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
  return rgbToHex(r * (1 + amount), g * (1 + amount), b * (1 + amount));
}
