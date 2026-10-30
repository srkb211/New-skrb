import { addComponentAnchors, bordersFromLabels, generateStatesFor, type TerrainHints } from './autogen';
import { distanceTransform } from './distance';
import { cityName, countryName, cultureByKey, govFor, newRegistry, pickCulture, regionName, subdivisionFor } from './names';
import { makeCountry, rasterizeBorders, type PoliticalLabels } from './political';
import { floodFill, rasterizePolyline, type Pt } from './raster';
import { rngFor } from './rng';
import type { CountryRecord, StateRecord, WorldState } from './world';

/** 1 つの国の州を作り直す（その国の州境と州だけを置き換える） */
export function regenerateCountryStates(
  world: WorldState,
  land: Uint8Array,
  labels: PoliticalLabels,
  countryIndex: number,
  count: number,
  hints: TerrainHints,
  variation: number,
): WorldState {
  const { width: w, height: h } = world;
  const n = w * h;
  const country = labels.country;
  const rec = labels.countries[countryIndex];
  // この国の中にある州境ストロークを除く
  const borders = world.borders.filter((b) => {
    if (b.kind !== 'state') return true;
    let inside = 0;
    let total = 0;
    rasterizePolyline(b.points, w, h, (i) => {
      if (!land[i]) return;
      total++;
      if (country[i] === countryIndex) inside++;
    });
    return total === 0 || inside / total < 0.5;
  });
  // この国の州レコードを除く
  const stateCountry = new Int32Array(labels.states.length).fill(-1);
  for (let i = 0; i < n; i++) if (labels.state[i] >= 0) stateCountry[labels.state[i]] = country[i];
  const removed = new Set<number>();
  labels.states.forEach((s, k) => {
    if (stateCountry[k] === countryIndex) removed.add(s.id);
  });
  const keptStates = labels.states.filter((s) => !removed.has(s.id));
  // 生成
  const rng = rngFor(world.seed, 77, rec.id, variation);
  const cap = rec.anchors[0];
  const capCell = cap ? Math.round(cap[1]) * w + Math.round(cap[0]) : -1;
  const sub = generateStatesFor(countryIndex, Math.max(1, count), capCell, country, land, w, h, hints, rng);
  let nextId = world.nextId;
  const newId = () => nextId++;
  const culture = cultureByKey(rec.culture);
  const reg = newRegistry([...world.countries.map((c) => c.name), ...keptStates.map((s) => s.name)]);
  const newStates: StateRecord[] = sub.seeds.map((s, j) => {
    const r = rngFor(world.seed, 9, s, variation);
    return {
      id: newId(),
      name: regionName(r, culture, reg),
      seat: j === 0 ? rec.capital : cityName(r, culture, reg),
      anchors: [[s % w, Math.floor(s / w)] as Pt],
    };
  });
  const grid = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (country[i] === countryIndex && sub.label[i] >= 0) grid[i] = sub.label[i];
  const added = bordersFromLabels(grid, w, h, () => true, 'state', newId);
  const allBorders = [...borders, ...added];
  addComponentAnchors(land, allBorders, w, h, grid, newStates, 'both', 1);
  return { ...world, borders: allBorders, states: [...keptStates, ...newStates], nextId };
}

/** 指定セルを含む陸の区画（国境で区切られた成分）を、別の国に編入する */
export function reassignComponent(
  world: WorldState,
  land: Uint8Array,
  cell: number,
  targetCountryId: number,
): WorldState {
  const { width: w, height: h } = world;
  const bars = rasterizeBorders(world.borders, w, h);
  const comp = floodFill(w, h, cell, (i) => land[i] === 1 && !bars.national[i]);
  if (comp.length === 0) return world;
  const inComp = new Uint8Array(w * h);
  for (const i of comp) inComp[i] = 1;
  const inside = (p: Pt) => {
    const x = Math.round(p[0]);
    const y = Math.round(p[1]);
    return x >= 0 && y >= 0 && x < w && y < h && inComp[y * w + x] === 1;
  };
  const countries = world.countries.map((c) => {
    const anchors = c.anchors.filter((a) => !inside(a));
    if (c.id === targetCountryId) anchors.push([cell % w, Math.floor(cell / w)]);
    return { ...c, anchors };
  });
  return { ...world, countries };
}

/** 国名・州名などを作り直す（文化は保つ） */
/**
 * 国名・州名などを作り直す。命名文化は保つが、世界設定で使わないことにした文化なら
 * 使ってよい文化から選び直す（区画の呼び名もその文化に合わせる）。
 */
export function renameCountry(world: WorldState, countryId: number, variation: number, labels?: PoliticalLabels): WorldState {
  const reg = newRegistry([...world.countries.map((c) => c.name), ...world.states.map((s) => s.name)]);
  const stateIds = new Set<number>();
  if (labels) {
    const ci = labels.countries.findIndex((c) => c.id === countryId);
    const n = world.width * world.height;
    for (let i = 0; i < n; i++) if (labels.country[i] === ci && labels.state[i] >= 0) stateIds.add(labels.states[labels.state[i]].id);
  }
  let culture = cultureByKey(world.countries.find((c) => c.id === countryId)?.culture ?? 'west');
  const repick = !world.nameCultures.includes(culture.key);
  if (repick) culture = pickCulture(rngFor(world.seed, 30, countryId, variation), world.nameCultures);
  const countries = world.countries.map((c) => {
    if (c.id !== countryId) return c;
    const rng = rngFor(world.seed, 31, c.id, variation);
    const next = { ...c, culture: culture.key, name: countryName(rng, culture, reg), gov: govFor(rng, culture), capital: cityName(rng, culture, reg) };
    if (repick) next.subdivision = subdivisionFor(rng, culture);
    return next;
  });
  const states = world.states.map((s) => {
    if (!stateIds.has(s.id)) return s;
    const rng = rngFor(world.seed, 32, s.id, variation);
    return { ...s, name: regionName(rng, culture, reg), seat: cityName(rng, culture, reg) };
  });
  return { ...world, countries, states };
}

// ---------------------------------------------------------------------------
// 区画を直接塗り替える編集（境界線は区画から作り直す）

/** セル番号の配列から、境界から最も遠いセル */
function deepestCell(mask: (i: number) => boolean, w: number, h: number): number {
  const dist = distanceTransform((i) => !mask(i), w, h);
  let best = -1;
  for (let i = 0; i < w * h; i++) if (mask(i) && (best < 0 || dist[i] > dist[best])) best = i;
  return best;
}

/**
 * 国・州のラベル格子から、境界線と代表点を作り直す。
 * 境界線はセルの角を通る形にするので、読み直したときに同じ区画になる。
 * 手描きの線のうち区画を分けていなかったもの（途切れた線）はなくなる。
 */
export function retracePolitical(
  world: WorldState,
  land: Uint8Array,
  country: Int32Array,
  state: Int32Array,
  countries: CountryRecord[],
  states: StateRecord[],
): WorldState {
  const { width: w, height: h } = world;
  const n = w * h;
  let nextId = world.nextId;
  const newId = () => nextId++;
  const stateCountry = new Int32Array(states.length).fill(-1);
  for (let i = 0; i < n; i++) if (state[i] >= 0 && country[i] >= 0) stateCountry[state[i]] = country[i];
  const borders = [
    ...bordersFromLabels(country, w, h, () => true, 'national', newId, true),
    ...bordersFromLabels(state, w, h, (a, b) => stateCountry[a] === stateCountry[b], 'state', newId, true),
  ];
  const inside = (grid: Int32Array, idx: number) => ([x, y]: Pt) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < w && yi < h && grid[yi * w + xi] === idx;
  };
  // 自分の領域の外に残った代表点は外す（他の区画を奪わないように）。首都を失ったら最も内側へ
  const fixAnchors = <T extends { anchors: Pt[] }>(records: T[], grid: Int32Array): T[] =>
    records.map((r, idx) => {
      const keep = r.anchors.filter(inside(grid, idx));
      if (keep.length === 0 || !inside(grid, idx)(r.anchors[0] ?? [-1, -1])) {
        const c = deepestCell((i) => grid[i] === idx, w, h);
        if (c >= 0) keep.unshift([c % w, Math.floor(c / w)]);
      }
      return { ...r, anchors: keep };
    });
  const newCountries = fixAnchors(countries, country);
  const newStates = fixAnchors(states, state);
  addComponentAnchors(land, borders, w, h, country, newCountries, 'national', 1);
  addComponentAnchors(land, borders, w, h, state, newStates, 'both', 1);
  return { ...world, borders, countries: newCountries, states: newStates, nextId };
}

export type TerritoryTarget = { kind: 'country'; index: number } | { kind: 'state'; index: number } | { kind: 'new' };

/**
 * 塗った陸のセルを、指定した国（または州）の領土にする。
 * 国を指定したときは、塗ったセルはその国の最寄りの州に入る。
 */
export function paintTerritory(
  world: WorldState,
  land: Uint8Array,
  labels: PoliticalLabels,
  cells: Iterable<number>,
  target: TerritoryTarget,
): WorldState {
  const { width: w, height: h } = world;
  const n = w * h;
  const painted = new Uint8Array(n);
  let count = 0;
  for (const i of cells) {
    if (i >= 0 && i < n && land[i] && !painted[i]) {
      painted[i] = 1;
      count++;
    }
  }
  if (count === 0) return world;
  const country = new Int32Array(labels.country);
  const state = new Int32Array(labels.state);
  const countries = labels.countries.map((c) => ({ ...c, anchors: [...c.anchors] }));
  const states = labels.states.map((s) => ({ ...s, anchors: [...s.anchors] }));
  let nextId = world.nextId;
  let tc: number;
  let ts = -1;
  if (target.kind === 'new') {
    const c = deepestCell((i) => painted[i] === 1, w, h);
    const anchor: Pt = [c % w, Math.floor(c / w)];
    const reg = newRegistry([...countries.map((x) => x.name), ...states.map((x) => x.name)]);
    const rec = makeCountry(world.seed, nextId++, anchor, reg, world.nameCultures);
    countries.push(rec);
    tc = countries.length - 1;
    const culture = cultureByKey(rec.culture);
    const rng = rngFor(world.seed, 7, anchor[0], anchor[1]);
    states.push({ id: nextId++, name: regionName(rng, culture, reg), seat: rec.capital, anchors: [anchor] });
    ts = states.length - 1;
  } else if (target.kind === 'state') {
    ts = target.index;
    tc = -1;
    for (let i = 0; i < n; i++) if (state[i] === ts) { tc = country[i]; break; }
    if (tc < 0) return world;
  } else {
    tc = target.index;
  }
  for (let i = 0; i < n; i++) if (painted[i]) country[i] = tc;
  if (ts >= 0) {
    for (let i = 0; i < n; i++) if (painted[i]) state[i] = ts;
  } else {
    // 塗った所は、その国の州のうち最も近いものに入れる
    const near = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      if (country[i] === tc && !painted[i] && state[i] >= 0) {
        near[i] = state[i];
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j < 0 || near[j] >= 0) continue;
        near[j] = near[i];
        queue[tail++] = j;
      }
    }
    for (let i = 0; i < n; i++) {
      if (!painted[i]) continue;
      if (near[i] >= 0) state[i] = near[i];
      else {
        // その国に州が無い（全部塗り替えられた等）ときは新しい州を作る
        const culture = cultureByKey(countries[tc].culture);
        const anchor: Pt = [i % w, Math.floor(i / w)];
        const rng = rngFor(world.seed, 7, anchor[0], anchor[1]);
        const reg = newRegistry([...countries.map((x) => x.name), ...states.map((x) => x.name)]);
        states.push({ id: nextId++, name: regionName(rng, culture, reg), seat: countries[tc].capital, anchors: [anchor] });
        const s = states.length - 1;
        for (let j = 0; j < n; j++) if (painted[j] && near[j] < 0) {
          state[j] = s;
          near[j] = s;
        }
      }
    }
  }
  return retracePolitical({ ...world, nextId }, land, country, state, countries, states);
}

/** 2 つの国（または同じ国の 2 つの州）を 1 つにまとめる。absorb 側の領域が keep 側になる */
export function mergeRegions(
  world: WorldState,
  land: Uint8Array,
  labels: PoliticalLabels,
  kind: 'country' | 'state',
  keep: number,
  absorb: number,
): WorldState {
  if (keep === absorb) return world;
  const n = world.width * world.height;
  const country = new Int32Array(labels.country);
  const state = new Int32Array(labels.state);
  if (kind === 'country') {
    for (let i = 0; i < n; i++) if (country[i] === absorb) country[i] = keep;
  } else {
    for (let i = 0; i < n; i++) if (state[i] === absorb) state[i] = keep;
  }
  return retracePolitical(world, land, country, state, labels.countries.map((c) => ({ ...c })), labels.states.map((s) => ({ ...s })));
}
