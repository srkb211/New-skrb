import { pick, pickWeighted, type Rng } from './rng';

/** 架空の固有名詞を作る命名文化 */
export interface Culture {
  key: string;
  label: string;
  /** 語根を作る音節（漢字文化は 1 字ずつ） */
  syllables: readonly string[];
  /** 漢字文化では語尾の字 */
  tails?: readonly string[];
  countrySuffix: readonly string[];
  citySuffix: readonly string[];
  govs: readonly (readonly [string, number])[];
  subdivisions: readonly string[];
  kanji?: boolean;
}

export const CULTURES: readonly Culture[] = [
  {
    key: 'west',
    label: '西方風',
    syllables: ['ア', 'ル', 'ヴェ', 'リ', 'マ', 'サ', 'テ', 'ナ', 'ロ', 'ベ', 'カ', 'ラ', 'ソ', 'フィ', 'ミ', 'ジ', 'ヴァ', 'セ', 'ト', 'ノ', 'レ', 'ヴィ', 'オ', 'エ', 'ガ', 'ダ', 'パ', 'ヴォ', 'ルカ', 'ラン', 'エル', 'モン', 'カル', 'ベル'],
    countrySuffix: ['ア', 'ニア', 'リア', 'ーナ', 'ヴィア', 'ディア', 'ティア', 'ーノ', 'ンテ'],
    citySuffix: ['ーラ', 'ーノ', 'ッサ', 'ンテ', 'ーナ', 'リオ', 'ーネ', 'ツィア', 'ーレ'],
    govs: [['王国', 5], ['公国', 2], ['共和国', 4], ['大公国', 1], ['神聖帝国', 0.5], ['連合王国', 0.7], ['都市同盟', 0.4]],
    subdivisions: ['州', '県', '領'],
  },
  {
    key: 'north',
    label: '北方風',
    syllables: ['ヴァル', 'ハイ', 'ゲル', 'ブル', 'ノル', 'スト', 'ルン', 'ドル', 'ヘル', 'フロ', 'ガン', 'ヴィン', 'エル', 'オス', 'ラグ', 'ベル', 'ムン', 'トル', 'シュ', 'ヴォル', 'イェル', 'スヴェ', 'アル', 'クラ', 'ディル', 'ホル'],
    countrySuffix: ['ラント', 'ヘイム', 'ガルド', 'マルク', 'ブルク', 'ンド', 'ヴァルト', 'ルク'],
    citySuffix: ['ブルク', 'ハイム', 'シュタット', 'ヴィク', 'ホルム', 'ガルド', 'ドルフ', 'フルト'],
    govs: [['王国', 5], ['公国', 2], ['辺境伯国', 1], ['連邦', 2], ['帝国', 1], ['選帝侯国', 0.5]],
    subdivisions: ['邦', '州', '郡', '伯領'],
  },
  {
    key: 'east',
    label: '東方風',
    syllables: ['ヴォ', 'ロ', 'ミ', 'スラ', 'ヴ', 'ボ', 'ラ', 'ツィ', 'ド', 'ネ', 'ゴ', 'ル', 'カ', 'ザ', 'ヤ', 'ミル', 'グラ', 'ヴェ', 'チェ', 'ジ', 'プ', 'リュ', 'スヴィ', 'トヴェ', 'クラ'],
    countrySuffix: ['ヴィア', 'スク', 'ニア', 'ヴァ', 'ルシ', 'ミア', 'ーヴィナ'],
    citySuffix: ['グラード', 'スク', 'ヴァ', 'ニツァ', 'ポリ', 'ゴロド', 'ヴェツ', 'ノフ'],
    govs: [['大公国', 3], ['王国', 3], ['帝国', 1], ['共和国', 3], ['連邦', 2], ['ツァーリ国', 0.8]],
    subdivisions: ['州', '県', '管区'],
  },
  {
    key: 'desert',
    label: '砂漠風',
    syllables: ['アル', 'ザ', 'カ', 'ハ', 'ラ', 'シャ', 'ム', 'ナ', 'ディ', 'ファ', 'ジャ', 'サ', 'ミ', 'バ', 'タ', 'リ', 'ク', 'ズ', 'ヤ', 'ハル', 'マル', 'ダル', 'スー', 'カー'],
    countrySuffix: ['スタン', 'ーン', 'ラ', 'ディア', 'ーム', 'ヤ', 'ール'],
    citySuffix: ['バード', 'ーン', 'ーラ', 'ダル', 'ハル', 'ーム', 'カンド', 'ーズ'],
    govs: [['首長国', 4], ['スルタン国', 3], ['王国', 2], ['共和国', 2], ['藩王国', 1], ['太守国', 1]],
    subdivisions: ['州', '県', '郡'],
  },
  {
    key: 'south',
    label: '南洋風',
    syllables: ['カ', 'ハ', 'ヌ', 'イ', 'マ', 'ロ', 'ア', 'ナ', 'ラ', 'ワ', 'ケ', 'オ', 'モ', 'ホ', 'ル', 'ティ', 'パ', 'ウ', 'リ', 'ミ', 'ヒ', 'ポ'],
    countrySuffix: ['', 'ア', 'ニ', 'ロア', 'ヌイ', 'ラニ'],
    citySuffix: ['', 'ア', 'ナ', 'ロ', 'ハ', 'ルア'],
    govs: [['王国', 4], ['首長国', 2], ['連邦', 2], ['共和国', 2], ['諸島連合', 1]],
    subdivisions: ['区', '地方', '州'],
  },
  {
    key: 'steppe',
    label: '草原風',
    syllables: ['ハン', 'テム', 'ボル', 'オル', 'ジン', 'カラ', 'バト', 'アル', 'タン', 'ウル', 'ゲ', 'セ', 'チ', 'ム', 'ダ', 'イル', 'ノ', 'ガ', 'ト', 'ス', 'ケレ', 'ヤク'],
    countrySuffix: ['', 'ル', 'ン', 'ト', 'ア', 'ガン'],
    citySuffix: ['バリク', 'クル', 'ゴル', 'ホト', 'タグ', 'オルド'],
    govs: [['汗国', 4], ['大汗国', 1], ['部族連合', 2], ['王国', 1], ['共和国', 1]],
    subdivisions: ['部', '州', '盟'],
  },
  {
    key: 'wa',
    label: '和風',
    kanji: true,
    syllables: ['秋', '朝', '青', '葦', '天', '磐', '出', '大', '葛', '白', '高', '武', '筑', '豊', '日', '美', '真', '若', '伊', '那', '鳴', '霧', '雪', '月', '星', '雲', '鷹', '鶴', '桜', '藤', '紅', '黒', '金', '風', '岩', '八', '千', '久', '長', '早', '春', '夏', '冬', '東', '西', '南', '北', '新', '古', '清', '静', '吉', '香', '宮', '富', '福', '安', '平', '和', '嶺', '玉', '常', '駿', '越', '琴', '蒼', '茜', '翠'],
    tails: ['津', '原', '島', '野', '瀬', '沢', '谷', '浦', '崎', '浜', '岡', '田', '川', '森', '宮', '江', '根', '見', '洲', '磯', '尾', '生', '城', '戸', '波', '木', '杜', '霞', '守', '代', '海', '陽', '賀', '和', '路', '国', '州'],
    countrySuffix: [''],
    citySuffix: [''],
    govs: [['国', 4], ['皇国', 2], ['王国', 1], ['藩国', 1], ['共和国', 1], ['連邦', 0.5]],
    subdivisions: ['国', '県', '州', '郡', '藩'],
  },
];

export function cultureByKey(key: string): Culture {
  return CULTURES.find((c) => c.key === key) ?? CULTURES[0];
}

const BAD_START = /^[ンーッァィゥェォャュョ]/;

/** 語根（固有名詞の核）を作る。 */
export function makeRoot(rng: Rng, culture: Culture, short = false): string {
  if (culture.kanji) {
    let a = pick(rng, culture.syllables);
    if (!short && rng() < 0.12) a += pick(rng, culture.syllables);
    let b = pick(rng, culture.tails!);
    if (b === a) b = pick(rng, culture.tails!);
    return a + b;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const count = short ? (rng() < 0.75 ? 2 : 3) : rng() < 0.55 ? 2 : 3;
    let s = '';
    let prev = '';
    for (let k = 0; k < count; k++) {
      let syl = pick(rng, culture.syllables);
      if (syl === prev) syl = pick(rng, culture.syllables);
      s += syl;
      prev = syl;
    }
    if (BAD_START.test(s)) continue;
    if (s.length > 7) continue;
    return s;
  }
  return pick(rng, culture.syllables) + pick(rng, culture.syllables);
}

export interface NameRegistry {
  used: Set<string>;
}

export function newRegistry(existing: Iterable<string> = []): NameRegistry {
  return { used: new Set(existing) };
}

function unique(reg: NameRegistry | undefined, make: () => string): string {
  let name = make();
  for (let k = 0; k < 30 && reg && reg.used.has(name); k++) name = make();
  reg?.used.add(name);
  return name;
}

export function countryName(rng: Rng, culture: Culture, reg?: NameRegistry): string {
  return unique(reg, () => {
    const root = makeRoot(rng, culture);
    if (culture.kanji) return root;
    const suf = pick(rng, culture.countrySuffix);
    // 語根の末尾が母音で終わる場合に「ア」などが重複しないよう調整
    if (suf && root.endsWith(suf.charAt(0))) return root + suf.slice(1);
    return root + suf;
  });
}

export function cityName(rng: Rng, culture: Culture, reg?: NameRegistry): string {
  return unique(reg, () => {
    const root = makeRoot(rng, culture, true);
    if (culture.kanji) return root;
    return root + pick(rng, culture.citySuffix);
  });
}

export function regionName(rng: Rng, culture: Culture, reg?: NameRegistry): string {
  return unique(reg, () => makeRoot(rng, culture, true));
}

export function govFor(rng: Rng, culture: Culture): string {
  return pickWeighted(rng, culture.govs);
}

export function subdivisionFor(rng: Rng, culture: Culture): string {
  return pick(rng, culture.subdivisions);
}

export function pickCulture(rng: Rng): Culture {
  return pickWeighted(rng, [
    [CULTURES[0], 3],
    [CULTURES[1], 3],
    [CULTURES[2], 2],
    [CULTURES[3], 2],
    [CULTURES[4], 1.2],
    [CULTURES[5], 1.2],
    [CULTURES[6], 1.5],
  ]);
}

export type FeatureKind = 'range' | 'massif' | 'peak' | 'river' | 'plain' | 'basin' | 'plateau' | 'lake';

const FEATURE_SUFFIX: Record<FeatureKind, string> = {
  range: '山脈',
  massif: '山地',
  peak: '山',
  river: '川',
  plain: '平野',
  basin: '盆地',
  plateau: '高原',
  lake: '湖',
};

export const FEATURE_LABEL: Record<FeatureKind, string> = {
  range: '山脈',
  massif: '山地',
  peak: '山頂',
  river: '河川',
  plain: '平野',
  basin: '盆地',
  plateau: '高原',
  lake: '湖',
};

export function featureName(rng: Rng, culture: Culture, kind: FeatureKind): string {
  const root = makeRoot(rng, culture, true);
  if (kind === 'peak' && !culture.kanji && rng() < 0.4) return root + '岳';
  if (kind === 'river' && rng() < 0.15) return root + '河';
  return root + FEATURE_SUFFIX[kind];
}
