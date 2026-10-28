import { fingerprint, sanitizeClimateParams } from '../core/climate';
import type { TerrainAnalysis } from '../core/generate';
import { computeStats, derivePolitical, type PoliticalLabels, type PoliticalStats } from '../core/political';
import { fillPolygon, type Pt } from '../core/raster';
import { randomSeed } from '../core/rng';
import { createWorld, currentLand, landFromCoast, landFromPaint, type WorldState } from '../core/world';
import { WorkerClient } from './worker-client';

export type ViewMode = 'physical' | 'political' | 'sketch';

export interface Selected {
  kind: 'country' | 'state';
  index: number;
  /** 選択したセル（島の編入などに使う） */
  cell: number;
}

export interface PoliticalDerived {
  labels: PoliticalLabels;
  stats: PoliticalStats;
}

const HISTORY_LIMIT = 60;

/** アプリの状態（ワールド・履歴・派生データ）を一元管理する */
export class Store {
  world: WorldState;
  land: Uint8Array;
  analysis: TerrainAnalysis | null = null;
  political: PoliticalDerived | null = null;
  /** 部分再生成の選択範囲 */
  selection: Uint8Array | null = null;
  selectionPath: Pt[] | null = null;
  selected: Selected | null = null;
  busy: string | null = null;
  /** 地形の解析結果が古い（再計算中） */
  analysisPending = false;
  readonly worker = new WorkerClient();

  private undoStack: WorldState[] = [];
  private redoStack: WorldState[] = [];
  private listeners = new Set<() => void>();
  private landKey: unknown = null;
  private polKey: unknown[] = [];
  private analysisKey: unknown[] = [];
  private analysisSeq = 0;
  private emitQueued = false;
  private busyCount = 0;

  constructor(world?: WorldState) {
    this.world = world ?? createWorld(720, 480, randomSeed());
    this.land = currentLand(this.world);
    this.refresh();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 変更通知（同じフレーム内の複数回の変更はまとめる） */
  emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const fn of this.listeners) fn();
    });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 新しい状態を確定し、履歴に積む */
  commit(next: WorldState): void {
    this.undoStack.push(this.world);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.world = next;
    this.refresh();
  }

  /** 履歴に積まずに置き換える（名前の入力途中など） */
  replace(next: WorldState): void {
    this.world = next;
    this.refresh();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.world);
    this.world = prev;
    this.selected = null;
    this.refresh();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.world);
    this.world = next;
    this.selected = null;
    this.refresh();
  }

  /** 別のワールドを開く（履歴はリセット） */
  load(world: WorldState): void {
    this.world = world;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.selectionPath = null;
    this.selected = null;
    this.analysis = null;
    this.landKey = null;
    this.polKey = [];
    this.analysisKey = [];
    this.refresh();
  }

  /** 派生データ（陸地・行政区画・地形解析）を必要な分だけ更新する */
  refresh(): void {
    const w = this.world;
    const landKey = w.terrain ? w.terrain.coast : w.paint;
    if (landKey !== this.landKey) {
      this.land = w.terrain ? landFromCoast(w.terrain.coast) : landFromPaint(w.paint, w.width, w.height);
      this.landKey = landKey;
    }
    const polKey = [this.land, w.borders, w.countries, w.states, w.kmPerCell];
    if (polKey.some((v, k) => v !== this.polKey[k])) {
      const labels = derivePolitical({
        land: this.land,
        w: w.width,
        h: w.height,
        borders: w.borders,
        countries: w.countries,
        states: w.states,
        seed: w.seed,
        nextId: w.nextId,
      });
      if (labels.addedCountries > 0 || labels.addedStates > 0) {
        this.world = { ...this.world, countries: labels.countries, states: labels.states, nextId: labels.nextId };
      } else {
        // 新規レコードが無ければ元の配列をそのまま使う（同一性を保つ）
        labels.countries = this.world.countries as typeof labels.countries;
        labels.states = this.world.states as typeof labels.states;
      }
      const stats = computeStats(labels, w.width, w.height, w.kmPerCell);
      this.political = { labels, stats };
      this.polKey = [this.land, this.world.borders, this.world.countries, this.world.states, this.world.kmPerCell];
      if (this.selected) {
        const list = this.selected.kind === 'country' ? labels.countries : labels.states;
        if (this.selected.index >= list.length) this.selected = null;
      }
    }
    const t = this.world.terrain;
    const aKey = [t, this.world.params.riverDensity];
    if (!t) {
      this.analysis = null;
      this.analysisKey = aKey;
      this.analysisPending = false;
    } else if (aKey.some((v, k) => v !== this.analysisKey[k])) {
      this.analysisKey = aKey;
      const seq = ++this.analysisSeq;
      this.analysisPending = true;
      const { width, height, params } = this.world;
      this.worker
        .run('analyze', { terrain: t, w: width, h: height, params })
        .then((res) => {
          if (seq !== this.analysisSeq) return;
          this.analysis = res;
          this.analysisPending = false;
          this.emit();
        })
        .catch((e) => {
          console.error(e);
          this.analysisPending = false;
          this.emit();
        });
    }
    this.emit();
  }

  /** 時間のかかる処理の間、画面に「処理中」を出す */
  async withBusy<T>(message: string, fn: () => Promise<T>): Promise<T> {
    this.busyCount++;
    this.busy = message;
    this.emit();
    try {
      return await fn();
    } finally {
      this.busyCount--;
      if (this.busyCount === 0) this.busy = null;
      this.emit();
    }
  }

  setSelectionPolygon(points: Pt[] | null): void {
    if (!points || points.length < 3) {
      this.selection = null;
      this.selectionPath = null;
    } else {
      const { width: w, height: h } = this.world;
      const mask = new Uint8Array(w * h);
      let count = 0;
      fillPolygon(points, w, h, (i) => {
        if (!mask[i]) count++;
        mask[i] = 1;
      });
      this.selection = count > 0 ? mask : null;
      this.selectionPath = count > 0 ? points : null;
    }
    this.emit();
  }

  select(sel: Selected | null): void {
    this.selected = sel;
    this.emit();
  }

  private fpCache: { src: unknown; fp: string } | null = null;

  /** 気候データが今の地形・設定から計算されたものかどうか */
  climateStatus(): { state: 'none' | 'ok' | 'stale'; reasons: string[] } {
    const w = this.world;
    const c = w.climate;
    if (!c) return { state: 'none', reasons: [] };
    const reasons: string[] = [];
    const src = w.terrain?.elevation ?? this.land;
    if (!this.fpCache || this.fpCache.src !== src) this.fpCache = { src, fp: fingerprint(w.terrain?.elevation ?? this.land) };
    if (this.fpCache.fp !== c.meta.sourceHash) reasons.push('地形が変わりました');
    if (stable(sanitizeClimateParams(w.climateParams).params) !== stable(c.meta.params)) reasons.push('気候パラメータが変わりました');
    if (stable(w.geoFrame) !== stable(c.meta.frame)) reasons.push('世界設定（緯度相当）が変わりました');
    if (Math.abs(c.meta.cellKm - w.kmPerCell * c.meta.gridFactor) > 1e-6) reasons.push('縮尺が変わりました');
    if (c.meta.width !== Math.ceil(w.width / c.meta.gridFactor) || c.meta.height !== Math.ceil(w.height / c.meta.gridFactor)) reasons.push('グリッドの大きさが合いません');
    return { state: reasons.length ? 'stale' : 'ok', reasons };
  }

  nextIds(count: number): number[] {
    const ids: number[] = [];
    for (let k = 0; k < count; k++) ids.push(this.world.nextId + k);
    return ids;
  }
}

/** キーの順序に依存しない JSON 文字列（設定の比較用） */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}
