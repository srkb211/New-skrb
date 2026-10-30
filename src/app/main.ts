import './styles.css';
import { decodeWorld } from '../core/serialize';
import { createWorld } from '../core/world';
import { randomSeed } from '../core/rng';
import { InputController } from './input';
import { DEFAULT_LAYERS, MapRenderer, type Overlay } from './renderer';
import { AUTOSAVE_ID, loadMap } from './storage';
import { Store, type ViewMode } from './store';
import { DEFAULT_TOOL_SETTINGS, TOOLS, type ToolId } from './tools';
import { AppUI } from './ui';
import { View } from './view';

async function boot(): Promise<void> {
  let initial = createWorld(720, 480, randomSeed());
  let restored = false;
  try {
    const saved = await loadMap(AUTOSAVE_ID);
    if (saved) {
      initial = decodeWorld(saved.data);
      restored = true;
    }
  } catch (e) {
    console.warn('autosave not available', e);
  }

  const store = new Store(initial);
  const renderer = new MapRenderer(store);
  const view = new View();
  const flags = { ...DEFAULT_LAYERS };
  const settings = { ...DEFAULT_TOOL_SETTINGS };
  const overlay: Overlay = {};
  let inspect: { x: number; y: number } | null = null;
  let tool: ToolId = restored ? 'pan' : 'outline';
  let mode: ViewMode = initial.terrain ? 'physical' : 'sketch';
  if (restored && initial.borders.length > 0) mode = 'political';

  let drawQueued = false;
  const requestDraw = () => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  };

  const ui = new AppUI(
    {
      store,
      renderer,
      getTool: () => tool,
      setTool: (t) => {
        tool = t;
        const group = TOOLS.find((d) => d.id === t)?.group;
        if (group === 'political' && mode === 'sketch') setMode('political');
        if ((group === 'terrain' || group === 'climate') && mode === 'sketch' && (store.world.terrain || store.world.climate)) setMode('physical');
        if (t === 'inspect') {
          if (flags.climate === 'none' && store.world.climate) flags.climate = 'biome';
          ui.showTab('climate', false);
        }
        requestDraw();
      },
      settings,
      getMode: () => mode,
      setMode: (m) => setMode(m),
      flags,
      requestDraw,
      fit,
      zoom: (f) => {
        const r = canvasRect();
        view.zoomAt(r.width / 2, r.height / 2, f);
        requestDraw();
      },
      focusOn: (x, y, radius) => {
        const r = canvasRect();
        const s = Math.min(r.width, r.height) / (radius * 2.6);
        view.scale = Math.max(view.minScale, Math.min(view.maxScale, s));
        view.ox = r.width / 2 - x * view.scale;
        view.oy = r.height / 2 - y * view.scale;
        requestDraw();
      },
      getInspect: () => inspect,
    },
    document.getElementById('app')!,
  );
  const canvas = ui.canvas;
  const ctx = canvas.getContext('2d')!;

  function setMode(m: ViewMode): void {
    mode = m;
    ui.refreshMode();
    requestDraw();
  }

  function canvasRect(): DOMRect {
    return ui.mapWrap.getBoundingClientRect();
  }

  function fit(): void {
    const r = canvasRect();
    view.fit(store.world.width, store.world.height, r.width, r.height, 12);
    requestDraw();
  }

  function draw(): void {
    drawQueued = false;
    const dpr = window.devicePixelRatio || 1;
    const r = canvasRect();
    const W = Math.max(1, Math.round(r.width * dpr));
    const H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const group = TOOLS.find((d) => d.id === tool)?.group;
    overlay.showRidges = tool === 'ridge' || tool === 'ridge-erase';
    overlay.showBorderStrokes = tool === 'national' || tool === 'state' || tool === 'border-erase';
    const f = { ...flags, sketch: flags.sketch || (group === 'sketch' && mode !== 'sketch' && (!store.world.terrain || store.world.terrainStale || !!overlay.livePaint)) };
    try {
      renderer.draw(ctx, { scale: view.scale * dpr, ox: view.ox * dpr, oy: view.oy * dpr, width: W, height: H, ui: dpr }, mode, f, overlay);
    } catch (e) {
      console.error(e);
    }
  }

  new InputController({
    store,
    view,
    canvas,
    tool: () => tool,
    settings: () => settings,
    overlay,
    requestDraw,
    writeLive: (paint, x0, y0, x1, y1) => {
      const c = renderer.layers.sketchCanvas(paint);
      renderer.layers.writeSketch(c, paint, x0, y0, x1, y1);
    },
    resetLive: (paint) => {
      renderer.layers.invalidate('sketch');
      if (paint !== store.world.paint) renderer.layers.sketchCanvas(paint);
    },
    onError: (e) => ui.error(e),
    notify: (m) => ui.toast(m),
    pickActive: () => ui.pendingPick !== null,
    onPick: (x, y) => ui.completePick(x, y),
    onSelectAt: (x, y) => {
      if (tool === 'inspect') {
        const inside = x >= 0 && y >= 0 && x < store.world.width && y < store.world.height;
        inspect = inside ? { x, y } : null;
        overlay.inspect = inspect ?? undefined;
        ui.showTab('climate', true);
        requestDraw();
        return;
      }
      const pol = store.political;
      const w = store.world.width;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (!pol || cx < 0 || cy < 0 || cx >= w || cy >= store.world.height) return store.select(null);
      const cell = cy * w + cx;
      const ci = pol.labels.country[cell];
      if (ci < 0) return store.select(null);
      const cur = store.selected;
      // 同じ国をもう一度タップしたら州を選ぶ
      if (cur && cur.kind === 'country' && cur.index === ci && pol.labels.state[cell] >= 0) {
        ui.selectRegion('state', pol.labels.state[cell], cell);
      } else {
        ui.selectRegion('country', ci, cell);
      }
    },
  });

  new ResizeObserver(() => requestDraw()).observe(ui.mapWrap);
  store.subscribe(requestDraw);
  ui.refreshMode();
  ui.refreshTools();
  requestAnimationFrame(() => {
    fit();
    if (restored) ui.toast(`前回の地図「${store.world.title}」を復元しました`);
  });
}

boot();
