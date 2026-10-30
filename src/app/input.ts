import { stampPolyline, type Pt } from '../core/raster';
import { eraseFromStrokes } from '../core/strokes';
import { PAINT_LAND, PAINT_OUTLINE, PAINT_SEA, type BorderStroke, type Stroke } from '../core/world';
import { eraseOutline } from '../core/strokes';
import * as actions from './actions';
import type { Overlay } from './renderer';
import type { Store } from './store';
import type { ToolId, ToolSettings } from './tools';
import type { TerritoryTarget } from '../core/edits';
import type { View } from './view';

interface Pointer {
  x: number;
  y: number;
  type: string;
  button: number;
}

export interface InputHost {
  store: Store;
  view: View;
  canvas: HTMLCanvasElement;
  tool: () => ToolId;
  settings: () => ToolSettings;
  overlay: Overlay;
  requestDraw: () => void;
  /** ブラシ操作中の下絵ラスタを部分更新する */
  writeLive: (paint: Uint8Array, x0: number, y0: number, x1: number, y1: number) => void;
  resetLive: (paint: Uint8Array) => void;
  onError: (e: unknown) => void;
  onSelectAt: (x: number, y: number) => void;
  /** 操作の結果を短く知らせる */
  notify: (message: string) => void;
  /** 地点の指定待ち（首都の位置など）か */
  pickActive: () => boolean;
  onPick: (x: number, y: number) => void;
}

type Action =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'paint'; paint: Uint8Array; last: Pt; value: number; radius: number; points: Pt[] }
  | { kind: 'line'; points: Pt[] }
  | { kind: 'territory'; points: Pt[]; target: { target: TerritoryTarget; color: string } }
  | { kind: 'erase-strokes'; target: 'ridge' | 'border'; strokes: Stroke[]; touched: Pt[][]; last: Pt | null }
  | { kind: 'tap'; x: number; y: number; moved: boolean; pick?: boolean }
  | { kind: 'pinch'; dist: number; midX: number; midY: number };

/** ポインタ（マウス・タッチ・ペン）入力をツール操作に変換する */
export class InputController {
  private pointers = new Map<number, Pointer>();
  private action: Action = { kind: 'none' };
  private spaceDown = false;

  constructor(private host: InputHost) {
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.cancel(e));
    c.addEventListener('pointerleave', () => {
      if (this.pointers.size === 0) {
        host.overlay.cursor = undefined;
        host.requestDraw();
      }
    });
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping()) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.host.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private world(sx: number, sy: number): Pt {
    return this.host.view.toWorld(sx, sy);
  }

  private down(e: PointerEvent): void {
    const [x, y] = this.local(e);
    this.host.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x, y, type: e.pointerType, button: e.button });
    if (this.pointers.size === 2) {
      // 2 本指：描きかけを破棄してピンチ操作へ
      this.abort();
      const [a, b] = [...this.pointers.values()];
      this.action = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    if (this.host.pickActive() && e.button === 0) {
      this.action = { kind: 'tap', x, y, moved: false, pick: true };
      return;
    }
    const tool = this.host.tool();
    if (tool === 'pan' || e.button === 1 || e.button === 2 || this.spaceDown) {
      this.action = { kind: 'pan', lastX: x, lastY: y };
      return;
    }
    if (this.host.store.busy) return;
    const p = this.world(x, y);
    const st = this.host.settings();
    const { store } = this.host;
    switch (tool) {
      case 'outline':
      case 'land':
      case 'sea':
      case 'erase': {
        const paint = new Uint8Array(store.world.paint);
        const value = tool === 'outline' ? PAINT_OUTLINE : tool === 'land' ? PAINT_LAND : tool === 'sea' ? PAINT_SEA : -1;
        const radius = tool === 'outline' ? st.pen : st.brush;
        this.host.resetLive(paint);
        this.action = { kind: 'paint', paint, last: p, value, radius, points: [p] };
        this.stamp([p]);
        break;
      }
      case 'territory': {
        const target = this.resolveTerritoryTarget(p);
        if (!target) {
          this.host.notify('領土ブラシは、広げたい国（州）の陸地の中から描き始めてください');
          this.action = { kind: 'none' };
          return;
        }
        this.action = { kind: 'territory', points: [p], target };
        this.host.overlay.stroke = { points: [p], style: 'territory', color: target.color, radius: st.brush };
        break;
      }
      case 'ridge':
      case 'national':
      case 'state':
      case 'lasso':
        this.action = { kind: 'line', points: [p] };
        this.host.overlay.stroke = { points: [p], style: tool };
        break;
      case 'ridge-erase':
        this.action = { kind: 'erase-strokes', target: 'ridge', strokes: [...store.world.ridges], touched: [], last: null };
        this.eraseAt(p);
        break;
      case 'border-erase':
        this.action = { kind: 'erase-strokes', target: 'border', strokes: [...store.world.borders], touched: [], last: null };
        this.eraseAt(p);
        break;
      case 'fill':
      case 'select':
      case 'inspect':
        this.action = { kind: 'tap', x, y, moved: false };
        break;
    }
    this.host.requestDraw();
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    this.updateCursor(x, y, e.pointerType);
    if (!ptr) return;
    ptr.x = x;
    ptr.y = y;
    const a = this.action;
    switch (a.kind) {
      case 'pinch': {
        const [p, q] = [...this.pointers.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const midX = (p.x + q.x) / 2;
        const midY = (p.y + q.y) / 2;
        this.host.view.pan(midX - a.midX, midY - a.midY);
        if (a.dist > 0) this.host.view.zoomAt(midX, midY, dist / a.dist);
        a.dist = dist;
        a.midX = midX;
        a.midY = midY;
        break;
      }
      case 'pan':
        this.host.view.pan(x - a.lastX, y - a.lastY);
        a.lastX = x;
        a.lastY = y;
        break;
      case 'paint': {
        const p = this.world(x, y);
        this.stamp([a.last, p]);
        a.last = p;
        a.points.push(p);
        break;
      }
      case 'territory': {
        const p = this.world(x, y);
        a.points.push(p);
        this.host.overlay.stroke!.points = a.points;
        break;
      }
      case 'line': {
        const p = this.world(x, y);
        const last = a.points[a.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.host.view.scale >= 2) {
          a.points.push(p);
          this.host.overlay.stroke!.points = a.points;
        }
        break;
      }
      case 'erase-strokes':
        this.eraseAt(this.world(x, y));
        break;
      case 'tap':
        if (Math.hypot(x - a.x, y - a.y) > 8) {
          // 動かしたらパン操作とみなす
          this.action = { kind: 'pan', lastX: x, lastY: y };
        }
        break;
    }
    this.host.requestDraw();
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const a = this.action;
    if (a.kind === 'pinch') {
      if (this.pointers.size === 0) this.action = { kind: 'none' };
      else {
        const [p] = [...this.pointers.values()];
        this.action = { kind: 'pan', lastX: p.x, lastY: p.y };
      }
      return;
    }
    if (this.pointers.size > 0) return;
    this.action = { kind: 'none' };
    const { store } = this.host;
    const tool = this.host.tool();
    try {
      switch (a.kind) {
        case 'paint':
          actions.commitPaint(store, a.paint);
          this.host.resetLive(store.world.paint);
          this.host.overlay.livePaint = undefined;
          break;
        case 'line': {
          this.host.overlay.stroke = undefined;
          const pts = a.points;
          if (tool === 'lasso') {
            store.setSelectionPolygon(pts.length >= 3 ? pts : null);
          } else if (tool === 'ridge') {
            actions.addRidge(store, pts).catch(this.host.onError);
          } else if (tool === 'national' || tool === 'state') {
            const r = Math.max(2, 16 / this.host.view.scale);
            const msg = actions.addBorder(store, tool, pts, r, this.host.settings().snap);
            if (msg) this.host.notify(msg);
          }
          break;
        }
        case 'territory': {
          this.host.overlay.stroke = undefined;
          const { world } = store;
          const cells: number[] = [];
          stampPolyline(a.points, this.host.settings().brush, world.width, world.height, (i) => {
            if (store.land[i]) cells.push(i);
          });
          if (!actions.paintTerritoryAction(store, cells, a.target.target)) this.host.notify('塗った所に陸地がありませんでした');
          break;
        }
        case 'erase-strokes':
          this.host.overlay.ridgeOverride = undefined;
          this.host.overlay.borderOverride = undefined;
          if (a.touched.length > 0) {
            if (a.target === 'ridge') actions.setRidges(store, a.strokes, a.touched).catch(this.host.onError);
            else store.commit({ ...store.world, borders: a.strokes as BorderStroke[] });
          }
          break;
        case 'tap': {
          const [wx, wy] = this.world(a.x, a.y);
          if (a.pick) this.host.onPick(wx, wy);
          else if (tool === 'fill') actions.fillAt(store, wx, wy, this.host.settings().fillTarget, this.host.settings().gap);
          else if (tool === 'select' || tool === 'inspect') this.host.onSelectAt(wx, wy);
          break;
        }
      }
    } catch (err) {
      this.host.onError(err);
    }
    this.host.requestDraw();
  }

  private cancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.abort();
      this.action = { kind: 'none' };
    }
  }

  /** 描きかけの操作を取り消す */
  private abort(): void {
    const a = this.action;
    if (a.kind === 'paint') {
      this.host.resetLive(this.host.store.world.paint);
      this.host.overlay.livePaint = undefined;
    }
    this.host.overlay.stroke = undefined;
    this.host.overlay.ridgeOverride = undefined;
    this.host.overlay.borderOverride = undefined;
    this.action = { kind: 'none' };
    this.host.requestDraw();
  }

  /** 領土ブラシの対象（描き始めの地点か、設定で選んだ国・州） */
  private resolveTerritoryTarget(p: Pt): { target: TerritoryTarget; color: string } | null {
    const { store } = this.host;
    const pol = store.political;
    if (!pol) return null;
    const st = this.host.settings();
    const { labels } = pol;
    const t = st.territoryTarget;
    if (t === 'new') return { target: { kind: 'new' }, color: '#888888' };
    if (t.startsWith('c:') || t.startsWith('s:')) {
      const id = Number(t.slice(2));
      if (t[0] === 'c') {
        const idx = labels.countries.findIndex((c) => c.id === id);
        if (idx >= 0) return { target: { kind: 'country', index: idx }, color: labels.countries[idx].color };
      } else {
        const idx = labels.states.findIndex((s) => s.id === id);
        const ci = pol.stats.states[idx]?.country ?? -1;
        if (idx >= 0) return { target: { kind: 'state', index: idx }, color: ci >= 0 ? labels.countries[ci].color : '#888888' };
      }
      return null;
    }
    const w = store.world.width;
    const cx = Math.floor(p[0]);
    const cy = Math.floor(p[1]);
    if (cx < 0 || cy < 0 || cx >= w || cy >= store.world.height) return null;
    const cell = cy * w + cx;
    const ci = labels.country[cell];
    if (ci < 0) return null;
    if (st.territoryLevel === 'state' && labels.state[cell] >= 0) return { target: { kind: 'state', index: labels.state[cell] }, color: labels.countries[ci].color };
    return { target: { kind: 'country', index: ci }, color: labels.countries[ci].color };
  }

  private stamp(pts: Pt[]): void {
    const a = this.action;
    if (a.kind !== 'paint') return;
    const { world } = this.host.store;
    const w = world.width;
    const h = world.height;
    const paint = a.paint;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const touched: number[] = [];
    stampPolyline(pts, a.radius, w, h, (i) => {
      touched.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (a.value >= 0) paint[i] = a.value;
    });
    if (a.value < 0) eraseOutline(paint, w, h, touched);
    if (touched.length) this.host.writeLive(paint, x0, y0, x1 + 1, y1 + 1);
    this.host.overlay.livePaint = paint;
  }

  private eraseAt(p: Pt): void {
    const a = this.action;
    if (a.kind !== 'erase-strokes') return;
    const r = Math.max(1, this.host.settings().brush * 0.6);
    let id = this.host.store.world.nextId + 1000;
    // 前回の位置から今回の位置まで、半径の半分ごとに消す（速くなぞっても途切れない）
    const from = a.last ?? p;
    const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - from[0], p[1] - from[1]) / (r * 0.5)));
    let changed = false;
    for (let k = 1; k <= steps; k++) {
      const q: Pt = [from[0] + ((p[0] - from[0]) * k) / steps, from[1] + ((p[1] - from[1]) * k) / steps];
      const res = eraseFromStrokes(a.strokes, q, r, () => id++);
      if (res.changed) {
        a.strokes = res.strokes;
        a.touched.push([q]);
        changed = true;
      }
    }
    a.last = p;
    if (changed) {
      // 新しい ID の衝突を避ける
      const { world } = this.host.store;
      const maxId = Math.max(world.nextId, ...a.strokes.map((s) => s.id + 1));
      if (maxId > world.nextId) this.host.store.replace({ ...world, nextId: maxId });
    }
    if (a.target === 'ridge') this.host.overlay.ridgeOverride = a.strokes;
    else this.host.overlay.borderOverride = a.strokes as BorderStroke[];
  }

  private updateCursor(sx: number, sy: number, type: string): void {
    const tool = this.host.tool();
    const st = this.host.settings();
    const brushTools: ToolId[] = ['land', 'sea', 'erase', 'outline', 'ridge-erase', 'border-erase', 'territory'];
    if (!brushTools.includes(tool) || (type === 'touch' && this.pointers.size === 0)) {
      if (this.host.overlay.cursor) {
        this.host.overlay.cursor = undefined;
        this.host.requestDraw();
      }
      return;
    }
    const [x, y] = this.world(sx, sy);
    const r = tool === 'outline' ? st.pen : tool === 'ridge-erase' || tool === 'border-erase' ? Math.max(1, st.brush * 0.6) : st.brush;
    this.host.overlay.cursor = { x, y, r };
    this.host.requestDraw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (e.ctrlKey || e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40 || e.deltaX === 0) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      this.host.view.zoomAt(x, y, factor);
    } else {
      this.host.view.pan(-e.deltaX, -e.deltaY);
    }
    this.host.requestDraw();
  }
}

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
