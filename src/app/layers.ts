import { shade } from '../core/colors';
import { contourRings, maskRings } from '../core/contour';
import { LF_LAKE } from '../core/landforms';
import type { Pt } from '../core/raster';
import { chaikin, simplify, type Ring } from '../core/topology';
import { PAINT_LAND, PAINT_OUTLINE } from '../core/world';
import { climateColor, type ClimateLayer } from './climate-style';
import { COLORS, landColor, seaColor } from './palette';
import type { Store } from './store';

export interface RegionGeom {
  fill: Path2D;
  bleed: Path2D;
  color: string;
}

export interface PoliticalGeom {
  countries: RegionGeom[];
  states: RegionGeom[];
  national: Path2D;
  state: Path2D;
}

export interface RiverGeom {
  path: Path2D;
  /** 基準となる線幅（CSS px） */
  width: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function pathFromRings(rings: Pt[][], smoothIter = 1): Path2D {
  const p = new Path2D();
  for (const r of rings) {
    const pts = smoothIter > 0 ? chaikin(r, smoothIter, true) : r;
    p.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) p.lineTo(pts[k][0], pts[k][1]);
    p.closePath();
  }
  return p;
}

/** 表示用ジオメトリとラスタのキャッシュ（入力配列の同一性で無効化する） */
export class MapLayers {
  private memo = new Map<string, { key: unknown[]; value: unknown }>();
  constructor(private store: Store) {}

  private cached<T>(name: string, key: unknown[], make: () => T): T {
    const m = this.memo.get(name);
    if (m && m.key.length === key.length && m.key.every((v, k) => v === key[k])) return m.value as T;
    const value = make();
    this.memo.set(name, { key, value });
    return value;
  }

  invalidate(name: string): void {
    this.memo.delete(name);
  }

  /** 海岸線（陸地の外形）のパス */
  coastPath(): Path2D {
    const { world, land } = this.store;
    return this.cached('coast', [world.terrain?.coast ?? land], () => {
      const w = world.width;
      const h = world.height;
      if (world.terrain) {
        const c = world.terrain.coast;
        return pathFromRings(contourRings((x, y) => c[y * w + x], w, h, 0), 1);
      }
      return pathFromRings(maskRings(land, w, h), 1);
    });
  }

  /** 下絵ラスタ（ブラシ操作中は外から直接書き換える） */
  sketchCanvas(paintOverride?: Uint8Array): HTMLCanvasElement {
    const { world } = this.store;
    return this.cached('sketch', [paintOverride ? 'live' : world.paint, world.width], () => {
      const c = makeCanvas(world.width, world.height);
      this.writeSketch(c, paintOverride ?? world.paint, 0, 0, world.width, world.height);
      return c;
    });
  }

  writeSketch(c: HTMLCanvasElement, paint: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
    const w = this.store.world.width;
    const h = this.store.world.height;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w, x1);
    y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(x1 - x0, y1 - y0);
    const d = img.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = paint[y * w + x];
        const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
        if (v === PAINT_LAND) {
          d[o] = COLORS.sketchLand[0];
          d[o + 1] = COLORS.sketchLand[1];
          d[o + 2] = COLORS.sketchLand[2];
          d[o + 3] = 255;
        } else if (v === PAINT_OUTLINE) {
          d[o] = COLORS.sketchOutline[0];
          d[o + 1] = COLORS.sketchOutline[1];
          d[o + 2] = COLORS.sketchOutline[2];
          d[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, x0, y0);
  }

  /** 気候レイヤーのラスタ（気候グリッドの解像度） */
  climateCanvas(layer: ClimateLayer): HTMLCanvasElement | null {
    const c = this.store.world.climate;
    if (!c || layer === 'none') return null;
    return this.cached('climate-' + layer, [c], () => {
      const cw = c.meta.width;
      const ch = c.meta.height;
      const canvas = makeCanvas(cw, ch);
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(cw, ch);
      const d = img.data;
      for (let i = 0; i < cw * ch; i++) {
        const col = climateColor(layer, c, i);
        if (!col) continue;
        d[i * 4] = col[0];
        d[i * 4 + 1] = col[1];
        d[i * 4 + 2] = col[2];
        d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    });
  }

  /** 陰影だけの灰色ラスタ（乗算で重ねて起伏を残す） */
  reliefCanvas(): HTMLCanvasElement | null {
    const { world } = this.store;
    const sh = this.hillshade();
    if (!sh) return null;
    return this.cached('relief', [sh], () => {
      const c = makeCanvas(world.width, world.height);
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(world.width, world.height);
      for (let i = 0; i < sh.length; i++) {
        const v = 255 * Math.max(0.5, Math.min(1, 0.12 + sh[i] * 0.88));
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
  }

  /** 陰影（ヒルシェード）係数。1 が平坦。 */
  private hillshade(): Float32Array | null {
    const { world } = this.store;
    const t = world.terrain;
    if (!t) return null;
    return this.cached('shade', [t.elevation, world.kmPerCell], () => {
      const w = world.width;
      const h = world.height;
      const e = t.elevation;
      const out = new Float32Array(w * h);
      const cellM = world.kmPerCell * 1000;
      const exag = 7 * Math.sqrt(world.kmPerCell / 2);
      const alt = (42 * Math.PI) / 180;
      const lx = -Math.cos(alt) * Math.SQRT1_2;
      const ly = -Math.cos(alt) * Math.SQRT1_2;
      const lz = Math.sin(alt);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const ex = Math.max(0, e[y * w + Math.min(w - 1, x + 1)]) - Math.max(0, e[y * w + Math.max(0, x - 1)]);
          const ey = Math.max(0, e[Math.min(h - 1, y + 1) * w + x]) - Math.max(0, e[Math.max(0, y - 1) * w + x]);
          const dzdx = (ex / (2 * cellM)) * exag;
          const dzdy = (ey / (2 * cellM)) * exag;
          const len = Math.hypot(dzdx, dzdy, 1);
          const dot = (-dzdx * lx - dzdy * ly + lz) / len;
          out[i] = Math.max(0.42, Math.min(1.4, 1 + (dot - lz) * 1.6));
        }
      }
      return out;
    });
  }

  /** 陸の段彩＋陰影ラスタ。mode=political では羊皮紙色の地に薄い陰影。 */
  landCanvas(mode: 'physical' | 'political', relief: boolean): HTMLCanvasElement | null {
    const { world, analysis } = this.store;
    const t = world.terrain;
    if (!t) return null;
    const lf = analysis?.landforms.classes ?? null;
    return this.cached('land-' + mode, [t.elevation, lf, relief, world.params.maxElevation, world.kmPerCell], () => {
      const w = world.width;
      const h = world.height;
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const sh = relief ? this.hillshade() : null;
      const col = [0, 0, 0];
      const maxE = world.params.maxElevation;
      for (let i = 0; i < w * h; i++) {
        const e = t.elevation[i];
        let r: number;
        let g: number;
        let b: number;
        if (mode === 'physical') {
          landColor(Math.max(0, e), maxE, col);
          [r, g, b] = col;
          if (lf && lf[i] === LF_LAKE) [r, g, b] = [150, 196, 222];
        } else {
          [r, g, b] = COLORS.parchment;
          const k = Math.min(1, Math.max(0, e) / Math.max(800, maxE));
          r -= 30 * k;
          g -= 34 * k;
          b -= 30 * k;
        }
        let s = sh ? sh[i] : 1;
        if (mode === 'political') s = 1 + (s - 1) * 0.55;
        const o = i * 4;
        d[o] = r * s;
        d[o + 1] = g * s;
        d[o + 2] = b * s;
        d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
  }

  seaCanvas(): HTMLCanvasElement | null {
    const { world } = this.store;
    const t = world.terrain;
    if (!t) return null;
    return this.cached('sea', [t.elevation], () => {
      const w = world.width;
      const h = world.height;
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const col = [0, 0, 0];
      for (let i = 0; i < w * h; i++) {
        seaColor(Math.max(0, -t.elevation[i]), col);
        const o = i * 4;
        d[o] = col[0];
        d[o + 1] = col[1];
        d[o + 2] = col[2];
        d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
  }

  lakePath(): Path2D | null {
    const { world, analysis } = this.store;
    if (!world.terrain || !analysis) return null;
    return this.cached('lake', [analysis], () => {
      const lake = analysis.hydrology.lake;
      let any = false;
      for (let i = 0; i < lake.length; i++) if (lake[i]) { any = true; break; }
      if (!any) return null;
      return pathFromRings(maskRings(lake, world.width, world.height), 2);
    });
  }

  rivers(): RiverGeom[] {
    const { analysis } = this.store;
    if (!analysis) return [];
    return this.cached('rivers', [analysis], () => {
      const hyd = analysis.hydrology;
      const T = hyd.riverThreshold;
      const classes = 7;
      const paths = Array.from({ length: classes }, () => new Path2D());
      const widthOf = (q: number) => Math.min(classes - 1, Math.max(0, Math.floor(Math.log2(q / T) * 0.9)));
      for (const r of hyd.rivers) {
        if (r.points.length < 2) continue;
        const pts = chaikin(r.points, 2);
        // 平滑化後の点に流量を対応づける（元の点列の位置に比例）
        let cur = -1;
        for (let k = 0; k < pts.length; k++) {
          const src = Math.min(r.flow.length - 1, Math.floor((k / (pts.length - 1)) * (r.flow.length - 1)));
          const cls = widthOf(r.flow[src]);
          if (cls !== cur) {
            if (k > 0) paths[cls].moveTo(pts[k - 1][0], pts[k - 1][1]);
            else paths[cls].moveTo(pts[k][0], pts[k][1]);
            cur = cls;
          }
          paths[cls].lineTo(pts[k][0], pts[k][1]);
        }
      }
      return paths.map((path, k) => ({ path, width: 0.55 + k * 0.45 }));
    });
  }

  contours(): { minor: Path2D; major: Path2D } | null {
    const { world } = this.store;
    const t = world.terrain;
    if (!t) return null;
    return this.cached('contours', [t.elevation], () => {
      const w = world.width;
      const e = t.elevation;
      const minor = new Path2D();
      const major = new Path2D();
      const levels = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000];
      for (const lv of levels) {
        const rings = contourRings((x, y) => e[y * w + x], w, world.height, lv, -1);
        const target = lv % 1000 === 0 ? major : minor;
        for (const r of rings) {
          if (r.length < 6) continue;
          const pts = chaikin(r, 1, true);
          target.moveTo(pts[0][0], pts[0][1]);
          for (let k = 1; k < pts.length; k++) target.lineTo(pts[k][0], pts[k][1]);
        }
      }
      return { minor, major };
    });
  }

  political(): PoliticalGeom | null {
    const pol = this.store.political;
    if (!pol) return null;
    return this.cached('political', [pol], () => {
      const { labels, stats } = pol;
      const smoothArcs = (arcs: Pt[][]) => arcs.map((a) => chaikin(simplify(a, 0.75), 2));
      const cArcs = smoothArcs(stats.countryArcs);
      const sArcs = smoothArcs(stats.stateArcs);
      const regionGeom = (
        topo: typeof stats.countryTopo,
        arcs: Pt[][],
        count: number,
        colorOf: (k: number) => string,
      ): RegionGeom[] => {
        const out: RegionGeom[] = [];
        for (let k = 0; k < count; k++) {
          const fill = new Path2D();
          const bleed = new Path2D();
          const reg = topo.regions.get(k);
          if (reg) {
            const addRing = (ring: Ring) => {
              let first = true;
              for (const { arc, reversed } of ring.arcs) {
                const pts = reversed ? [...arcs[arc]].reverse() : arcs[arc];
                for (let j = 0; j < pts.length; j++) {
                  if (first) {
                    fill.moveTo(pts[j][0], pts[j][1]);
                    first = false;
                  } else if (j > 0) fill.lineTo(pts[j][0], pts[j][1]);
                }
                const a = topo.arcs[arc];
                if (a.left < 0 || a.right < 0) {
                  bleed.moveTo(pts[0][0], pts[0][1]);
                  for (let j = 1; j < pts.length; j++) bleed.lineTo(pts[j][0], pts[j][1]);
                }
              }
              fill.closePath();
            };
            for (const part of reg.parts) {
              addRing(part.outer);
              for (const hole of part.holes) addRing(hole);
            }
          }
          out.push({ fill, bleed, color: colorOf(k) });
        }
        return out;
      };
      const countries = regionGeom(stats.countryTopo, cArcs, labels.countries.length, (k) => labels.countries[k].color);
      // 州の色：国の色を明暗 3 段階で塗り分け（隣接州と重ならないように）
      const stateShade = new Map<number, number>();
      const order = [...stats.states].sort((a, b) => b.cells - a.cells);
      for (const s of order) {
        const used = new Set<number>();
        for (const nb of s.neighbors.keys()) {
          if (stats.states[nb].country === s.country && stateShade.has(nb)) used.add(stateShade.get(nb)!);
        }
        let v = 0;
        while (used.has(v) && v < 3) v++;
        stateShade.set(s.index, v % 3);
      }
      const shades = [0, 0.22, -0.1];
      const states = regionGeom(stats.stateTopo, sArcs, labels.states.length, (k) => {
        const c = stats.states[k].country;
        const base = c >= 0 ? labels.countries[c].color : '#cccccc';
        return shade(base, shades[stateShade.get(k) ?? 0]);
      });
      const national = new Path2D();
      stats.countryTopo.arcs.forEach((a, k) => {
        if (a.left < 0 || a.right < 0) return;
        const pts = cArcs[k];
        national.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) national.lineTo(pts[j][0], pts[j][1]);
      });
      const state = new Path2D();
      stats.stateTopo.arcs.forEach((a, k) => {
        if (a.left < 0 || a.right < 0) return;
        if (stats.states[a.left].country !== stats.states[a.right].country) return;
        const pts = sArcs[k];
        state.moveTo(pts[0][0], pts[0][1]);
        for (let j = 1; j < pts.length; j++) state.lineTo(pts[j][0], pts[j][1]);
      });
      return { countries, states, national, state };
    });
  }
}
