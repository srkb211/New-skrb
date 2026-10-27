import { colorGraph, pickColor } from './colors';
import { distanceTransform } from './distance';
import { cityName, countryName, cultureByKey, govFor, newRegistry, pickCulture, regionName, subdivisionFor } from './names';
import { labelComponents, rasterizePolyline, type Pt } from './raster';
import { rngFor } from './rng';
import { buildTopology, polylineLength, simplify, type Topology } from './topology';
import type { BorderStroke, CountryRecord, StateRecord } from './world';

export interface PoliticalInput {
  land: Uint8Array;
  w: number;
  h: number;
  borders: readonly BorderStroke[];
  countries: readonly CountryRecord[];
  states: readonly StateRecord[];
  seed: number;
  nextId: number;
}

export interface PoliticalLabels {
  /** 各セルの国（countries 配列の添字、海は -1） */
  country: Int32Array;
  /** 各セルの州（states 配列の添字、海は -1） */
  state: Int32Array;
  /** 新たに作られた国・州（呼び出し側で状態に追加する） */
  countries: CountryRecord[];
  states: StateRecord[];
  addedCountries: number;
  addedStates: number;
  nextId: number;
}

export function minCountryCells(w: number, h: number): number {
  return Math.max(20, Math.round((w * h) / 2500));
}

export function minStateCells(w: number, h: number): number {
  return Math.max(8, Math.round((w * h) / 9000));
}

export function rasterizeBorders(borders: readonly BorderStroke[], w: number, h: number) {
  const national = new Uint8Array(w * h);
  const state = new Uint8Array(w * h);
  for (const b of borders) {
    const target = b.kind === 'national' ? national : state;
    rasterizePolyline(b.points, w, h, (i) => (target[i] = 1));
  }
  return { national, state };
}

/** 代表点から、近くの「有効なセル」を探す（代表点が境界線や海に落ちた場合の救済） */
function snapAnchor(p: Pt, w: number, h: number, ok: (i: number) => boolean, radius = 4): number {
  const x0 = Math.round(p[0]);
  const y0 = Math.round(p[1]);
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (ok(i)) return i;
      }
    }
  }
  return -1;
}

/** 成分の内部にある代表点（境界から最も遠いセル） */
function interiorPoints(labels: Int32Array, count: number, w: number, h: number): Int32Array {
  const dist = distanceTransform((i) => {
    const l = labels[i];
    if (l < 0) return true;
    const x = i % w;
    return (
      x === 0 || x === w - 1 || i < w || i >= w * h - w ||
      labels[i - 1] !== l || labels[i + 1] !== l || labels[i - w] !== l || labels[i + w] !== l
    );
  }, w, h);
  const best = new Int32Array(count).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l >= 0 && (best[l] < 0 || dist[i] > dist[best[l]])) best[l] = i;
  }
  return best;
}

const toPt = (i: number, w: number): Pt => [i % w, Math.floor(i / w)];

/**
 * 国境線・州境線（ストローク）から行政区画を求める。
 * 1) 国境で区切られた陸の連結成分を、代表点（anchor）によって国に対応づける
 * 2) 代表点の無い大きな成分には新しい国を作り、小島は最寄りの国に属させる
 * 3) 境界線上のセルは隣接する区画に吸収させる
 * 州についても国の内側で同じ処理を行う。
 */
export function derivePolitical(input: PoliticalInput): PoliticalLabels {
  const { land, w, h, seed } = input;
  const n = w * h;
  const bars = rasterizeBorders(input.borders, w, h);
  const countries = input.countries.map((c) => ({ ...c }));
  const states = input.states.map((s) => ({ ...s }));
  let nextId = input.nextId;
  const reg = newRegistry([...countries.map((c) => c.name), ...states.map((s) => s.name)]);

  // ---- 国 ----
  const compN = labelComponents(w, h, (i) => land[i] === 1 && !bars.national[i], 4);
  const compCountry = new Int32Array(compN.count).fill(-1);
  countries.forEach((c, ci) => {
    for (const a of c.anchors) {
      const cell = snapAnchor(a, w, h, (i) => compN.labels[i] >= 0);
      if (cell < 0) continue;
      const comp = compN.labels[cell];
      if (compCountry[comp] < 0) compCountry[comp] = ci;
    }
  });
  const minC = minCountryCells(w, h);
  let addedCountries = 0;
  const interiorN = interiorPoints(compN.labels, compN.count, w, h);
  const compOrder = [...Array(compN.count).keys()].sort((a, b) => compN.sizes[b] - compN.sizes[a]);
  for (const comp of compOrder) {
    if (compCountry[comp] >= 0) continue;
    const big = compN.sizes[comp] >= minC;
    const none = countries.length === 0;
    if (!big && !none) continue;
    const anchor = toPt(interiorN[comp], w);
    countries.push(makeCountry(seed, nextId++, anchor, reg));
    compCountry[comp] = countries.length - 1;
    addedCountries++;
  }
  const country = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const comp = compN.labels[i];
    if (comp >= 0) country[i] = compCountry[comp];
  }
  absorb(country, land, w, h, () => true);
  assignStrays(country, land, w, h);

  // ---- 州 ----
  const compS = labelComponents(
    w,
    h,
    (i) => country[i] >= 0 && !bars.state[i] && !bars.national[i],
    4,
    (a, b) => country[a] === country[b],
  );
  const compState = new Int32Array(compS.count).fill(-1);
  states.forEach((s, si) => {
    for (const a of s.anchors) {
      const cell = snapAnchor(a, w, h, (i) => compS.labels[i] >= 0);
      if (cell < 0) continue;
      const comp = compS.labels[cell];
      if (compState[comp] < 0) compState[comp] = si;
    }
  });
  const minS = minStateCells(w, h);
  const interiorS = interiorPoints(compS.labels, compS.count, w, h);
  const compCountryS = new Int32Array(compS.count).fill(-1);
  for (let i = 0; i < n; i++) if (compS.labels[i] >= 0) compCountryS[compS.labels[i]] = country[i];
  const hasState = new Uint8Array(countries.length);
  for (let c = 0; c < compS.count; c++) if (compState[c] >= 0) hasState[compCountryS[c]] = 1;
  let addedStates = 0;
  const orderS = [...Array(compS.count).keys()].sort((a, b) => compS.sizes[b] - compS.sizes[a]);
  for (const comp of orderS) {
    if (compState[comp] >= 0) continue;
    const ci = compCountryS[comp];
    if (compS.sizes[comp] < minS && hasState[ci]) continue;
    const culture = cultureByKey(countries[ci].culture);
    const anchor = toPt(interiorS[comp], w);
    const rng = rngFor(seed, 7, anchor[0], anchor[1]);
    states.push({ id: nextId++, name: regionName(rng, culture, reg), seat: cityName(rng, culture, reg), anchors: [anchor] });
    compState[comp] = states.length - 1;
    hasState[ci] = 1;
    addedStates++;
  }
  const state = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const comp = compS.labels[i];
    if (comp >= 0) state[i] = compState[comp];
  }
  absorb(state, land, w, h, (a, b) => country[a] === country[b]);
  assignStraysWithin(state, country, w, h);

  return { country, state, countries, states, addedCountries, addedStates, nextId };
}

export function makeCountry(seed: number, id: number, anchor: Pt, reg = newRegistry()): CountryRecord {
  const rng = rngFor(seed, 3, anchor[0], anchor[1]);
  const culture = pickCulture(rng);
  return {
    id,
    name: countryName(rng, culture, reg),
    gov: govFor(rng, culture),
    color: pickColor([], Math.floor(rng() * 16)),
    culture: culture.key,
    subdivision: subdivisionFor(rng, culture),
    capital: cityName(rng, culture, reg),
    anchors: [anchor],
  };
}

/** 未割当の陸セル（境界線上など）を、隣接する割当済みセルから幅優先で埋める */
function absorb(
  labels: Int32Array,
  land: Uint8Array,
  w: number,
  h: number,
  allowed: (from: number, to: number) => boolean,
): void {
  const n = w * h;
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (labels[i] >= 0) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const l = labels[i];
    const visit = (j: number) => {
      if (labels[j] < 0 && land[j] && allowed(i, j)) {
        labels[j] = l;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
}

/** まだ未割当の陸（小島）を、海を越えて最も近い区画に属させる */
function assignStrays(labels: Int32Array, land: Uint8Array, w: number, h: number): void {
  const n = w * h;
  let stray = false;
  for (let i = 0; i < n; i++) if (land[i] && labels[i] < 0) stray = true;
  if (!stray) return;
  const near = new Int32Array(labels);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (labels[i] >= 0) queue[tail++] = i;
  if (tail === 0) return;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const l = near[i];
    const visit = (j: number) => {
      if (near[j] < 0) {
        near[j] = l;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  // 小島ごとに 1 つの区画へ（島の中で最初に到達したセルの値）
  const comps = labelComponents(w, h, (i) => land[i] === 1 && labels[i] < 0, 4);
  const pick = new Int32Array(comps.count).fill(-1);
  for (let k = 0; k < tail; k++) {
    const i = queue[k];
    const c = comps.labels[i];
    if (c >= 0 && pick[c] < 0) pick[c] = near[i];
  }
  for (let i = 0; i < n; i++) {
    const c = comps.labels[i];
    if (c >= 0) labels[i] = pick[c];
  }
}

/** 州が未割当のセル（国内の小島など）を、同じ国の最寄りの州へ */
function assignStraysWithin(state: Int32Array, country: Int32Array, w: number, h: number): void {
  const n = w * h;
  const comps = labelComponents(w, h, (i) => country[i] >= 0 && state[i] < 0, 4, (a, b) => country[a] === country[b]);
  if (comps.count === 0) return;
  // 州ごとの重心
  const sums = new Map<number, { x: number; y: number; m: number; c: number }>();
  for (let i = 0; i < n; i++) {
    const s = state[i];
    if (s < 0) continue;
    let e = sums.get(s);
    if (!e) sums.set(s, (e = { x: 0, y: 0, m: 0, c: country[i] }));
    e.x += i % w;
    e.y += Math.floor(i / w);
    e.m++;
  }
  const first = new Int32Array(comps.count).fill(-1);
  for (let i = 0; i < n; i++) if (comps.labels[i] >= 0 && first[comps.labels[i]] < 0) first[comps.labels[i]] = i;
  const target = new Int32Array(comps.count).fill(-1);
  for (let c = 0; c < comps.count; c++) {
    const i = first[c];
    const cx = i % w;
    const cy = Math.floor(i / w);
    let best = -1;
    let bestD = Infinity;
    for (const [s, e] of sums) {
      if (e.c !== country[i]) continue;
      const d = (e.x / e.m - cx) ** 2 + (e.y / e.m - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    target[c] = best;
  }
  for (let i = 0; i < n; i++) {
    const c = comps.labels[i];
    if (c >= 0) state[i] = target[c];
  }
}

// ---------------------------------------------------------------------------
// 統計（面積・隣接・海岸線）とポリゴン

export interface RegionStats {
  index: number;
  cells: number;
  /** 面積 (km²) */
  area: number;
  /** 海岸線の長さ (km) */
  coast: number;
  /** 隣接区画（添字 → 共有境界の長さ km） */
  neighbors: Map<number, number>;
  /** ラベル位置と内接半径（セル単位） */
  labelX: number;
  labelY: number;
  labelRadius: number;
  /** 州の場合の所属国 */
  country: number;
}

export interface PoliticalStats {
  countries: RegionStats[];
  states: RegionStats[];
  countryTopo: Topology;
  stateTopo: Topology;
  /** 簡略化した弧（描画・GeoJSON 用） */
  countryArcs: Pt[][];
  stateArcs: Pt[][];
}

export function computeStats(
  labels: PoliticalLabels,
  w: number,
  h: number,
  kmPerCell: number,
  simplifyTol = 0.75,
): PoliticalStats {
  const countryTopo = buildTopology(labels.country, w, h);
  const stateTopo = buildTopology(labels.state, w, h);
  const countryArcs = countryTopo.arcs.map((a) => simplify(a.points, simplifyTol));
  const stateArcs = stateTopo.arcs.map((a) => simplify(a.points, simplifyTol));
  const stateCountry = new Int32Array(labels.states.length).fill(-1);
  for (let i = 0; i < w * h; i++) if (labels.state[i] >= 0) stateCountry[labels.state[i]] = labels.country[i];
  const make = (
    count: number,
    grid: Int32Array,
    topo: Topology,
    arcs: Pt[][],
    countryOf: (idx: number) => number,
  ): RegionStats[] => {
    const out: RegionStats[] = [];
    for (let k = 0; k < count; k++) {
      out.push({
        index: k, cells: 0, area: 0, coast: 0, neighbors: new Map(),
        labelX: 0, labelY: 0, labelRadius: 0, country: countryOf(k),
      });
    }
    for (let i = 0; i < w * h; i++) if (grid[i] >= 0) out[grid[i]].cells++;
    topo.arcs.forEach((a, k) => {
      const len = arcLengthKm(arcs[k], w, h, kmPerCell);
      if (a.left >= 0 && a.right >= 0) {
        const l = out[a.left].neighbors;
        l.set(a.right, (l.get(a.right) ?? 0) + len.total);
        const r = out[a.right].neighbors;
        r.set(a.left, (r.get(a.left) ?? 0) + len.total);
      } else {
        const side = a.left >= 0 ? a.left : a.right;
        if (side >= 0) out[side].coast += len.inner;
      }
    });
    const pole = polesOfInaccessibility(grid, count, w, h);
    for (const s of out) {
      s.area = s.cells * kmPerCell * kmPerCell;
      s.labelX = pole.x[s.index];
      s.labelY = pole.y[s.index];
      s.labelRadius = pole.r[s.index];
    }
    return out;
  };
  return {
    countries: make(labels.countries.length, labels.country, countryTopo, countryArcs, (k) => k),
    states: make(labels.states.length, labels.state, stateTopo, stateArcs, (k) => stateCountry[k]),
    countryTopo,
    stateTopo,
    countryArcs,
    stateArcs,
  };
}

/** 弧の長さ。total は全体、inner はマップ外周上の部分を除いた長さ。 */
function arcLengthKm(pts: Pt[], w: number, h: number, km: number): { total: number; inner: number } {
  let total = 0;
  let inner = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const len = Math.hypot(bx - ax, by - ay);
    total += len;
    const onEdge =
      (ax === bx && (ax === 0 || ax === w)) || (ay === by && (ay === 0 || ay === h));
    if (!onEdge) inner += len;
  }
  return { total: total * km, inner: inner * km };
}

/** 各区画で境界から最も遠い点（ラベル配置用） */
export function polesOfInaccessibility(grid: Int32Array, count: number, w: number, h: number) {
  const n = w * h;
  const dist = distanceTransform((i) => {
    const l = grid[i];
    if (l < 0) return true;
    const x = i % w;
    return (
      x === 0 || x === w - 1 || i < w || i >= n - w ||
      grid[i - 1] !== l || grid[i + 1] !== l || grid[i - w] !== l || grid[i + w] !== l
    );
  }, w, h);
  const best = new Int32Array(count).fill(-1);
  for (let i = 0; i < n; i++) {
    const l = grid[i];
    if (l >= 0 && (best[l] < 0 || dist[i] > dist[best[l]])) best[l] = i;
  }
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const r = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const i = best[k];
    if (i < 0) continue;
    x[k] = (i % w) + 0.5;
    y[k] = Math.floor(i / w) + 0.5;
    r[k] = dist[i] + 0.5;
  }
  return { x, y, r };
}

/** 弧の総延長（セル単位） */
export function arcsLength(arcs: Pt[][]): number {
  let s = 0;
  for (const a of arcs) s += polylineLength(a);
  return s;
}

/** 隣接関係に基づいて国の色を塗り直す */
export function recolorCountries(countries: CountryRecord[], stats: RegionStats[]): CountryRecord[] {
  const nb = new Map<number, Set<number>>();
  const ids: number[] = [];
  stats.forEach((s) => {
    if (s.cells === 0) return;
    ids.push(s.index);
    nb.set(s.index, new Set(s.neighbors.keys()));
  });
  const colors = colorGraph(ids, nb, countries.length);
  return countries.map((c, k) => (colors.has(k) ? { ...c, color: colors.get(k)! } : c));
}

export { cultureByKey };
