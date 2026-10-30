import { colorGraph } from './colors';
import { MinHeap } from './heap';
import { cityName, countryName, cultureByKey, govFor, newRegistry, pickCulture, regionName, subdivisionFor, type NameRegistry } from './names';
import { rasterizeBorders } from './political';
import { labelComponents, type Pt } from './raster';
import { rngFor, type Rng } from './rng';
import { buildTopology, chaikin, simplify } from './topology';
import type { BorderStroke, CountryRecord, StateRecord } from './world';

export interface AutoPoliticalOptions {
  countries: number;
  statesPerCountry: number;
  seed: number;
  /** 使う命名文化（省略時は西洋系） */
  cultures?: readonly string[];
}

export interface TerrainHints {
  elevation: Float32Array | null;
  /** 流量累積（河川を国境にしやすくする） */
  acc: Float32Array | null;
  riverThreshold: number;
}

export interface AutoPoliticalResult {
  borders: BorderStroke[];
  countries: CountryRecord[];
  states: StateRecord[];
  nextId: number;
  /** 生成時のラベル（検証用） */
  countryGrid: Int32Array;
  stateGrid: Int32Array;
}

/** 首都の置きやすさ（低地・川沿い・海岸から少し内陸） */
function suitability(i: number, hints: TerrainHints): number {
  let s = 1;
  if (hints.elevation) s *= Math.exp(-Math.max(0, hints.elevation[i]) / 900);
  if (hints.acc && hints.riverThreshold > 0) {
    const a = hints.acc[i] / hints.riverThreshold;
    if (a >= 1) s *= 1.6 + Math.min(1, Math.log10(a) / 2);
  }
  return s;
}

/** 間隔を空けながら、適性の高いセルを種として選ぶ */
function pickSeeds(
  rng: Rng,
  candidates: number[],
  count: number,
  minDist: number,
  w: number,
  hints: TerrainHints,
  existing: number[] = [],
): number[] {
  const scored = candidates.map((i) => ({ i, s: suitability(i, hints) * (0.35 + rng()) }));
  scored.sort((a, b) => b.s - a.s);
  const seeds = [...existing];
  let r = minDist;
  for (let pass = 0; pass < 6 && seeds.length < existing.length + count; pass++) {
    for (const { i } of scored) {
      if (seeds.length >= existing.length + count) break;
      const x = i % w;
      const y = Math.floor(i / w);
      let ok = true;
      for (const s of seeds) {
        const dx = (s % w) - x;
        const dy = Math.floor(s / w) - y;
        if (dx * dx + dy * dy < r * r) {
          ok = false;
          break;
        }
      }
      if (ok) seeds.push(i);
    }
    r *= 0.75;
  }
  return seeds.slice(existing.length);
}

/**
 * 複数の種からのダイクストラ法で領域を広げる。
 * 山・急斜面・大河を越えるほどコストが高いので、自然な地形境界に沿った国境になる。
 */
function grow(
  seeds: number[],
  strength: number[],
  land: Uint8Array,
  w: number,
  h: number,
  hints: TerrainHints,
  allowed: (i: number) => boolean,
  terrainWeight: number,
  seaCost: number,
): Int32Array {
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const label = new Int32Array(n).fill(-1);
  const heap = new MinHeap(4096);
  seeds.forEach((s, k) => {
    dist[s] = 0;
    label[s] = k;
    heap.push(0, s);
  });
  const elev = hints.elevation;
  const acc = hints.acc;
  const bigRiver = hints.riverThreshold * 10;
  while (heap.size > 0) {
    const c = heap.pop();
    const dc = heap.lastKey;
    if (dc > dist[c]) continue;
    const l = label[c];
    const x = c % w;
    const nb = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c >= w ? c - w : -1, c < n - w ? c + w : -1];
    for (const j of nb) {
      if (j < 0 || !allowed(j)) continue;
      let cost: number;
      if (!land[j]) cost = seaCost;
      else {
        cost = 1;
        if (elev) {
          const e = Math.max(0, elev[j]);
          cost += terrainWeight * (Math.abs(e - Math.max(0, elev[c])) / 45 + (e / 1600) ** 2 * 1.5);
        }
        if (acc && land[c] && acc[j] >= bigRiver && acc[c] < bigRiver) cost += terrainWeight * 7;
      }
      const d = dc + cost / strength[l];
      if (d < dist[j]) {
        dist[j] = d;
        label[j] = l;
        heap.push(d, j);
      }
    }
  }
  for (let i = 0; i < n; i++) if (!land[i]) label[i] = -1;
  return label;
}

/** 本土と地続きの飛び地を、最も多く接する隣の区画へ統合する */
function removeExclaves(label: Int32Array, land: Uint8Array, seeds: number[], w: number, h: number, scope?: Int32Array): void {
  const n = w * h;
  const landComp = labelComponents(w, h, (i) => land[i] === 1, 4);
  const comps = labelComponents(w, h, (i) => label[i] >= 0, 4, (a, b) => label[a] === label[b]);
  const seedComp = new Set(seeds.map((s) => comps.labels[s]));
  // 成分ごとに、陸塊全体を占めているか（＝島）を判定
  const landSizeOf = (c: number, cell: number) => landComp.sizes[landComp.labels[cell]] === comps.sizes[c];
  const first = new Int32Array(comps.count).fill(-1);
  for (let i = 0; i < n; i++) if (comps.labels[i] >= 0 && first[comps.labels[i]] < 0) first[comps.labels[i]] = i;
  const contacts: Map<number, number>[] = Array.from({ length: comps.count }, () => new Map());
  for (let i = 0; i < n; i++) {
    const c = comps.labels[i];
    if (c < 0) continue;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
      if (j < 0 || label[j] < 0 || label[j] === label[i]) continue;
      if (scope && scope[j] !== scope[i]) continue;
      const m = contacts[c];
      m.set(label[j], (m.get(label[j]) ?? 0) + 1);
    }
  }
  const target = new Int32Array(comps.count).fill(-1);
  for (let c = 0; c < comps.count; c++) {
    if (seedComp.has(c) || landSizeOf(c, first[c])) continue;
    let best = -1;
    let bestN = 0;
    for (const [l, k] of contacts[c]) {
      if (k > bestN) {
        bestN = k;
        best = l;
      }
    }
    target[c] = best;
  }
  for (let i = 0; i < n; i++) {
    const c = comps.labels[i];
    if (c >= 0 && target[c] >= 0) label[i] = target[c];
  }
}

/** 区画ラベルの境界から境界線ストロークを作る */
export function bordersFromLabels(
  grid: Int32Array,
  w: number,
  h: number,
  include: (left: number, right: number) => boolean,
  kind: 'national' | 'state',
  nextId: () => number,
  /** true ならセルの角をそのままたどる（読み直すと元の区画と完全に一致する） */
  exact = false,
): BorderStroke[] {
  const topo = buildTopology(grid, w, h);
  const out: BorderStroke[] = [];
  const seaAt = (x: number, y: number): Pt | null => {
    for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      if (grid[cy * w + cx] < 0) return [cx + 0.5, cy + 0.5];
    }
    return null;
  };
  for (const arc of topo.arcs) {
    if (arc.left < 0 || arc.right < 0 || !include(arc.left, arc.right)) continue;
    if (exact) {
      out.push({ id: nextId(), kind, points: arc.points.map(([x, y]) => [x, y] as Pt) });
      continue;
    }
    let pts: Pt[] = chaikin(simplify(arc.points, 0.9), 1);
    // 海に接する端点は海側のセルまで延ばし、区画が確実に閉じるようにする
    const a = arc.points[0];
    const b = arc.points[arc.points.length - 1];
    const sa = seaAt(a[0], a[1]);
    const sb = seaAt(b[0], b[1]);
    if (sa) pts = [sa, ...pts];
    if (sb) pts = [...pts, sb];
    out.push({ id: nextId(), kind, points: pts.map(([x, y]) => [round2(x), round2(y)]) });
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function interiorOf(cells: number[], grid: Int32Array, w: number, h: number): number {
  // 簡易：成分の重心に最も近い成分内セル（内側へ寄せるため 4 近傍が同ラベルのものを優先）
  let sx = 0;
  let sy = 0;
  for (const i of cells) {
    sx += i % w;
    sy += Math.floor(i / w);
  }
  const cx = sx / cells.length;
  const cy = sy / cells.length;
  let best = cells[0];
  let bestD = Infinity;
  for (const i of cells) {
    const x = i % w;
    const y = Math.floor(i / w);
    const l = grid[i];
    const inner =
      x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
      grid[i - 1] === l && grid[i + 1] === l && grid[i - w] === l && grid[i + w] === l;
    const d = (x - cx) ** 2 + (y - cy) ** 2 + (inner ? 0 : 1e6);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 生成した境界線で区切られる各成分に、対応する国・州の代表点を追加する
 * （飛び地の島などが新しい国として扱われないように）。
 */
export function addComponentAnchors(
  land: Uint8Array,
  borders: BorderStroke[],
  w: number,
  h: number,
  grid: Int32Array,
  records: { anchors: Pt[] }[],
  kinds: 'national' | 'both',
  minSize: number,
): void {
  const bars = rasterizeBorders(borders, w, h);
  const comps = labelComponents(
    w,
    h,
    (i) => land[i] === 1 && !bars.national[i] && (kinds === 'national' || !bars.state[i]),
    4,
  );
  const cells: number[][] = Array.from({ length: comps.count }, () => []);
  for (let i = 0; i < w * h; i++) if (comps.labels[i] >= 0) cells[comps.labels[i]].push(i);
  for (let c = 0; c < comps.count; c++) {
    if (comps.sizes[c] < minSize) continue;
    const votes = new Map<number, number>();
    for (const i of cells[c]) if (grid[i] >= 0) votes.set(grid[i], (votes.get(grid[i]) ?? 0) + 1);
    let best = -1;
    let bestN = 0;
    for (const [l, k] of votes) {
      if (k > bestN) {
        bestN = k;
        best = l;
      }
    }
    if (best < 0) continue;
    const rec = records[best];
    const has = rec.anchors.some(([x, y]) => comps.labels[y * w + x] === c);
    if (!has) {
      const i = interiorOf(cells[c], comps.labels, w, h);
      rec.anchors.push([i % w, Math.floor(i / w)]);
    }
  }
}

export function autoGeneratePolitical(
  land: Uint8Array,
  w: number,
  h: number,
  hints: TerrainHints,
  opts: AutoPoliticalOptions,
  startId: number,
): AutoPoliticalResult {
  const n = w * h;
  let id = startId;
  const nextId = () => id++;
  const rng = rngFor(opts.seed, 4242);
  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (land[i]) landCells.push(i);
  const empty: AutoPoliticalResult = {
    borders: [], countries: [], states: [], nextId: id,
    countryGrid: new Int32Array(n).fill(-1), stateGrid: new Int32Array(n).fill(-1),
  };
  if (landCells.length === 0) return empty;
  const N = Math.max(1, Math.round(opts.countries));
  const sampleCount = Math.min(landCells.length, 6000);
  const candidates: number[] = [];
  for (let k = 0; k < sampleCount; k++) candidates.push(landCells[Math.floor(rng() * landCells.length)]);
  const minDist = 0.6 * Math.sqrt(landCells.length / N);
  const seeds = pickSeeds(rng, candidates, N, minDist, w, hints);
  // 大きな島に種が無ければ追加する
  const landComp = labelComponents(w, h, (i) => land[i] === 1, 4);
  const seeded = new Set(seeds.map((s) => landComp.labels[s]));
  const bigIsland = (landCells.length / N) * 0.45;
  for (let c = 0; c < landComp.count; c++) {
    if (seeded.has(c) || landComp.sizes[c] < bigIsland) continue;
    const cells = landCells.filter((i) => landComp.labels[i] === c);
    const extra = pickSeeds(rng, cells.slice(0, 3000), 1, 0, w, hints);
    if (extra.length) seeds.push(extra[0]);
  }
  const strength = seeds.map(() => 0.75 + rng() * 0.55);
  const country = grow(seeds, strength, land, w, h, hints, () => true, 1, 5);
  removeExclaves(country, land, seeds, w, h);

  // 国のレコード
  const reg: NameRegistry = newRegistry();
  const countries: CountryRecord[] = seeds.map((s) => {
    const r = rngFor(opts.seed, 3, s);
    const culture = pickCulture(r, opts.cultures);
    return {
      id: nextId(),
      name: countryName(r, culture, reg),
      gov: govFor(r, culture),
      color: '#cccccc',
      culture: culture.key,
      subdivision: subdivisionFor(r, culture),
      capital: cityName(r, culture, reg),
      anchors: [[s % w, Math.floor(s / w)] as Pt],
    };
  });

  // 州：国ごとに種を選び、国内でのみ成長させる
  const area = new Int32Array(seeds.length);
  for (let i = 0; i < n; i++) if (country[i] >= 0) area[country[i]]++;
  const avgArea = landCells.length / seeds.length;
  const stateGrid = new Int32Array(n).fill(-1);
  const states: StateRecord[] = [];
  const stateCountry: number[] = [];
  const spc = Math.max(1, opts.statesPerCountry);
  for (let c = 0; c < seeds.length; c++) {
    if (area[c] === 0) continue;
    const k = Math.max(1, Math.min(spc * 3, Math.round((spc * area[c]) / avgArea)));
    const sub = generateStatesFor(c, k, seeds[c], country, land, w, h, hints, rng);
    const culture = cultureByKey(countries[c].culture);
    sub.seeds.forEach((s, j) => {
      const r = rngFor(opts.seed, 9, s);
      states.push({
        id: nextId(),
        name: regionName(r, culture, reg),
        seat: j === 0 ? countries[c].capital : cityName(r, culture, reg),
        anchors: [[s % w, Math.floor(s / w)]],
      });
      stateCountry.push(c);
    });
    const base = states.length - sub.seeds.length;
    for (let i = 0; i < n; i++) if (sub.label[i] >= 0) stateGrid[i] = base + sub.label[i];
  }

  // 境界線
  const borders = [
    ...bordersFromLabels(country, w, h, () => true, 'national', nextId),
    ...bordersFromLabels(stateGrid, w, h, (a, b) => stateCountry[a] === stateCountry[b], 'state', nextId),
  ];
  addComponentAnchors(land, borders, w, h, country, countries, 'national', 1);
  addComponentAnchors(land, borders, w, h, stateGrid, states, 'both', 1);

  // 隣接に基づく彩色
  const nb = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const a = country[i];
    if (a < 0) continue;
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i < n - w ? i + w : -1]) {
      if (j < 0) continue;
      const b = country[j];
      if (b < 0 || b === a) continue;
      if (!nb.has(a)) nb.set(a, new Set());
      if (!nb.has(b)) nb.set(b, new Set());
      nb.get(a)!.add(b);
      nb.get(b)!.add(a);
    }
  }
  const colors = colorGraph(countries.map((_, k) => k), nb, Math.floor(rng() * 16));
  countries.forEach((c, k) => (c.color = colors.get(k)!));

  return { borders, countries, states, nextId: id, countryGrid: country, stateGrid };
}

/** 1 つの国の内部を k 個の州に分ける */
export function generateStatesFor(
  c: number,
  k: number,
  capitalCell: number,
  country: Int32Array,
  land: Uint8Array,
  w: number,
  h: number,
  hints: TerrainHints,
  rng: Rng,
): { seeds: number[]; label: Int32Array } {
  const cells: number[] = [];
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < country.length; i++) {
    if (country[i] !== c) continue;
    cells.push(i);
    const x = i % w;
    const y = Math.floor(i / w);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const first = capitalCell >= 0 && country[capitalCell] === c ? capitalCell : cells[0];
  const sample: number[] = [];
  for (let s = 0; s < Math.min(cells.length, 3000); s++) sample.push(cells[Math.floor(rng() * cells.length)]);
  const minDist = 0.65 * Math.sqrt(cells.length / k);
  const seeds = [first, ...pickSeeds(rng, sample, k - 1, minDist, w, hints, [first])];
  const margin = 24;
  const allowed = (i: number) => {
    const x = i % w;
    const y = Math.floor(i / w);
    if (x < minX - margin || x > maxX + margin || y < minY - margin || y > maxY + margin) return false;
    return land[i] ? country[i] === c : true;
  };
  const strength = seeds.map(() => 0.85 + rng() * 0.3);
  const label = grow(seeds, strength, land, w, h, hints, allowed, 0.45, 3);
  for (let i = 0; i < label.length; i++) if (country[i] !== c) label[i] = -1;
  removeExclaves(label, land, seeds, w, h, country);
  // 他国のセルに伸びた分は除去済み。届かなかった国内セルは最寄りの州へ。
  for (const i of cells) if (label[i] < 0) label[i] = 0;
  return { seeds, label };
}
