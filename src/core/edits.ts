import { addComponentAnchors, bordersFromLabels, generateStatesFor, type TerrainHints } from './autogen';
import { cityName, countryName, cultureByKey, govFor, newRegistry, regionName } from './names';
import { rasterizeBorders, type PoliticalLabels } from './political';
import { floodFill, rasterizePolyline, type Pt } from './raster';
import { rngFor } from './rng';
import type { StateRecord, WorldState } from './world';

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
export function renameCountry(world: WorldState, countryId: number, variation: number, labels?: PoliticalLabels): WorldState {
  const reg = newRegistry([...world.countries.map((c) => c.name), ...world.states.map((s) => s.name)]);
  const stateIds = new Set<number>();
  if (labels) {
    const ci = labels.countries.findIndex((c) => c.id === countryId);
    const n = world.width * world.height;
    for (let i = 0; i < n; i++) if (labels.country[i] === ci && labels.state[i] >= 0) stateIds.add(labels.states[labels.state[i]].id);
  }
  const countries = world.countries.map((c) => {
    if (c.id !== countryId) return c;
    const rng = rngFor(world.seed, 31, c.id, variation);
    const culture = cultureByKey(c.culture);
    return { ...c, name: countryName(rng, culture, reg), gov: govFor(rng, culture), capital: cityName(rng, culture, reg) };
  });
  const culture = cultureByKey(world.countries.find((c) => c.id === countryId)?.culture ?? 'west');
  const states = world.states.map((s) => {
    if (!stateIds.has(s.id)) return s;
    const rng = rngFor(world.seed, 32, s.id, variation);
    return { ...s, name: regionName(rng, culture, reg), seat: cityName(rng, culture, reg) };
  });
  return { ...world, countries, states };
}
