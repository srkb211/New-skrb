import { describe, expect, it } from 'vitest';
import { eraseFromStrokes, fillPaint, snapBorderStroke } from '../src/core/strokes';
import { stampPolyline, type Pt } from '../src/core/raster';
import { PAINT_LAND, PAINT_OUTLINE } from '../src/core/world';

describe('fillPaint', () => {
  const w = 40;
  const h = 30;
  function ring(gapAt?: number) {
    const paint = new Uint8Array(w * h);
    const pts: Pt[] = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      pts.push([20 + Math.cos(a) * 10, 15 + Math.sin(a) * 10]);
    }
    stampPolyline(pts, 0.6, w, h, (i) => (paint[i] = PAINT_OUTLINE));
    if (gapAt !== undefined) for (let y = 14; y < 14 + gapAt; y++) for (let x = 28; x < 33; x++) paint[y * w + x] = 0;
    return paint;
  }

  it('閉じた輪郭の内側だけを塗る', () => {
    const paint = ring();
    const out = fillPaint(paint, w, h, 15 * w + 20, PAINT_LAND, 0)!;
    expect(out[15 * w + 20]).toBe(PAINT_LAND);
    expect(out[0]).toBe(0);
  });

  it('小さな切れ目は隙間閉じで漏れない', () => {
    const paint = ring(2);
    const leak = fillPaint(paint, w, h, 15 * w + 20, PAINT_LAND, 0)!;
    expect(leak[0]).toBe(PAINT_LAND);
    const closed = fillPaint(paint, w, h, 15 * w + 20, PAINT_LAND, 2)!;
    expect(closed[0]).toBe(0);
    expect(closed[15 * w + 28]).toBe(PAINT_LAND);
  });
});

describe('snapBorderStroke', () => {
  it('海岸の手前で止まった線を海まで延ばす', () => {
    const w = 30;
    const h = 20;
    const land = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 5; x < 25; x++) land[y * w + x] = 1;
    const out = snapBorderStroke([[10, 10], [22.5, 10]], land, [], w, h, 4);
    const last = out[out.length - 1];
    expect(land[Math.floor(last[1]) * w + Math.floor(last[0])]).toBe(0);
    const first = out[0];
    expect(land[Math.floor(first[1]) * w + Math.floor(first[0])]).toBe(0);
  });
});

describe('eraseFromStrokes', () => {
  it('線の途中を消すと 2 本に分かれる', () => {
    let id = 100;
    const { strokes, changed } = eraseFromStrokes([{ id: 1, points: [[0, 0], [20, 0]] }], [10, 0], 2, () => id++);
    expect(changed).toBe(true);
    expect(strokes.length).toBe(2);
    expect(strokes[0].id).toBe(1);
    expect(strokes[1].id).toBe(100);
  });
});
