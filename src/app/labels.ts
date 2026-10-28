import type { Feature } from '../core/landforms';
import { cultureByKey, featureName, type FeatureKind } from '../core/names';
import { rngFor } from '../core/rng';
import type { FeatureNameOverride } from '../core/world';
import type { Store } from './store';

/** 手動の名前を、近くにある同種の地物のうち最も近いものに対応させる距離（セル） */
const OVERRIDE_RADIUS = 14;

let resolved: { features: unknown; names: unknown; map: Map<Feature, FeatureNameOverride> } | null = null;

/** 地物ごとの手動の名前（無ければ undefined） */
export function featureOverride(store: Store, f: Feature): FeatureNameOverride | undefined {
  const features = store.analysis?.landforms.features ?? [];
  const names = store.world.featureNames;
  if (!resolved || resolved.features !== features || resolved.names !== names) {
    const map = new Map<Feature, FeatureNameOverride>();
    const w = store.world.width;
    for (const o of names) {
      let best: Feature | null = null;
      let bestD = OVERRIDE_RADIUS * OVERRIDE_RADIUS;
      for (const g of features) {
        if (g.kind !== o.kind) continue;
        const d = ((g.key % w) - o.x) ** 2 + (Math.floor(g.key / w) - o.y) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = g;
        }
      }
      if (best) map.set(best, o);
    }
    resolved = { features, names, map };
  }
  return resolved.map.get(f);
}

/** 自動で付く名前（その場所の国の命名文化で、決定的に作る） */
export function featureAutoName(store: Store, f: Feature): string {
  const { world, political } = store;
  let culture = cultureByKey(['west', 'north', 'east', 'wa'][world.seed % 4]);
  if (political) {
    const c = political.labels.country[f.key];
    const rec = c >= 0 ? political.labels.countries[c] : null;
    if (rec) culture = cultureByKey(rec.culture);
  }
  const rng = rngFor(world.seed, 555, f.key, kindCode(f.kind));
  return featureName(rng, culture, f.kind);
}

export function featureDisplayName(store: Store, f: Feature): string {
  return featureOverride(store, f)?.name ?? featureAutoName(store, f);
}

function kindCode(k: FeatureKind): number {
  return ['range', 'massif', 'peak', 'river', 'plain', 'basin', 'plateau', 'lake'].indexOf(k);
}

export interface PlacedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 単純な衝突判定つきのラベル配置器（優先度の高い順に置く） */
export class LabelPlacer {
  private boxes: PlacedBox[] = [];

  tryPlace(cx: number, cy: number, width: number, height: number, angle: number, pad = 2): boolean {
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    const hw = (width * c + height * s) / 2 + pad;
    const hh = (width * s + height * c) / 2 + pad;
    const box = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
    for (const b of this.boxes) {
      if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) return false;
    }
    this.boxes.push(box);
    return true;
  }

  reserve(box: PlacedBox): void {
    this.boxes.push(box);
  }
}
