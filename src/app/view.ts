/** 画面座標（CSS px）とワールド座標（セル）の変換。scale はセルあたりの CSS px。 */
export class View {
  scale = 1;
  ox = 0;
  oy = 0;
  minScale = 0.2;
  maxScale = 40;

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (sy - this.oy) / this.scale];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [wx * this.scale + this.ox, wy * this.scale + this.oy];
  }

  fit(worldW: number, worldH: number, screenW: number, screenH: number, margin = 16): void {
    const s = Math.min((screenW - margin * 2) / worldW, (screenH - margin * 2) / worldH);
    this.scale = Math.max(this.minScale, s);
    this.minScale = Math.min(0.5, this.scale * 0.5);
    this.ox = (screenW - worldW * this.scale) / 2;
    this.oy = (screenH - worldH * this.scale) / 2;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const ns = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    const f = ns / this.scale;
    this.ox = sx - (sx - this.ox) * f;
    this.oy = sy - (sy - this.oy) * f;
    this.scale = ns;
  }

  pan(dx: number, dy: number): void {
    this.ox += dx;
    this.oy += dy;
  }
}
