import { describe, expect, it } from 'vitest';
import * as actions from '../src/app/actions';
import { featureDisplayName, featureOverride } from '../src/app/labels';
import { Store } from '../src/app/store';
import type { Feature } from '../src/core/landforms';
import { createWorld } from '../src/core/world';

function landWorld() {
  const w = createWorld(80, 60, 5);
  for (let y = 10; y < 50; y++) for (let x = 10; x < 70; x++) w.paint[y * 80 + x] = 1;
  w.borders = [{ id: 1, kind: 'national', points: [[40.2, 0], [40.2, 60]] }];
  w.nextId = 2;
  return w;
}

describe('首都・中心都市の位置', () => {
  it('国内の地点に首都を移せる。国外は拒否する', () => {
    const store = new Store(landWorld());
    const pol = store.political!;
    expect(pol.labels.countries.length).toBe(2);
    const west = pol.labels.countries[pol.labels.country[30 * 80 + 20]];
    actions.setCapitalLocation(store, west.id, 15.5, 20.5);
    const moved = store.world.countries.find((c) => c.id === west.id)!;
    expect(moved.anchors[0]).toEqual([15, 20]);
    // 領域は変わらない
    expect(store.political!.labels.country[30 * 80 + 20]).toBe(pol.labels.country[30 * 80 + 20]);
    expect(() => actions.setCapitalLocation(store, west.id, 60, 30)).toThrow();
    expect(() => actions.setCapitalLocation(store, west.id, 2, 2)).toThrow();
  });

  it('州の中心都市も州の中に移せる', () => {
    const store = new Store(landWorld());
    const pol = store.political!;
    const si = pol.labels.state[30 * 80 + 60];
    const st = pol.labels.states[si];
    actions.setSeatLocation(store, st.id, 65, 45);
    expect(store.world.states.find((s) => s.id === st.id)!.anchors[0]).toEqual([65, 45]);
    expect(() => actions.setSeatLocation(store, st.id, 20, 30)).toThrow();
  });
});

describe('地物名の手動変更', () => {
  const feature = (kind: Feature['kind'], key: number): Feature => ({ kind, key, x: 0, y: 0, angle: 0, extent: 0, size: 1, elevation: 0, length: 0, river: -1 });

  it('近くの同種の地物のうち最も近いものに名前を付け、空にすると戻る', () => {
    const store = new Store(createWorld(80, 60, 5));
    const a = feature('peak', 20 * 80 + 20);
    const b = feature('peak', 20 * 80 + 26);
    const r = feature('river', 20 * 80 + 20);
    // 地形が無い状態のため、解析結果を直接与える（commit のたびに消えるので都度設定）
    const setFeatures = (list: Feature[]) => ((store as unknown as { analysis: unknown }).analysis = { landforms: { features: list } });
    setFeatures([a, b, r]);
    const autoA = featureDisplayName(store, a);
    actions.renameFeature(store, 'peak', a.key, '白銀岳', autoA);
    setFeatures([a, b, r]);
    expect(featureDisplayName(store, a)).toBe('白銀岳');
    expect(featureOverride(store, b)).toBeUndefined();
    expect(featureOverride(store, r)).toBeUndefined();
    // 地形の再生成で代表点が少しずれても引き継ぐ
    const a2 = feature('peak', 21 * 80 + 21);
    setFeatures([a2, b]);
    expect(featureDisplayName(store, a2)).toBe('白銀岳');
    actions.renameFeature(store, 'peak', a2.key, '', autoA);
    setFeatures([a2, b]);
    expect(featureOverride(store, a2)).toBeUndefined();
  });
});
