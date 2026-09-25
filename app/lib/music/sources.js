/**
 * MacKit · 音乐模块 · 音源目录
 *
 * 本文件是 57 个 musicdl 音源的**元数据唯一来源**（设计文档 §3.3 / §9）：
 *   - GROUPS      : 6 大分组的展示结构（id / 中文标签 / 有序音源键）；
 *   - SOURCE_META : 「注册键名 → { label, group, defaultOn, drm, radio, note }」；
 *   - merge()     : 与运行时 `REGISTERED_MODULES.keys()` 合并成前端可用的视图；
 *   - defaultSelected() / isDrm() / resolveAlias() : 便捷查询。
 *
 * 口径（与设计文档 §1.1 的 Q1/Q2 决策一致）：
 *   - **默认只勾选「大中华区」12 源**（defaultOn=true），其余 45 源仍全部可选、默认不勾；
 *   - **3 个 DRM 源**（Apple/Spotify/TIDAL）保留但不默认勾选，UI 上加 ⚠️ 提示；
 *   - **5 个电台/听书源**单独成组（radio），需要额外解析、单源结果较少。
 *
 * SOURCE_META 的键名逐一取自 musicdl 的 `MusicClientBuilder.REGISTERED_MODULES`
 * （2026 校验，57 项），与运行结果对齐；未登记进本表的运行时音源会被归入「未分类」。
 */

// ---------------------------------------------------------------------------
// 分组定义（6 大分组）
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} GroupDef
 * @property {string} id      分组 id（英文，前端作 key）
 * @property {string} label   分组中文名
 * @property {string[]} keys  该组音源（顺序即展示顺序）
 */
/** @type {GroupDef[]} */
export const GROUPS = Object.freeze([
  {
    id: 'china',
    label: '大中华区音乐',
    keys: [
      'QQMusicClient', 'NeteaseMusicClient', 'KugouMusicClient', 'KuwoMusicClient',
      'MiguMusicClient', 'QianqianMusicClient', 'BilibiliMusicClient', 'StreetVoiceMusicClient',
      'SodaMusicClient', 'FiveSingMusicClient', 'BodianMusicClient', 'MOOVMusicClient',
    ],
  },
  {
    id: 'global',
    label: '全球流媒体',
    keys: [
      'YouTubeMusicClient', 'JooxMusicClient', 'AppleMusicClient', 'SoundCloudMusicClient',
      'DeezerMusicClient', 'QobuzMusicClient', 'SpotifyMusicClient', 'TIDALMusicClient',
      'JioSaavnMusicClient', 'SunoMusicClient', 'FMAMusicClient',
    ],
  },
  {
    id: 'indie',
    label: '独立 / 开放版权',
    keys: [
      'JamendoMusicClient', 'OpenGameArtMusicClient', 'WikimediaCommonsMusicClient',
      'AudiusMusicClient', 'CCMixterMusicClient',
    ],
  },
  {
    id: 'radio',
    label: '电台 / 听书',
    keys: [
      'XimalayaMusicClient', 'LizhiMusicClient', 'QingtingMusicClient',
      'LRTSMusicClient', 'ITunesMusicClient',
    ],
  },
  {
    id: 'aggregator',
    label: '聚合器',
    keys: [
      'MP3JuiceMusicClient', 'TuneHubMusicClient', 'GDStudioMusicClient',
      'MyFreeMP3MusicClient', 'JBSouMusicClient', 'XiaoBaiMusicClient',
    ],
  },
  {
    id: 'thirdparty',
    label: '第三方下载站',
    keys: [
      'MituMusicClient', 'BuguyyMusicClient', 'GequbaoMusicClient', 'YinyuedaoMusicClient',
      'XiagebaMusicClient', 'FangpiMusicClient', 'FiveSongMusicClient', 'KKWSMusicClient',
      'GequhaiMusicClient', 'LivePOOMusicClient', 'HTQYYMusicClient', 'TwoT58MusicClient',
      'YinyuekuMusicClient', 'LiziYYMusicClient', 'MGMP3MusicClient', 'ITingWaMusicClient',
      'SgogoMusicClient', 'XMFWAVMusicClient',
    ],
  },
]);

// ---------------------------------------------------------------------------
// 音源元数据
// ---------------------------------------------------------------------------
/** 默认勾选的分组 id（Q1：默认只勾大中华区 12 源） */
const DEFAULT_ON_GROUPS = Object.freeze(['china']);
/** DRM 源（依赖 pywidevine 解密，PolyForm 非商业许可叠加 DRM，默认不勾 + ⚠️） */
const DRM_SOURCES = Object.freeze(['AppleMusicClient', 'SpotifyMusicClient', 'TIDALMusicClient']);
/** 电台/听书源（分组即 radio，单独标注，单源结果较少） */
const RADIO_GROUP = 'radio';

/**
 * 音源中文标签表（键名与 musicdl REGISTERED_MODULES 完全一致）。
 * @type {Record<string,string>}
 */
const LABELS = Object.freeze({
  // 大中华区
  QQMusicClient: 'QQ音乐', NeteaseMusicClient: '网易云音乐', KugouMusicClient: '酷狗音乐',
  KuwoMusicClient: '酷我音乐', MiguMusicClient: '咪咕音乐', QianqianMusicClient: '千千音乐',
  BilibiliMusicClient: '哔哩哔哩', StreetVoiceMusicClient: '街声', SodaMusicClient: '汽水音乐',
  FiveSingMusicClient: '5sing', BodianMusicClient: '波点音乐', MOOVMusicClient: 'MOOV',
  // 全球流媒体
  YouTubeMusicClient: 'YouTube Music', JooxMusicClient: 'JOOX', AppleMusicClient: 'Apple Music',
  SoundCloudMusicClient: 'SoundCloud', DeezerMusicClient: 'Deezer', QobuzMusicClient: 'Qobuz',
  SpotifyMusicClient: 'Spotify', TIDALMusicClient: 'TIDAL', JioSaavnMusicClient: 'JioSaavn',
  SunoMusicClient: 'Suno', FMAMusicClient: 'Free Music Archive',
  // 独立 / 开放版权
  JamendoMusicClient: 'Jamendo', OpenGameArtMusicClient: 'OpenGameArt',
  WikimediaCommonsMusicClient: '维基共享资源', AudiusMusicClient: 'Audius', CCMixterMusicClient: 'ccMixter',
  // 电台 / 听书
  XimalayaMusicClient: '喜马拉雅', LizhiMusicClient: '荔枝FM', QingtingMusicClient: '蜻蜓FM',
  LRTSMusicClient: '懒人听书', ITunesMusicClient: 'iTunes',
  // 聚合器
  MP3JuiceMusicClient: 'MP3Juice', TuneHubMusicClient: 'TuneHub', GDStudioMusicClient: 'GDStudio',
  MyFreeMP3MusicClient: 'MyFreeMP3', JBSouMusicClient: '极贝搜索', XiaoBaiMusicClient: '小白音乐',
  // 第三方下载站
  MituMusicClient: '米兔音乐', BuguyyMusicClient: '布谷音乐', GequbaoMusicClient: '歌曲宝',
  YinyuedaoMusicClient: '音乐岛', XiagebaMusicClient: '下歌吧', FangpiMusicClient: '放屁音乐',
  FiveSongMusicClient: '五歌', KKWSMusicClient: '可可微音乐', GequhaiMusicClient: '歌曲海',
  LivePOOMusicClient: 'LivePOOMusic', HTQYYMusicClient: '好好听音乐', TwoT58MusicClient: '58听书',
  YinyuekuMusicClient: '音乐库', LiziYYMusicClient: '栗子音乐', MGMP3MusicClient: 'MGMP3',
  ITingWaMusicClient: '爱听蛙', SgogoMusicClient: '搜狗音乐', XMFWAVMusicClient: '熊猫无损',
});

/**
 * 「注册键名 → 元数据」表。未登记的运行时音源由 merge() 归入「未分类」且 defaultOn=false。
 * @type {Record<string,{label:string,group:string,defaultOn:boolean,drm:boolean,radio:boolean,note:string}>}
 */
export const SOURCE_META = Object.freeze(
  Object.fromEntries(GROUPS.flatMap((g) => g.keys.map((k) => {
    const drm = DRM_SOURCES.includes(k);
    const radio = g.id === RADIO_GROUP;
    const defaultOn = DEFAULT_ON_GROUPS.includes(g.id) && !drm;
    let note = '';
    if (drm) note = 'DRM 音源（需自备账号，非商业用途请自行评估）';
    else if (radio) note = '电台 / 听书源，需额外解析、单源结果较少';
    return [k, { label: LABELS[k] || k, group: g.id, defaultOn, drm, radio, note }];
  })))
);

/** 全部音源的规范顺序（按分组顺序拍平），用于稳定展示与计数。 */
export const SOURCE_KEYS = Object.freeze(GROUPS.flatMap((g) => g.keys));

/**
 * 别名 → 注册键名（设计 §3.2 手写示例里的 `QQMusic` 等简写 / 常见拼写归一）。
 * 匹配大小写不敏感：先按注册键名精确匹配，再落到本表。
 * @type {Record<string,string>}
 */
const ALIASES = Object.freeze({
  qq: 'QQMusicClient', qqmusic: 'QQMusicClient', 'qq音乐': 'QQMusicClient',
  netease: 'NeteaseMusicClient', '163': 'NeteaseMusicClient', wyy: 'NeteaseMusicClient',
  kugou: 'KugouMusicClient', kuwo: 'KuwoMusicClient', migu: 'MiguMusicClient',
  baidu: 'QianqianMusicClient', qianqian: 'QianqianMusicClient', bilibili: 'BilibiliMusicClient',
  streetvoice: 'StreetVoiceMusicClient', soda: 'SodaMusicClient', fivesing: 'FiveSingMusicClient',
  bodian: 'BodianMusicClient', moov: 'MOOVMusicClient',
  youtube: 'YouTubeMusicClient', yt: 'YouTubeMusicClient', joox: 'JooxMusicClient',
  apple: 'AppleMusicClient', 'apple music': 'AppleMusicClient', soundcloud: 'SoundCloudMusicClient',
  deezer: 'DeezerMusicClient', qobuz: 'QobuzMusicClient', spotify: 'SpotifyMusicClient',
  tidal: 'TIDALMusicClient', jiosaavn: 'JioSaavnMusicClient', suno: 'SunoMusicClient', fma: 'FMAMusicClient',
  jamendo: 'JamendoMusicClient', opengameart: 'OpenGameArtMusicClient',
  wikimedia: 'WikimediaCommonsMusicClient', audius: 'AudiusMusicClient', ccmixter: 'CCMixterMusicClient',
  ximalaya: 'XimalayaMusicClient', lizhi: 'LizhiMusicClient', qingting: 'QingtingMusicClient',
  lrts: 'LRTSMusicClient', itunes: 'ITunesMusicClient',
  mp3juice: 'MP3JuiceMusicClient', tunehub: 'TuneHubMusicClient', gdstudio: 'GDStudioMusicClient',
  myfreemp3: 'MyFreeMP3MusicClient', jbsou: 'JBSouMusicClient', xiaobai: 'XiaoBaiMusicClient',
});

// ---------------------------------------------------------------------------
// 查询 / 合并
// ---------------------------------------------------------------------------
/**
 * 默认勾选的音源（大中华区 12，排除 DRM）。
 * @returns {string[]}
 */
export function defaultSelected() {
  return SOURCE_KEYS.filter((k) => SOURCE_META[k] && SOURCE_META[k].defaultOn);
}

/**
 * 是否为 DRM 音源。
 * @param {string} name
 * @returns {boolean}
 */
export function isDrm(name) {
  const meta = SOURCE_META[name];
  return !!(meta && meta.drm);
}

/**
 * 把任意写法归一为注册键名（精确匹配 → 别名；都失败返回 null）。
 * @param {string} name
 * @returns {string|null}
 */
export function resolveAlias(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  if (SOURCE_META[raw]) return raw;
  return ALIASES[raw.toLowerCase()] || null;
}

/** 把一个注册键名投影为前端视图条目。 */
function toView(key) {
  const meta = SOURCE_META[key];
  return {
    name: key,
    label: meta ? meta.label : key,
    defaultOn: !!(meta && meta.defaultOn),
    drm: !!(meta && meta.drm),
    radio: !!(meta && meta.radio),
    note: meta ? (meta.note || '') : '',
  };
}

/**
 * 与运行时 `REGISTERED_MODULES.keys()` 合并，生成前端可用的音源视图。
 *
 * @param {string[]|null} registered 运行时已登记的音源键列表；为 null/空表示「不可知」
 *        （musicdl 未安装）——此时返回静态目录、`registered:false`。
 * @returns {{groups:Array<{id:string,label:string,sources:object[]}>,
 *            total:number, defaultSelected:string[], registered:boolean}}
 */
export function merge(registered) {
  const reg = Array.isArray(registered)
    ? registered.filter((k) => typeof k === 'string' && k.length > 0) : null;
  const present = reg && reg.length ? new Set(reg) : null;

  const groups = [];
  const used = new Set();
  for (const g of GROUPS) {
    const sources = [];
    for (const key of g.keys) {
      if (present && !present.has(key)) continue; // 运行时没有该源：过滤掉
      sources.push(toView(key));
      used.add(key);
    }
    if (sources.length > 0) groups.push({ id: g.id, label: g.label, sources });
  }

  // 运行时登记了、但 SOURCE_META 未收录的音源 → 归入「未分类」，defaultOn=false
  if (present) {
    const extra = [...present].filter((k) => !used.has(k)).sort();
    if (extra.length > 0) {
      groups.push({
        id: 'unclassified',
        label: '未分类',
        sources: extra.map((k) => ({ name: k, label: k, defaultOn: false, drm: false, radio: false, note: '未登记的音源，默认不勾选' })),
      });
    }
  }

  const total = groups.reduce((n, g) => n + g.sources.length, 0);
  return { groups, total, defaultSelected: defaultSelected(), registered: !!present };
}
