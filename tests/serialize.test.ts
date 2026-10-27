import { describe, expect, it } from 'vitest';
import { decodeWorld, embedWorldInPng, encodeWorld, extractWorldFromPng } from '../src/core/serialize';
import { crc32, encodePng, readChunks } from '../src/core/png';
import { createWorld } from '../src/core/world';

function sampleWorld() {
  const w = createWorld(64, 48, 99);
  for (let i = 0; i < w.paint.length; i += 3) w.paint[i] = 1;
  const coast = new Float32Array(64 * 48).map((_, i) => Math.sin(i) * 20);
  coast[0] = 0.001;
  coast[1] = -0.001;
  coast[2] = 0;
  const elevation = new Float32Array(64 * 48).map((_, i) => Math.round(((i % 97) * 37.013 - 1500.5) * 100) / 100);
  w.terrain = { coast, elevation };
  w.borders = [{ id: 3, kind: 'national', points: [[1.234, 2.345], [10.5, 20.25]] }];
  w.countries = [{ id: 4, name: 'テスト王国', gov: '王国', color: '#abcdef', culture: 'west', subdivision: '州', capital: '都', anchors: [[5, 6]] }];
  w.title = '試験の世界';
  return w;
}

describe('serialize', () => {
  it('エンコードとデコードで内容が保たれる', () => {
    const w = sampleWorld();
    const back = decodeWorld(encodeWorld(w));
    expect(back.title).toBe('試験の世界');
    expect(back.width).toBe(64);
    expect(Array.from(back.paint)).toEqual(Array.from(w.paint));
    expect(back.countries[0].name).toBe('テスト王国');
    expect(back.borders[0].points[0]).toEqual([1.23, 2.35]);
    for (let i = 0; i < w.paint.length; i++) {
      expect(Math.abs(back.terrain!.coast[i] - w.terrain!.coast[i])).toBeLessThan(0.011);
      expect(back.terrain!.elevation[i]).toBe(w.terrain!.elevation[i]);
      expect(back.terrain!.coast[i] > 0).toBe(w.terrain!.coast[i] > 0);
    }
  });

  it('PNG に埋め込んで取り出せ、PNG として妥当なまま', () => {
    const w = sampleWorld();
    const rgba = new Uint8Array(8 * 8 * 4).fill(200);
    const png = encodePng(rgba, 8, 8);
    const withData = embedWorldInPng(png, w);
    const chunks = readChunks(withData);
    expect(chunks[0].type).toBe('IHDR');
    expect(chunks[chunks.length - 1].type).toBe('IEND');
    for (const c of chunks) {
      const crcStored = new DataView(withData.buffer, withData.byteOffset).getUint32(c.offset + 8 + c.data.length);
      expect(crc32(withData, c.offset + 4, c.offset + 8 + c.data.length)).toBe(crcStored);
    }
    const back = extractWorldFromPng(withData)!;
    expect(back.countries[0].anchors[0]).toEqual([5, 6]);
    // 再埋め込みしてもチャンクは 1 つ
    const again = embedWorldInPng(withData, w);
    expect(readChunks(again).filter((c) => c.type === 'fmAp').length).toBe(1);
    expect(extractWorldFromPng(png)).toBeNull();
  });
});
