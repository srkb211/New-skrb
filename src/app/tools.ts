export type ToolId =
  | 'pan'
  | 'outline'
  | 'fill'
  | 'land'
  | 'sea'
  | 'erase'
  | 'ridge'
  | 'ridge-erase'
  | 'lasso'
  | 'national'
  | 'state'
  | 'border-erase'
  | 'select';

export interface ToolDef {
  id: ToolId;
  label: string;
  group: 'view' | 'sketch' | 'terrain' | 'political';
  hint: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'pan', label: '移動', group: 'view', hint: 'ドラッグで地図を動かします（2 本指でも移動・拡大できます）' },
  { id: 'outline', label: '輪郭ペン', group: 'sketch', hint: '陸地の輪郭を描きます。描き終えたら「塗りつぶし」で内側を陸にします' },
  { id: 'fill', label: '塗りつぶし', group: 'sketch', hint: '囲まれた範囲を陸（または海）で塗ります' },
  { id: 'land', label: '陸ブラシ', group: 'sketch', hint: 'なぞった所を陸にします' },
  { id: 'sea', label: '海ブラシ', group: 'sketch', hint: 'なぞった所を海にします（湾や湖を作る）' },
  { id: 'erase', label: '線消し', group: 'sketch', hint: '輪郭線を消します' },
  { id: 'ridge', label: '山脈ペン', group: 'terrain', hint: '山脈を通したい所に線を引きます。生成済みなら周辺の地形がすぐ更新されます' },
  { id: 'ridge-erase', label: '山脈消し', group: 'terrain', hint: '山脈ガイドを消します' },
  { id: 'lasso', label: '範囲選択', group: 'terrain', hint: '部分再生成する範囲を囲みます' },
  { id: 'national', label: '国境ペン', group: 'political', hint: '国境を描きます。端は近くの海岸や他の境界線に自動でつながります' },
  { id: 'state', label: '州境ペン', group: 'political', hint: '国の中を区切る州境を描きます' },
  { id: 'border-erase', label: '境界消し', group: 'political', hint: 'なぞった所の国境・州境を消します' },
  { id: 'select', label: '区画選択', group: 'political', hint: '国や州をタップして情報を見たり名前を変えたりします' },
];

export const GROUP_LABEL: Record<ToolDef['group'], string> = {
  view: '表示',
  sketch: '下絵',
  terrain: '地形',
  political: '政治',
};

export interface ToolSettings {
  /** ブラシ半径（セル） */
  brush: number;
  /** 輪郭ペンの太さ（セル） */
  pen: number;
  fillTarget: 'land' | 'sea';
  /** 塗りつぶしの隙間閉じ（セル） */
  gap: number;
  /** 境界線を海岸や他の線へ自動でつなぐ */
  snap: boolean;
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  brush: 8,
  pen: 0.8,
  fillTarget: 'land',
  gap: 2,
  snap: true,
};
