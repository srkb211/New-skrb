import { describe, expect, it } from 'vitest';
import { contourRings, maskRings } from '../src/core/contour';
import { ringArea } from '../src/core/topology';

describe('contourRings', () => {
  it('円の等値線は閉じていて面積がおおむね一致する', () => {
    const w = 60;
    const h = 50;
    const rings = contourRings((x, y) => 15 - Math.hypot(x + 0.5 - 30, y + 0.5 - 25), w, h, 0);
    expect(rings.length).toBe(1);
    const r = rings[0];
    expect(r[0]).toEqual(r[r.length - 1]);
    expect(ringArea(r)).toBeGreaterThan(Math.PI * 225 * 0.97);
    expect(ringArea(r)).toBeLessThan(Math.PI * 225 * 1.03);
  });

  it('値が閾値ちょうどのセルが多くても連続したリングになる', () => {
    const w = 40;
    const h = 30;
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = 10 - Math.hypot(x - 20, y - 15);
        f[y * w + x] = d > 0 ? Math.round(d) : 0;
      }
    const rings = contourRings((x, y) => f[y * w + x], w, h, 0);
    for (const r of rings)
      for (let k = 1; k < r.length; k++) expect(Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1])).toBeLessThan(1.5);
  });

  it('マップ端に接する陸も閉じたリングになる', () => {
    const mask = new Uint8Array(20 * 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 8; x++) mask[y * 20 + x] = 1;
    const rings = maskRings(mask, 20, 10);
    expect(rings.length).toBe(1);
    expect(ringArea(rings[0])).toBeGreaterThan(70);
  });
});
