import {
  BIOMES,
  CLIMATE_ASSUMPTIONS,
  CLIMATE_UNITS,
  DEFAULT_BIOME,
  DEFAULT_KOPPEN,
  KOPPEN_CODES,
  KOPPEN_INFO,
  climateCellAt,
  climateCellInfo,
  climateCsv,
  sanitizeClimateParams,
  validateClimate,
  type BiomeThresholds,
  type ClimateCellInfo,
  type KoppenThresholds,
  type ValidationIssue,
} from '../core/climate';
import { formatLatitude, latitudeRange } from '../core/geoframe';
import { CULTURES, FEATURE_LABEL, cultureByKey } from '../core/names';
import { decodeWorld } from '../core/serialize';
import { randomSeed } from '../core/rng';
import type { Feature } from '../core/landforms';
import * as actions from './actions';
import { fmtArea, fmtKm, h, sliderRow } from './dom';
import { buildMapPng, downloadBytes, maxExportScale, politicalGeoJSON, readWorldFromFile, safeFilename, thumbnail } from './exporter';
import { CLIMATE_LAYERS, type ClimateLayer } from './climate-style';
import { icon } from './icons';
import { featureAutoName, featureDisplayName, featureOverride } from './labels';
import type { LayerFlags, MapRenderer } from './renderer';
import { AUTOSAVE_ID, deleteMap, listMaps, loadMap, newMapId, saveMap } from './storage';
import type { Store, ViewMode } from './store';
import { GROUP_LABEL, TOOLS, type ToolId, type ToolSettings } from './tools';

export interface UiHost {
  store: Store;
  renderer: MapRenderer;
  getTool: () => ToolId;
  setTool: (t: ToolId) => void;
  settings: ToolSettings;
  getMode: () => ViewMode;
  setMode: (m: ViewMode) => void;
  flags: LayerFlags;
  requestDraw: () => void;
  fit: () => void;
  zoom: (f: number) => void;
  focusOn: (x: number, y: number, radiusCells: number) => void;
  /** 地点情報ツールで調べている地点（地形セル座標） */
  getInspect: () => { x: number; y: number } | null;
}

type Tab = 'tool' | 'generate' | 'data' | 'features' | 'climate';
type BoolFlag = { [K in keyof LayerFlags]: LayerFlags[K] extends boolean ? K : never }[keyof LayerFlags];

/** 地図上の地点指定（首都・州都の位置）を待っている状態 */
export interface PendingPick {
  kind: 'capital' | 'seat';
  id: number;
  label: string;
}

/** 画面の DOM 部分（上部バー・ツールバー・パネル・ダイアログ） */
export class AppUI {
  readonly root: HTMLElement;
  readonly mapWrap: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private toolbar: HTMLElement;
  private panel: HTMLElement;
  private panelBody: HTMLElement;
  private tabsEl: HTMLElement;
  private hintEl: HTMLElement;
  private busyEl: HTMLElement;
  private staleEl: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private titleInput!: HTMLInputElement;
  private modeSeg!: HTMLElement;
  private toastEl: HTMLElement;
  private tab: Tab = 'tool';
  private currentMapId: string | null = null;
  private panelDirty = true;
  private autosaveTimer = 0;
  private hintTimer = 0;
  private lastWorld: unknown = null;
  private autoCountries = 8;
  private autoStates = 4;
  private exportScale = 2;
  private exportMode: ViewMode = 'physical';
  private partialMode: 'all' | 'elevation' = 'all';
  /** 地点指定の待ち（首都の位置など） */
  pendingPick: PendingPick | null = null;
  private partialNew = true;

  constructor(private host: UiHost, mount: HTMLElement) {
    this.root = mount;
    this.canvas = h('canvas', { 'aria-label': '地図キャンバス' });
    this.hintEl = h('div', { class: 'hint' });
    this.busyEl = h('div', { class: 'busy', hidden: true }, h('div', { class: 'busy-card' }, h('div', { class: 'spinner' }), h('span', {})));
    this.staleEl = h('div', { class: 'stale-banner', hidden: true });
    const hud = h(
      'div',
      { class: 'hud' },
      h('button', { title: '拡大', html: icon('plus'), onclick: () => host.zoom(1.4) }),
      h('button', { title: '縮小', html: icon('minus'), onclick: () => host.zoom(1 / 1.4) }),
      h('button', { title: '全体を表示', html: icon('fit'), onclick: () => host.fit() }),
    );
    this.mapWrap = h('div', { class: 'map-wrap' }, this.canvas, this.hintEl, this.staleEl, hud, this.busyEl);
    this.toolbar = h('nav', { class: 'toolbar', 'aria-label': 'ツール' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.panelBody = h('div', { class: 'panel-body' });
    this.panel = h('aside', { class: 'panel' }, this.tabsEl, this.panelBody);
    this.toastEl = h('div', { class: 'toast' });
    mount.append(this.buildTopbar(), this.toolbar, this.mapWrap, this.panel, this.toastEl);
    this.buildToolbar();
    this.buildTabs();
    host.store.subscribe(() => this.onStoreChange());
    this.panelBody.addEventListener('focusout', () => {
      if (this.panelDirty) setTimeout(() => this.renderPanel(), 0);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.onStoreChange();
  }

  // ---------------------------------------------------------------- 上部バー
  private buildTopbar(): HTMLElement {
    const { store } = this.host;
    this.titleInput = h('input', {
      class: 'title-input',
      type: 'text',
      value: store.world.title,
      title: '地図のタイトル',
      onchange: () => actions.setWorldFields(store, { title: this.titleInput.value.trim() || '無題の世界' }),
    });
    this.undoBtn = h('button', { class: 'tb-btn', title: '元に戻す (Ctrl+Z)', html: icon('undo'), onclick: () => store.undo() });
    this.redoBtn = h('button', { class: 'tb-btn', title: 'やり直す (Ctrl+Shift+Z)', html: icon('redo'), onclick: () => store.redo() });
    this.modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '表示モード' });
    const modes: [ViewMode, string][] = [
      ['physical', '地形'],
      ['political', '政治'],
      ['sketch', '下絵'],
    ];
    for (const [m, label] of modes) {
      this.modeSeg.append(h('button', { 'data-mode': m, onclick: () => this.host.setMode(m) }, label));
    }
    const tbBtn = (name: string, label: string, onclick: () => void, title = label) =>
      h('button', { class: 'tb-btn', title, onclick }, h('span', { html: icon(name) }), h('span', { class: 'tb-label' }, label));
    return h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, '架空地図アトラス', h('small', {}, 'Fantasy Atlas')),
      this.titleInput,
      tbBtn('new', '新規', () => this.newDialog()),
      tbBtn('open', '開く', () => this.openDialog()),
      tbBtn('save', '保存', () => this.saveToBrowser(false), 'ブラウザに保存'),
      tbBtn('image', '画像DL', () => this.exportDialog(), '画像としてダウンロード（データ埋め込み）'),
      this.undoBtn,
      this.redoBtn,
      h('div', { class: 'spacer' }),
      this.modeSeg,
      h('button', {
        class: 'tb-btn panel-toggle',
        title: 'パネル',
        html: icon('panel'),
        onclick: () => this.panel.classList.toggle('open'),
      }),
    );
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    let group = '';
    for (const t of TOOLS) {
      if (t.group !== group) {
        group = t.group;
        this.toolbar.append(h('div', { class: 'tool-group-label' }, GROUP_LABEL[t.group]));
      }
      this.toolbar.append(
        h(
          'button',
          {
            class: 'tool' + (this.host.getTool() === t.id ? ' on' : ''),
            'data-tool': t.id,
            title: t.hint,
            onclick: () => {
              this.host.setTool(t.id);
              this.refreshTools();
            },
          },
          h('span', { html: icon(t.id, 22) }),
          t.label,
        ),
      );
    }
  }

  refreshTools(): void {
    const tool = this.host.getTool();
    this.toolbar.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    const def = TOOLS.find((t) => t.id === tool);
    this.hintEl.textContent = def?.hint ?? '';
    this.hintEl.hidden = !def;
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hintEl.hidden = true), 6000);
    if (this.tab === 'tool') this.renderPanel();
  }

  refreshMode(): void {
    const mode = this.host.getMode();
    this.modeSeg.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  }

  private buildTabs(): void {
    const tabs: [Tab, string][] = [
      ['tool', 'ツール'],
      ['generate', '生成'],
      ['data', 'データ'],
      ['features', '地物'],
      ['climate', '気候'],
    ];
    this.tabsEl.innerHTML = '';
    for (const [t, label] of tabs) {
      this.tabsEl.append(h('button', { 'data-tab': t, class: this.tab === t ? 'on' : '', onclick: () => this.showTab(t) }, label));
    }
    this.tabsEl.append(
      h('button', { class: 'panel-close', title: '閉じる', html: icon('close', 18), onclick: () => this.panel.classList.remove('open') }),
    );
  }

  showTab(t: Tab, openPanel = false): void {
    this.tab = t;
    this.tabsEl.querySelectorAll<HTMLElement>('button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (openPanel) this.panel.classList.add('open');
    this.renderPanel();
  }

  // ---------------------------------------------------------------- 更新
  private onStoreChange(): void {
    const { store } = this.host;
    this.undoBtn.disabled = !store.canUndo;
    this.redoBtn.disabled = !store.canRedo;
    if (document.activeElement !== this.titleInput) this.titleInput.value = store.world.title;
    const busy = store.busy;
    this.busyEl.hidden = !busy;
    (this.busyEl.querySelector('span') as HTMLElement).textContent = busy ?? '';
    this.updateStaleBanner();
    this.panelDirty = true;
    const active = document.activeElement;
    if (!(active && this.panelBody.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA'))) {
      this.renderPanel();
    }
    this.host.requestDraw();
    if (store.world !== this.lastWorld) {
      this.lastWorld = store.world;
      this.scheduleAutosave();
    }
  }

  private updateStaleBanner(): void {
    const { store } = this.host;
    const w = store.world;
    this.staleEl.innerHTML = '';
    if (store.busy) {
      this.staleEl.hidden = true;
      return;
    }
    if (!w.terrain) {
      let any = false;
      for (let i = 0; i < w.paint.length; i += 7) if (w.paint[i] === 1) { any = true; break; }
      if (any) {
        this.staleEl.append(
          h('span', {}, '下絵ができたら地形を生成しましょう'),
          h('button', { onclick: () => this.generateTerrain() }, '地形を生成'),
        );
        this.staleEl.hidden = false;
        return;
      }
    } else if (w.terrainStale) {
      this.staleEl.append(
        h('span', {}, '下絵が変更されています'),
        h('button', { onclick: () => this.generateTerrain() }, '全体を再生成'),
        h('button', { onclick: () => { this.host.setTool('lasso'); this.refreshTools(); this.showTab('generate', true); } }, '一部だけ'),
      );
      this.staleEl.hidden = false;
      return;
    }
    this.staleEl.hidden = true;
  }

  private renderPanel(): void {
    this.panelDirty = false;
    const scrollTop = this.panelBody.scrollTop;
    this.panelBody.innerHTML = '';
    switch (this.tab) {
      case 'tool':
        this.panelBody.append(...this.renderToolTab());
        break;
      case 'generate':
        this.panelBody.append(...this.renderGenerateTab());
        break;
      case 'data':
        this.panelBody.append(...this.renderDataTab());
        break;
      case 'features':
        this.panelBody.append(...this.renderFeaturesTab());
        break;
      case 'climate':
        this.panelBody.append(...this.renderClimateTab());
        break;
    }
    this.panelBody.scrollTop = scrollTop;
  }

  // ---------------------------------------------------------------- ツールタブ
  private renderToolTab(): HTMLElement[] {
    const { settings, flags } = this.host;
    const tool = this.host.getTool();
    const out: HTMLElement[] = [];
    const def = TOOLS.find((t) => t.id === tool)!;
    const opts = h('div', { class: 'section' }, h('h3', {}, def.label, h('small', {}, GROUP_LABEL[def.group])), h('p', { class: 'note' }, def.hint));
    if (tool === 'outline') {
      opts.append(sliderRow('線の太さ', settings.pen, 0.5, 4, 0.1, (v) => v.toFixed(1), (v) => (settings.pen = v)));
    }
    if (tool === 'land' || tool === 'sea' || tool === 'erase' || tool === 'ridge-erase' || tool === 'border-erase' || tool === 'territory') {
      opts.append(sliderRow('ブラシの大きさ', settings.brush, 1, 40, 0.5, (v) => v.toFixed(1), (v) => (settings.brush = v)));
    }
    if (tool === 'fill') {
      const sel = h('div', { class: 'btn-row' });
      for (const [v, label] of [['land', '陸で塗る'], ['sea', '海で塗る']] as const) {
        sel.append(h('button', { class: 'btn' + (settings.fillTarget === v ? ' primary' : ''), onclick: () => { settings.fillTarget = v; this.renderPanel(); } }, label));
      }
      opts.append(sel, sliderRow('隙間閉じ', settings.gap, 0, 6, 1, (v) => `${v} セル`, (v) => (settings.gap = v)));
      opts.append(h('p', { class: 'note' }, '輪郭線が少し途切れていても、隙間閉じの幅までは塞いでから塗ります。'));
    }
    if (tool === 'territory') opts.append(...this.territoryOptions());
    if (tool === 'national' || tool === 'state') {
      opts.append(
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settings.snap, onchange: (e: Event) => (settings.snap = (e.target as HTMLInputElement).checked) }), '端点を海岸・他の境界線へ自動でつなぐ'),
        h('p', { class: 'note' }, '国境で囲まれた陸地が自動で「国」に、州境で区切られた範囲が「州」になります。線の両端は海か他の境界線まで届かせてください（届いていない端は赤い丸で表示されます）。'),
        h('p', { class: 'note' }, '思った形にならないときは「領土ブラシ」で国の領土を直接塗り直すと確実です。'),
      );
    }
    if (tool === 'lasso') {
      opts.append(h('p', { class: 'note' }, '囲んだあと「生成」タブの「選択範囲を再生成」を押します。'));
      if (this.host.store.selection) opts.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => this.showTab('generate') }, '再生成の設定へ'), h('button', { class: 'btn', onclick: () => this.host.store.setSelectionPolygon(null) }, '選択解除')));
    }
    if (tool === 'ridge' && !this.host.store.world.terrain) {
      opts.append(h('p', { class: 'note' }, '地形を生成すると、描いた線に沿って山脈ができます。'));
    }
    out.push(opts);

    const layer = (key: BoolFlag, label: string) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: flags[key], onchange: (e: Event) => { flags[key] = (e.target as HTMLInputElement).checked; this.host.requestDraw(); } }), label);
    out.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, '表示'),
        h('div', { class: 'grid2' },
          layer('relief', '陰影（起伏）'),
          layer('rivers', '河川'),
          layer('contours', '等高線'),
          layer('borders', '国境・州境'),
          layer('labels', '地名ラベル'),
          layer('features', '地物名'),
          layer('stateFill', '州ごとに塗る'),
          layer('grid', '方眼'),
          layer('sketch', '下絵を重ねる'),
          layer('latitude', '緯度相当線'),
          layer('wind', '卓越風'),
        ),
        this.climateLayerSelect(),
      ),
    );
    out.push(this.guideSection());
    return out;
  }

  private guideSection(): HTMLElement {
    return h(
      'div',
      { class: 'section guide' },
      h('h3', {}, '使い方'),
      h(
        'ol',
        {},
        h('li', {}, '「輪郭ペン」で陸地の形を描き、「塗りつぶし」で内側を陸にする（陸ブラシで直接塗っても OK）'),
        h('li', {}, '「地形を生成」で海岸線が複雑になり、山地・河川・平野ができる'),
        h('li', {}, '「国境ペン」「州境ペン」で境界を描く、または「生成」タブで架空の国を自動生成'),
        h('li', {}, '気に入らない所は「範囲選択」で囲んで部分再生成'),
        h('li', {}, '「画像DL」で PNG として保存。その PNG を「開く」で読み込むと編集を続けられます'),
      ),
      h('p', { class: 'note' }, '操作：2 本指／ホイールで拡大縮小、移動ツール・右ドラッグ・スペース＋ドラッグで移動、', h('span', { class: 'kbd' }, 'Ctrl+Z'), ' で元に戻す。'),
    );
  }

  // ---------------------------------------------------------------- 生成タブ
  private renderGenerateTab(): HTMLElement[] {
    const { store } = this.host;
    const w = store.world;
    const p = w.params;
    const out: HTMLElement[] = [];

    const seedInput = h('input', { type: 'number', value: String(w.seed), onchange: () => actions.setWorldFields(store, { seed: Math.abs(Math.floor(Number(seedInput.value))) || 1 }) });
    const terrain = h(
      'div',
      { class: 'section' },
      h('h3', {}, '地形の生成', h('small', {}, w.terrain ? (w.terrainStale ? '下絵が変更されています' : '生成済み') : '未生成')),
      h('div', { class: 'row' }, h('label', {}, 'シード'), seedInput, h('button', { class: 'btn small', title: 'ランダム', html: icon('dice', 16), onclick: () => actions.setWorldFields(store, { seed: randomSeed() }) })),
      sliderRow('海岸線の複雑さ', p.roughness, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => actions.setParams(store, { roughness: v })),
      sliderRow('山地の多さ', p.mountains, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => actions.setParams(store, { mountains: v })),
      sliderRow('最高標高の目安', p.maxElevation, 800, 8000, 100, (v) => `${v}m`, (v) => actions.setParams(store, { maxElevation: v })),
      sliderRow('侵食（谷の深さ）', p.erosion, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => actions.setParams(store, { erosion: v })),
      sliderRow('河川の密度', p.riverDensity, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => actions.setParams(store, { riverDensity: v })),
      h('button', { class: 'btn primary block', onclick: () => this.generateTerrain() }, w.terrain ? '地形を全体再生成' : '地形を生成'),
      h('p', { class: 'note' }, '河川の密度以外の設定は、次の生成から反映されます。同じシード・同じ下絵なら同じ地形になります。'),
    );
    if (w.terrain) {
      terrain.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => actions.terrainToSketch(store) }, '生成結果の海岸線を下絵に取り込む')));
    }
    out.push(terrain);

    const sel = store.selection;
    const partial = h('div', { class: 'section' }, h('h3', {}, '部分再生成', h('small', {}, sel ? '範囲選択中' : '')));
    if (!w.terrain) partial.append(h('p', { class: 'note' }, '地形を生成すると使えます。'));
    else {
      partial.append(
        h('p', { class: 'note' }, '「範囲選択」ツールで囲んだ範囲だけを作り直し、周囲と滑らかにつなぎます。下絵を描き直した所の反映にも使えます。'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pmode', checked: this.partialMode === 'all', onchange: () => (this.partialMode = 'all') }), '海岸線と地形'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pmode', checked: this.partialMode === 'elevation', onchange: () => (this.partialMode = 'elevation') }), '地形のみ（海岸線はそのまま）'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.partialNew, onchange: (e: Event) => (this.partialNew = (e.target as HTMLInputElement).checked) }), '別のパターンにする（シードを変える）'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', disabled: !sel, onclick: () => this.run(() => actions.regenerateSelection(store, this.partialMode, this.partialNew)) }, '選択範囲を再生成'),
          sel ? h('button', { class: 'btn', onclick: () => store.setSelectionPolygon(null) }, '選択解除') : h('button', { class: 'btn', onclick: () => { this.host.setTool('lasso'); this.refreshTools(); } }, '範囲を選ぶ'),
        ),
      );
    }
    out.push(partial);

    const pol = store.political;
    const liveCountries = pol ? pol.stats.countries.filter((s) => s.cells > 0).length : 0;
    out.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, '架空の国の自動生成'),
        sliderRow('国の数', this.autoCountries, 1, 30, 1, (v) => `${v}`, (v) => (this.autoCountries = v)),
        sliderRow('1国あたりの州', this.autoStates, 1, 12, 1, (v) => `${v}`, (v) => (this.autoStates = v)),
        h('button', {
          class: 'btn primary block',
          onclick: () => {
            if (w.borders.length > 0 && !confirm('今ある国境・州境と国名はすべて置き換えられます。よろしいですか？（元に戻すこともできます）')) return;
            this.run(async () => {
              await actions.autoPolitical(store, this.autoCountries, this.autoStates);
              this.host.setMode('political');
            });
          },
        }, '国と州を自動生成'),
        h('p', { class: 'note' }, '山脈・大河・急斜面を越えにくいように領域を広げるので、地形に沿った国境になります。' + (w.terrain ? '' : '（地形を生成してからの方が自然になります）')),
        this.cultureChooser(),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', disabled: liveCountries === 0, onclick: () => actions.renameAll(store) }, '国名・州名をすべて作り直す'),
          h('button', { class: 'btn small danger', disabled: w.borders.length === 0 && w.countries.length === 0, onclick: () => confirm('国境・州境と国のデータを消去しますか？') && actions.clearPolitical(store) }, '政治データを消去'),
        ),
      ),
    );

    const kmInput = h('input', { type: 'number', min: '0.1', step: '0.1', value: String(w.kmPerCell), onchange: () => {
      const v = Number(kmInput.value);
      if (v > 0) actions.setWorldFields(store, { kmPerCell: v });
    } });
    const titleInput = h('input', { type: 'text', value: w.title, onchange: () => actions.setWorldFields(store, { title: titleInput.value.trim() || '無題の世界' }) });
    out.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, '地図の設定'),
        h('div', { class: 'row' }, h('label', {}, 'タイトル'), titleInput),
        h('div', { class: 'row' }, h('label', {}, '縮尺 (km/セル)'), kmInput),
        h('p', { class: 'note' }, `グリッド ${w.width}×${w.height} セル ＝ ${fmtKm(w.width * w.kmPerCell)} × ${fmtKm(w.height * w.kmPerCell)}`),
        h('p', { class: 'note' }, '緯度相当・北相当の向き・地軸の傾きなどの世界設定は「気候」タブにあります（地図の Y 座標は緯度とはみなしません）。'),
      ),
    );
    return out;
  }

  // ---------------------------------------------------------------- データタブ
  private renderDataTab(): HTMLElement[] {
    const { store } = this.host;
    const pol = store.political;
    const out: HTMLElement[] = [];
    const w = store.world;
    if (!pol) return [h('p', { class: 'note' }, 'データがありません。')];
    const { labels, stats } = pol;
    if (store.selected) out.push(this.inspector());

    let landCells = 0;
    for (let i = 0; i < store.land.length; i++) landCells += store.land[i];
    const live = stats.countries.filter((s) => s.cells > 0);
    const liveStates = stats.states.filter((s) => s.cells > 0);
    const lf = store.analysis?.landforms;
    const topPeak = lf?.features.filter((f) => f.kind === 'peak').sort((a, b) => b.elevation - a.elevation)[0];
    const longest = lf?.features.filter((f) => f.kind === 'river').sort((a, b) => b.length - a.length)[0];
    out.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, '概要'),
        h('dl', { class: 'stats' },
          h('dt', {}, '陸地面積'), h('dd', {}, fmtArea(landCells * w.kmPerCell ** 2)),
          h('dt', {}, '国の数'), h('dd', {}, String(live.length)),
          h('dt', {}, '州（行政区画）の数'), h('dd', {}, String(liveStates.length)),
          topPeak ? [h('dt', {}, '最高峰'), h('dd', {}, `${featureDisplayName(store, topPeak)} ${Math.round(topPeak.elevation).toLocaleString()}m`)] : null,
          longest ? [h('dt', {}, '最長の川'), h('dd', {}, `${featureDisplayName(store, longest)} ${fmtKm(longest.length * w.kmPerCell)}`)] : null,
        ),
      ),
    );

    const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, '国'), h('th', {}, '面積'), h('th', {}, '州'), h('th', {}, '隣国'))));
    const tbody = h('tbody', {});
    const stateCount = new Map<number, number>();
    for (const s of liveStates) stateCount.set(s.country, (stateCount.get(s.country) ?? 0) + 1);
    for (const s of [...live].sort((a, b) => b.area - a.area)) {
      const c = labels.countries[s.index];
      const selected = store.selected?.kind === 'country' && store.selected.index === s.index;
      tbody.append(
        h('tr', { class: 'click' + (selected ? ' sel' : ''), onclick: () => this.selectRegion('country', s.index) },
          h('td', {}, h('span', { class: 'swatch', style: `background:${c.color}` }), c.name + c.gov),
          h('td', { class: 'num' }, `${fmtArea(s.area)}`, h('br', {}), h('span', { class: 'muted' }, `${((s.cells / Math.max(1, landCells)) * 100).toFixed(1)}%`)),
          h('td', { class: 'num' }, String(stateCount.get(s.index) ?? 0)),
          h('td', {}, [...s.neighbors.keys()].map((k) => labels.countries[k].name).join('、') || h('span', { class: 'muted' }, 'なし')),
        ),
      );
    }
    table.append(tbody);
    out.push(h('div', { class: 'section' }, h('h3', {}, '国の一覧', h('small', {}, 'タップで選択')), live.length ? table : h('p', { class: 'note' }, '国境ペンで陸地を区切るか、「生成」タブで自動生成してください。')));

    out.push(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, 'データの書き出し'),
        h('p', { class: 'note' }, '行政区画ポリゴン（国・州）を、面積・隣接関係・境界の長さ付きの GeoJSON で書き出します。'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => {
            const json = JSON.stringify(politicalGeoJSON(store), null, 1);
            downloadBytes(new TextEncoder().encode(json), `${safeFilename(w.title)}.geojson`, 'application/geo+json');
          } }, 'GeoJSON を書き出す'),
        ),
      ),
    );
    return out;
  }

  private inspector(): HTMLElement {
    const { store } = this.host;
    const sel = store.selected!;
    const { labels, stats } = store.political!;
    if (sel.kind === 'country') {
      const s = stats.countries[sel.index];
      const c = labels.countries[sel.index];
      if (!s || !c) return h('div', {});
      const culture = cultureByKey(c.culture);
      const nameIn = h('input', { type: 'text', value: c.name, onchange: () => actions.updateCountry(store, c.id, { name: nameIn.value.trim() || c.name }) });
      const govIn = h('input', { type: 'text', value: c.gov, onchange: () => actions.updateCountry(store, c.id, { gov: govIn.value.trim() }) });
      const capIn = h('input', { type: 'text', value: c.capital, onchange: () => actions.updateCountry(store, c.id, { capital: capIn.value.trim() || c.capital }) });
      const subIn = h('input', { type: 'text', value: c.subdivision, onchange: () => actions.updateCountry(store, c.id, { subdivision: subIn.value.trim() }) });
      const colorIn = h('input', { type: 'color', value: c.color, onchange: () => actions.updateCountry(store, c.id, { color: colorIn.value }) });
      const cultureSel = h('select', { onchange: () => actions.updateCountry(store, c.id, { culture: cultureSel.value }) },
        h('optgroup', { label: '西洋系' }, CULTURES.filter((cu) => cu.western).map((cu) => h('option', { value: cu.key, selected: cu.key === culture.key }, cu.label))),
        h('optgroup', { label: '西洋以外' }, CULTURES.filter((cu) => !cu.western).map((cu) => h('option', { value: cu.key, selected: cu.key === culture.key }, cu.label))));
      const myStates = stats.states.filter((st) => st.country === sel.index && st.cells > 0).sort((a, b) => b.area - a.area);
      const stateCountIn = h('input', { type: 'number', min: '1', max: '30', value: String(Math.max(1, myStates.length)), style: 'width:64px;flex:none' });
      // 選択セルを含む成分（島など）を別の国へ
      const others = labels.countries.map((cc, k) => ({ cc, k })).filter(({ k }) => k !== sel.index && stats.countries[k]?.cells > 0);
      const moveSel = h('select', {}, h('option', { value: '' }, '編入先を選ぶ…'), others.map(({ cc }) => h('option', { value: String(cc.id) }, cc.name + cc.gov)));
      return h(
        'div',
        { class: 'card' },
        h('h4', {}, h('span', { class: 'swatch', style: `background:${c.color}` }), c.name + c.gov, h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: '選択解除', html: icon('close', 16), onclick: () => store.select(null) })),
        h('div', { class: 'row' }, h('label', {}, '国名'), nameIn),
        h('div', { class: 'row' }, h('label', {}, '政体'), govIn),
        h('div', { class: 'row' }, h('label', {}, '首都'), capIn),
        h('div', { class: 'row' }, h('label', {}, '首都の位置'), this.pickButton({ kind: 'capital', id: c.id, label: `${c.name}の首都にする地点` })),
        h('div', { class: 'row' }, h('label', {}, '区画の呼び名'), subIn),
        h('div', { class: 'row' }, h('label', {}, '命名文化'), cultureSel),
        h('div', { class: 'row' }, h('label', {}, '色'), colorIn),
        h('dl', { class: 'stats' },
          h('dt', {}, '面積'), h('dd', {}, fmtArea(s.area)),
          h('dt', {}, '海岸線'), h('dd', {}, fmtKm(s.coast)),
          h('dt', {}, '州の数'), h('dd', {}, String(myStates.length)),
        ),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, '隣国（共有する国境の長さ）'),
        h('div', { class: 'chips' }, [...s.neighbors].sort((a, b) => b[1] - a[1]).map(([k, len]) => h('span', { class: 'chip', onclick: () => this.selectRegion('country', k) }, `${labels.countries[k].name} ${fmtKm(len)}`))),
        s.neighbors.size === 0 ? h('div', { class: 'note' }, '陸で接する国はありません') : null,
        h('div', { class: 'muted', style: 'font-size:12px;margin:8px 0 4px' }, `${c.subdivision || '州'}の一覧`),
        h('div', { class: 'chips' }, myStates.map((st) => h('span', { class: 'chip', onclick: () => this.selectRegion('state', st.index) }, `${labels.states[st.index].name} ${fmtArea(st.area)}`))),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => actions.renameCountryAction(store, c.id) }, '名前を作り直す'),
        ),
        h('div', { class: 'row' }, h('label', {}, '州を自動生成'), stateCountIn, h('button', { class: 'btn small', onclick: () => {
          const k = Math.max(1, Math.min(30, Math.floor(Number(stateCountIn.value)) || 1));
          actions.regenerateStates(store, sel.index, k);
        } }, '実行')),
        others.length ? h('div', { class: 'row' }, h('label', {}, 'タップした島/地域'), moveSel, h('button', { class: 'btn small', onclick: () => {
          if (!moveSel.value) return;
          actions.moveComponentTo(store, sel.cell, Number(moveSel.value));
          store.select(null);
        } }, '編入')) : null,
        s.neighbors.size ? this.mergeRow('country', sel.index, [...s.neighbors.keys()].map((k) => ({ index: k, label: labels.countries[k].name + labels.countries[k].gov }))) : null,
        h('p', { class: 'note' }, `命名文化：${culture.label}。国境で囲まれた範囲（タップした所を含む島や地域）を別の国に編入できます。国境の形は「領土ブラシ」で塗り直せます。`),
      );
    }
    const s = stats.states[sel.index];
    const st = labels.states[sel.index];
    if (!s || !st) return h('div', {});
    const country = s.country >= 0 ? labels.countries[s.country] : null;
    const nameIn = h('input', { type: 'text', value: st.name, onchange: () => actions.updateState(store, st.id, { name: nameIn.value.trim() || st.name }) });
    const seatIn = h('input', { type: 'text', value: st.seat, onchange: () => actions.updateState(store, st.id, { seat: seatIn.value.trim() || st.seat }) });
    return h(
      'div',
      { class: 'card' },
      h('h4', {}, st.name + (country?.subdivision ?? ''), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: '選択解除', html: icon('close', 16), onclick: () => store.select(null) })),
      country ? h('div', { class: 'note' }, '所属：', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.selectRegion('country', s.country); } }, country.name + country.gov)) : null,
      h('div', { class: 'row' }, h('label', {}, '名前'), nameIn),
      h('div', { class: 'row' }, h('label', {}, '中心都市'), seatIn),
      h('div', { class: 'row' }, h('label', {}, '中心都市の位置'), this.pickButton({ kind: 'seat', id: st.id, label: `${st.name}の中心都市にする地点` })),
      h('dl', { class: 'stats' },
        h('dt', {}, '面積'), h('dd', {}, fmtArea(s.area)),
        h('dt', {}, '国内での割合'), h('dd', {}, country ? `${((s.cells / Math.max(1, stats.countries[s.country].cells)) * 100).toFixed(1)}%` : '-'),
        h('dt', {}, '海岸線'), h('dd', {}, fmtKm(s.coast)),
      ),
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, '隣接する区画（境界の長さ）'),
      h('div', { class: 'chips' }, [...s.neighbors].sort((a, b) => b[1] - a[1]).map(([k, len]) => {
        const other = labels.states[k];
        const oc = stats.states[k].country;
        const foreign = oc !== s.country && oc >= 0 ? `（${labels.countries[oc].name}）` : '';
        return h('span', { class: 'chip', onclick: () => this.selectRegion('state', k) }, `${other.name}${foreign} ${fmtKm(len)}`);
      })),
      this.mergeRow('state', sel.index, [...s.neighbors.keys()].filter((k) => stats.states[k].country === s.country).map((k) => ({ index: k, label: labels.states[k].name }))),
    );
  }

  /** 隣の国（州）をこの国（州）に統合する行 */
  private mergeRow(kind: 'country' | 'state', keep: number, options: { index: number; label: string }[]): HTMLElement | null {
    if (options.length === 0) return null;
    const sel = h('select', {}, h('option', { value: '' }, kind === 'country' ? '統合する隣国を選ぶ…' : '統合する隣の州を選ぶ…'), options.map((o) => h('option', { value: String(o.index) }, o.label)));
    return h('div', { class: 'row' }, h('label', {}, kind === 'country' ? '隣国を統合' : '隣の州を統合'), sel, h('button', { class: 'btn small', onclick: () => {
      if (!sel.value) return;
      actions.mergeAction(this.host.store, kind, keep, Number(sel.value));
      this.toast('統合しました（元に戻すは Ctrl+Z）');
    } }, '統合'));
  }

  /** 自動の命名に使う文化の選択（既定は西洋系のみ） */
  private cultureChooser(): HTMLElement {
    const { store } = this.host;
    const chosen = new Set(store.world.nameCultures);
    const box = (key: string, label: string) =>
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox',
        checked: chosen.has(key),
        onchange: (e: Event) => {
          const next = new Set(store.world.nameCultures);
          if ((e.target as HTMLInputElement).checked) next.add(key);
          else next.delete(key);
          try {
            actions.setNameCultures(store, CULTURES.filter((c) => next.has(c.key)).map((c) => c.key));
          } catch (err) {
            this.error(err);
            this.renderPanel();
          }
        },
      }), label);
    const nonWestern = CULTURES.filter((c) => !c.western);
    const usingNonWestern = nonWestern.some((c) => chosen.has(c.key));
    return h('div', {},
      h('div', { class: 'subhead' }, '名前に使う文化'),
      h('div', { class: 'grid2' }, CULTURES.filter((c) => c.western).map((c) => box(c.key, c.label))),
      h('details', { open: usingNonWestern }, h('summary', { class: 'note', style: 'cursor:pointer' }, '西洋以外の文化も使う'),
        h('div', { class: 'grid2' }, nonWestern.map((c) => box(c.key, c.label)))),
      h('p', { class: 'note' }, '新しく作る国・州・都市・地物の名前は、ここで選んだ文化からだけ作ります。既にある国で使わない文化のものは「名前をすべて作り直す」で選んだ文化に置き換わります。'),
    );
  }

  private territoryOptions(): HTMLElement[] {
    const { settings, store } = this.host;
    const pol = store.political;
    const level = h('div', { class: 'btn-row' });
    for (const [v, label] of [['country', '国単位'], ['state', '州単位']] as const) {
      level.append(h('button', { class: 'btn small' + (settings.territoryLevel === v ? ' primary' : ''), onclick: () => { settings.territoryLevel = v; this.renderPanel(); } }, label));
    }
    const target = h('select', { onchange: () => { settings.territoryTarget = target.value; } },
      h('option', { value: 'start', selected: settings.territoryTarget === 'start' }, '描き始めた所の国（州）を広げる'),
      h('option', { value: 'new', selected: settings.territoryTarget === 'new' }, '新しい国を作る'),
      pol ? h('optgroup', { label: '国を指定' }, pol.labels.countries.map((c, k) => pol.stats.countries[k]?.cells > 0
        ? h('option', { value: `c:${c.id}`, selected: settings.territoryTarget === `c:${c.id}` }, c.name + c.gov) : null)) : null,
      pol ? h('optgroup', { label: '州を指定' }, pol.labels.states.map((s, k) => {
        const st = pol.stats.states[k];
        if (!st || st.cells === 0) return null;
        const c = st.country >= 0 ? pol.labels.countries[st.country] : null;
        return h('option', { value: `s:${s.id}`, selected: settings.territoryTarget === `s:${s.id}` }, `${s.name}${c?.subdivision ?? ''}（${c?.name ?? ''}）`);
      })) : null,
    );
    return [
      h('div', { class: 'row' }, h('label', {}, '塗る単位'), level),
      h('div', { class: 'row' }, h('label', {}, '塗る先'), target),
      h('p', { class: 'note' }, '塗った陸地はその国（州）の領土になり、国境・州境は塗った形に合わせて自動で引き直されます。新しい国も塗って作れます。元に戻すは Ctrl+Z。'),
    ];
  }

  private pickButton(pick: PendingPick): HTMLElement {
    const active = this.pendingPick?.kind === pick.kind && this.pendingPick.id === pick.id;
    return h('button', {
      class: 'btn small' + (active ? ' primary' : ''),
      onclick: () => {
        this.pendingPick = active ? null : pick;
        this.showPickHint();
        this.renderPanel();
      },
    }, active ? '地図をタップ…（取り消す）' : '地図で指定');
  }

  private showPickHint(): void {
    if (this.pendingPick) {
      clearTimeout(this.hintTimer);
      this.hintEl.textContent = `${this.pendingPick.label}をタップしてください（Esc で取り消し）`;
      this.hintEl.hidden = false;
      this.mapWrap.classList.add('picking');
      if (window.matchMedia('(max-width: 900px)').matches) this.panel.classList.remove('open');
    } else {
      this.hintEl.hidden = true;
      this.mapWrap.classList.remove('picking');
    }
  }

  /** 地図上でタップされた地点で、待っていた指定を実行する */
  completePick(x: number, y: number): void {
    const pick = this.pendingPick;
    if (!pick) return;
    try {
      if (pick.kind === 'capital') actions.setCapitalLocation(this.host.store, pick.id, x, y);
      else actions.setSeatLocation(this.host.store, pick.id, x, y);
      this.pendingPick = null;
      this.showPickHint();
      this.toast(pick.kind === 'capital' ? '首都の位置を変更しました' : '中心都市の位置を変更しました');
    } catch (e) {
      this.error(e);
    }
    this.renderPanel();
  }

  selectRegion(kind: 'country' | 'state', index: number, cell?: number): void {
    const { store } = this.host;
    const pol = store.political;
    if (!pol) return;
    const s = kind === 'country' ? pol.stats.countries[index] : pol.stats.states[index];
    const anchorCell = cell ?? Math.floor(s.labelY) * store.world.width + Math.floor(s.labelX);
    store.select({ kind, index, cell: anchorCell });
    if (this.tab !== 'data') this.showTab('data');
  }

  // ---------------------------------------------------------------- 気候タブ
  climateLayerSelect(): HTMLElement {
    const { flags } = this.host;
    const sel = h('select', {
      onchange: () => {
        flags.climate = sel.value as ClimateLayer;
        this.host.requestDraw();
        this.renderPanel();
      },
    }, CLIMATE_LAYERS.map((l) => h('option', { value: l.id, selected: flags.climate === l.id }, l.label)));
    const wrap = h('div', {}, h('div', { class: 'row' }, h('label', {}, '気候レイヤー'), sel));
    if (flags.climate !== 'none') {
      wrap.append(sliderRow('不透明度', flags.climateOpacity, 0.2, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { flags.climateOpacity = v; this.host.requestDraw(); }));
      if (!this.host.store.world.climate) wrap.append(h('p', { class: 'note warn' }, '気候がまだ計算されていません。「気候」タブで計算してください。'));
    }
    return wrap;
  }

  private numRow(label: string, value: number, unit: string, step: number, onCommit: (v: number) => void, title?: string): HTMLElement {
    const input: HTMLInputElement = h('input', {
      type: 'number',
      step: String(step),
      value: String(value),
      title,
      onchange: () => {
        const v = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(v)) {
          this.toast('数値を入力してください', true);
          input.value = String(value);
          return;
        }
        onCommit(v);
      },
    });
    return h('div', { class: 'row', title }, h('label', {}, label), input, h('span', { class: 'unit' }, unit));
  }

  private renderClimateTab(): HTMLElement[] {
    const { store } = this.host;
    const w = store.world;
    const c = w.climate;
    const p = w.climateParams;
    const status = store.climateStatus();
    const out: HTMLElement[] = [];

    // 状態
    const stateLabel = status.state === 'none' ? '未計算' : status.state === 'ok' ? '計算済み' : '要再計算';
    const st = h('div', { class: 'section' }, h('h3', {}, '気候の計算', h('small', {}, stateLabel)));
    if (c) {
      st.append(h('dl', { class: 'stats' },
        h('dt', {}, '生成方式'), h('dd', {}, c.meta.algorithm.split('/').pop() ?? c.meta.algorithm),
        h('dt', {}, 'バージョン'), h('dd', {}, c.meta.version),
        h('dt', {}, 'シード'), h('dd', {}, String(c.meta.seed)),
        h('dt', {}, '気候グリッド'), h('dd', {}, `${c.meta.width}×${c.meta.height}（1 セル ${c.meta.cellKm} km）`),
        h('dt', {}, '計算日時'), h('dd', {}, new Date(c.meta.generatedAt).toLocaleString()),
        w.terrain?.meta ? [h('dt', {}, '地形の生成方式'), h('dd', {}, `${w.terrain.meta.algorithm.split('/').pop()} v${w.terrain.meta.version}${w.terrain.meta.edits ? `（部分修正 ${w.terrain.meta.edits} 回）` : ''}`)] : null,
      ));
    }
    if (status.state === 'stale') st.append(h('p', { class: 'note warn' }, `再計算が必要です：${status.reasons.join('、')}`));
    st.append(
      h('button', { class: 'btn primary block', onclick: () => this.run(async () => {
        await actions.computeClimateAction(store);
        if (this.host.flags.climate === 'none') this.host.flags.climate = 'biome';
        this.host.requestDraw();
      }) }, c ? '気候を再計算' : '気候を計算'),
      h('p', { class: 'note' }, '地形を生成・部分再生成すると自動で計算し直します。下の設定を変えたときは「再計算」を押してください。'),
    );
    out.push(st);

    // 表示
    const disp = h('div', { class: 'section' }, h('h3', {}, '表示'), this.climateLayerSelect());
    const flagsRow = (key: 'latitude' | 'wind', label: string) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.host.flags[key], onchange: (e: Event) => { this.host.flags[key] = (e.target as HTMLInputElement).checked; this.host.requestDraw(); } }), label);
    disp.append(h('div', { class: 'grid2' }, flagsRow('latitude', '緯度相当線'), flagsRow('wind', '卓越風の矢印')));
    if (c) disp.append(this.climateSummary());
    out.push(disp);

    // 地点の気候
    out.push(this.inspectSection());

    // 世界設定
    const f = w.geoFrame;
    const [lo, hi] = latitudeRange(f, w.width, w.height, w.kmPerCell);
    out.push(h('div', { class: 'section' },
      h('h3', {}, '世界設定（緯度相当）'),
      h('p', { class: 'note' }, '地図の座標（左上からの km）と、気候計算に使う「緯度相当」は別のものです。Y 座標を緯度とはみなさず、ここで決めた対応で各地点の緯度相当を求めます。'),
      this.numRow('中心の緯度相当', f.centerLat, '度', 1, (v) => actions.setGeoFrame(store, { centerLat: v }), '地図の中心がどの緯度に相当するか（北が正、南が負）'),
      this.numRow('北相当の向き', f.northAngle, '度', 5, (v) => actions.setGeoFrame(store, { northAngle: v }), '地図の上方向から時計回りの角度。90 なら地図の右が北相当'),
      this.numRow('緯度1度の距離', f.kmPerDegree, 'km', 1, (v) => actions.setGeoFrame(store, { kmPerDegree: v }), '地球は約 111 km。小さくすると同じ地図でも緯度の幅が広がる（小さな惑星）'),
      this.numRow('地軸の傾き', f.axialTilt, '度', 0.5, (v) => actions.setGeoFrame(store, { axialTilt: v }), '大きいほど季節の差が大きくなる（地球は 23.4°）'),
      h('p', { class: 'note' }, `この地図の範囲：${formatLatitude(lo)} 〜 ${formatLatitude(hi)}（南北 ${Math.round(hi - lo)} 度分）`),
      lo < -90 || hi > 90 ? h('p', { class: 'note warn' }, '緯度相当が ±90° を超えています。超えた部分は極として扱われます。') : null,
    ));

    // 気温
    out.push(h('div', { class: 'section' },
      h('h3', {}, '気温のパラメータ'),
      this.numRow('全体の気温補正', p.tempOffset, '°C', 0.5, (v) => actions.setClimateParams(store, { tempOffset: v }), '温暖な世界・寒冷な世界にしたいときに'),
      this.numRow('気温減率', p.lapseRate, '°C/km', 0.1, (v) => actions.setClimateParams(store, { lapseRate: v }), '標高 1 km あたりの気温の下がり方（地球の平均は約 6.5）'),
      this.numRow('大陸度の距離', p.continentalityKm, 'km', 50, (v) => actions.setClimateParams(store, { continentalityKm: v }), '海からこの距離ほど離れると大陸性の気候に近づく（風上側の距離を重視）'),
      this.numRow('海洋性の振れ幅', p.maritimeAmplitude, '倍', 0.01, (v) => actions.setClimateParams(store, { maritimeAmplitude: v }), '海の近くでの季節変化の大きさ（日射の季節変化に対する比）'),
      this.numRow('大陸性の振れ幅', p.continentalAmplitude, '倍', 0.01, (v) => actions.setClimateParams(store, { continentalAmplitude: v }), '内陸での季節変化の大きさ'),
      this.numRow('海による高緯度の温暖化', p.oceanWarming, '°C', 0.5, (v) => actions.setClimateParams(store, { oceanWarming: v }), '海流などの効果の代わりに、高緯度の海に近い所を暖かくする'),
    ));

    // 風と降水
    const windSel = h('select', { onchange: () => actions.setClimateParams(store, { windMode: windSel.value as 'bands' | 'fixed' }) },
      h('option', { value: 'bands', selected: p.windMode === 'bands' }, '緯度帯モデル（貿易風・偏西風・極東風）'),
      h('option', { value: 'fixed', selected: p.windMode === 'fixed' }, '固定の風向'));
    out.push(h('div', { class: 'section' },
      h('h3', {}, '卓越風と降水のパラメータ'),
      h('div', { class: 'row' }, h('label', {}, '卓越風'), windSel),
      p.windMode === 'fixed' ? this.numRow('風が吹いてくる方角', p.windFrom, '度', 15, (v) => actions.setClimateParams(store, { windFrom: v }), '北相当を 0 として時計回り。270 なら西風') : null,
      this.numRow('降水帯の季節移動', p.seasonalShift, '度', 0.5, (v) => actions.setClimateParams(store, { seasonalShift: v }), '夏と冬で雨の多い緯度帯がずれる量。大きいほど雨季・乾季がはっきりする'),
      this.numRow('水蒸気の到達距離', p.moistureLengthKm, 'km', 50, (v) => actions.setClimateParams(store, { moistureLengthKm: v }), '長いほど内陸まで湿る'),
      this.numRow('地形性降水の強さ', p.orographic, '倍', 0.1, (v) => actions.setClimateParams(store, { orographic: v }), '風上の山で雨が増え、風下が乾く効果の強さ'),
      this.numRow('降水量の倍率', p.precipScale, '倍', 0.05, (v) => actions.setClimateParams(store, { precipScale: v })),
      this.numRow('蒸発散による再供給', p.recycling, '割', 0.05, (v) => actions.setClimateParams(store, { recycling: v }), '陸に降った雨が再び水蒸気に戻る割合（0〜0.9）'),
    ));

    // 計算設定
    const gridSel = h('select', { onchange: () => actions.setClimateParams(store, { gridFactor: Number(gridSel.value) }) },
      [1, 2, 4].map((g) => h('option', { value: String(g), selected: p.gridFactor === g }, `${g}×${g} 地形セル（${Math.ceil(w.width / g)}×${Math.ceil(w.height / g)}）`)));
    const seedIn = h('input', { type: 'number', value: String(p.seed), onchange: () => actions.setClimateParams(store, { seed: Math.abs(Math.floor(Number(seedIn.value))) || 1 }) });
    out.push(h('div', { class: 'section' },
      h('h3', {}, '計算の設定'),
      h('div', { class: 'row' }, h('label', {}, '気候グリッド'), gridSel),
      h('div', { class: 'row' }, h('label', {}, 'シード'), seedIn, h('button', { class: 'btn small', title: 'ランダム', html: icon('dice', 16), onclick: () => actions.setClimateParams(store, { seed: Math.floor(Math.random() * 1e9) }) })),
      this.numRow('局所的なゆらぎ', p.variability, '', 0.05, (v) => actions.setClimateParams(store, { variability: v }), '0 でゆらぎなし。シードを変えるとゆらぎの模様が変わる'),
    ));

    // 分類条件
    out.push(this.thresholdSection());

    // 検証
    const issues: ValidationIssue[] = [...sanitizeClimateParams(p).issues];
    if (c) {
      for (const i of c.meta.issues) if (!issues.some((j) => j.code === i.code && j.message === i.message)) issues.push(i);
      for (const i of validateClimate(c, { width: Math.ceil(w.width / c.meta.gridFactor), height: Math.ceil(w.height / c.meta.gridFactor) })) {
        if (!issues.some((j) => j.code === i.code)) issues.push(i);
      }
    }
    out.push(h('div', { class: 'section' },
      h('h3', {}, 'データの検証', h('small', {}, issues.length ? `${issues.length} 件` : '問題なし')),
      h('p', { class: 'note' }, '欠損値・無効値（NaN など）・範囲外の値・大小関係の矛盾・範囲外の設定を調べます。'),
      issues.length
        ? h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.level }, `${i.level === 'error' ? 'エラー' : i.level === 'warning' ? '注意' : '情報'}：${i.message}${i.count ? `（${i.count} 件）` : ''}`)))
        : h('ul', { class: 'issues' }, h('li', {}, c ? '問題は見つかりませんでした' : '気候はまだ計算されていません')),
    ));

    // 前提と限界
    out.push(h('div', { class: 'section' },
      h('h3', {}, '計算上の前提と限界'),
      h('p', { class: 'note' }, 'これは架空世界づくりのための大まかな近似モデルで、実際の気象・気候の予測ではありません。'),
      h('ol', { class: 'assumptions' }, CLIMATE_ASSUMPTIONS.map((a) => h('li', {}, a))),
      h('p', { class: 'note' }, `単位：気温 ${CLIMATE_UNITS.temperature}、降水量 ${CLIMATE_UNITS.precipitation}、季節性：年較差 ${CLIMATE_UNITS.temperatureRange}／降水 ${CLIMATE_UNITS.precipitationSeasonality}`),
    ));

    // 書き出し
    if (c) {
      out.push(h('div', { class: 'section' },
        h('h3', {}, '気候データの書き出し'),
        h('p', { class: 'note' }, 'セル ID・位置（セル・km）・緯度相当・標高・年平均気温・年降水量・季節性・気候区分・バイオームを CSV で書き出します。先頭の # 行に生成方式・バージョン・単位を記録します。'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => downloadBytes(new TextEncoder().encode(climateCsv(c, w.width, w.height, w.kmPerCell, true)), `${safeFilename(w.title)}-climate.csv`, 'text/csv') }, 'CSV（陸のみ）'),
          h('button', { class: 'btn', onclick: () => downloadBytes(new TextEncoder().encode(climateCsv(c, w.width, w.height, w.kmPerCell, false)), `${safeFilename(w.title)}-climate-all.csv`, 'text/csv') }, 'CSV（海を含む）'),
        ),
      ));
    }
    return out;
  }

  private climateSummary(): HTMLElement {
    const c = this.host.store.world.climate!;
    const bc = new Map<number, number>();
    let land = 0;
    let tSum = 0;
    let pSum = 0;
    for (let i = 0; i < c.biome.length; i++) {
      if (c.land[i] < 0.5) continue;
      land++;
      tSum += c.tMean[i];
      pSum += c.precip[i];
      bc.set(c.biome[i], (bc.get(c.biome[i]) ?? 0) + 1);
    }
    if (!land) return h('p', { class: 'note' }, '陸地がありません。');
    const top = [...bc].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return h('div', {},
      h('dl', { class: 'stats' },
        h('dt', {}, '陸の平均気温'), h('dd', {}, `${(tSum / land).toFixed(1)} °C`),
        h('dt', {}, '陸の平均降水量'), h('dd', {}, `${Math.round(pSum / land).toLocaleString()} mm/年`),
      ),
      h('div', { class: 'subhead' }, '陸地のバイオーム構成'),
      h('dl', { class: 'stats' }, top.map(([b, n]) => [
        h('dt', {}, h('span', { class: 'swatch', style: `background:${BIOMES[b].color}` }), BIOMES[b].label),
        h('dd', {}, `${((n / land) * 100).toFixed(1)}%`),
      ])),
    );
  }

  private inspectSection(): HTMLElement {
    const { store } = this.host;
    const w = store.world;
    const c = w.climate;
    const pt = this.host.getInspect();
    const sec = h('div', { class: 'section' }, h('h3', {}, '地点の気候'));
    if (!c) return sec.appendChild(h('p', { class: 'note' }, '気候を計算すると、「地点情報」ツールでタップした地点の気候を見られます。')).parentElement as HTMLElement;
    if (!pt) {
      sec.append(
        h('p', { class: 'note' }, '「地点情報」ツールで地図をタップすると、その地点の値と雨温図を表示します。'),
        h('button', { class: 'btn small', onclick: () => { this.host.setTool('inspect'); this.refreshTools(); } }, '地点情報ツールを使う'),
      );
      return sec;
    }
    const id = climateCellAt(c, pt.x, pt.y);
    if (id < 0) return sec.appendChild(h('p', { class: 'note' }, '地図の外です。')).parentElement as HTMLElement;
    const info = climateCellInfo(c, w.width, w.height, w.kmPerCell, id);
    const k = info.koppen;
    const b = BIOMES.find((x) => x.key === info.biome);
    sec.append(
      h('dl', { class: 'stats' },
        h('dt', {}, 'セル ID'), h('dd', {}, `${info.id}（${info.ix}, ${info.iy}）`),
        h('dt', {}, '位置'), h('dd', {}, `x ${info.xKm.toFixed(0)} km, y ${info.yKm.toFixed(0)} km`),
        h('dt', {}, '緯度相当'), h('dd', {}, formatLatitude(info.lat)),
        h('dt', {}, '平均標高'), h('dd', {}, info.land >= 0.5 ? `${Math.round(info.elevation).toLocaleString()} m` : '海'),
        h('dt', {}, '年平均気温'), h('dd', {}, `${info.tMean.toFixed(1)} °C`),
        h('dt', {}, '最暖月／最寒月'), h('dd', {}, `${info.tWarm.toFixed(1)} ／ ${info.tCold.toFixed(1)} °C`),
        h('dt', {}, '気温の年較差'), h('dd', {}, `${info.tRange.toFixed(1)} °C`),
        info.land >= 0.5 ? [
          h('dt', {}, '年降水量'), h('dd', {}, `${Math.round(info.precip).toLocaleString()} mm`),
          h('dt', {}, '降水の季節性'), h('dd', {}, `${info.precipSeasonality.toFixed(2)}（${info.highSun >= 0.5 ? '夏' : '冬'}に多い）`),
          h('dt', {}, '気候区分'), h('dd', {}, k ? `${k} ${KOPPEN_INFO[k].label}` : '—'),
          h('dt', {}, 'バイオーム'), h('dd', {}, b?.label ?? '—'),
        ] : null,
      ),
    );
    if (info.land >= 0.5) sec.append(this.climograph(info));
    sec.append(
      h('p', { class: 'note' }, '月別の値は、保存している年平均・最暖月・最寒月・夏冬の降水割合から近似的に描いたものです。'),
    );
    return sec;
  }

  private climograph(info: ClimateCellInfo): HTMLCanvasElement {
    const dpr = window.devicePixelRatio || 1;
    const W = 320;
    const H = 150;
    const cv = h('canvas', { class: 'climograph', width: W * dpr, height: H * dpr });
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const left = 30;
    const right = 34;
    const top = 12;
    const bottom = 20;
    const pw = W - left - right;
    const ph = H - top - bottom;
    const pMax = Math.max(100, Math.ceil(Math.max(...info.monthlyP) / 50) * 50);
    const tMin = Math.min(-10, Math.floor(Math.min(...info.monthlyT) / 10) * 10);
    const tMax = Math.max(30, Math.ceil(Math.max(...info.monthlyT) / 10) * 10);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#6e6457';
    ctx.strokeStyle = '#e6dccb';
    for (let k = 0; k <= 4; k++) {
      const y = top + (ph * k) / 4;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + pw, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(tMax - ((tMax - tMin) * k) / 4)), left - 4, y + 3);
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(pMax - (pMax * k) / 4)), left + pw + 4, y + 3);
    }
    const bw = pw / 12;
    ctx.fillStyle = 'rgba(63, 127, 196, 0.75)';
    info.monthlyP.forEach((v, m) => {
      const bh = (v / pMax) * ph;
      ctx.fillRect(left + m * bw + 2, top + ph - bh, bw - 4, bh);
    });
    ctx.strokeStyle = '#d2421f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    info.monthlyT.forEach((v, m) => {
      const x = left + m * bw + bw / 2;
      const y = top + ((tMax - v) / (tMax - tMin)) * ph;
      if (m === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#6e6457';
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++) ctx.fillText(String(m + 1), left + m * bw + bw / 2, H - 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d2421f';
    ctx.fillText('°C', 2, 10);
    ctx.fillStyle = '#3f7fc4';
    ctx.textAlign = 'right';
    ctx.fillText('mm', W - 2, 10);
    return cv;
  }

  private thresholdSection(): HTMLElement {
    const { store } = this.host;
    const p = store.world.climateParams;
    const kRows: [keyof KoppenThresholds, string, string, string][] = [
      ['tropicalMinCold', 'A：最寒月の下限', '°C', '最寒月平均気温がこれ以上なら熱帯（A）'],
      ['cdBoundary', 'C/D の境', '°C', '最寒月平均気温がこれより高ければ温帯（C）、以下なら亜寒帯（D）。-3 または 0 が一般的'],
      ['polarMaxWarm', 'E：最暖月の上限', '°C', '最暖月平均気温がこれ未満なら寒帯（E）'],
      ['iceMaxWarm', 'EF：最暖月の上限', '°C', '最暖月平均気温がこれ未満なら氷雪気候'],
      ['aridFactor', 'B：乾燥限界の係数', 'mm/°C', '乾燥限界 = 係数 × 年平均気温 + 補正'],
      ['aridSummerOffset', 'B：補正（夏雨）', 'mm', '降水の 70% 以上が夏半年のとき'],
      ['aridEvenOffset', 'B：補正（中間）', 'mm', ''],
      ['aridWinterOffset', 'B：補正（冬雨）', 'mm', '降水の 70% 以上が冬半年のとき'],
      ['hotAridMean', 'h/k の境', '°C', '乾燥気候のうち年平均気温がこれ以上なら高温（h）'],
      ['tropicalWetMonth', 'Af：最少雨月', 'mm', '最少雨月降水量がこれ以上なら熱帯雨林気候'],
      ['summerDryMax', 's：夏の最少雨月', 'mm', ''],
      ['summerDryRatio', 's：冬の最多雨月との比', '分の1', ''],
      ['winterDryRatio', 'w：夏の最多雨月との比', '分の1', ''],
      ['hotSummer', 'a：最暖月', '°C', '最暖月平均気温がこれ以上なら a'],
      ['warmMonthTemp', 'b：月平均気温', '°C', ''],
      ['warmMonths', 'b：その月数', 'か月', ''],
      ['extremeCold', 'd：最寒月', '°C', '亜寒帯で最寒月平均気温がこれ未満なら d'],
    ];
    const bRows: [keyof BiomeThresholds, string, string, string][] = [
      ['grasslandMaxPrecip', '草原の年降水量', 'mm', '温帯・亜寒帯でこれ未満なら草原（年平均 10°C の場合。寒いほど小さく補正）'],
      ['temperateRainforestMinPrecip', '温帯雨林', 'mm', '年降水量がこれ以上の冷涼な温帯は温帯雨林'],
      ['tropicalRainforestMinPrecip', '熱帯雨林', 'mm', 'Af/Am で年降水量がこれ以上なら熱帯雨林、未満なら熱帯季節林'],
      ['tropicalSeasonalMinPrecip', '熱帯季節林', 'mm', 'Aw/As で年降水量がこれ以上なら熱帯季節林、未満ならサバナ'],
      ['subtropicalMinTemp', '照葉樹林の気温', '°C', '暑夏の温帯で年平均気温がこれ以上なら照葉樹林'],
      ['alpineMinElevation', '高山帯の標高', 'm', '寒帯気候のうち、この標高以上（かつ緯度相当 62° 未満）は高山帯'],
    ];
    const details = (title: string, body: HTMLElement[]) => {
      const d = h('details', {}, h('summary', { class: 'subhead', style: 'cursor:pointer' }, title), ...body);
      return d;
    };
    return h('div', { class: 'section' },
      h('h3', {}, '分類の条件'),
      h('p', { class: 'note' }, 'ケッペン気候区分（近似）とバイオームを決める閾値です。変更後は「気候を再計算」を押してください。'),
      details('気候区分（ケッペン）の条件', [
        ...kRows.map(([key, label, unit, hint]) => this.numRow(label, p.koppen[key], unit, 1, (v) => actions.setClimateParams(store, { koppen: { ...p.koppen, [key]: v } }), hint)),
        h('button', { class: 'btn small', onclick: () => actions.setClimateParams(store, { koppen: { ...DEFAULT_KOPPEN } }) }, '既定値に戻す'),
      ]),
      details('バイオームの条件', [
        ...bRows.map(([key, label, unit, hint]) => this.numRow(label, p.biome[key], unit, key === 'subtropicalMinTemp' ? 0.5 : 50, (v) => actions.setClimateParams(store, { biome: { ...p.biome, [key]: v } }), hint)),
        h('button', { class: 'btn small', onclick: () => actions.setClimateParams(store, { biome: { ...DEFAULT_BIOME } }) }, '既定値に戻す'),
      ]),
      h('p', { class: 'note' }, `区分コード：${KOPPEN_CODES.filter(Boolean).length} 種類（${KOPPEN_CODES.filter(Boolean).slice(0, 6).join(', ')} …）、バイオーム ${BIOMES.length - 1} 種類`),
    );
  }

  // ---------------------------------------------------------------- 地物タブ
  private renderFeaturesTab(): HTMLElement[] {
    const { store } = this.host;
    const w = store.world;
    if (!w.terrain) return [h('p', { class: 'note' }, '地形を生成すると、山脈・河川・平野などの一覧がここに表示されます。')];
    const a = store.analysis;
    if (!a) return [h('p', { class: 'note' }, '解析中…')];
    const km = w.kmPerCell;
    const feats = a.landforms.features;
    const section = (title: string, list: Feature[], cols: [string, (f: Feature) => string][]): HTMLElement | null => {
      if (list.length === 0) return null;
      const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, '名前'), cols.map(([c]) => h('th', {}, c)))));
      const tb = h('tbody', {});
      for (const f of list) {
        const auto = featureAutoName(store, f);
        const custom = featureOverride(store, f);
        const input: HTMLInputElement = h('input', {
          class: 'name-input' + (custom ? ' custom' : ''),
          type: 'text',
          value: custom?.name ?? auto,
          placeholder: auto,
          title: '名前を変更できます（空にすると自動の名前に戻ります）',
          onclick: (e: Event) => e.stopPropagation(),
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') input.blur(); },
          onchange: () => actions.renameFeature(store, f.kind, f.key, input.value, auto),
        });
        tb.append(h('tr', { class: 'click', title: '行をタップすると地図がその場所へ移動します', onclick: () => this.host.focusOn(f.x, f.y, Math.max(20, f.extent || f.length / 2 || 20)) },
          h('td', {}, input), cols.map(([, fn]) => h('td', { class: 'num' }, fn(f)))));
      }
      table.append(tb);
      return h('div', { class: 'section' }, h('h3', {}, title, h('small', {}, `${list.length} 件`)), table);
    };
    const of = (k: Feature['kind'][]) => feats.filter((f) => k.includes(f.kind));
    const lfCount = new Map<number, number>();
    for (let i = 0; i < a.landforms.classes.length; i++) lfCount.set(a.landforms.classes[i], (lfCount.get(a.landforms.classes[i]) ?? 0) + 1);
    let landCells = 0;
    for (let i = 0; i < a.land.length; i++) landCells += a.land[i];
    const pct = (k: number) => `${(((lfCount.get(k) ?? 0) / Math.max(1, landCells)) * 100).toFixed(1)}%`;
    const sections: (HTMLElement | null)[] = [
      h('p', { class: 'note' }, '名前の欄をタップすると書き換えられます（空にすると自動の名前に戻ります）。国名・州名・首都名は「データ」タブ、または「区画選択」ツールで変更できます。'),
      h('div', { class: 'section' }, h('h3', {}, '地形の構成'), h('dl', { class: 'stats' },
        h('dt', {}, '平野'), h('dd', {}, pct(2)),
        h('dt', {}, '丘陵'), h('dd', {}, pct(3)),
        h('dt', {}, '高原'), h('dd', {}, pct(4)),
        h('dt', {}, '山地'), h('dd', {}, pct(5)),
        h('dt', {}, '高山'), h('dd', {}, pct(6)),
        h('dt', {}, '湖'), h('dd', {}, pct(1)),
      ), h('p', { class: 'note' }, `区分の目安：平野 < ${Math.round(a.landforms.thresholds.plain)}m、山地 ≥ ${Math.round(a.landforms.thresholds.mountain)}m、高山 ≥ ${Math.round(a.landforms.thresholds.alpine)}m（起伏も考慮）`)),
      section('山脈・山地', of(['range', 'massif']).sort((x, y) => y.size - x.size), [
        ['種別', (f) => FEATURE_LABEL[f.kind]],
        ['最高点', (f) => `${Math.round(f.elevation).toLocaleString()}m`],
        ['面積', (f) => fmtArea(f.size * km * km)],
      ]),
      section('主な山', of(['peak']).sort((x, y) => y.elevation - x.elevation).slice(0, 20), [['標高', (f) => `${Math.round(f.elevation).toLocaleString()}m`]]),
      section('河川', of(['river']).sort((x, y) => y.length - x.length), [['長さ', (f) => fmtKm(f.length * km)]]),
      section('平野・盆地・高原', of(['plain', 'basin', 'plateau']).sort((x, y) => y.size - x.size), [
        ['種別', (f) => FEATURE_LABEL[f.kind]],
        ['面積', (f) => fmtArea(f.size * km * km)],
      ]),
      section('湖', of(['lake']).sort((x, y) => y.size - x.size), [['面積', (f) => fmtArea(f.size * km * km)]]),
    ];
    return sections.filter((x): x is HTMLElement => x !== null);
  }

  // ---------------------------------------------------------------- ダイアログ
  private dialog(title: string, body: HTMLElement, footer: HTMLElement[] = []): { close: () => void } {
    const back = h('div', { class: 'dialog-back' });
    const close = () => back.remove();
    back.append(
      h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
        h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', title: '閉じる', html: icon('close'), onclick: close })),
        h('div', { class: 'body' }, body),
        footer.length ? h('footer', {}, footer) : null,
      ),
    );
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    document.body.append(back);
    return { close };
  }

  newDialog(): void {
    const sizes: [string, number, number][] = [
      ['小 480×320', 480, 320],
      ['中 720×480', 720, 480],
      ['大 1080×720', 1080, 720],
    ];
    let pick = 1;
    let template: 'blank' | 'sample' = 'blank';
    const sizeChoice = h('div', { class: 'choice' }, sizes.map(([label], k) =>
      h('label', {}, h('input', { type: 'radio', name: 'size', checked: k === pick, onchange: () => (pick = k) }), label)));
    const tplChoice = h('div', { class: 'choice', style: 'grid-template-columns:1fr 1fr' },
      h('label', {}, h('input', { type: 'radio', name: 'tpl', checked: true, onchange: () => (template = 'blank') }), '白紙から描く'),
      h('label', {}, h('input', { type: 'radio', name: 'tpl', onchange: () => (template = 'sample') }), 'サンプルの下絵'),
    );
    const d = this.dialog(
      '新しい地図',
      h('div', {},
        h('p', { class: 'note' }, 'グリッドの大きさ（大きいほど精細ですが、生成に時間がかかります）'),
        sizeChoice,
        h('p', { class: 'note', style: 'margin-top:12px' }, '始め方'),
        tplChoice,
        h('p', { class: 'note warn' }, '今の地図は自動保存されています（「開く」から戻せます）。'),
      ),
      [
        h('button', { class: 'btn', onclick: () => d.close() }, 'キャンセル'),
        h('button', { class: 'btn primary', onclick: async () => {
          d.close();
          await this.saveToBrowser(true);
          const [, w, hh] = sizes[pick];
          actions.newWorld(this.host.store, w, hh, template);
          this.currentMapId = null;
          this.host.setTool(template === 'blank' ? 'outline' : 'fill');
          this.refreshTools();
          this.host.fit();
        } }, '作成'),
      ],
    );
  }

  async openDialog(): Promise<void> {
    const list = h('div', { class: 'saved-list' }, h('p', { class: 'note' }, '読み込み中…'));
    const fileInput = h('input', { type: 'file', accept: 'image/png,.png', style: 'display:none', onchange: async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const world = await readWorldFromFile(f);
        d.close();
        await this.saveToBrowser(true);
        this.host.store.load(world);
        this.currentMapId = null;
        this.host.fit();
        this.toast(`「${world.title}」を読み込みました`);
      } catch (e) {
        this.error(e);
      }
    } });
    const d = this.dialog(
      '地図を開く',
      h('div', {},
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '画像ファイル（PNG）から開く'), fileInput),
        h('p', { class: 'note' }, 'このアプリの「画像DL」で保存した PNG には地図データが埋め込まれていて、元の状態から編集を続けられます。'),
        h('h3', { style: 'font-size:13.5px;margin:14px 0 8px' }, 'このブラウザに保存した地図'),
        list,
      ),
    );
    try {
      const maps = await listMaps();
      list.innerHTML = '';
      if (maps.length === 0) list.append(h('p', { class: 'note' }, 'まだ保存された地図はありません。'));
      for (const m of maps) {
        const card = h('div', { class: 'saved', onclick: async () => {
          try {
            const rec = await loadMap(m.id);
            if (!rec) return;
            if (m.id !== AUTOSAVE_ID) await this.saveToBrowser(true);
            this.host.store.load(decodeWorld(rec.data));
            this.currentMapId = m.id === AUTOSAVE_ID ? null : m.id;
            d.close();
            this.host.fit();
            this.toast(`「${m.title}」を開きました`);
          } catch (e) {
            this.error(e);
          }
        } },
          h('img', { src: m.thumb, alt: '' }),
          h('div', { class: 'meta' }, m.id === AUTOSAVE_ID ? `（自動保存）${m.title}` : m.title, h('small', {}, new Date(m.updatedAt).toLocaleString())),
          h('button', { class: 'icon-btn del', title: '削除', html: icon('close', 14), onclick: async (e: Event) => {
            e.stopPropagation();
            if (!confirm(`「${m.title}」を削除しますか？`)) return;
            await deleteMap(m.id);
            card.remove();
          } }),
        );
        list.append(card);
      }
    } catch (e) {
      list.innerHTML = '';
      list.append(h('p', { class: 'note warn' }, 'ブラウザの保存領域を開けませんでした（プライベートモードでは使えないことがあります）。'));
      console.warn(e);
    }
  }

  async saveToBrowser(auto: boolean): Promise<void> {
    const { store, renderer } = this.host;
    try {
      const data = await store.worker.run('encode', store.world);
      const thumb = thumbnail(store, renderer, store.world.terrain ? 'physical' : 'sketch', this.host.flags);
      const id = auto ? AUTOSAVE_ID : (this.currentMapId ??= newMapId());
      await saveMap({ id, title: store.world.title, updatedAt: Date.now(), thumb, data });
      if (!auto) this.toast('ブラウザに保存しました（「開く」から読み込めます）');
    } catch (e) {
      if (!auto) this.error(e);
      else console.warn('autosave failed', e);
    }
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      if (this.host.store.busy) return this.scheduleAutosave();
      this.saveToBrowser(true);
    }, 2500);
  }

  exportDialog(): void {
    const { store } = this.host;
    const w = store.world;
    const maxScale = maxExportScale(w);
    const scales = [1, 2, 3, 4].filter((s) => s <= maxScale);
    if (!scales.includes(this.exportScale)) this.exportScale = scales[scales.length - 1];
    this.exportMode = this.host.getMode() === 'sketch' && w.terrain ? 'physical' : this.host.getMode();
    const info = h('p', { class: 'note' });
    const updateInfo = () => (info.textContent = `出力サイズ：${Math.round(w.width * this.exportScale)} × ${Math.round(w.height * this.exportScale)} px`);
    updateInfo();
    const scaleChoice = h('div', { class: 'choice', style: `grid-template-columns:repeat(${scales.length},1fr)` }, scales.map((s) =>
      h('label', {}, h('input', { type: 'radio', name: 'scale', checked: s === this.exportScale, onchange: () => { this.exportScale = s; updateInfo(); } }), `${s}倍`)));
    const modeChoice = h('div', { class: 'choice' }, ([['physical', '地形図'], ['political', '政治図'], ['sketch', '下絵']] as [ViewMode, string][]).map(([m, label]) =>
      h('label', {}, h('input', { type: 'radio', name: 'emode', checked: m === this.exportMode, onchange: () => (this.exportMode = m) }), label)));
    const d = this.dialog(
      '画像としてダウンロード',
      h('div', {},
        h('p', { class: 'note' }, '地図を PNG 画像で保存します。画像の中に地図データ（下絵・地形・国境・名前など）が埋め込まれるので、「開く」でこの画像を選ぶと再編集できます。'),
        h('p', { class: 'note', style: 'margin-top:10px' }, '図の種類'), modeChoice,
        h('p', { class: 'note', style: 'margin-top:10px' }, '解像度'), scaleChoice, info,
        h('p', { class: 'note warn' }, '画像を加工・圧縮（JPEG 変換や SNS への投稿など）するとデータは失われます。保存用には元の PNG を残してください。'),
      ),
      [
        h('button', { class: 'btn', onclick: () => d.close() }, 'キャンセル'),
        h('button', { class: 'btn primary', onclick: async () => {
          d.close();
          try {
            const bytes = await store.withBusy('画像を作成しています…', async () => {
              await new Promise((r) => setTimeout(r, 30));
              return buildMapPng(store, this.host.renderer, this.exportMode, this.host.flags, this.exportScale);
            });
            downloadBytes(bytes, `${safeFilename(w.title)}.png`, 'image/png');
            this.toast(`画像を保存しました（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
          } catch (e) {
            this.error(e);
          }
        } }, 'ダウンロード'),
      ],
    );
  }

  // ---------------------------------------------------------------- その他
  generateTerrain(): Promise<void> {
    return this.run(async () => {
      await actions.generateAll(this.host.store);
      if (this.host.getMode() === 'sketch') this.host.setMode('physical');
    });
  }

  async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.error(e);
    }
  }

  toast(msg: string, error = false): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('error', error);
    this.toastEl.classList.add('show');
    clearTimeout((this.toastEl as unknown as { _t: number })._t);
    const ms = Math.max(error ? 5000 : 2600, msg.length * 90);
    (this.toastEl as unknown as { _t: number })._t = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  error(e: unknown): void {
    console.error(e);
    this.toast(e instanceof Error ? e.message : String(e), true);
  }

  private onKey(e: KeyboardEvent): void {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.host.store.redo();
      else this.host.store.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.host.store.redo();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.saveToBrowser(false);
    } else if (e.key === 'Escape') {
      if (this.pendingPick) {
        this.pendingPick = null;
        this.showPickHint();
        this.renderPanel();
        return;
      }
      this.host.store.setSelectionPolygon(null);
      this.host.store.select(null);
    }
  }
}
