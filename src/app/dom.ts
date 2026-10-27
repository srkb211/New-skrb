/** 小さな DOM 構築ヘルパー */
type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (k in el && k !== 'list' && k !== 'style') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function fmtArea(km2: number): string {
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(2)} 百万km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

export function fmtKm(km: number): string {
  return `${Math.round(km).toLocaleString()} km`;
}

/** スライダー行（離したときに onCommit） */
export function sliderRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string,
  onCommit: (v: number) => void,
): HTMLElement {
  const val = h('span', { class: 'val' }, format(value));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    oninput: () => (val.textContent = format(Number(input.value))),
    onchange: () => onCommit(Number(input.value)),
  });
  return h('div', { class: 'row' }, h('label', {}, label), input, val);
}
