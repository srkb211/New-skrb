import { BIOMES, KOPPEN_CODES, KOPPEN_INFO, type ClimateData } from '../core/climate';
import { hexToRgb } from '../core/colors';

export type ClimateLayer = 'none' | 'temp' | 'precip' | 'trange' | 'pseason' | 'koppen' | 'biome';

export const CLIMATE_LAYERS: { id: ClimateLayer; label: string; unit: string }[] = [
  { id: 'none', label: '表示しない', unit: '' },
  { id: 'temp', label: '年平均気温', unit: '°C' },
  { id: 'precip', label: '年間降水量', unit: 'mm/年' },
  { id: 'trange', label: '気温の年較差（季節性）', unit: '°C' },
  { id: 'pseason', label: '降水の季節性', unit: '' },
  { id: 'koppen', label: '気候区分（ケッペン）', unit: '' },
  { id: 'biome', label: 'バイオーム', unit: '' },
];

type Stops = [number, string][];

export const TEMP_STOPS: Stops = [
  [-35, '#3b1f73'],
  [-20, '#3f5fb8'],
  [-8, '#6ea6dd'],
  [0, '#cfe9f2'],
  [8, '#e8f0b4'],
  [16, '#f6d36b'],
  [22, '#f39a3d'],
  [28, '#d9472b'],
  [36, '#8c1424'],
];

export const PRECIP_STOPS: Stops = [
  [0, '#a8742c'],
  [150, '#cf9d4f'],
  [350, '#e3cc7c'],
  [700, '#d8e3a0'],
  [1100, '#8fca7f'],
  [1800, '#3e9f68'],
  [2800, '#1f7f93'],
  [4500, '#244f9e'],
  [8000, '#3a2777'],
];

export const TRANGE_STOPS: Stops = [
  [0, '#2c6fb0'],
  [8, '#8cc4df'],
  [18, '#f6f2c4'],
  [30, '#f6a65a'],
  [45, '#d8402a'],
  [60, '#7e1020'],
];

/** 高日射期の降水割合 0..1：0 冬に多雨、0.5 季節差なし、1 夏に多雨 */
export const PSEASON_STOPS: Stops = [
  [0, '#6a2c91'],
  [0.3, '#b98bc9'],
  [0.5, '#f3f1ea'],
  [0.7, '#8fcf8a'],
  [1, '#1b7a3a'],
];

const rgbCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let c = rgbCache.get(hex);
  if (!c) rgbCache.set(hex, (c = hexToRgb(hex)));
  return c;
}

export function rampColor(stops: Stops, v: number): [number, number, number] {
  if (!Number.isFinite(v)) return [255, 0, 255];
  if (v <= stops[0][0]) return rgb(stops[0][1]);
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [a, ca] = stops[k - 1];
      const [b, cb] = stops[k];
      const t = (v - a) / (b - a);
      const x = rgb(ca);
      const y = rgb(cb);
      return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
    }
  }
  return rgb(stops[stops.length - 1][1]);
}

/** 気候セル c の表示色（null は描かない） */
export function climateColor(layer: ClimateLayer, d: ClimateData, c: number): [number, number, number] | null {
  const land = d.land[c] >= 0.5;
  switch (layer) {
    case 'temp':
      return rampColor(TEMP_STOPS, d.tMean[c]);
    case 'precip':
      return land ? rampColor(PRECIP_STOPS, d.precip[c]) : null;
    case 'trange':
      return land ? rampColor(TRANGE_STOPS, d.tWarm[c] - d.tCold[c]) : null;
    case 'pseason':
      return land ? rampColor(PSEASON_STOPS, d.highSun[c]) : null;
    case 'koppen': {
      if (!land) return null;
      const info = KOPPEN_INFO[KOPPEN_CODES[d.koppen[c]] ?? ''];
      return info ? rgb(info.color) : null;
    }
    case 'biome':
      return land && d.biome[c] > 0 ? rgb(BIOMES[d.biome[c]]?.color ?? '#000000') : null;
    default:
      return null;
  }
}

export interface LegendItem {
  color: string;
  label: string;
}

export interface Legend {
  title: string;
  /** 連続値：色の段階と目盛り */
  ramp?: { stops: Stops; ticks: number[]; format: (v: number) => string };
  /** 区分：データに現れるものだけ */
  items?: LegendItem[];
}

export function legendFor(layer: ClimateLayer, d: ClimateData): Legend | null {
  switch (layer) {
    case 'temp':
      return { title: '年平均気温 (°C)', ramp: { stops: TEMP_STOPS, ticks: [-30, -15, 0, 10, 20, 30], format: (v) => `${v}` } };
    case 'precip':
      return { title: '年間降水量 (mm/年)', ramp: { stops: PRECIP_STOPS, ticks: [0, 350, 1100, 2800, 8000], format: (v) => `${v}` } };
    case 'trange':
      return { title: '気温の年較差 (°C)', ramp: { stops: TRANGE_STOPS, ticks: [0, 18, 30, 45, 60], format: (v) => `${v}` } };
    case 'pseason':
      return {
        title: '降水の季節性',
        ramp: { stops: PSEASON_STOPS, ticks: [0, 0.5, 1], format: (v) => (v === 0 ? '冬に多雨' : v === 1 ? '夏に多雨' : '差なし') },
      };
    case 'koppen':
    case 'biome': {
      const counts = new Map<number, number>();
      const arr = layer === 'koppen' ? d.koppen : d.biome;
      for (let c = 0; c < arr.length; c++) if (arr[c] > 0 && d.land[c] >= 0.5) counts.set(arr[c], (counts.get(arr[c]) ?? 0) + 1);
      const items = [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([code]) => {
          if (layer === 'koppen') {
            const k = KOPPEN_CODES[code];
            return { color: KOPPEN_INFO[k].color, label: `${k} ${KOPPEN_INFO[k].label}` };
          }
          return { color: BIOMES[code].color, label: BIOMES[code].label };
        });
      return { title: layer === 'koppen' ? '気候区分（ケッペン近似）' : 'バイオーム', items };
    }
    default:
      return null;
  }
}
