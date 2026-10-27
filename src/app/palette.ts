/** 標高段彩（m → RGB） */
const LAND_STOPS: [number, [number, number, number]][] = [
  [0, [112, 160, 96]],
  [120, [138, 178, 104]],
  [350, [184, 198, 128]],
  [700, [216, 204, 148]],
  [1200, [204, 172, 120]],
  [1900, [172, 134, 98]],
  [2700, [148, 120, 104]],
  [3400, [176, 170, 166]],
  [4200, [236, 236, 238]],
];

const SEA_STOPS: [number, [number, number, number]][] = [
  [0, [172, 214, 230]],
  [60, [150, 198, 222]],
  [250, [112, 168, 206]],
  [1200, [72, 128, 180]],
  [3500, [44, 90, 146]],
];

function ramp(stops: [number, [number, number, number]][], v: number, out: number[]): void {
  if (v <= stops[0][0]) {
    out[0] = stops[0][1][0];
    out[1] = stops[0][1][1];
    out[2] = stops[0][1][2];
    return;
  }
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [a, ca] = stops[k - 1];
      const [b, cb] = stops[k];
      const t = (v - a) / (b - a);
      out[0] = ca[0] + (cb[0] - ca[0]) * t;
      out[1] = ca[1] + (cb[1] - ca[1]) * t;
      out[2] = ca[2] + (cb[2] - ca[2]) * t;
      return;
    }
  }
  const c = stops[stops.length - 1][1];
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
}

/** maxElevation に合わせて段彩を伸縮させる（低い世界でも色幅を使う） */
export function landColor(elev: number, maxElevation: number, out: number[]): void {
  const k = 4200 / Math.max(800, maxElevation);
  ramp(LAND_STOPS, elev * Math.min(1.6, Math.max(0.75, k)), out);
}

export function seaColor(depth: number, out: number[]): void {
  ramp(SEA_STOPS, depth, out);
}

export const COLORS = {
  sea: '#9ccbe0',
  seaDeep: '#3f7fb6',
  outside: '#20303c',
  parchment: [243, 236, 218] as const,
  sketchLand: [234, 222, 192] as const,
  sketchOutline: [58, 48, 40] as const,
  coast: 'rgba(38, 64, 86, 0.9)',
  river: '#3f7fc4',
  lake: '#a6d0e8',
  national: '#7a2632',
  state: 'rgba(70, 60, 60, 0.75)',
  label: '#2b2420',
  halo: 'rgba(255, 252, 242, 0.85)',
};

export const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif JP", "Noto Serif CJK JP", serif';
export const SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", system-ui, sans-serif';
