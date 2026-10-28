/**
 * 架空世界の座標系と、気候計算用の「緯度相当」座標の対応。
 *
 * 地図の座標（セル・km）はあくまで平面の座標で、Y 座標＝緯度とはみなさない。
 * 気候計算では、世界設定の次の値から各地点の緯度相当値を線形に求める：
 *   - 地図中心の緯度相当（centerLat）
 *   - 「北相当」の向き（northAngle：地図の上方向から時計回りの角度）
 *   - 緯度相当 1 度あたりの距離（kmPerDegree：惑星の大きさに相当）
 * 地軸の傾き（axialTilt）は季節変化の大きさを決める。
 */
export interface GeoFrame {
  centerLat: number;
  northAngle: number;
  kmPerDegree: number;
  axialTilt: number;
}

export const DEFAULT_GEO_FRAME: GeoFrame = {
  centerLat: 38,
  northAngle: 0,
  kmPerDegree: 111,
  axialTilt: 23.44,
};

export const GEO_FRAME_LIMITS = {
  centerLat: [-90, 90],
  northAngle: [-360, 360],
  kmPerDegree: [5, 2000],
  axialTilt: [0, 60],
} as const;

/** 北相当・東相当の単位ベクトル（地図座標系、y は下向き） */
export function frameAxes(frame: GeoFrame): { north: [number, number]; east: [number, number] } {
  const a = (frame.northAngle * Math.PI) / 180;
  return { north: [Math.sin(a), -Math.cos(a)], east: [Math.cos(a), Math.sin(a)] };
}

/**
 * 地図上の点（セル座標）の緯度相当値（度）。範囲外（|φ|>90）でもそのまま返す。
 * 呼び出し側で clampLatitude して使い、範囲外の件数は検証で報告する。
 */
export function latitudeAt(frame: GeoFrame, worldW: number, worldH: number, kmPerCell: number, x: number, y: number): number {
  const { north } = frameAxes(frame);
  const dx = (x - worldW / 2) * kmPerCell;
  const dy = (y - worldH / 2) * kmPerCell;
  return frame.centerLat + (dx * north[0] + dy * north[1]) / frame.kmPerDegree;
}

export function clampLatitude(lat: number): number {
  return Math.max(-89.9, Math.min(89.9, lat));
}

/** 地図の四隅の緯度相当値の範囲 */
export function latitudeRange(frame: GeoFrame, w: number, h: number, kmPerCell: number): [number, number] {
  const c = [
    latitudeAt(frame, w, h, kmPerCell, 0, 0),
    latitudeAt(frame, w, h, kmPerCell, w, 0),
    latitudeAt(frame, w, h, kmPerCell, 0, h),
    latitudeAt(frame, w, h, kmPerCell, w, h),
  ];
  return [Math.min(...c), Math.max(...c)];
}

export function formatLatitude(lat: number): string {
  const a = Math.abs(lat);
  const s = a < 0.05 ? '0°' : `${a.toFixed(a >= 10 ? 0 : 1)}°${lat > 0 ? 'N' : 'S'}`;
  return s + '相当';
}

/** 地図内に入る緯度相当線（step 度ごと）を線分として返す（セル座標） */
export function latitudeLines(frame: GeoFrame, w: number, h: number, kmPerCell: number, step: number): { lat: number; a: [number, number]; b: [number, number] }[] {
  const [lo, hi] = latitudeRange(frame, w, h, kmPerCell);
  const { north, east } = frameAxes(frame);
  const out: { lat: number; a: [number, number]; b: [number, number] }[] = [];
  const diag = Math.hypot(w, h);
  for (let lat = Math.ceil(lo / step) * step; lat <= hi; lat += step) {
    if (lat < -90 || lat > 90) continue;
    const along = ((lat - frame.centerLat) * frame.kmPerDegree) / kmPerCell;
    const cx = w / 2 + north[0] * along;
    const cy = h / 2 + north[1] * along;
    const seg = clipLine(cx - east[0] * diag, cy - east[1] * diag, cx + east[0] * diag, cy + east[1] * diag, w, h);
    if (seg) out.push({ lat, a: seg[0], b: seg[1] });
  }
  return out;
}

/** Liang–Barsky による矩形クリップ */
function clipLine(x0: number, y0: number, x1: number, y1: number, w: number, h: number): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0, w - x0, y0, h - y0];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return [
    [x0 + dx * t0, y0 + dy * t0],
    [x0 + dx * t1, y0 + dy * t1],
  ];
}
