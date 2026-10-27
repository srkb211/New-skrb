import type { Feature } from '../core/landforms';
import { cultureByKey, featureName, type FeatureKind } from '../core/names';
import { rngFor } from '../core/rng';
import type { Store } from './store';

/** 地物の名前（その場所の国の命名文化で、決定的に作る） */
export function featureDisplayName(store: Store, f: Feature): string {
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
