import { mapScale } from '../core/coast';
import type { ClimateData, ClimateParams } from '../core/climate';
import type { GeoFrame } from '../core/geoframe';
import type { FeatureKind } from '../core/names';
import { mergeRegions, paintTerritory, regenerateCountryStates, reassignComponent, renameCountry, type TerritoryTarget } from '../core/edits';
import { stampPolyline, type Pt } from '../core/raster';
import { randomSeed } from '../core/rng';
import { sampleSketch } from '../core/sample';
import { cleanStroke, fillPaint, openStrokeEnds, snapBorderStroke } from '../core/strokes';
import { createWorld, landFromCoast, landFromPaint, PAINT_LAND, PAINT_SEA, type BorderKind, type CountryRecord, type GenParams, type StateRecord, type Stroke, type TerrainLayers, type WorldState } from '../core/world';
import type { Store } from './store';

export function newWorld(store: Store, w: number, h: number, template: 'blank' | 'sample'): void {
  const world = createWorld(w, h, randomSeed());
  if (template === 'sample') world.paint = sampleSketch(w, h, world.seed);
  store.load(world);
}

export function commitPaint(store: Store, paint: Uint8Array): void {
  const { world } = store;
  store.commit({ ...world, paint, terrainStale: world.terrain !== null });
}

export function fillAt(store: Store, x: number, y: number, target: 'land' | 'sea', gap: number): boolean {
  const { world } = store;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return false;
  const out = fillPaint(world.paint, world.width, world.height, cy * world.width + cx, target === 'land' ? PAINT_LAND : PAINT_SEA, gap);
  if (!out) return false;
  commitPaint(store, out);
  return true;
}

/** 下絵から地形全体を生成 */
export async function generateAll(store: Store): Promise<void> {
  const { world } = store;
  let any = false;
  for (let i = 0; i < world.paint.length; i++) if (world.paint[i]) { any = true; break; }
  if (!any) throw new Error('下絵に陸地がありません。輪郭を描いて陸を塗ってください。');
  const { terrain, climate } = await store.withBusy('地形と気候を生成しています…', async () => {
    const terrain = await store.worker.run('generate', {
      paint: world.paint,
      w: world.width,
      h: world.height,
      seed: world.seed,
      params: world.params,
      ridges: world.ridges,
    });
    return { terrain, climate: await climateFor(store, world, terrain) };
  });
  store.commit({ ...store.world, terrain, climate, terrainStale: false });
}

/** 地形（または下絵）から気候を計算する */
function climateFor(store: Store, world: WorldState, terrain: TerrainLayers | null): Promise<ClimateData> {
  const land = terrain ? landFromCoast(terrain.coast) : landFromPaint(world.paint, world.width, world.height);
  return store.worker.run('climate', {
    w: world.width,
    h: world.height,
    kmPerCell: world.kmPerCell,
    land,
    elevation: terrain?.elevation ?? null,
    frame: world.geoFrame,
    params: world.climateParams,
  });
}

/** 現在の設定で気候を（再）計算する */
export async function computeClimateAction(store: Store): Promise<void> {
  const { world } = store;
  let any = false;
  for (let i = 0; i < store.land.length; i++) if (store.land[i]) { any = true; break; }
  if (!any) throw new Error('陸地がありません。下絵を描くか地形を生成してください。');
  const climate = await store.withBusy('気候を計算しています…', () => climateFor(store, world, world.terrain));
  store.commit({ ...store.world, climate });
}

export function setGeoFrame(store: Store, patch: Partial<GeoFrame>): void {
  store.commit({ ...store.world, geoFrame: { ...store.world.geoFrame, ...patch } });
}

export function setClimateParams(store: Store, patch: Partial<ClimateParams>): void {
  const p = store.world.climateParams;
  store.commit({
    ...store.world,
    climateParams: { ...p, ...patch, koppen: { ...p.koppen, ...(patch.koppen ?? {}) }, biome: { ...p.biome, ...(patch.biome ?? {}) } },
  });
}

/** 選択範囲を作り直す */
export async function regenerateSelection(store: Store, mode: 'all' | 'elevation', newPattern: boolean): Promise<void> {
  const { world, selection } = store;
  if (!world.terrain) throw new Error('先に地形を生成してください。');
  if (!selection) throw new Error('範囲選択ツールで再生成する範囲を囲んでください。');
  const { terrain, climate } = await store.withBusy('選択範囲を再生成しています…', async () => {
    const terrain = await store.worker.run('partial', {
      paint: world.paint,
      w: world.width,
      h: world.height,
      seed: world.seed,
      params: world.params,
      ridges: world.ridges,
      old: world.terrain!,
      selection,
      mode,
      variationSeed: newPattern ? randomSeed() : world.seed,
    });
    return { terrain, climate: await climateFor(store, world, terrain) };
  });
  store.commit({ ...store.world, terrain, climate });
}

/** 山脈ガイドの追加・削除。地形があればその周辺の標高だけ作り直す。 */
export async function setRidges(store: Store, ridges: Stroke[], touched: Pt[][]): Promise<void> {
  const { world } = store;
  if (!world.terrain || touched.length === 0) {
    store.commit({ ...world, ridges });
    return;
  }
  const w = world.width;
  const h = world.height;
  const selection = new Uint8Array(w * h);
  const r = 26 * mapScale(w, h);
  for (const pts of touched) stampPolyline(pts, r, w, h, (i) => (selection[i] = 1));
  const { terrain, climate } = await store.withBusy('山脈を反映しています…', async () => {
    const terrain = await store.worker.run('partial', {
      paint: world.paint,
      w,
      h,
      seed: world.seed,
      params: world.params,
      ridges,
      old: world.terrain!,
      selection,
      mode: 'elevation',
      variationSeed: world.seed,
    });
    return { terrain, climate: await climateFor(store, world, terrain) };
  });
  store.commit({ ...store.world, ridges, terrain, climate });
}

export function addRidge(store: Store, raw: Pt[]): Promise<void> {
  const pts = cleanStroke(raw, 0.5, 0.6);
  if (pts.length < 2) return Promise.resolve();
  const { world } = store;
  const ridge: Stroke = { id: world.nextId, points: pts };
  store.replace({ ...world, nextId: world.nextId + 1 });
  return setRidges(store, [...store.world.ridges, ridge], [pts]);
}

/** 区画の数（領域のあるものだけ） */
function liveRegions(store: Store): { countries: number; states: number } {
  const st = store.political?.stats;
  return {
    countries: st ? st.countries.filter((s) => s.cells > 0).length : 0,
    states: st ? st.states.filter((s) => s.cells > 0).length : 0,
  };
}

/**
 * 境界線を追加する。区画が変わらなかったとき（線の端が海岸や他の線に届いていないなど）は
 * 利用者に知らせる文を返す。
 */
export function addBorder(store: Store, kind: BorderKind, raw: Pt[], snapRadius: number, snap: boolean): string | null {
  const { world, land } = store;
  let pts = cleanStroke(raw, 0.4, 0.45);
  if (pts.length < 2) return null;
  if (snap) pts = snapBorderStroke(pts, land, world.borders, world.width, world.height, snapRadius);
  const before = liveRegions(store);
  const id = world.nextId;
  store.commit({ ...world, borders: [...world.borders, { id, kind, points: pts }], nextId: world.nextId + 1 });
  const after = liveRegions(store);
  const changed = kind === 'national' ? after.countries !== before.countries : after.states !== before.states;
  if (changed) return null;
  const open = openStrokeEnds(store.world.borders, store.land, world.width, world.height).filter((e) => e.strokeId === id);
  if (open.length > 0) {
    return `線の端（赤い丸）が海岸や他の${kind === 'national' ? '国境' : '境界線'}に届いていないため、区画は分かれていません。端を海や線の上まで伸ばしてください。`;
  }
  return null;
}

export async function autoPolitical(store: Store, countries: number, statesPerCountry: number): Promise<void> {
  const { world, land, analysis } = store;
  let any = false;
  for (let i = 0; i < land.length; i++) if (land[i]) { any = true; break; }
  if (!any) throw new Error('陸地がありません。');
  const seed = randomSeed();
  const res = await store.withBusy('架空の国を生成しています…', () =>
    store.worker.run('autoPolitical', {
      land,
      w: world.width,
      h: world.height,
      hints: {
        elevation: world.terrain?.elevation ?? null,
        acc: analysis?.hydrology.acc ?? null,
        riverThreshold: analysis?.hydrology.riverThreshold ?? 0,
      },
      opts: { countries, statesPerCountry, seed, cultures: world.nameCultures },
      startId: world.nextId,
    }),
  );
  store.select(null);
  store.commit({ ...store.world, borders: res.borders, countries: res.countries, states: res.states, nextId: res.nextId });
}

export function clearPolitical(store: Store): void {
  store.select(null);
  store.commit({ ...store.world, borders: [], countries: [], states: [] });
}

export function regenerateStates(store: Store, countryIndex: number, count: number): void {
  const { world, land, political, analysis } = store;
  if (!political) return;
  const next = regenerateCountryStates(
    world,
    land,
    political.labels,
    countryIndex,
    count,
    {
      elevation: world.terrain?.elevation ?? null,
      acc: analysis?.hydrology.acc ?? null,
      riverThreshold: analysis?.hydrology.riverThreshold ?? 0,
    },
    randomSeed(),
  );
  store.commit(next);
}

export function updateCountry(store: Store, id: number, patch: Partial<CountryRecord>, history = true): void {
  const { world } = store;
  const next = { ...world, countries: world.countries.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
  if (history) store.commit(next);
  else store.replace(next);
}

export function updateState(store: Store, id: number, patch: Partial<StateRecord>, history = true): void {
  const { world } = store;
  const next = { ...world, states: world.states.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  if (history) store.commit(next);
  else store.replace(next);
}

export function renameCountryAction(store: Store, id: number): void {
  store.commit(renameCountry(store.world, id, randomSeed(), store.political?.labels));
}

/** 自動の命名に使う文化を設定する（空にはしない） */
export function setNameCultures(store: Store, cultures: string[]): void {
  if (cultures.length === 0) throw new Error('少なくとも 1 つの命名文化を選んでください');
  store.commit({ ...store.world, nameCultures: cultures });
}

export function renameAll(store: Store): void {
  let world = store.world;
  const v = randomSeed();
  for (const c of world.countries) world = renameCountry(world, c.id, v + c.id, store.political?.labels);
  store.commit(world);
}

/** 領土ブラシ：塗った陸のセルを対象の国（州）の領土にする */
export function paintTerritoryAction(store: Store, cells: number[], target: TerritoryTarget): boolean {
  const { world, land, political } = store;
  if (!political) return false;
  const next = paintTerritory(world, land, political.labels, cells, target);
  if (next === world) return false;
  store.commit(next);
  return true;
}

/** 国（または同じ国の州）を統合する。absorb の領域が keep に加わる */
export function mergeAction(store: Store, kind: 'country' | 'state', keep: number, absorb: number): void {
  const { world, land, political } = store;
  if (!political) return;
  store.commit(mergeRegions(world, land, political.labels, kind, keep, absorb));
}

export function moveComponentTo(store: Store, cell: number, countryId: number): void {
  store.commit(reassignComponent(store.world, store.land, cell, countryId));
}

export function setParams(store: Store, patch: Partial<GenParams>): void {
  store.commit({ ...store.world, params: { ...store.world.params, ...patch } });
}

export function setWorldFields(store: Store, patch: Partial<Pick<WorldState, 'title' | 'kmPerCell' | 'seed'>>): void {
  store.commit({ ...store.world, ...patch });
}

/** 生成済みの地形の海岸線を下絵に書き戻す（生成結果を下絵として編集し直したいとき） */
export function terrainToSketch(store: Store): void {
  const { world } = store;
  if (!world.terrain) return;
  const land = landFromCoast(world.terrain.coast);
  store.commit({ ...world, paint: land, terrainStale: false });
}

/** 地物の名前を手動で設定する（空文字または自動名と同じなら手動設定を解除） */
export function renameFeature(store: Store, kind: FeatureKind, keyCell: number, name: string, autoName: string): void {
  const { world } = store;
  const x = keyCell % world.width;
  const y = Math.floor(keyCell / world.width);
  const rest = world.featureNames.filter((o) => !(o.kind === kind && (o.x - x) ** 2 + (o.y - y) ** 2 <= 4));
  const trimmed = name.trim();
  const featureNames = trimmed && trimmed !== autoName ? [...rest, { kind, x, y, name: trimmed }] : rest;
  store.commit({ ...world, featureNames });
}

/** 首都の位置を変える（その国の陸地の中に限る） */
export function setCapitalLocation(store: Store, countryId: number, x: number, y: number): void {
  const { world, political } = store;
  const cell = Math.floor(y) * world.width + Math.floor(x);
  const ci = world.countries.findIndex((c) => c.id === countryId);
  if (!political || ci < 0 || political.labels.country[cell] !== ci) throw new Error('首都はその国の陸地の中に置いてください');
  const pt: Pt = [Math.floor(x), Math.floor(y)];
  const countries = world.countries.map((c) =>
    c.id === countryId ? { ...c, anchors: [pt, ...c.anchors.filter((a) => a[0] !== pt[0] || a[1] !== pt[1])] } : c,
  );
  store.commit({ ...world, countries });
}

/** 州都（中心都市）の位置を変える（その州の中に限る） */
export function setSeatLocation(store: Store, stateId: number, x: number, y: number): void {
  const { world, political } = store;
  const cell = Math.floor(y) * world.width + Math.floor(x);
  const si = world.states.findIndex((s) => s.id === stateId);
  if (!political || si < 0 || political.labels.state[cell] !== si) throw new Error('中心都市はその区画の中に置いてください');
  const pt: Pt = [Math.floor(x), Math.floor(y)];
  const states = world.states.map((s) =>
    s.id === stateId ? { ...s, anchors: [pt, ...s.anchors.filter((a) => a[0] !== pt[0] || a[1] !== pt[1])] } : s,
  );
  store.commit({ ...world, states });
}
