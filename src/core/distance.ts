/**
 * Felzenszwalb & Huttenlocher のユークリッド距離変換。
 * feature[i] が真のセルからの距離（セル単位）を返す。特徴セルが無い場合は大きな値。
 */
export function distanceTransform(
  feature: (i: number) => boolean,
  w: number,
  h: number,
): Float32Array {
  const INF = 1e20;
  const n = w * h;
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) grid[i] = feature(i) ? 0 : INF;
  const size = Math.max(w, h);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);

  const edt1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  const out = new Float32Array(n);
  const cap = (w + h) * 2;
  for (let i = 0; i < n; i++) out[i] = grid[i] >= INF / 2 ? cap : Math.sqrt(grid[i]);
  return out;
}

/** 陸を正、海を負とする符号付き距離（境界は ±0.5）。 */
export function signedDistance(land: Uint8Array, w: number, h: number): Float32Array {
  const toSea = distanceTransform((i) => land[i] === 0, w, h);
  const toLand = distanceTransform((i) => land[i] !== 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = land[i] ? toSea[i] - 0.5 : -(toLand[i] - 0.5);
  }
  return out;
}
