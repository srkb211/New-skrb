import { describe, expect, it } from 'vitest';
import { buildTopology, ringArea, ringPoints, simplify } from '../src/core/topology';

function grid(rows: string[]): { labels: Int32Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const labels = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      labels[y * w + x] = ch === '.' ? -1 : Number(ch);
    }
  return { labels, w, h };
}

function areaOf(topo: ReturnType<typeof buildTopology>, label: number): number {
  const r = topo.regions.get(label);
  if (!r) return 0;
  let a = 0;
  for (const p of r.parts) {
    a += ringArea(ringPoints(p.outer, topo.arcs));
    for (const hole of p.holes) a += ringArea(ringPoints(hole, topo.arcs));
  }
  return a;
}

describe('buildTopology', () => {
  it('ポリゴン面積がセル数と一致する', () => {
    const g = grid([
      '..000..',
      '.00011.',
      '.001112',
      '..11222',
      '...222.',
    ]);
    const topo = buildTopology(g.labels, g.w, g.h);
    for (const label of [0, 1, 2]) {
      const cells = g.labels.filter((v) => v === label).length;
      expect(areaOf(topo, label)).toBe(cells);
    }
  });

  it('穴（内陸の湖）を持つ区画を正しく組み立てる', () => {
    const g = grid([
      '00000',
      '0...0',
      '0.1.0',
      '0...0',
      '00000',
    ]);
    const topo = buildTopology(g.labels, g.w, g.h);
    const r0 = topo.regions.get(0)!;
    expect(r0.parts.length).toBe(1);
    expect(r0.parts[0].holes.length).toBe(1);
    expect(areaOf(topo, 0)).toBe(16);
    expect(areaOf(topo, 1)).toBe(1);
  });

  it('斜めにしか接しないセルは別の環になる', () => {
    const g = grid([
      '01',
      '10',
    ]);
    const topo = buildTopology(g.labels, g.w, g.h);
    expect(topo.regions.get(0)!.parts.length).toBe(2);
    expect(topo.regions.get(1)!.parts.length).toBe(2);
    expect(areaOf(topo, 0)).toBe(2);
  });

  it('隣接する区画は同じ弧を共有する', () => {
    const g = grid([
      '0011',
      '0011',
    ]);
    const topo = buildTopology(g.labels, g.w, g.h);
    const shared = topo.arcs.filter((a) => a.left >= 0 && a.right >= 0);
    expect(shared.length).toBe(1);
    expect(new Set([shared[0].left, shared[0].right])).toEqual(new Set([0, 1]));
  });
});

describe('simplify', () => {
  it('端点を保ったまま階段状の線を間引く', () => {
    const stairs: [number, number][] = [];
    for (let k = 0; k < 20; k++) stairs.push([k, k], [k + 1, k]);
    const s = simplify(stairs, 1);
    expect(s[0]).toEqual(stairs[0]);
    expect(s[s.length - 1]).toEqual(stairs[stairs.length - 1]);
    expect(s.length).toBeLessThan(5);
  });
});
