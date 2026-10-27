import { mapScale } from '../core/coast';
import { regenerateCountryStates, reassignComponent, renameCountry } from '../core/edits';
import { stampPolyline, type Pt } from '../core/raster';
import { randomSeed } from '../core/rng';
import { sampleSketch } from '../core/sample';
import { cleanStroke, fillPaint, snapBorderStroke } from '../core/strokes';
import { createWorld, landFromCoast, PAINT_LAND, PAINT_SEA, type BorderKind, type CountryRecord, type GenParams, type StateRecord, type Stroke, type WorldState } from '../core/world';
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
  const terrain = await store.withBusy('地形を生成しています…', () =>
    store.worker.run('generate', {
      paint: world.paint,
      w: world.width,
      h: world.height,
      seed: world.seed,
      params: world.params,
      ridges: world.ridges,
    }),
  );
  store.commit({ ...store.world, terrain, terrainStale: false });
}

/** 選択範囲を作り直す */
export async function regenerateSelection(store: Store, mode: 'all' | 'elevation', newPattern: boolean): Promise<void> {
  const { world, selection } = store;
  if (!world.terrain) throw new Error('先に地形を生成してください。');
  if (!selection) throw new Error('範囲選択ツールで再生成する範囲を囲んでください。');
  const terrain = await store.withBusy('選択範囲を再生成しています…', () =>
    store.worker.run('partial', {
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
    }),
  );
  store.commit({ ...store.world, terrain });
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
  const terrain = await store.withBusy('山脈を反映しています…', () =>
    store.worker.run('partial', {
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
    }),
  );
  store.commit({ ...store.world, ridges, terrain });
}

export function addRidge(store: Store, raw: Pt[]): Promise<void> {
  const pts = cleanStroke(raw, 0.5, 0.6);
  if (pts.length < 2) return Promise.resolve();
  const { world } = store;
  const ridge: Stroke = { id: world.nextId, points: pts };
  store.replace({ ...world, nextId: world.nextId + 1 });
  return setRidges(store, [...store.world.ridges, ridge], [pts]);
}

export function addBorder(store: Store, kind: BorderKind, raw: Pt[], snapRadius: number, snap: boolean): void {
  const { world, land } = store;
  let pts = cleanStroke(raw, 0.4, 0.45);
  if (pts.length < 2) return;
  if (snap) pts = snapBorderStroke(pts, land, world.borders, world.width, world.height, snapRadius);
  store.commit({ ...world, borders: [...world.borders, { id: world.nextId, kind, points: pts }], nextId: world.nextId + 1 });
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
      opts: { countries, statesPerCountry, seed },
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

export function renameAll(store: Store): void {
  let world = store.world;
  const v = randomSeed();
  for (const c of world.countries) world = renameCountry(world, c.id, v + c.id, store.political?.labels);
  store.commit(world);
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
