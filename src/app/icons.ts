/** ツールなどのアイコン（24×24 の SVG パス） */
const P: Record<string, string> = {
  pan: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
  outline: '<path d="M4 20c2-6 5-4 7-9s5-6 9-7"/><path d="M15 4l5 5"/>',
  fill: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M19 15c1 2 2 3 2 4a2 2 0 1 1-4 0c0-1 1-2 2-4z"/>',
  land: '<circle cx="12" cy="12" r="7" fill="currentColor" fill-opacity=".35"/><circle cx="12" cy="12" r="7"/>',
  sea: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  erase: '<path d="M8 20h12M5 15l9-9 5 5-9 9H8z"/>',
  ridge: '<path d="M2 19l6-9 4 5 3-4 7 8z"/>',
  'ridge-erase': '<path d="M2 19l6-9 4 5 3-4 7 8z" stroke-dasharray="2 2"/><path d="M15 4l5 5M20 4l-5 5"/>',
  lasso: '<path d="M12 4c5 0 8 2 8 5s-3 5-8 5-8-2-8-5 3-5 8-5z" stroke-dasharray="3 2"/><path d="M7 13c-1 3 1 5 3 6"/>',
  national: '<path d="M3 18c4-1 4-8 9-9s5-5 9-6" stroke-dasharray="6 2 1.5 2"/>',
  state: '<path d="M3 18c4-1 4-8 9-9s5-5 9-6" stroke-dasharray="3 3"/>',
  'border-erase': '<path d="M3 18c4-1 4-8 9-9" stroke-dasharray="4 2"/><path d="M15 12l6 6M21 12l-6 6"/>',
  select: '<path d="M5 3l12 6-5 2-2 5z"/><path d="M12 11l6 6"/>',
  inspect: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>',
  climate: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 1 1 17 18z"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-2" transform="translate(0 -5)"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 0 0 0 12h2" transform="translate(0 -5)"/>',
  new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>',
  open: '<path d="M3 7h6l2 2h10v10H3z"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M14 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export function icon(name: string, size = 20): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
