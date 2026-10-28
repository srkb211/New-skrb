import { distanceTransform } from './distance';
import { clampLatitude, frameAxes, latitudeAt, type GeoFrame } from './geoframe';
import { Noise2D, clamp, smoothstep } from './noise';
import { hashInts } from './rng';

/**
 * 初期段階の架空世界向け「近似」気候モデル。
 *
 * 気象予測ではなく、次の単純化した仮定から気温・降水の大まかな分布を作る：
 *  1. 緯度相当と地軸の傾きから大気上端の日射量（月平均）を求め、線形式で海面気温に換算
 *  2. 標高に比例した気温低下（気温減率）
 *  3. 海洋からの距離（風上側の距離を重視）で季節の振れ幅を増減（海洋性 ⇔ 大陸性）
 *  4. 緯度帯ごとの卓越風（貿易風・偏西風・極東風）または固定風向で水蒸気を運び、
 *     風上斜面で降水が増え、風下で減る（雨陰）。夏・冬で降水帯を南北にずらして季節性を出す
 *  5. 月別の気温・降水からケッペン気候区分を判定し、気候区分と降水量からバイオームを決める
 * 海流・氷雪のアルベド・季節の遅れ・大気の大循環の詳細などは扱わない。
 */
export const CLIMATE_ALGORITHM = 'fantasy-atlas/climate-energy-advection';
export const CLIMATE_VERSION = '1.0.0';

export const CLIMATE_UNITS = {
  temperature: '°C',
  precipitation: 'mm/年',
  temperatureRange: '°C（最暖月−最寒月）',
  precipitationSeasonality: '0〜1（0=季節差なし, 1=半年に集中）',
  highSunFraction: '高日射期（夏半年）の降水割合 0〜1',
  position: 'セル（地図座標）および km',
  latitude: '度（緯度相当。世界設定から算出）',
} as const;

// ---------------------------------------------------------------------------
// パラメータ

export interface KoppenThresholds {
  /** A：最寒月平均気温の下限 (°C) */
  tropicalMinCold: number;
  /** C と D の境：最寒月平均気温 (°C)。-3 または 0 がよく使われる */
  cdBoundary: number;
  /** E：最暖月平均気温の上限 (°C) */
  polarMaxWarm: number;
  /** EF：最暖月平均気温の上限 (°C) */
  iceMaxWarm: number;
  /** B：乾燥限界 = aridFactor × 年平均気温 + 補正 (mm) */
  aridFactor: number;
  aridSummerOffset: number;
  aridEvenOffset: number;
  aridWinterOffset: number;
  /** BWh/BSh と BWk/BSk の境：年平均気温 (°C) */
  hotAridMean: number;
  /** Af：最少雨月降水量の下限 (mm) */
  tropicalWetMonth: number;
  /** s：夏の最少雨月の上限 (mm) と、冬の最多雨月との比 */
  summerDryMax: number;
  summerDryRatio: number;
  /** w：冬の最少雨月が夏の最多雨月の 1/ratio 未満 */
  winterDryRatio: number;
  /** a：最暖月平均気温の下限 (°C) */
  hotSummer: number;
  /** b：月平均気温がこの値以上の月が warmMonths か月以上 */
  warmMonthTemp: number;
  warmMonths: number;
  /** d：最寒月平均気温の上限 (°C) */
  extremeCold: number;
}

export interface BiomeThresholds {
  /**
   * これ未満の年降水量の温帯・亜寒帯は草原 (mm)。年平均 10°C のときの値で、
   * 寒いほど小さく・暑いほど大きく補正する（蒸発量の違いを反映）
   */
  grasslandMaxPrecip: number;
  /** 温帯雨林になる年降水量 (mm) */
  temperateRainforestMinPrecip: number;
  /** 熱帯雨林になる年降水量 (mm) */
  tropicalRainforestMinPrecip: number;
  /** 熱帯季節林になる年降水量（これ未満はサバナ） (mm) */
  tropicalSeasonalMinPrecip: number;
  /** 照葉樹林（亜熱帯湿潤林）になる年平均気温 (°C) */
  subtropicalMinTemp: number;
  /** E 気候のうち高山帯とみなす標高 (m) */
  alpineMinElevation: number;
}

export interface ClimateParams {
  /** 局所的なゆらぎの乱数シード */
  seed: number;
  /** 気候グリッドの粗さ（地形セル何個分で 1 気候セルか） */
  gridFactor: number;
  /** 全球の気温補正 (°C) */
  tempOffset: number;
  /** 気温減率 (°C/km) */
  lapseRate: number;
  /** 大陸度が約 63% になる海からの距離 (km) */
  continentalityKm: number;
  /** 海洋上・内陸での季節の振れ幅（日射の季節変化に対する比） */
  maritimeAmplitude: number;
  continentalAmplitude: number;
  /** 海洋による高緯度の温暖化 (°C)。海流などによる熱の運搬を、海に近いほど暖かくする形で近似 */
  oceanWarming: number;
  /** 卓越風：緯度帯モデル または 固定風向 */
  windMode: 'bands' | 'fixed';
  /** 固定風向のとき、風が吹いてくる方角（北相当から時計回り, 度） */
  windFrom: number;
  /** 季節による降水帯の南北移動 (度) */
  seasonalShift: number;
  /** 水蒸気が雨として失われる基本の距離 (km)。長いほど内陸まで湿る */
  moistureLengthKm: number;
  /** 地形性降水の強さ（0 で無効） */
  orographic: number;
  /** 降水量の全体倍率 */
  precipScale: number;
  /** 陸上での蒸発散による水蒸気の再供給率 0〜1 */
  recycling: number;
  /** 局所ゆらぎの強さ 0〜1 */
  variability: number;
  koppen: KoppenThresholds;
  biome: BiomeThresholds;
}

export const DEFAULT_KOPPEN: KoppenThresholds = {
  tropicalMinCold: 18,
  cdBoundary: -3,
  polarMaxWarm: 10,
  iceMaxWarm: 0,
  aridFactor: 20,
  aridSummerOffset: 280,
  aridEvenOffset: 140,
  aridWinterOffset: 0,
  hotAridMean: 18,
  tropicalWetMonth: 60,
  summerDryMax: 40,
  summerDryRatio: 3,
  winterDryRatio: 10,
  hotSummer: 22,
  warmMonthTemp: 10,
  warmMonths: 4,
  extremeCold: -38,
};

export const DEFAULT_BIOME: BiomeThresholds = {
  grasslandMaxPrecip: 450,
  temperateRainforestMinPrecip: 2000,
  tropicalRainforestMinPrecip: 1800,
  tropicalSeasonalMinPrecip: 1000,
  subtropicalMinTemp: 14,
  alpineMinElevation: 1500,
};

export const DEFAULT_CLIMATE_PARAMS: ClimateParams = {
  seed: 1,
  gridFactor: 2,
  tempOffset: 0,
  lapseRate: 6.5,
  continentalityKm: 700,
  maritimeAmplitude: 0.15,
  continentalAmplitude: 0.66,
  oceanWarming: 5,
  windMode: 'bands',
  windFrom: 270,
  seasonalShift: 6,
  moistureLengthKm: 1400,
  orographic: 1,
  precipScale: 1,
  recycling: 0.35,
  variability: 0.3,
  koppen: { ...DEFAULT_KOPPEN },
  biome: { ...DEFAULT_BIOME },
};

/** 各パラメータの有効範囲（範囲外は計算前に丸め、検証で報告する） */
export const CLIMATE_PARAM_LIMITS: Record<string, [number, number]> = {
  gridFactor: [1, 8],
  tempOffset: [-40, 40],
  lapseRate: [0, 15],
  continentalityKm: [10, 10000],
  maritimeAmplitude: [0, 1.5],
  continentalAmplitude: [0, 1.5],
  oceanWarming: [0, 20],
  windFrom: [-360, 360],
  seasonalShift: [0, 30],
  moistureLengthKm: [50, 20000],
  orographic: [0, 5],
  precipScale: [0, 10],
  recycling: [0, 0.9],
  variability: [0, 1],
};

export function withClimateDefaults(p: Partial<ClimateParams> | undefined): ClimateParams {
  return {
    ...DEFAULT_CLIMATE_PARAMS,
    ...(p ?? {}),
    koppen: { ...DEFAULT_KOPPEN, ...(p?.koppen ?? {}) },
    biome: { ...DEFAULT_BIOME, ...(p?.biome ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// 分類コード

export const KOPPEN_CODES = [
  '', 'Af', 'Am', 'Aw', 'As', 'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd', 'Dfa', 'Dfb', 'Dfc', 'Dfd',
  'ET', 'EF',
] as const;

export const KOPPEN_INFO: Record<string, { label: string; color: string }> = {
  Af: { label: '熱帯雨林気候', color: '#0000fe' },
  Am: { label: '熱帯モンスーン気候', color: '#0077ff' },
  Aw: { label: 'サバナ気候（冬季乾燥）', color: '#46a9fa' },
  As: { label: 'サバナ気候（夏季乾燥）', color: '#78c8fa' },
  BWh: { label: '砂漠気候（高温）', color: '#fe0000' },
  BWk: { label: '砂漠気候（低温）', color: '#fe9695' },
  BSh: { label: 'ステップ気候（高温）', color: '#f5a301' },
  BSk: { label: 'ステップ気候（低温）', color: '#ffdb63' },
  Csa: { label: '地中海性気候（暑夏）', color: '#ffff00' },
  Csb: { label: '地中海性気候（温夏）', color: '#c6c700' },
  Csc: { label: '地中海性気候（冷夏）', color: '#969600' },
  Cwa: { label: '温暖冬季少雨気候（暑夏）', color: '#96ff96' },
  Cwb: { label: '温暖冬季少雨気候（温夏）', color: '#63c764' },
  Cwc: { label: '温暖冬季少雨気候（冷夏）', color: '#329633' },
  Cfa: { label: '温暖湿潤気候', color: '#c6ff4e' },
  Cfb: { label: '西岸海洋性気候', color: '#66ff33' },
  Cfc: { label: '西岸海洋性気候（冷夏）', color: '#33c701' },
  Dsa: { label: '亜寒帯夏季少雨気候（暑夏）', color: '#ff00fe' },
  Dsb: { label: '亜寒帯夏季少雨気候（温夏）', color: '#c600c7' },
  Dsc: { label: '亜寒帯夏季少雨気候（冷夏）', color: '#963295' },
  Dsd: { label: '亜寒帯夏季少雨気候（極寒）', color: '#966495' },
  Dwa: { label: '亜寒帯冬季少雨気候（暑夏）', color: '#abb1ff' },
  Dwb: { label: '亜寒帯冬季少雨気候（温夏）', color: '#5a77db' },
  Dwc: { label: '亜寒帯冬季少雨気候（冷夏）', color: '#4c51b5' },
  Dwd: { label: '亜寒帯冬季少雨気候（極寒）', color: '#320087' },
  Dfa: { label: '亜寒帯湿潤気候（暑夏）', color: '#00ffff' },
  Dfb: { label: '亜寒帯湿潤気候（温夏）', color: '#38c7ff' },
  Dfc: { label: '亜寒帯湿潤気候（冷夏）', color: '#007e7d' },
  Dfd: { label: '亜寒帯湿潤気候（極寒）', color: '#00455e' },
  ET: { label: 'ツンドラ気候', color: '#b2b2b2' },
  EF: { label: '氷雪気候', color: '#686868' },
};

export const BIOMES = [
  { key: 'none', label: '—', color: '#000000' },
  { key: 'ice', label: '氷雪', color: '#eef4f8' },
  { key: 'tundra', label: 'ツンドラ', color: '#b7bda9' },
  { key: 'alpine', label: '高山帯', color: '#a39b92' },
  { key: 'taiga', label: '亜寒帯針葉樹林（タイガ）', color: '#3d6b56' },
  { key: 'mixed', label: '冷温帯混交林', color: '#4f8a5a' },
  { key: 'deciduous', label: '温帯落葉樹林', color: '#72a65a' },
  { key: 'temperate_rainforest', label: '温帯雨林', color: '#2c7d60' },
  { key: 'laurel', label: '照葉樹林（亜熱帯湿潤林）', color: '#4d9c44' },
  { key: 'mediterranean', label: '地中海性硬葉樹林・低木林', color: '#a8a85b' },
  { key: 'grassland', label: '温帯草原', color: '#c8d07e' },
  { key: 'steppe', label: 'ステップ（乾燥草原）', color: '#d9c682' },
  { key: 'cold_desert', label: '寒冷砂漠', color: '#d4cbb2' },
  { key: 'hot_desert', label: '熱帯・亜熱帯砂漠', color: '#ecd9a2' },
  { key: 'savanna', label: 'サバナ', color: '#cbb95a' },
  { key: 'tropical_seasonal', label: '熱帯季節林', color: '#8daf3a' },
  { key: 'tropical_rainforest', label: '熱帯雨林', color: '#1d7838' },
] as const;

export type BiomeKey = (typeof BIOMES)[number]['key'];
export const BIOME_INDEX: Record<BiomeKey, number> = Object.fromEntries(BIOMES.map((b, i) => [b.key, i])) as Record<BiomeKey, number>;

// ---------------------------------------------------------------------------
// データ

export interface ClimateMeta {
  algorithm: string;
  version: string;
  seed: number;
  params: ClimateParams;
  frame: GeoFrame;
  /** 気候グリッドの大きさ */
  width: number;
  height: number;
  gridFactor: number;
  /** 気候セル 1 辺の長さ (km) */
  cellKm: number;
  /** 計算に使った標高データの指紋（地形が変わったかの判定用） */
  sourceHash: string;
  generatedAt: string;
  units: typeof CLIMATE_UNITS;
  /** 計算時の検証結果の要約 */
  issues: ValidationIssue[];
}

/**
 * 気候グリッド。セル ID は i = iy * width + ix。
 * セル中心の地図座標は ((ix + 0.5) * gridFactor, (iy + 0.5) * gridFactor)（地形セル単位）。
 */
export interface ClimateData {
  meta: ClimateMeta;
  /** 年平均気温 (°C) */
  tMean: Float32Array;
  /** 最暖月・最寒月の平均気温 (°C) */
  tWarm: Float32Array;
  tCold: Float32Array;
  /** 年降水量 (mm/年) */
  precip: Float32Array;
  /** 高日射期（夏半年）の降水割合 0〜1 */
  highSun: Float32Array;
  /** 陸の割合 0〜1 */
  land: Float32Array;
  /** 平均標高 (m)（陸のみ。海は 0） */
  elevation: Float32Array;
  /** ケッペン気候区分（KOPPEN_CODES の添字、0 は海） */
  koppen: Uint8Array;
  /** バイオーム（BIOMES の添字、0 は海） */
  biome: Uint8Array;
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  count?: number;
}

export interface ClimateInput {
  /** 地形グリッド */
  w: number;
  h: number;
  kmPerCell: number;
  land: Uint8Array;
  /** 標高 (m)。地形が未生成なら null（陸は標高 0 として扱う） */
  elevation: Float32Array | null;
  frame: GeoFrame;
  params: ClimateParams;
}

// ---------------------------------------------------------------------------
// 日射と気温

const S0 = 1361;
/** 大気上端の日平均日射量 (W/m²) */
export function dailyInsolation(latDeg: number, declDeg: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const d = (declDeg * Math.PI) / 180;
  const x = -Math.tan(phi) * Math.tan(d);
  const h0 = x >= 1 ? 0 : x <= -1 ? Math.PI : Math.acos(x);
  return Math.max(0, (S0 / Math.PI) * (h0 * Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.sin(h0)));
}

/** 月 m（0=1 月）の太陽赤緯 */
export function monthDeclination(m: number, tilt: number): number {
  const day = 15 + 30.42 * m;
  return tilt * Math.sin((2 * Math.PI * (day - 80)) / 365.25);
}

/**
 * 日射量 (W/m²) から海面気温 (°C) への換算表。
 * 地球の緯度帯ごとの年平均気温に合うよう折れ線で近似したもの（大気による熱輸送の効果を含む）。
 */
export const INSOLATION_TO_TEMP: [number, number][] = [
  [0, -50],
  [173, -22],
  [178, -18],
  [185, -14],
  [198, -10],
  [214, -5],
  [237, -1],
  [261, 3],
  [285, 7],
  [307, 11],
  [328, 14],
  [365, 20],
  [393, 25],
  [415, 27],
  [520, 41],
  [600, 50],
];

export function insolationToTemp(q: number): number {
  const t = INSOLATION_TO_TEMP;
  if (q <= t[0][0]) return t[0][1];
  for (let k = 1; k < t.length; k++) {
    if (q <= t[k][0]) {
      const [q0, v0] = t[k - 1];
      const [q1, v1] = t[k];
      return v0 + ((v1 - v0) * (q - q0)) / (q1 - q0);
    }
  }
  return t[t.length - 1][1];
}

/**
 * 緯度ごとの気温表。annual は年平均日射から求めた年平均気温、
 * months は月ごとの日射から求めた値で、季節変化の「形」だけに使う（monthsMean からの偏差）。
 */
function rawTempTable(tilt: number): { lat0: number; step: number; months: Float32Array[]; monthsMean: Float32Array; annual: Float32Array } {
  const step = 0.5;
  const n = Math.round(180 / step) + 1;
  const months = Array.from({ length: 12 }, () => new Float32Array(n));
  const monthsMean = new Float32Array(n);
  const annual = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const lat = -90 + k * step;
    let s = 0;
    let q = 0;
    for (let m = 0; m < 12; m++) {
      const qm = dailyInsolation(lat, monthDeclination(m, tilt));
      const t = insolationToTemp(qm);
      months[m][k] = t;
      s += t;
      q += qm;
    }
    monthsMean[k] = s / 12;
    annual[k] = insolationToTemp(q / 12);
  }
  return { lat0: -90, step, months, monthsMean, annual };
}

function tableAt(arr: Float32Array, lat: number, lat0: number, step: number): number {
  const f = (lat - lat0) / step;
  const i = Math.max(0, Math.min(arr.length - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - i));
  return arr[i] * (1 - t) + arr[i + 1] * t;
}

// ---------------------------------------------------------------------------
// 卓越風

/** 緯度帯モデルの風（東向き・北向き成分、最大 1） */
export function bandWind(lat: number): [number, number] {
  const a = Math.abs(lat);
  const s = lat >= 0 ? 1 : -1;
  const rad = Math.PI / 180;
  if (a < 30) {
    // 貿易風：東から、赤道へ向かう
    const e = -Math.cos(a * 3 * rad);
    return [e, -0.35 * s * Math.abs(e)];
  }
  if (a < 60) {
    // 偏西風：西から、極へ向かう
    const e = Math.sin((a - 30) * 6 * rad);
    return [e, 0.35 * s * e];
  }
  // 極東風
  const e = -Math.sin(Math.min(180, (a - 60) * 6) * rad);
  return [e, -0.35 * s * Math.abs(e)];
}

/** 緯度帯ごとの大規模な降水の起こりやすさ（熱帯収束帯で多く、亜熱帯高圧帯で少ない） */
export function zonalPrecipFactor(lat: number): number {
  const a = Math.abs(lat);
  const itcz = 1.4 * Math.exp(-((lat / 9) ** 2));
  const storm = 0.85 * Math.exp(-(((a - 52) / 14) ** 2));
  const polar = 1 - 0.55 * smoothstep(62, 90, a);
  return (0.2 + itcz + storm) * polar;
}

/** 気温に対する水蒸気量の上限（相対値、25°C で 1） */
export function moistureCapacity(t: number): number {
  return clamp(Math.exp(0.035 * (t - 25)), 0.03, 1.4);
}

// ---------------------------------------------------------------------------
// 気候区分

export interface MonthlyClimate {
  /** 12 か月の平均気温 (°C) */
  t: number[];
  /** 12 か月の降水量 (mm) */
  p: number[];
  /** 夏（高日射期）の月か */
  summer: boolean[];
}

/** 月別データからケッペン気候区分（KOPPEN_CODES の添字）を判定する */
export function classifyKoppen(mc: MonthlyClimate, th: KoppenThresholds): number {
  const { t, p, summer } = mc;
  let tSum = 0;
  let pAnn = 0;
  let tWarm = -Infinity;
  let tCold = Infinity;
  let pSummer = 0;
  for (let m = 0; m < 12; m++) {
    tSum += t[m];
    pAnn += p[m];
    tWarm = Math.max(tWarm, t[m]);
    tCold = Math.min(tCold, t[m]);
    if (summer[m]) pSummer += p[m];
  }
  const tAnn = tSum / 12;
  const code = (s: string) => KOPPEN_CODES.indexOf(s as (typeof KOPPEN_CODES)[number]);
  if (tWarm < th.polarMaxWarm) return code(tWarm < th.iceMaxWarm ? 'EF' : 'ET');
  const frac = pAnn > 0 ? pSummer / pAnn : 0.5;
  const offset = frac >= 0.7 ? th.aridSummerOffset : frac <= 0.3 ? th.aridWinterOffset : th.aridEvenOffset;
  const pTh = Math.max(0, th.aridFactor * tAnn + offset);
  if (pAnn < pTh) {
    return code((pAnn < pTh / 2 ? 'BW' : 'BS') + (tAnn >= th.hotAridMean ? 'h' : 'k'));
  }
  let pDry = Infinity;
  let psMin = Infinity;
  let psMax = 0;
  let pwMin = Infinity;
  let pwMax = 0;
  for (let m = 0; m < 12; m++) {
    pDry = Math.min(pDry, p[m]);
    if (summer[m]) {
      psMin = Math.min(psMin, p[m]);
      psMax = Math.max(psMax, p[m]);
    } else {
      pwMin = Math.min(pwMin, p[m]);
      pwMax = Math.max(pwMax, p[m]);
    }
  }
  if (tCold >= th.tropicalMinCold) {
    if (pDry >= th.tropicalWetMonth) return code('Af');
    if (pDry >= 100 - pAnn / 25) return code('Am');
    return code(psMin < pwMin ? 'As' : 'Aw');
  }
  const group = tCold > th.cdBoundary ? 'C' : 'D';
  const isS = psMin < th.summerDryMax && psMin < pwMax / th.summerDryRatio;
  const isW = pwMin < psMax / th.winterDryRatio;
  let second = 'f';
  if (isS && isW) second = pwMin / Math.max(1e-6, psMax) < psMin / Math.max(1e-6, pwMax) ? 'w' : 's';
  else if (isS) second = 's';
  else if (isW) second = 'w';
  let warmCount = 0;
  for (let m = 0; m < 12; m++) if (t[m] >= th.warmMonthTemp) warmCount++;
  let third: string;
  if (tWarm >= th.hotSummer) third = 'a';
  else if (warmCount >= th.warmMonths) third = 'b';
  else if (group === 'D' && tCold < th.extremeCold) third = 'd';
  else third = 'c';
  if (group === 'C' && third === 'd') third = 'c';
  return code(group + second + third);
}

/** 気候区分・年降水量などからバイオーム（BIOMES の添字）を決める */
export function classifyBiome(koppen: number, tMean: number, precip: number, elevation: number, lat: number, th: BiomeThresholds): number {
  const k = KOPPEN_CODES[koppen] ?? '';
  const b = (key: BiomeKey) => BIOME_INDEX[key];
  if (!k) return 0;
  if (k === 'EF') return b('ice');
  if (k === 'ET') return elevation >= th.alpineMinElevation && Math.abs(lat) < 62 ? b('alpine') : b('tundra');
  if (k.startsWith('BW')) return k.endsWith('h') ? b('hot_desert') : b('cold_desert');
  if (k.startsWith('BS')) return b('steppe');
  if (k === 'Af' || k === 'Am') return precip >= th.tropicalRainforestMinPrecip ? b('tropical_rainforest') : b('tropical_seasonal');
  if (k === 'Aw' || k === 'As') return precip >= th.tropicalSeasonalMinPrecip ? b('tropical_seasonal') : b('savanna');
  if (k.startsWith('Cs')) return b('mediterranean');
  const grassMax = th.grasslandMaxPrecip * clamp((tMean + 10) / 20, 0.25, 1.6);
  if (k.startsWith('C')) {
    if (precip < grassMax) return b('grassland');
    if (precip >= th.temperateRainforestMinPrecip && tMean < th.subtropicalMinTemp + 4) return b('temperate_rainforest');
    if (k.endsWith('a') && tMean >= th.subtropicalMinTemp) return b('laurel');
    return b('deciduous');
  }
  // D
  if (precip < grassMax) return b('grassland');
  return k.endsWith('a') || k.endsWith('b') ? b('mixed') : b('taiga');
}

/** 半年ごとの降水から月別降水を近似する（正弦波で配分） */
export function monthlyPrecip(precip: number, highSunFrac: number, northern: boolean): number[] {
  const diff = 2 * highSunFrac - 1;
  const amp = clamp(1.553 * diff, -0.95, 0.95);
  const peak = northern ? 5.5 : 11.5;
  const out: number[] = [];
  for (let m = 0; m < 12; m++) out.push((precip / 12) * (1 + amp * Math.cos((2 * Math.PI * (m - peak)) / 12)));
  return out;
}

export function summerMonths(northern: boolean): boolean[] {
  return Array.from({ length: 12 }, (_, m) => (northern ? m >= 3 && m <= 8 : m <= 2 || m >= 9));
}

// ---------------------------------------------------------------------------
// 計算本体

/** 配列の指紋（気候が今の地形から計算されたものかを判定するため） */
export function fingerprint(a: Float32Array | Uint8Array | null): string {
  if (!a) return 'none';
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(a.length / 4096));
  for (let i = 0; i < a.length; i += step) {
    h ^= Math.round(a[i] * 100) | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${a.length}:${h.toString(16)}`;
}

/** パラメータを有効範囲に丸め、範囲外だったものを報告する */
export function sanitizeClimateParams(p: ClimateParams): { params: ClimateParams; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const out = withClimateDefaults(p);
  const rec = out as unknown as Record<string, unknown>;
  for (const [key, [lo, hi]] of Object.entries(CLIMATE_PARAM_LIMITS)) {
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ level: 'warning', code: 'param-invalid', message: `パラメータ ${key} が無効な値のため既定値を使いました` });
      rec[key] = (DEFAULT_CLIMATE_PARAMS as unknown as Record<string, number>)[key];
    } else if (v < lo || v > hi) {
      issues.push({ level: 'warning', code: 'param-range', message: `パラメータ ${key}=${v} は範囲外（${lo}〜${hi}）のため丸めました` });
      rec[key] = clamp(v, lo, hi);
    }
  }
  out.gridFactor = Math.max(1, Math.round(out.gridFactor));
  for (const group of ['koppen', 'biome'] as const) {
    const g = out[group] as unknown as Record<string, number>;
    const d = (group === 'koppen' ? DEFAULT_KOPPEN : DEFAULT_BIOME) as unknown as Record<string, number>;
    for (const key of Object.keys(d)) {
      if (typeof g[key] !== 'number' || !Number.isFinite(g[key])) {
        issues.push({ level: 'warning', code: 'threshold-invalid', message: `分類条件 ${key} が無効なため既定値を使いました` });
        g[key] = d[key];
      }
    }
  }
  if (out.koppen.summerDryRatio <= 0 || out.koppen.winterDryRatio <= 0) {
    issues.push({ level: 'warning', code: 'threshold-range', message: '乾季判定の比は正の値にしてください（既定値を使いました）' });
    if (out.koppen.summerDryRatio <= 0) out.koppen.summerDryRatio = DEFAULT_KOPPEN.summerDryRatio;
    if (out.koppen.winterDryRatio <= 0) out.koppen.winterDryRatio = DEFAULT_KOPPEN.winterDryRatio;
  }
  if (out.koppen.iceMaxWarm > out.koppen.polarMaxWarm) {
    issues.push({ level: 'warning', code: 'threshold-order', message: '氷雪気候の上限が寒帯の上限より高くなっています' });
  }
  return { params: out, issues };
}

export function computeClimate(input: ClimateInput): ClimateData {
  const { w, h, kmPerCell, land: landMask, frame } = input;
  const { params, issues } = sanitizeClimateParams(input.params);
  const f = params.gridFactor;
  const cw = Math.ceil(w / f);
  const ch = Math.ceil(h / f);
  const n = cw * ch;
  const cellKm = f * kmPerCell;

  // --- 地形を気候グリッドへ集約
  const landFrac = new Float32Array(n);
  const elev = new Float32Array(n);
  let badElevation = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let landCount = 0;
      let total = 0;
      let eSum = 0;
      for (let y = cy * f; y < Math.min(h, (cy + 1) * f); y++) {
        for (let x = cx * f; x < Math.min(w, (cx + 1) * f); x++) {
          const i = y * w + x;
          total++;
          if (!landMask[i]) continue;
          landCount++;
          const e = input.elevation ? input.elevation[i] : 0;
          if (!Number.isFinite(e)) badElevation++;
          else eSum += Math.max(0, e);
        }
      }
      const c = cy * cw + cx;
      landFrac[c] = total ? landCount / total : 0;
      elev[c] = landCount ? eSum / landCount : 0;
    }
  }
  if (badElevation > 0) issues.push({ level: 'error', code: 'elevation-invalid', message: '標高に無効な値（NaN など）があり、0 m として扱いました', count: badElevation });
  const isLand = (c: number) => landFrac[c] >= 0.5;

  // --- 緯度相当
  const lat = new Float32Array(n);
  let outOfRange = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const raw = latitudeAt(frame, w, h, kmPerCell, (cx + 0.5) * f, (cy + 0.5) * f);
      if (!Number.isFinite(raw) || Math.abs(raw) > 90) outOfRange++;
      lat[cy * cw + cx] = clampLatitude(Number.isFinite(raw) ? raw : 0);
    }
  }
  if (outOfRange > 0) {
    issues.push({ level: 'warning', code: 'latitude-range', message: '緯度相当が ±90° を超える地点があり、極として扱いました（世界設定の中心緯度・1 度あたりの距離を確認してください）', count: outOfRange });
  }

  // --- 風（年平均と、北半球の夏・冬に相当する季節のずれ）
  const windAt = (latEff: number): [number, number, number] => prevailingWind(frame, params, latEff);

  // --- 海からの距離（直線距離と風上側の距離）
  const seaDist = distanceTransform((c) => !isLand(c), cw, ch);
  const windAnnual = Array.from({ length: n }, (_, c) => windAt(lat[c]));
  const upwindDist = advectDistance(cw, ch, isLand, windAnnual, cellKm);

  // --- 気温
  const table = rawTempTable(frame.axialTilt);
  const noise = new Noise2D(hashInts(params.seed, 7001));
  const nFreq = cellKm / 350;
  const tMean = new Float32Array(n);
  const tWarm = new Float32Array(n);
  const tCold = new Float32Array(n);
  const tJan = new Float32Array(n);
  const tJul = new Float32Array(n);
  const monthT = Array.from({ length: 12 }, () => new Float32Array(n));
  for (let c = 0; c < n; c++) {
    const cx = c % cw;
    const cy = (c - cx) / cw;
    const L = lat[c];
    const rawMean = tableAt(table.monthsMean, L, table.lat0, table.step);
    let k = params.maritimeAmplitude;
    let base = tableAt(table.annual, L, table.lat0, table.step) + params.tempOffset;
    let cont = 0;
    if (isLand(c)) {
      const d = 0.4 * seaDist[c] * cellKm + 0.6 * Math.min(upwindDist[c], seaDist[c] * cellKm * 4 + cellKm);
      cont = 1 - Math.exp(-d / params.continentalityKm);
      k = params.maritimeAmplitude + (params.continentalAmplitude - params.maritimeAmplitude) * (0.2 + 0.8 * cont);
      base -= (params.lapseRate * elev[c]) / 1000;
    }
    base += params.oceanWarming * (1 - cont) * smoothstep(35, 70, Math.abs(L));
    base += params.variability * 1.5 * noise.fbm(cx * nFreq, cy * nFreq, 3);
    let sum = 0;
    let mx = -Infinity;
    let mn = Infinity;
    for (let m = 0; m < 12; m++) {
      const anom = tableAt(table.months[m], L, table.lat0, table.step) - rawMean;
      // 夏の昇温は融雪・蒸発に使われる分だけ抑える（簡易）
      const t = base + k * anom * (anom > 0 ? 0.85 : 1);
      monthT[m][c] = t;
      sum += t;
      mx = Math.max(mx, t);
      mn = Math.min(mn, t);
    }
    tMean[c] = sum / 12;
    tWarm[c] = mx;
    tCold[c] = mn;
    tJan[c] = monthT[0][c];
    tJul[c] = monthT[6][c];
  }

  // --- 降水（北半球の夏＝7 月ごろ と 冬＝1 月ごろ の 2 季節を計算）
  const pJul = precipitationRun(cw, ch, lat, isLand, elev, tJul, tMean, -params.seasonalShift, windAt, params, cellKm);
  const pJan = precipitationRun(cw, ch, lat, isLand, elev, tJan, tMean, params.seasonalShift, windAt, params, cellKm);
  const pNoise = new Noise2D(hashInts(params.seed, 7002));
  const precip = new Float32Array(n);
  const highSun = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const cx = c % cw;
    const cy = (c - cx) / cw;
    const northern = lat[c] >= 0;
    const hi = northern ? pJul[c] : pJan[c];
    const lo = northern ? pJan[c] : pJul[c];
    const mult = Math.max(0.2, 1 + params.variability * 0.35 * pNoise.fbm(cx * nFreq * 1.3, cy * nFreq * 1.3, 3));
    // 極端な値を抑える（実在の最多雨地点でも年 1 万 mm 程度）
    const annual = 14000 * Math.tanh((((hi + lo) / 2) * mult) / 14000);
    precip[c] = annual;
    highSun[c] = hi + lo > 0 ? hi / (hi + lo) : 0.5;
  }
  smoothLand(precip, isLand, cw, ch);

  // --- 分類
  const koppen = new Uint8Array(n);
  const biome = new Uint8Array(n);
  const t12 = new Array<number>(12);
  for (let c = 0; c < n; c++) {
    if (!isLand(c)) continue;
    const northern = lat[c] >= 0;
    for (let m = 0; m < 12; m++) t12[m] = monthT[m][c];
    const mc: MonthlyClimate = { t: t12, p: monthlyPrecip(precip[c], highSun[c], northern), summer: summerMonths(northern) };
    koppen[c] = classifyKoppen(mc, params.koppen);
    biome[c] = classifyBiome(koppen[c], tMean[c], precip[c], elev[c], lat[c], params.biome);
  }

  // --- 保存値と同じ精度に丸める（保存・読込で値が変わらないように）
  for (let c = 0; c < n; c++) {
    tMean[c] = Math.round(tMean[c] * 100) / 100;
    tWarm[c] = Math.round(tWarm[c] * 100) / 100;
    tCold[c] = Math.round(tCold[c] * 100) / 100;
    precip[c] = Math.round(precip[c]);
    highSun[c] = Math.round(highSun[c] * 10000) / 10000;
    landFrac[c] = Math.round(landFrac[c] * 10000) / 10000;
    elev[c] = Math.round(elev[c]);
  }

  const data: ClimateData = {
    meta: {
      algorithm: CLIMATE_ALGORITHM,
      version: CLIMATE_VERSION,
      seed: params.seed,
      params,
      frame: { ...frame },
      width: cw,
      height: ch,
      gridFactor: f,
      cellKm,
      sourceHash: fingerprint(input.elevation ?? landMask),
      generatedAt: new Date().toISOString(),
      units: CLIMATE_UNITS,
      issues: [],
    },
    tMean,
    tWarm,
    tCold,
    precip,
    highSun,
    land: landFrac,
    elevation: elev,
    koppen,
    biome,
  };
  data.meta.issues = [...issues, ...validateClimate(data)];
  return data;
}

type WindFn = (lat: number) => [number, number, number];

/** 風上をたどったときの海からの距離 (km) */
function advectDistance(cw: number, ch: number, isLand: (c: number) => boolean, wind: [number, number, number][], cellKm: number): Float32Array {
  const n = cw * ch;
  const D = new Float32Array(n);
  for (let c = 0; c < n; c++) D[c] = isLand(c) ? 1e6 : 0;
  sweep(cw, ch, (c, x, y) => {
    if (!isLand(c)) return;
    const [vx, vy, mag] = wind[c];
    const up = sample(D, cw, ch, x - vx, y - vy, 0);
    const nb = neighborMin(D, cw, ch, x, y);
    const viaWind = up + cellKm;
    const viaNb = nb + cellKm * (mag < 0.3 ? 1 : 3);
    D[c] = Math.min(D[c], viaWind, viaNb);
  });
  return D;
}

/** 水蒸気を風で運び、風上斜面で多く降らせる */
function precipitationRun(
  cw: number,
  ch: number,
  lat: Float32Array,
  isLand: (c: number) => boolean,
  elev: Float32Array,
  temp: Float32Array,
  seaTemp: Float32Array,
  shift: number,
  windAt: WindFn,
  p: ClimateParams,
  cellKm: number,
): Float32Array {
  const n = cw * ch;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const mag = new Float32Array(n);
  const zon = new Float32Array(n);
  const cap = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const latEff = lat[c] + shift;
    const [x, y, m] = windAt(latEff);
    vx[c] = x;
    vy[c] = y;
    mag[c] = m;
    zon[c] = zonalPrecipFactor(latEff);
    // 海面水温は季節変化が小さいので、海上の水蒸気量は年平均気温で決める
    cap[c] = moistureCapacity(isLand(c) ? temp[c] : seaTemp[c]);
  }
  const lambdaB = 1 / p.moistureLengthKm;
  const K = 1600 * p.moistureLengthKm * p.precipScale;
  const recharge = 1 - Math.exp(-cellKm / 350);
  const orK = 0.3 * p.orographic;
  const leeDecay = Math.exp(-cellKm / 350);
  const M = new Float32Array(n);
  const P = new Float32Array(n);
  // 山を越えて下った量（km）。下降気流で乾いた空気が風下に続く「雨陰」を表す
  const Lee = new Float32Array(n);
  for (let c = 0; c < n; c++) M[c] = isLand(c) ? cap[c] * 0.5 : cap[c];
  sweep(cw, ch, (c, x, y) => {
    // マップの外は海とみなし、水蒸気が満ちた空気が入ってくる
    let mUp = sample(M, cw, ch, x - vx[c], y - vy[c], moistureCapacity(seaTemp[c]));
    const hUp = sample(elev, cw, ch, x - vx[c], y - vy[c], 0);
    const wgt = clamp(mag[c] * 1.5, 0.35, 1);
    if (wgt < 1) mUp = mUp * wgt + neighborAvg(M, cw, ch, x, y) * (1 - wgt);
    const leeUp = sample(Lee, cw, ch, x - vx[c], y - vy[c], 0);
    if (!isLand(c)) {
      M[c] = mUp + (cap[c] - mUp) * recharge;
      Lee[c] = leeUp * 0.5;
      P[c] = K * mUp * lambdaB * zon[c];
      return;
    }
    const slope = (elev[c] - hUp) / cellKm;
    Lee[c] = leeUp * leeDecay + Math.max(0, hUp - elev[c]) / 1000 * p.orographic;
    const orog = clamp(1 + orK * slope, 0.2, 6) / (1 + 1.5 * Lee[c]);
    const lambda = lambdaB * zon[c] * orog;
    const loss = 1 - Math.exp(-lambda * cellKm);
    let rain = mUp * loss;
    // 冷たい所へ運ばれて飽和を超えた分は雨になる
    const excess = Math.max(0, mUp - rain - cap[c] * 1.15);
    rain += excess * 0.3;
    M[c] = Math.max(0, mUp - rain * (1 - p.recycling));
    P[c] = (K * rain) / cellKm;
  });
  return P;
}

/** 4 方向の順序で繰り返し走査する（どの風向きでも上流の値が早く伝わる） */
function sweep(cw: number, ch: number, fn: (c: number, x: number, y: number) => void): void {
  const orders: [number, number][] = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (let rep = 0; rep < 3; rep++) {
    for (const [sx, sy] of orders) {
      for (let j = 0; j < ch; j++) {
        const y = sy > 0 ? j : ch - 1 - j;
        for (let k = 0; k < cw; k++) {
          const x = sx > 0 ? k : cw - 1 - k;
          fn(y * cw + x, x, y);
        }
      }
    }
  }
}

function sample(a: Float32Array, cw: number, ch: number, x: number, y: number, outside: number): number {
  if (x < 0 || y < 0 || x > cw - 1 || y > ch - 1) return outside;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(cw - 1, x0 + 1);
  const y1 = Math.min(ch - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a0 = a[y0 * cw + x0] * (1 - tx) + a[y0 * cw + x1] * tx;
  const a1 = a[y1 * cw + x0] * (1 - tx) + a[y1 * cw + x1] * tx;
  return a0 * (1 - ty) + a1 * ty;
}

function neighborAvg(a: Float32Array, cw: number, ch: number, x: number, y: number): number {
  let s = 0;
  let k = 0;
  if (x > 0) { s += a[y * cw + x - 1]; k++; }
  if (x < cw - 1) { s += a[y * cw + x + 1]; k++; }
  if (y > 0) { s += a[(y - 1) * cw + x]; k++; }
  if (y < ch - 1) { s += a[(y + 1) * cw + x]; k++; }
  return k ? s / k : a[y * cw + x];
}

function neighborMin(a: Float32Array, cw: number, ch: number, x: number, y: number): number {
  let m = Infinity;
  if (x > 0) m = Math.min(m, a[y * cw + x - 1]);
  if (x < cw - 1) m = Math.min(m, a[y * cw + x + 1]);
  if (y > 0) m = Math.min(m, a[(y - 1) * cw + x]);
  if (y < ch - 1) m = Math.min(m, a[(y + 1) * cw + x]);
  return m;
}

function smoothLand(a: Float32Array, isLand: (c: number) => boolean, cw: number, ch: number): void {
  const src = new Float32Array(a);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const c = y * cw + x;
      if (!isLand(c)) continue;
      let s = src[c] * 2;
      let k = 2;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const j = ny * cw + nx;
        if (!isLand(j)) continue;
        s += src[j];
        k++;
      }
      a[c] = s / k;
    }
  }
}

// ---------------------------------------------------------------------------
// 検証

const RANGES = {
  temperature: [-90, 60],
  precipitation: [0, 15000],
} as const;

/** 欠損値・無効値・範囲外の値・整合性を調べる */
export function validateClimate(c: ClimateData, expected?: { width: number; height: number }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const n = c.meta.width * c.meta.height;
  if (expected && (expected.width !== c.meta.width || expected.height !== c.meta.height)) {
    issues.push({ level: 'error', code: 'grid-mismatch', message: `気候グリッドの大きさ（${c.meta.width}×${c.meta.height}）が地図と合いません` });
  }
  const arrays: [string, ArrayLike<number>][] = [
    ['年平均気温', c.tMean],
    ['最暖月気温', c.tWarm],
    ['最寒月気温', c.tCold],
    ['年降水量', c.precip],
    ['夏半年の降水割合', c.highSun],
  ];
  for (const [name, arr] of arrays) {
    if (!arr || arr.length !== n) {
      issues.push({ level: 'error', code: 'missing', message: `${name} のデータが欠けています（${arr?.length ?? 0}/${n}）` });
      continue;
    }
    let bad = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(arr[i])) bad++;
    if (bad) issues.push({ level: 'error', code: 'invalid', message: `${name} に無効な値（NaN・無限大）があります`, count: bad });
  }
  let tOut = 0;
  let pOut = 0;
  let order = 0;
  let fracOut = 0;
  let codeOut = 0;
  let unclassified = 0;
  for (let i = 0; i < n; i++) {
    for (const t of [c.tMean[i], c.tWarm[i], c.tCold[i]]) if (t < RANGES.temperature[0] || t > RANGES.temperature[1]) tOut++;
    if (c.precip[i] < RANGES.precipitation[0] || c.precip[i] > RANGES.precipitation[1]) pOut++;
    if (c.tWarm[i] + 0.01 < c.tMean[i] || c.tCold[i] - 0.01 > c.tMean[i]) order++;
    if (c.highSun[i] < 0 || c.highSun[i] > 1) fracOut++;
    if (c.koppen[i] >= KOPPEN_CODES.length || c.biome[i] >= BIOMES.length) codeOut++;
    if (c.land[i] >= 0.5 && (c.koppen[i] === 0 || c.biome[i] === 0)) unclassified++;
  }
  if (tOut) issues.push({ level: 'warning', code: 'temp-range', message: `気温が想定範囲（${RANGES.temperature[0]}〜${RANGES.temperature[1]}°C）外の値があります`, count: tOut });
  if (pOut) issues.push({ level: 'warning', code: 'precip-range', message: `年降水量が想定範囲（${RANGES.precipitation[0]}〜${RANGES.precipitation[1]} mm）外の地点があります`, count: pOut });
  if (order) issues.push({ level: 'error', code: 'temp-order', message: '最暖月・年平均・最寒月の大小関係が崩れている地点があります', count: order });
  if (fracOut) issues.push({ level: 'error', code: 'fraction-range', message: '夏半年の降水割合が 0〜1 の範囲外です', count: fracOut });
  if (codeOut) issues.push({ level: 'error', code: 'class-code', message: '気候区分・バイオームのコードが不正です', count: codeOut });
  if (unclassified) issues.push({ level: 'warning', code: 'unclassified', message: '陸なのに分類されていない地点があります', count: unclassified });
  return issues;
}

// ---------------------------------------------------------------------------
// 地点情報と書き出し

export interface ClimateCellInfo {
  id: number;
  ix: number;
  iy: number;
  /** セル中心の地図座標（地形セル単位）と km */
  x: number;
  y: number;
  xKm: number;
  yKm: number;
  lat: number;
  land: number;
  elevation: number;
  tMean: number;
  tWarm: number;
  tCold: number;
  tRange: number;
  precip: number;
  highSun: number;
  /** 降水の季節性 0〜1 */
  precipSeasonality: number;
  koppen: string;
  biome: string;
  monthlyT: number[];
  monthlyP: number[];
}

/** 地図座標（地形セル単位）にある気候セルの ID（範囲外は -1） */
export function climateCellAt(c: ClimateData, wx: number, wy: number): number {
  const ix = Math.floor(wx / c.meta.gridFactor);
  const iy = Math.floor(wy / c.meta.gridFactor);
  if (ix < 0 || iy < 0 || ix >= c.meta.width || iy >= c.meta.height) return -1;
  return iy * c.meta.width + ix;
}

/** 1 地点の情報（12 か月の値は保存値から近似式で復元する） */
export function climateCellInfo(c: ClimateData, worldW: number, worldH: number, kmPerCell: number, id: number): ClimateCellInfo {
  const { width, gridFactor: f } = c.meta;
  const ix = id % width;
  const iy = Math.floor(id / width);
  const x = (ix + 0.5) * f;
  const y = (iy + 0.5) * f;
  const lat = clampLatitude(latitudeAt(c.meta.frame, worldW, worldH, kmPerCell, x, y));
  const northern = lat >= 0;
  // 月別気温：最寒月と最暖月の間を余弦で補間（夏至の約 1 か月後に最暖とみなす）
  const peak = northern ? 6 : 0;
  const mid = (c.tWarm[id] + c.tCold[id]) / 2;
  const amp = (c.tWarm[id] - c.tCold[id]) / 2;
  const monthlyT = Array.from({ length: 12 }, (_, m) => Math.round((mid + amp * Math.cos((2 * Math.PI * (m - peak)) / 12)) * 10) / 10);
  const monthlyP = monthlyPrecip(c.precip[id], c.highSun[id], northern).map((v) => Math.round(v));
  return {
    id,
    ix,
    iy,
    x,
    y,
    xKm: x * kmPerCell,
    yKm: y * kmPerCell,
    lat,
    land: c.land[id],
    elevation: c.elevation[id],
    tMean: c.tMean[id],
    tWarm: c.tWarm[id],
    tCold: c.tCold[id],
    tRange: Math.round((c.tWarm[id] - c.tCold[id]) * 100) / 100,
    precip: c.precip[id],
    highSun: c.highSun[id],
    precipSeasonality: Math.round(Math.abs(2 * c.highSun[id] - 1) * 1000) / 1000,
    koppen: KOPPEN_CODES[c.koppen[id]] ?? '',
    biome: BIOMES[c.biome[id]]?.key ?? 'none',
    monthlyT,
    monthlyP,
  };
}

/** 気候グリッドを CSV に（先頭の # 行にメタデータ・単位・前提を記す） */
export function climateCsv(c: ClimateData, worldW: number, worldH: number, kmPerCell: number, landOnly = true): string {
  const m = c.meta;
  const lines: string[] = [
    `# algorithm=${m.algorithm}`,
    `# version=${m.version}`,
    `# seed=${m.seed}`,
    `# generated_at=${m.generatedAt}`,
    `# grid=${m.width}x${m.height} grid_factor=${m.gridFactor} cell_km=${m.cellKm}`,
    `# frame=center_lat:${m.frame.centerLat} north_angle:${m.frame.northAngle} km_per_degree:${m.frame.kmPerDegree} axial_tilt:${m.frame.axialTilt}`,
    '# units: temperature=degC, precipitation=mm/year, position=terrain cells and km from map top-left, lat_equiv=degrees (derived from world settings, not from map Y)',
    '# note: approximate model for fictional worlds; not a weather or climate prediction',
    'cell_id,ix,iy,x_cell,y_cell,x_km,y_km,lat_equiv,land_fraction,elevation_m,t_mean_c,t_warm_c,t_cold_c,t_range_c,precip_mm,precip_highsun_fraction,precip_seasonality,koppen,biome',
  ];
  const n = m.width * m.height;
  for (let id = 0; id < n; id++) {
    if (landOnly && c.land[id] < 0.5) continue;
    const i = climateCellInfo(c, worldW, worldH, kmPerCell, id);
    lines.push(
      [
        i.id, i.ix, i.iy, i.x, i.y, i.xKm.toFixed(1), i.yKm.toFixed(1), i.lat.toFixed(2), i.land.toFixed(4), Math.round(i.elevation),
        i.tMean.toFixed(2), i.tWarm.toFixed(2), i.tCold.toFixed(2), i.tRange.toFixed(2), Math.round(i.precip),
        i.highSun.toFixed(4), i.precipSeasonality.toFixed(3), i.koppen, i.biome,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** 計算上の前提と限界（UI と書き出しで共通に使う） */
export const CLIMATE_ASSUMPTIONS: string[] = [
  '地図の Y 座標は緯度ではありません。緯度相当は「世界設定」（中心の緯度相当・北相当の向き・1 度あたりの距離）から線形に求めます。惑星の丸さによるゆがみは無視します。',
  '気温は大気上端の日射量を一次式で換算した値に、標高による低下（気温減率）と海陸による季節の振れ幅の違いを加えたものです。海流、氷雪や雲による反射、季節の遅れ（最暖月の遅れ）は考慮しません。',
  '卓越風は緯度帯モデル（貿易風・偏西風・極東風）か固定風向の単純な場で、気圧配置や季節風（モンスーン）の循環は表現しません。地図の外は海とみなします。',
  '降水は、海で水蒸気を受け取った空気が風で運ばれ、距離・上り斜面・低温で雨になるという単純な輸送モデルです。降水帯は季節により南北に一定量ずれるとします。',
  '月別の降水量は夏半年・冬半年の合計から正弦波で配分した近似値で、気候区分の判定にはこの近似値を使います。',
  '結果は乱数シードと設定から決まり、同じ入力なら同じ結果になります。数値は地図作りの目安であり、実在の気候や気象の予測を意図したものではありません。',
];

/** 卓越風（地図座標の単位ベクトル）。季節のずれは含まない年平均の向き */
export function prevailingWind(frame: GeoFrame, params: Pick<ClimateParams, 'windMode' | 'windFrom'>, lat: number): [number, number, number] {
  let ue: number;
  let un: number;
  if (params.windMode === 'fixed') {
    const to = ((params.windFrom + 180) * Math.PI) / 180;
    ue = Math.sin(to);
    un = Math.cos(to);
  } else {
    [ue, un] = bandWind(lat);
  }
  const axes = frameAxes(frame);
  const vx = ue * axes.east[0] + un * axes.north[0];
  const vy = ue * axes.east[1] + un * axes.north[1];
  const mag = Math.hypot(vx, vy);
  return mag > 1e-6 ? [vx / mag, vy / mag, mag] : [0, 0, 0];
}
