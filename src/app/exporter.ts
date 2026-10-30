import { extractWorldFromPng } from '../core/serialize';
import { insertChunk, MAP_CHUNK } from '../core/png';
import type { Pt } from '../core/raster';
import { ringPoints, type Ring } from '../core/topology';
import type { WorldState } from '../core/world';
import { SERIF } from './palette';
import type { LayerFlags, MapRenderer } from './renderer';
import type { Store, ViewMode } from './store';

/** 書き出し画像の最大画素数（モバイルのキャンバス上限に配慮） */
const MAX_PIXELS = 14_000_000;

export function maxExportScale(world: WorldState): number {
  return Math.max(1, Math.floor(Math.sqrt(MAX_PIXELS / (world.width * world.height)) * 10) / 10);
}

export function renderMapImage(
  store: Store,
  renderer: MapRenderer,
  mode: ViewMode,
  flags: LayerFlags,
  pxPerCell: number,
  withTitle = true,
): HTMLCanvasElement {
  const { world } = store;
  const scale = Math.min(pxPerCell, maxExportScale(world));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(world.width * scale);
  canvas.height = Math.round(world.height * scale);
  const ctx = canvas.getContext('2d')!;
  const ui = Math.max(1, scale / 1.6);
  renderer.draw(ctx, { scale, ox: 0, oy: 0, width: canvas.width, height: canvas.height, ui }, mode, flags, {}, true);
  if (withTitle && world.title) {
    const size = 22 * ui;
    ctx.save();
    ctx.font = `bold ${size}px ${SERIF}`;
    const tw = ctx.measureText(world.title).width;
    ctx.fillStyle = 'rgba(255, 250, 238, 0.86)';
    ctx.strokeStyle = 'rgba(80, 60, 40, 0.8)';
    ctx.lineWidth = 1.5 * ui;
    const x = 18 * ui;
    const y = 18 * ui;
    ctx.fillRect(x, y, tw + 28 * ui, size + 20 * ui);
    ctx.strokeRect(x + 3 * ui, y + 3 * ui, tw + 22 * ui, size + 14 * ui);
    ctx.fillStyle = '#3a2a1e';
    ctx.textBaseline = 'middle';
    ctx.fillText(world.title, x + 14 * ui, y + (size + 20 * ui) / 2);
    ctx.restore();
  }
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('画像を作成できませんでした'));
      blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, 'image/png');
  });
}

/** 地図画像にデータを埋め込んだ PNG を作る */
export async function buildMapPng(store: Store, renderer: MapRenderer, mode: ViewMode, flags: LayerFlags, pxPerCell: number): Promise<Uint8Array> {
  const canvas = renderMapImage(store, renderer, mode, flags, pxPerCell);
  const [png, data] = await Promise.all([canvasToPng(canvas), store.worker.run('encode', store.world)]);
  return insertChunk(png, MAP_CHUNK, data);
}

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

/** claude.ai 上で公開したページでは、通常のダウンロードが使えないので保存の仕組みを借りる */
let downloadsApi: Promise<DownloadsApi | null> | null = null;
function claudeDownloads(): Promise<DownloadsApi | null> {
  const c = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (!c?.use) return Promise.resolve(null);
  downloadsApi ??= c.use('downloads').then((d) => (d as DownloadsApi | null) ?? null, () => null);
  return downloadsApi;
}

/**
 * ファイルを保存する。claude.ai 上なら確認画面を出して保存し、それ以外は通常のダウンロード。
 * 保存しなかった（取り消した）ときは false。
 */
export async function downloadBytes(bytes: Uint8Array, filename: string, type: string): Promise<boolean> {
  const blob = new Blob([bytes as BlobPart], { type });
  const api = await claudeDownloads();
  if (api) {
    try {
      await api.save({ filename, data: blob });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'declined') return false;
      if (code !== 'unavailable' && code !== 'not_granted' && code !== 'capability_disabled' && code !== 'capability_removed') {
        throw new Error(`保存できませんでした（${code ?? '不明なエラー'}）`);
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export function safeFilename(title: string): string {
  return (title || 'map').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

export async function readWorldFromFile(file: File): Promise<WorldState> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const world = extractWorldFromPng(bytes);
  if (!world) throw new Error('この画像には地図データが含まれていません（このアプリで書き出した PNG を選んでください）');
  return world;
}

/** サムネイル（保存一覧用） */
export function thumbnail(store: Store, renderer: MapRenderer, mode: ViewMode, flags: LayerFlags): string {
  const { world } = store;
  const scale = 220 / world.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(world.width * scale);
  canvas.height = Math.round(world.height * scale);
  const ctx = canvas.getContext('2d')!;
  renderer.draw(ctx, { scale, ox: 0, oy: 0, width: canvas.width, height: canvas.height, ui: 0.5 }, mode, { ...flags, labels: false, grid: false }, {}, true);
  return canvas.toDataURL('image/jpeg', 0.7);
}

/** 行政区画ポリゴンを GeoJSON に（座標は km、北が上になるよう y を反転） */
export function politicalGeoJSON(store: Store): object {
  const { world, political } = store;
  if (!political) return { type: 'FeatureCollection', features: [] };
  const { labels, stats } = political;
  const km = world.kmPerCell;
  const conv = (p: Pt): [number, number] => [round(p[0] * km), round((world.height - p[1]) * km)];
  const geometry = (topo: typeof stats.countryTopo, arcs: Pt[][], index: number) => {
    const reg = topo.regions.get(index);
    if (!reg) return null;
    const ring = (r: Ring) => ringPoints(r, arcs.map((points) => ({ points }))).map(conv);
    return {
      type: 'MultiPolygon',
      coordinates: reg.parts.map((p) => [ring(p.outer), ...p.holes.map(ring)]),
    };
  };
  const features: object[] = [];
  stats.countries.forEach((s, k) => {
    if (s.cells === 0) return;
    const c = labels.countries[k];
    features.push({
      type: 'Feature',
      properties: {
        level: 'country',
        id: c.id,
        name: c.name,
        fullName: c.name + c.gov,
        government: c.gov,
        capital: c.capital,
        area_km2: Math.round(s.area),
        coastline_km: Math.round(s.coast),
        neighbors: [...s.neighbors].map(([n, len]) => ({ name: labels.countries[n].name, border_km: Math.round(len) })),
        color: c.color,
      },
      geometry: geometry(stats.countryTopo, stats.countryArcs, k),
    });
  });
  stats.states.forEach((s, k) => {
    if (s.cells === 0) return;
    const st = labels.states[k];
    const c = s.country >= 0 ? labels.countries[s.country] : null;
    features.push({
      type: 'Feature',
      properties: {
        level: 'state',
        id: st.id,
        name: st.name + (c?.subdivision ?? ''),
        seat: st.seat,
        country: c?.name ?? null,
        area_km2: Math.round(s.area),
        coastline_km: Math.round(s.coast),
        neighbors: [...s.neighbors].map(([n, len]) => ({ name: labels.states[n].name, border_km: Math.round(len) })),
      },
      geometry: geometry(stats.stateTopo, stats.stateArcs, k),
    });
  });
  return { type: 'FeatureCollection', name: world.title, crs_note: '座標は地図左下を原点とする km 単位の平面座標', features };
}

const round = (v: number) => Math.round(v * 100) / 100;
