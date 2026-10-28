import { prevailingWind } from '../core/climate';
import { clampLatitude, formatLatitude, latitudeAt, latitudeLines } from '../core/geoframe';
import type { Feature } from '../core/landforms';
import { legendFor, type ClimateLayer } from './climate-style';
import type { Pt } from '../core/raster';
import type { BorderStroke, Stroke } from '../core/world';
import { featureDisplayName, LabelPlacer } from './labels';
import { MapLayers } from './layers';
import { COLORS, SANS, SERIF } from './palette';
import type { Store, ViewMode } from './store';

export interface LayerFlags {
  relief: boolean;
  rivers: boolean;
  contours: boolean;
  borders: boolean;
  labels: boolean;
  features: boolean;
  grid: boolean;
  sketch: boolean;
  stateFill: boolean;
  /** 気候レイヤー（none で非表示） */
  climate: ClimateLayer;
  climateOpacity: number;
  /** 卓越風の矢印 */
  wind: boolean;
  /** 緯度相当線 */
  latitude: boolean;
}

export const DEFAULT_LAYERS: LayerFlags = {
  relief: true,
  rivers: true,
  contours: false,
  borders: true,
  labels: true,
  features: true,
  grid: false,
  sketch: false,
  stateFill: false,
  climate: 'none',
  climateOpacity: 0.85,
  wind: false,
  latitude: false,
};

/** 描画時の座標変換（デバイス px）。scale はセルあたりのデバイス px。 */
export interface DrawTransform {
  scale: number;
  ox: number;
  oy: number;
  /** 画面の大きさ（デバイス px） */
  width: number;
  height: number;
  /** 文字や線の太さの倍率（devicePixelRatio や書き出し倍率） */
  ui: number;
}

export interface Overlay {
  /** 描画中のストローク */
  stroke?: { points: Pt[]; style: 'outline' | 'ridge' | 'national' | 'state' | 'lasso' | 'brush-land' | 'brush-sea' };
  /** ブラシのカーソル（ワールド座標と半径） */
  cursor?: { x: number; y: number; r: number };
  /** ブラシ操作中の下絵 */
  livePaint?: Uint8Array;
  showRidges?: boolean;
  showBorderStrokes?: boolean;
  /** 地点情報ツールで調べている地点 */
  inspect?: { x: number; y: number };
  /** 消しゴム操作中のストローク */
  ridgeOverride?: Stroke[];
  borderOverride?: BorderStroke[];
}

export class MapRenderer {
  readonly layers: MapLayers;
  constructor(private store: Store) {
    this.layers = new MapLayers(store);
  }

  draw(ctx: CanvasRenderingContext2D, tf: DrawTransform, mode: ViewMode, flags: LayerFlags, overlay: Overlay = {}, forExport = false): void {
    const { world } = this.store;
    const w = world.width;
    const h = world.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = forExport ? COLORS.sea : COLORS.outside;
    ctx.fillRect(0, 0, tf.width, tf.height);
    ctx.setTransform(tf.scale, 0, 0, tf.scale, tf.ox, tf.oy);
    const px = 1 / tf.scale; // 1 デバイス px のワールド長
    const u = tf.ui * px; // 1 CSS px 相当

    // 地図の範囲でクリップ
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const hasTerrain = world.terrain !== null;
    const coast = this.layers.coastPath();

    // 海
    const sea = mode !== 'sketch' ? this.layers.seaCanvas() : null;
    if (sea) ctx.drawImage(sea, 0, 0, w, h);
    else {
      ctx.fillStyle = mode === 'sketch' ? '#cfe4ee' : COLORS.sea;
      ctx.fillRect(0, 0, w, h);
    }
    if (mode !== 'sketch') this.drawCoastRipples(ctx, coast, u);

    if (mode === 'sketch') {
      this.drawSketch(ctx, overlay.livePaint, tf, 1);
    } else {
      // 陸
      ctx.save();
      ctx.clip(coast);
      const landImg = hasTerrain ? this.layers.landCanvas(mode === 'political' ? 'political' : 'physical', flags.relief) : null;
      if (landImg) ctx.drawImage(landImg, 0, 0, w, h);
      else {
        ctx.fillStyle = mode === 'political' ? 'rgb(243,236,218)' : 'rgb(150,184,110)';
        ctx.fillRect(0, 0, w, h);
      }
      if (mode === 'political') this.drawPoliticalFill(ctx, flags, u);
      if (flags.climate !== 'none' && flags.climate !== 'temp') this.drawClimate(ctx, flags, flags.relief);
      if (flags.contours && hasTerrain) this.drawContours(ctx, u);
      ctx.restore();
      if (flags.climate === 'temp') this.drawClimate(ctx, flags, false);

      const lake = this.layers.lakePath();
      if (lake) {
        ctx.fillStyle = COLORS.lake;
        ctx.fill(lake);
        ctx.strokeStyle = 'rgba(40, 90, 130, 0.7)';
        ctx.lineWidth = 0.8 * u;
        ctx.stroke(lake);
      }
      if (flags.rivers) this.drawRivers(ctx, tf, u, mode);
      ctx.strokeStyle = COLORS.coast;
      ctx.lineWidth = 1.1 * u;
      ctx.lineJoin = 'round';
      ctx.stroke(coast);
      if (flags.borders) this.drawBorders(ctx, u, mode);
      if (overlay.livePaint || flags.sketch) this.drawSketch(ctx, overlay.livePaint, tf, 0.5);
    }
    if (flags.grid) this.drawGrid(ctx, u);
    if (flags.latitude) this.drawLatitudeLines(ctx, tf, u);
    if (flags.wind) this.drawWind(ctx, tf, u);
    if (overlay.showRidges || overlay.ridgeOverride) this.drawRidgeStrokes(ctx, u, overlay.ridgeOverride);
    if (overlay.showBorderStrokes || overlay.borderOverride) this.drawBorderStrokes(ctx, u, overlay.borderOverride);
    this.drawSelection(ctx, u);
    ctx.restore();

    // 枠
    ctx.strokeStyle = 'rgba(30, 30, 30, 0.6)';
    ctx.lineWidth = 1 * u;
    ctx.strokeRect(0, 0, w, h);

    if (flags.labels) this.drawLabels(ctx, tf, mode, flags);
    if (overlay.inspect) {
      const r = 6 * u;
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4 * u;
      ctx.beginPath();
      ctx.arc(overlay.inspect.x, overlay.inspect.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#d2421f';
      ctx.lineWidth = 2 * u;
      ctx.stroke();
      ctx.restore();
    }
    if (overlay.stroke) this.drawStrokePreview(ctx, overlay.stroke, u);
    if (overlay.cursor) {
      ctx.beginPath();
      ctx.arc(overlay.cursor.x, overlay.cursor.y, Math.max(overlay.cursor.r, 2 * u), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5 * u;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1.2 * u;
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawScaleBar(ctx, tf, forExport);
    if (flags.climate !== 'none' && mode !== 'sketch') this.drawLegend(ctx, tf, flags.climate, forExport);
    ctx.restore();
  }

  private drawClimate(ctx: CanvasRenderingContext2D, flags: LayerFlags, relief: boolean): void {
    const { world } = this.store;
    const c = world.climate;
    const img = this.layers.climateCanvas(flags.climate);
    if (!c || !img) return;
    const f = c.meta.gridFactor;
    ctx.save();
    ctx.globalAlpha = flags.climateOpacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, c.meta.width * f, c.meta.height * f);
    ctx.globalAlpha = 1;
    const rel = relief ? this.layers.reliefCanvas() : null;
    if (rel) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(rel, 0, 0, world.width, world.height);
    }
    ctx.restore();
  }

  private drawLatitudeLines(ctx: CanvasRenderingContext2D, tf: DrawTransform, u: number): void {
    const { world } = this.store;
    const [a, b] = [latitudeAt(world.geoFrame, world.width, world.height, world.kmPerCell, 0, 0), latitudeAt(world.geoFrame, world.width, world.height, world.kmPerCell, world.width, world.height)];
    const span = Math.abs(a - b) + 1;
    const step = [1, 2, 5, 10, 15, 20, 30].find((s) => span / s <= 8) ?? 30;
    const lines = latitudeLines(world.geoFrame, world.width, world.height, world.kmPerCell, step);
    ctx.save();
    ctx.strokeStyle = 'rgba(30, 50, 90, 0.55)';
    ctx.lineWidth = 1 * u;
    ctx.setLineDash([8 * u, 5 * u]);
    for (const l of lines) {
      ctx.beginPath();
      ctx.moveTo(l.a[0], l.a[1]);
      ctx.lineTo(l.b[0], l.b[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${10 * tf.ui}px ${SANS}`;
    ctx.textBaseline = 'bottom';
    for (const l of lines) {
      // 地図の左寄りの端にラベル
      const p = l.a[0] <= l.b[0] ? l.a : l.b;
      const sx = p[0] * tf.scale + tf.ox + 4 * tf.ui;
      const sy = p[1] * tf.scale + tf.oy - 2 * tf.ui;
      const text = formatLatitude(l.lat);
      ctx.lineWidth = 3 * tf.ui;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = '#1e3260';
      ctx.fillText(text, sx, sy);
    }
    ctx.restore();
  }

  private drawWind(ctx: CanvasRenderingContext2D, tf: DrawTransform, u: number): void {
    const { world } = this.store;
    const spacingPx = 64 * tf.ui;
    const step = Math.max(2, spacingPx / tf.scale);
    const x0 = Math.max(0, -tf.ox / tf.scale);
    const y0 = Math.max(0, -tf.oy / tf.scale);
    const x1 = Math.min(world.width, (tf.width - tf.ox) / tf.scale);
    const y1 = Math.min(world.height, (tf.height - tf.oy) / tf.scale);
    const len = step * 0.42;
    ctx.save();
    ctx.strokeStyle = 'rgba(20, 30, 50, 0.7)';
    ctx.fillStyle = 'rgba(20, 30, 50, 0.7)';
    ctx.lineWidth = 1.4 * u;
    ctx.lineCap = 'round';
    for (let y = Math.floor(y0 / step) * step + step / 2; y < y1; y += step) {
      for (let x = Math.floor(x0 / step) * step + step / 2; x < x1; x += step) {
        const lat = clampLatitude(latitudeAt(world.geoFrame, world.width, world.height, world.kmPerCell, x, y));
        const [vx, vy, mag] = prevailingWind(world.geoFrame, world.climateParams, lat);
        if (mag < 0.15) {
          ctx.beginPath();
          ctx.arc(x, y, 2 * u, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }
        const l = len * Math.min(1, 0.4 + mag);
        const ax = x - vx * l;
        const ay = y - vy * l;
        const bx = x + vx * l;
        const by = y + vy * l;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        const hx = -vx * 6 * u;
        const hy = -vy * 6 * u;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + hx - hy * 0.6, by + hy + hx * 0.6);
        ctx.lineTo(bx + hx + hy * 0.6, by + hy - hx * 0.6);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawLegend(ctx: CanvasRenderingContext2D, tf: DrawTransform, layer: ClimateLayer, forExport: boolean): void {
    const c = this.store.world.climate;
    if (!c) return;
    const lg = legendFor(layer, c);
    if (!lg) return;
    const ui = tf.ui;
    const pad = 8 * ui;
    const x = (forExport ? 18 : 12) * ui;
    let y = (forExport ? 84 : 12) * ui;
    const width = 210 * ui;
    const items = lg.items?.slice(0, 14) ?? [];
    const height = lg.ramp ? 58 * ui : (26 + items.length * 15 + (lg.items && lg.items.length > items.length ? 14 : 0)) * ui;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 252, 244, 0.9)';
    ctx.strokeStyle = 'rgba(80, 60, 40, 0.4)';
    ctx.lineWidth = 1 * ui;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#2b2420';
    ctx.font = `bold ${11 * ui}px ${SANS}`;
    ctx.textBaseline = 'top';
    ctx.fillText(lg.title, x + pad, y + pad);
    y += 24 * ui;
    if (lg.ramp) {
      const { stops, ticks, format } = lg.ramp;
      const x0 = x + pad;
      const w = width - pad * 2;
      const lo = stops[0][0];
      const hi = stops[stops.length - 1][0];
      const grad = ctx.createLinearGradient(x0, 0, x0 + w, 0);
      for (const [v, col] of stops) grad.addColorStop((v - lo) / (hi - lo), col);
      ctx.fillStyle = grad;
      ctx.fillRect(x0, y, w, 10 * ui);
      ctx.fillStyle = '#2b2420';
      ctx.font = `${9.5 * ui}px ${SANS}`;
      ctx.textAlign = 'center';
      for (const t of ticks) {
        const tx = x0 + ((t - lo) / (hi - lo)) * w;
        ctx.fillRect(tx - 0.5 * ui, y + 10 * ui, 1 * ui, 3 * ui);
        ctx.fillText(format(t), Math.min(x0 + w - 10 * ui, Math.max(x0 + 10 * ui, tx)), y + 14 * ui);
      }
    } else {
      ctx.font = `${10 * ui}px ${SANS}`;
      for (const it of items) {
        ctx.fillStyle = it.color;
        ctx.fillRect(x + pad, y + 1 * ui, 12 * ui, 10 * ui);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.strokeRect(x + pad, y + 1 * ui, 12 * ui, 10 * ui);
        ctx.fillStyle = '#2b2420';
        ctx.fillText(it.label, x + pad + 18 * ui, y);
        y += 15 * ui;
      }
      if (lg.items && lg.items.length > items.length) ctx.fillText(`ほか ${lg.items.length - items.length} 種類`, x + pad, y);
    }
    ctx.restore();
  }

  private drawSketch(ctx: CanvasRenderingContext2D, live: Uint8Array | undefined, tf: DrawTransform, alpha: number): void {
    const { world } = this.store;
    const c = this.layers.sketchCanvas(live);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = tf.scale / tf.ui < 5;
    ctx.drawImage(c, 0, 0, world.width, world.height);
    ctx.restore();
  }

  private drawCoastRipples(ctx: CanvasRenderingContext2D, coast: Path2D, u: number): void {
    ctx.save();
    ctx.lineJoin = 'round';
    const rings = [
      [9, 'rgba(255,255,255,0.10)'],
      [5, 'rgba(255,255,255,0.16)'],
      [2.5, 'rgba(255,255,255,0.22)'],
    ] as const;
    for (const [wd, col] of rings) {
      ctx.strokeStyle = col;
      ctx.lineWidth = wd * u * 2;
      ctx.stroke(coast);
    }
    ctx.restore();
  }

  private drawPoliticalFill(ctx: CanvasRenderingContext2D, flags: LayerFlags, u: number): void {
    const geom = this.layers.political();
    if (!geom) return;
    const regions = flags.stateFill ? geom.states : geom.countries;
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.lineJoin = 'round';
    for (const r of regions) {
      ctx.fillStyle = r.color;
      ctx.fill(r.fill);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(2.2, 6 * u);
      ctx.stroke(r.bleed);
    }
    ctx.restore();
  }

  private drawContours(ctx: CanvasRenderingContext2D, u: number): void {
    const c = this.layers.contours();
    if (!c) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(90, 60, 30, 0.35)';
    ctx.lineWidth = 0.6 * u;
    ctx.stroke(c.minor);
    ctx.strokeStyle = 'rgba(90, 60, 30, 0.55)';
    ctx.lineWidth = 1 * u;
    ctx.stroke(c.major);
    ctx.restore();
  }

  private drawRivers(ctx: CanvasRenderingContext2D, tf: DrawTransform, u: number, mode: ViewMode): void {
    const rivers = this.layers.rivers();
    const zoom = Math.sqrt(Math.max(0.5, tf.scale / tf.ui / 1.5));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = mode === 'political' ? 'rgba(63, 127, 196, 0.75)' : COLORS.river;
    for (const r of rivers) {
      const px = r.width * zoom;
      if (px < 0.35) continue;
      ctx.lineWidth = px * u;
      ctx.stroke(r.path);
    }
    ctx.restore();
  }

  private drawBorders(ctx: CanvasRenderingContext2D, u: number, mode: ViewMode): void {
    const geom = this.layers.political();
    if (!geom) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.state;
    ctx.lineWidth = 0.9 * u;
    ctx.setLineDash([4 * u, 3 * u]);
    ctx.stroke(geom.state);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 250, 240, 0.6)';
    ctx.lineWidth = 4.2 * u;
    ctx.stroke(geom.national);
    ctx.strokeStyle = mode === 'political' ? COLORS.national : 'rgba(122, 38, 50, 0.85)';
    ctx.lineWidth = 1.8 * u;
    ctx.setLineDash([7 * u, 2.5 * u, 1.5 * u, 2.5 * u]);
    ctx.stroke(geom.national);
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, u: number): void {
    const { world } = this.store;
    const km = world.kmPerCell;
    const totalKm = Math.max(world.width, world.height) * km;
    const steps = [50, 100, 200, 250, 500, 1000, 2000];
    let stepKm = steps[steps.length - 1];
    for (const s of steps) if (totalKm / s <= 12) { stepKm = s; break; }
    const step = stepKm / km;
    ctx.save();
    ctx.strokeStyle = 'rgba(40, 50, 70, 0.22)';
    ctx.lineWidth = 0.8 * u;
    ctx.beginPath();
    for (let x = step; x < world.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, world.height);
    }
    for (let y = step; y < world.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(world.width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawRidgeStrokes(ctx: CanvasRenderingContext2D, u: number, list?: Stroke[]): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 70, 20, 0.85)';
    ctx.lineWidth = 2 * u;
    ctx.setLineDash([6 * u, 4 * u]);
    ctx.lineCap = 'round';
    for (const r of list ?? this.store.world.ridges) this.polyline(ctx, r.points);
    ctx.restore();
  }

  private drawBorderStrokes(ctx: CanvasRenderingContext2D, u: number, list?: BorderStroke[]): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of list ?? this.store.world.borders) {
      ctx.strokeStyle = b.kind === 'national' ? 'rgba(200, 30, 60, 0.55)' : 'rgba(60, 60, 200, 0.5)';
      ctx.lineWidth = (b.kind === 'national' ? 2 : 1.4) * u;
      this.polyline(ctx, b.points);
    }
    ctx.restore();
  }

  private polyline(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
    if (pts.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.stroke();
  }

  private drawSelection(ctx: CanvasRenderingContext2D, u: number): void {
    const { selectionPath, selected } = this.store;
    if (selectionPath) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(selectionPath[0][0], selectionPath[0][1]);
      for (const p of selectionPath) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 200, 40, 0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 180, 0, 0.95)';
      ctx.lineWidth = 2 * u;
      ctx.setLineDash([6 * u, 4 * u]);
      ctx.stroke();
      ctx.restore();
    }
    if (selected) {
      const geom = this.layers.political();
      const r = geom ? (selected.kind === 'country' ? geom.countries : geom.states)[selected.index] : null;
      if (r) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 140, 0, 0.16)';
        ctx.fill(r.fill);
        ctx.strokeStyle = 'rgba(255, 120, 0, 0.95)';
        ctx.lineWidth = 2.6 * u;
        ctx.lineJoin = 'round';
        ctx.stroke(r.fill);
        ctx.restore();
      }
    }
  }

  private drawStrokePreview(ctx: CanvasRenderingContext2D, s: NonNullable<Overlay['stroke']>, u: number): void {
    if (s.points.length === 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (s.style) {
      case 'national':
        ctx.strokeStyle = 'rgba(200, 30, 60, 0.95)';
        ctx.lineWidth = 2.5 * u;
        break;
      case 'state':
        ctx.strokeStyle = 'rgba(60, 60, 220, 0.9)';
        ctx.lineWidth = 2 * u;
        break;
      case 'ridge':
        ctx.strokeStyle = 'rgba(130, 70, 10, 0.95)';
        ctx.lineWidth = 3 * u;
        break;
      case 'lasso':
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.95)';
        ctx.lineWidth = 2 * u;
        ctx.setLineDash([6 * u, 4 * u]);
        break;
      default:
        ctx.strokeStyle = 'rgba(40, 30, 20, 0.9)';
        ctx.lineWidth = 2 * u;
    }
    this.polyline(ctx, s.points);
    ctx.restore();
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D, tf: DrawTransform, forExport: boolean): void {
    const { world } = this.store;
    const ui = tf.ui;
    const pxPerKm = tf.scale / world.kmPerCell;
    const target = 120 * ui;
    const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    let km = nice[0];
    for (const k of nice) if (k * pxPerKm <= target) km = k;
    const len = km * pxPerKm;
    const x = (forExport ? 24 : 16) * ui;
    const y = tf.height - (forExport ? 24 : 18) * ui;
    ctx.save();
    ctx.font = `${11 * ui}px ${SANS}`;
    const label = `${km} km`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(x - 8 * ui, y - 24 * ui, len + tw / 2 + 16 * ui, 32 * ui);
    ctx.fillStyle = '#222';
    ctx.fillRect(x, y - 4 * ui, len / 2, 4 * ui);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1 * ui;
    ctx.strokeRect(x, y - 4 * ui, len, 4 * ui);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', x, y - 6 * ui);
    ctx.fillText(label, x + len, y - 6 * ui);
    ctx.restore();
    if (forExport) {
      // 方位記号
      const cx = tf.width - 40 * ui;
      const cy = 48 * ui;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.arc(cx, cy, 24 * ui, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 18 * ui);
      ctx.lineTo(cx + 7 * ui, cy + 8 * ui);
      ctx.lineTo(cx, cy + 3 * ui);
      ctx.lineTo(cx - 7 * ui, cy + 8 * ui);
      ctx.closePath();
      ctx.fill();
      ctx.font = `bold ${11 * ui}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('N', cx, cy + 20 * ui);
      ctx.restore();
    }
  }

  // ---- ラベル ----

  private drawLabels(ctx: CanvasRenderingContext2D, tf: DrawTransform, mode: ViewMode, flags: LayerFlags): void {
    const { political, analysis, world } = this.store;
    const placer = new LabelPlacer();
    const ui = tf.ui;
    const toS = (x: number, y: number): [number, number] => [x * tf.scale + tf.ox, y * tf.scale + tf.oy];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 縮尺バーの領域を予約
    placer.reserve({ x0: 0, y0: tf.height - 50 * ui, x1: 200 * ui, y1: tf.height });

    const pxPerCell = tf.scale / ui;
    if (political && mode !== 'sketch') {
      const { labels, stats } = political;
      // 国名
      const order = [...stats.countries].sort((a, b) => b.cells - a.cells);
      for (const s of order) {
        if (s.cells === 0) continue;
        const rec = labels.countries[s.index];
        const [sx, sy] = toS(s.labelX, s.labelY);
        const radiusPx = s.labelRadius * tf.scale;
        let size = Math.min(radiusPx * 0.5, (radiusPx * 2.4) / Math.max(2, rec.name.length * 1.15), 30 * ui);
        if (mode !== 'political') size *= 0.85;
        if (size < 9 * ui) {
          if (s.cells * pxPerCell * pxPerCell < 600) continue;
          size = 9 * ui;
        }
        this.spacedText(ctx, placer, rec.name, sx, sy, size, 0, {
          font: `bold ${size}px ${SERIF}`,
          fill: mode === 'political' ? '#3a2a22' : 'rgba(60, 40, 30, 0.9)',
          spacing: 0.18,
          force: true,
        });
      }
      // 首都
      if (mode === 'political') {
        labels.countries.forEach((c, k) => {
          if (stats.countries[k]?.cells === 0 || !c.anchors[0]) return;
          const [sx, sy] = toS(c.anchors[0][0] + 0.5, c.anchors[0][1] + 0.5);
          this.drawCapital(ctx, placer, sx, sy, c.capital, ui, true);
        });
      }
      // 州名
      if (mode === 'political') {
        const sOrder = [...stats.states].sort((a, b) => b.cells - a.cells);
        for (const s of sOrder) {
          if (s.cells === 0) continue;
          const rec = labels.states[s.index];
          const country = s.country >= 0 ? labels.countries[s.country] : null;
          const name = rec.name + (country?.subdivision ?? '');
          const size = Math.min(13 * ui, Math.max(8 * ui, s.labelRadius * tf.scale * 0.35));
          if (s.labelRadius * tf.scale < 14 * ui) continue;
          const [sx, sy] = toS(s.labelX, s.labelY);
          this.spacedText(ctx, placer, name, sx, sy + size * 1.4, size, 0, {
            font: `italic ${size}px ${SERIF}`,
            fill: 'rgba(70, 50, 50, 0.9)',
            spacing: 0.08,
          });
        }
        // 州都
        if (pxPerCell > 2.2) {
          for (const s of stats.states) {
            const rec = labels.states[s.index];
            if (s.cells === 0 || !rec.anchors[0]) continue;
            const country = s.country >= 0 ? labels.countries[s.country] : null;
            const cap = country?.anchors[0];
            if (cap && cap[0] === rec.anchors[0][0] && cap[1] === rec.anchors[0][1]) continue;
            const [sx, sy] = toS(rec.anchors[0][0] + 0.5, rec.anchors[0][1] + 0.5);
            this.drawCapital(ctx, placer, sx, sy, rec.seat, ui, false);
          }
        }
      }
    }

    if (flags.features && analysis && world.terrain && mode !== 'sketch') {
      const feats = [...analysis.landforms.features].sort((a, b) => featurePriority(b) - featurePriority(a));
      for (const f of feats) {
        if (mode === 'political' && (f.kind === 'plain' || f.kind === 'basin' || f.kind === 'plateau' || f.kind === 'peak')) continue;
        this.drawFeature(ctx, placer, f, tf, toS);
      }
    }
    ctx.restore();
  }

  private drawCapital(ctx: CanvasRenderingContext2D, placer: LabelPlacer, sx: number, sy: number, name: string, ui: number, capital: boolean): void {
    const size = (capital ? 11 : 9.5) * ui;
    ctx.font = `${capital ? 'bold ' : ''}${size}px ${SANS}`;
    const tw = ctx.measureText(name).width;
    const tx = sx + 6 * ui + tw / 2;
    if (!placer.tryPlace(tx, sy, tw + 8 * ui, size, 0, 1)) return;
    placer.reserve({ x0: sx - 6 * ui, y0: sy - 6 * ui, x1: sx + 6 * ui, y1: sy + 6 * ui });
    ctx.save();
    if (capital) {
      ctx.fillStyle = '#b3122e';
      star(ctx, sx, sy, 5.5 * ui, 2.4 * ui);
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1 * ui;
      ctx.stroke();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.2 * ui;
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * ui;
    ctx.strokeStyle = COLORS.halo;
    ctx.strokeText(name, sx + 6 * ui, sy);
    ctx.fillStyle = '#2a2a2a';
    ctx.fillText(name, sx + 6 * ui, sy);
    ctx.restore();
  }

  private drawFeature(
    ctx: CanvasRenderingContext2D,
    placer: LabelPlacer,
    f: Feature,
    tf: DrawTransform,
    toS: (x: number, y: number) => [number, number],
  ): void {
    const ui = tf.ui;
    const name = featureDisplayName(this.store, f);
    const [sx, sy] = toS(f.x, f.y);
    if (sx < -50 || sy < -50 || sx > tf.width + 50 || sy > tf.height + 50) return;
    switch (f.kind) {
      case 'range':
      case 'massif': {
        const extentPx = f.extent * tf.scale;
        const size = Math.min(17 * ui, Math.max(9 * ui, extentPx * 0.06));
        if (extentPx < name.length * size * 0.9) return;
        this.spacedText(ctx, placer, name, sx, sy, size, f.kind === 'range' ? f.angle : 0, {
          font: `italic bold ${size}px ${SERIF}`,
          fill: 'rgba(96, 58, 28, 0.95)',
          spacing: f.kind === 'range' ? 0.45 : 0.2,
        });
        return;
      }
      case 'peak': {
        if (tf.scale / ui < 1.6) return;
        const size = 9.5 * ui;
        const label = `${name} ${Math.round(f.elevation).toLocaleString()}m`;
        ctx.font = `${size}px ${SANS}`;
        const tw = ctx.measureText(label).width;
        if (!placer.tryPlace(sx + 7 * ui + tw / 2, sy, tw + 14 * ui, size + 2, 0)) return;
        ctx.save();
        ctx.fillStyle = '#4a2f1a';
        ctx.beginPath();
        ctx.moveTo(sx, sy - 5 * ui);
        ctx.lineTo(sx + 4.5 * ui, sy + 3.5 * ui);
        ctx.lineTo(sx - 4.5 * ui, sy + 3.5 * ui);
        ctx.closePath();
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = COLORS.halo;
        ctx.lineWidth = 3 * ui;
        ctx.strokeText(label, sx + 7 * ui, sy);
        ctx.fillStyle = '#4a2f1a';
        ctx.fillText(label, sx + 7 * ui, sy);
        ctx.restore();
        return;
      }
      case 'river': {
        const lengthPx = f.length * tf.scale;
        const size = Math.min(12.5 * ui, Math.max(9 * ui, lengthPx * 0.035));
        if (lengthPx < name.length * size * 2.2) return;
        this.spacedText(ctx, placer, name, sx, sy - size * 0.7, size, f.angle, {
          font: `italic ${size}px ${SERIF}`,
          fill: '#1f5a9a',
          spacing: 0.25,
        });
        return;
      }
      case 'lake': {
        if (f.size * tf.scale * tf.scale < 300 * ui * ui) return;
        const size = 10 * ui;
        this.spacedText(ctx, placer, name, sx, sy, size, 0, { font: `italic ${size}px ${SERIF}`, fill: '#1f5a9a', spacing: 0.1 });
        return;
      }
      default: {
        const extentPx = f.extent * tf.scale;
        const size = Math.min(14 * ui, Math.max(9 * ui, extentPx * 0.12));
        if (extentPx < name.length * size * 0.8) return;
        const fill = f.kind === 'plateau' ? 'rgba(110, 80, 40, 0.9)' : 'rgba(40, 90, 40, 0.92)';
        this.spacedText(ctx, placer, name, sx, sy, size, 0, { font: `italic ${size}px ${SERIF}`, fill, spacing: 0.3 });
      }
    }
  }

  /** 字間をあけた文字列を（回転して）描く */
  private spacedText(
    ctx: CanvasRenderingContext2D,
    placer: LabelPlacer,
    text: string,
    x: number,
    y: number,
    size: number,
    angle: number,
    opt: { font: string; fill: string; spacing: number; force?: boolean },
  ): boolean {
    ctx.font = opt.font;
    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const gap = size * opt.spacing;
    const total = widths.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
    if (!placer.tryPlace(x, y, total, size, angle) && !opt.force) return false;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let cx = -total / 2;
    ctx.strokeStyle = COLORS.halo;
    ctx.lineWidth = Math.max(2, size * 0.28);
    for (let k = 0; k < chars.length; k++) {
      ctx.strokeText(chars[k], cx, 0);
      cx += widths[k] + gap;
    }
    cx = -total / 2;
    ctx.fillStyle = opt.fill;
    for (let k = 0; k < chars.length; k++) {
      ctx.fillText(chars[k], cx, 0);
      cx += widths[k] + gap;
    }
    ctx.restore();
    return true;
  }
}

function featurePriority(f: Feature): number {
  switch (f.kind) {
    case 'range':
      return 1000 + f.size;
    case 'massif':
      return 600 + f.size * 0.5;
    case 'river':
      return 500 + f.length;
    case 'plain':
    case 'basin':
    case 'plateau':
      return 300 + f.size * 0.1;
    case 'lake':
      return 200 + f.size;
    default:
      return f.elevation / 100;
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, r2: number): void {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 === 0 ? r : r2;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}
