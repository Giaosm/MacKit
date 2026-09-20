/**
 * MacKit · 音乐下载（视图）
 *
 * 契约（对齐 web/app.js 顶部说明）：默认导出 { id, title, mount(root, ctx), unmount?() }。
 * 侧边栏图标由 app.js 的 NAV 统一提供，视图不自带。
 *
 * 后端接口（本视图只读查询 + 任务提交，绝不直接跑子进程）：
 *   - GET  /api/music/deployStatus?force=1   → 四态部署状态（not_deployed/broken/deployed/outdated）
 *   - GET  /api/music/sources                → 57 音源（6 分组 + 默认勾选）
 *   - GET  /api/music/config                 → 下载目录 / 模板 / 通道 / 已选音源
 *   - PUT  /api/music/config                 → 保存上述四项
 *   - GET  /api/music/chooseFolder           → osascript 选择目录（失败回落手输）
 *   - POST /api/music/openFolder              → 在 Finder 打开下载目录（普通动作，目录不存在自动创建）
 *   - POST /api/music/search                 → 起一次搜索会话（立即返回 searchId）
 *   - GET  /api/music/search/:id?since=n     → 轮询增量
 *   - POST /api/music/search/:id/cancel      → 取消搜索
 *   - POST /api/music/playlist               → 起一次歌单解析会话（与搜索同构，同一结果表）
 *   - GET  /api/music/playlist/:id?since=n   → 轮询增量
 *   - POST /api/tasks {module:'music',…}     → 安装 / 卸载 / 下载（★ 不走 ctx.runTask，见 §5.6）
 *
 * ★ 两条硬性约定（设计 §5.6）：
 *   1) 提交任务**不用** `ctx.runTask`：直接 `ctx.api('POST','/api/tasks',…)`，
 *      避免占用全局 `state.running` 而阻塞用户在其它视图发起任务；
 *   2) 结果表**不用** `ctx.ui.dataTable`（其 `setRows` 会清空勾选），自建表 + `Map<uid,row>` 保选中态。
 *
 * ★ 入口降级：未部署 / 损坏（not_deployed / broken）时**只渲染部署区**，不创建搜索 / 结果 / 队列 DOM。
 */

// ============================== 定时器 / 实时流 ==============================
/** 视图内所有 interval 的登记处，unmount 时统一回收。 */
const timers = new Set();
/**
 * 视图是否已卸载（mount 复位 false / unmount 置 true）。
 * ★ 卸载后在途的异步续跑（await 之后）不得再注册 interval / EventSource 或触碰 DOM：
 *   新实例的 clearTimers 无从回收这些句柄，否则就是永久泄漏。
 */
let disposed = false;
/** 打开中的 EventSource（实时日志流）登记处；unmount / 切换任务时必须全部关闭，避免连接泄漏。 */
const sseSources = new Set();
/**
 * 每个任务的「实时态」：已收到的日志行 + 当前日志容器 + SSE 句柄 + 是否已收尾。
 * 视图每 1.5s 重绘队列，日志区内容从这里回填，保证滚动内容不丢、不重建连接。
 * `renderedLines` = 已渲染进 logEl 的日志行数（增量 append 的游标）；
 * `hasPlaceholder` = 当前容器里是否只挂着「等待日志…」占位行。
 * @type {Map<string, {lines:object[], logEl:HTMLElement|null, stream:object|null, done:boolean, startedAt:number, pinned:boolean, renderedLines:number, hasPlaceholder:boolean}>}
 */
const live = new Map();

/** SSE 自动重连次数上限：超过则回落一次性查询（与外壳 app.js 同口径）。 */
const SSE_MAX_RETRY = 5;
/** 断流后兜底轮询间隔（毫秒）。 */
const TASK_FALLBACK_MS = 2000;
/** 单个任务实时日志最多保留的行数（避免超长下载日志拖垮渲染）。 */
const LIVE_LOG_MAX = 500;
/** 搜索轮询遇到网络类失败时的连续容忍次数（业务错误仍立即判失败）。 */
const POLL_NET_RETRY_MAX = 3;
/** 分页：结果区每页 10 首；下载队列每页 5 条（列表本身最新在前）。 */
const RESULTS_PER_PAGE = 10;
const QUEUE_PER_PAGE = 5;

/** 取（或惰性创建）某任务的实时态。 */
function liveFor(id) {
  let e = live.get(id);
  if (!e) {
    e = { lines: [], logEl: null, stream: null, done: false, startedAt: 0, pinned: true, renderedLines: 0, hasPlaceholder: false };
    live.set(id, e);
  }
  return e;
}

function addTimer(fn, ms) { if (disposed) return null; const h = setInterval(fn, ms); timers.add(h); return h; }

/** 关闭单个 EventSource 并注销。 */
function closeSource(es) {
  if (!es) return;
  try { es.close(); } catch { /* ignore */ }
  sseSources.delete(es);
}

// ============================== 播放引擎（模块级单例，跨视图存活） ==============================
/**
 * 播放引擎单例：**跨视图存活** —— 切换模块不停播；切回时无缝接管 UI。
 *
 * 地基：app.js 用动态 `import()` 加载视图模块，同一模块只求值一次 → 顶层 `let/const` 跨切换存活；
 *       `<audio>` 被移出文档后仍继续播放（只要 JS 持有引用）。
 * · ui        ：当前已挂载视图的播放条 DOM 引用集合；**null = 视图未挂载（后台播放中）**。
 * · ctx       ：最近一次 mount 的上下文（el / api / ui.toast 用；unmount 后仍保留，后台可用）。
 * · sessId    ：**正在播放**曲目所属的 searchId（stream / lyric 路由用）。
 * · viewSessId：当前视图结果集所属的 searchId（用于 playRow 建立播放列表）。
 * · rows      ：当前视图结果行（供 playableTracks / 播放回退用）。
 */
const player = {
  audio: null, uid: null, row: null, list: [], index: -1,
  volume: 1, dragging: false,
  ui: null, ctx: null, sessId: null, viewSessId: null, rows: [],
  lyric: { open: true, uid: null, lines: [], active: -1, synced: false, loading: false, error: null, cache: new Map() },
};

/**
 * 歌词缓存上限（有界 LRU）：cache 为模块级 Map，跨视图整页存活；每播放一首就写入一条，
 * 不设上限会在长会话里无限增长。超限时按插入序逐出最旧条目。
 */
const LYRIC_CACHE_MAX = 60;

/** 会话快照：unmount 时保存，切回时恢复（**仅内存**，不落 localStorage）。 */
let lastSession = null;
/** 当前实例的 saveSession（unmount 时从模块级入口调用）。 */
let saveSessionFn = null;

/** 视图卸载时只解绑 UI 引用（**绝不** pause / 清 src / remove audio —— 后台继续播放）。 */
function detachPlayerUI() { player.ui = null; }

/** 封面路由 URL（uid 必含 `#` → 必须 encodeURIComponent）。 */
function coverUrlFor(sessId, uid) {
  return `/api/music/cover/${encodeURIComponent(sessId || '')}/${encodeURIComponent(uid)}`;
}
/** 播放路由 URL（裸二进制流；uid 必 encodeURIComponent，否则 `#` 会被当 URL 片段丢弃）。 */
function streamUrlFor(sessId, uid) {
  return `/api/music/stream/${encodeURIComponent(sessId || '')}/${encodeURIComponent(uid)}`;
}

/** 播放相关提示（视图未挂载时静默）。 */
function playerToast(level, text) {
  try { if (player.ctx && player.ctx.ui) player.ctx.ui.toast(level, text); } catch { /* ignore */ }
}

/** 惰性创建 <audio> 并绑定事件（**只建一次**，跨视图复用；元素本身不显形）。 */
function ensureAudio() {
  if (player.audio) return player.audio;
  const el = player.ctx && player.ctx.el;
  if (!el) return null; // 尚未 mount（正常流程不会：首次播放一定发生在视图内）
  const a = el('audio', { preload: 'metadata' });
  a.volume = player.volume;
  a.addEventListener('play', () => syncPlayButton());
  a.addEventListener('pause', () => syncPlayButton());
  a.addEventListener('ended', () => playAdjacent(1)); // 放完自动下一首（视图未挂载也照走）
  a.addEventListener('timeupdate', () => {
    syncProgress();
    syncLyric(); // ★ 即使视图未挂载也推进歌词索引 → 切回时正停在当前句
  });
  a.addEventListener('loadedmetadata', () => { syncProgress(); });
  a.addEventListener('error', () => {
    if (player.uid) playerToast('err', '播放失败：该音源可能已失效或被限流');
    syncPlayButton();
  });
  player.audio = a;
  return a;
}

/** 可播放曲目（按当前结果表顺序；排除专辑行 / 无直链 / HLS）。 */
function playableTracks() {
  return (player.rows || []).filter((r) => r.kind === 'track' && r.playable !== false && r.protocol !== 'HLS');
}

/** 播放某行（重建播放列表 = 当前结果顺序；列表本身不落前端，直链由路由取）。 */
function playRow(row) {
  if (!row || row.kind !== 'track') return;
  if (row.protocol === 'HLS') { playerToast('warn', '该音源为 HLS，暂不支持在线试听'); return; }
  if (row.playable === false) { playerToast('warn', '该曲目没有可用的在线播放直链'); return; }
  const list = playableTracks();
  let idx = list.findIndex((x) => x.uid === row.uid);
  if (idx < 0) { list.push(row); idx = list.length - 1; }
  player.list = list; player.index = idx;
  player.sessId = player.viewSessId; // 记住本曲所属会话（后台自动下一首时仍用它取直链）
  loadCurrent(true);
}

/** 加载并（可选）播放当前索引曲目。 */
function loadCurrent(autoplay) {
  const row = player.list[player.index];
  if (!row) return;
  const a = ensureAudio();
  if (!a) return;
  player.uid = row.uid; player.row = row;
  a.src = streamUrlFor(player.sessId, row.uid); // 每次切歌换 src；浏览器 seek 自动发 Range，服务端已支持 206
  renderNowPlaying();
  loadLyric(row.uid); // 内联歌词行默认显示：无条件加载（按 uid 缓存，切歌成本可控）
  if (autoplay !== false) { const p = a.play(); if (p && p.catch) p.catch(() => { /* 自动播放被拒：保留暂停态 */ }); }
  syncPlayButton();
}

/** 上一首（dir=-1）/ 下一首（dir=+1），循环。 */
function playAdjacent(dir) {
  if (player.list.length === 0) return;
  player.index = (player.index + dir + player.list.length) % player.list.length;
  loadCurrent(true);
}

function togglePlay() {
  const a = player.audio;
  if (!a || !player.uid) {
    const first = playableTracks()[0];
    if (first) playRow(first); else playerToast('warn', '没有可播放的曲目（先搜索，且音源需支持试听）');
    return;
  }
  if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
  else a.pause();
}

/** 播放/暂停图标（视图未挂载时不动 DOM）。 */
function syncPlayButton() {
  const ui = player.ui;
  if (!ui || !ui.playBtn) return;
  const playing = !!(player.audio && !player.audio.paused && player.uid);
  ui.playBtn.textContent = playing ? '‖' : '▶';
  ui.playBtn.title = playing ? '暂停' : '播放';
}

/** 进度 / 时间标签同步（拖动中不抢占；视图未挂载时仅更新状态，不碰 DOM）。 */
function syncProgress() {
  const a = player.audio;
  if (!a) return;
  const dur = Number.isFinite(a.duration) ? a.duration : 0;
  const ui = player.ui;
  if (!ui) return; // 后台播放：不碰 DOM
  if (ui.seekEl && !player.dragging) {
    ui.seekEl.value = String(dur > 0 ? Math.round((a.currentTime / dur) * 1000) : 0);
    ui.seekEl.disabled = !(dur > 0);
  }
  if (ui.curTimeEl) ui.curTimeEl.textContent = fmtClock(a.currentTime);
  if (ui.durTimeEl) ui.durTimeEl.textContent = fmtClock(dur);
}

/** 播放条「当前曲目」区（标题 / 歌手·专辑 / 封面）。 */
function renderNowPlaying() {
  const ui = player.ui;
  if (!ui) return;
  const el = player.ctx.el;
  const row = player.row;
  if (ui.npTitleEl) ui.npTitleEl.textContent = row ? (row.songname || '（未知曲目）') : '未在播放';
  if (ui.npMetaEl) ui.npMetaEl.textContent = row ? ([row.singers, row.album].filter(Boolean).join(' · ') || '—') : '';
  if (!ui.npCoverEl) return;
  ui.npCoverEl.innerHTML = '';
  if (row && row.has_cover) {
    const im = el('img', { class: 'music-np__cover', src: coverUrlFor(player.sessId, row.uid), alt: '' });
    im.addEventListener('error', () => { im.replaceWith(el('div', { class: 'music-np__cover is-empty' })); });
    ui.npCoverEl.append(im);
  } else {
    ui.npCoverEl.append(el('div', { class: 'music-np__cover is-empty' }));
  }
}

/** 内联单行歌词（播放条内、进度条下方）：五态（未播放 / 加载中 / 失败 / 无歌词 / 当前句）。 */
function renderLyricLine() {
  const ui = player.ui;
  if (!ui || !ui.npLyricEl) return;
  const box = ui.npLyricEl;
  const lyric = player.lyric;
  box.classList.toggle('is-hidden', !lyric.open);
  let text = '—';
  let muted = true;
  if (!player.uid) { text = '未在播放'; }
  else if (lyric.loading) { text = '歌词加载中…'; }
  else if (lyric.error) { text = lyric.error; }
  else if (!lyric.lines.length) { text = '该曲目无歌词'; }
  else if (lyric.active < 0) { text = '…'; }
  else { text = lyric.lines[lyric.active].text || '…'; muted = false; }
  box.textContent = text;
  box.classList.toggle('is-muted', muted);
}

/** 显示 / 隐藏内联单行歌词（不再有展开面板；唯一调用点即无参切换）。 */
function toggleLyric() {
  const lyric = player.lyric;
  lyric.open = !lyric.open;
  const ui = player.ui;
  if (ui && ui.lyricBtn) ui.lyricBtn.classList.toggle('is-active', lyric.open);
  renderLyricLine();
}

/** 拉取并解析当前曲目歌词（带 uid 级缓存；切歌竞态用 lyric.uid 兜住）。 */
async function loadLyric(uid) {
  const lyric = player.lyric;
  if (!uid) return;
  lyric.uid = uid;
  const cached = lyric.cache.get(uid);
  if (cached) {
    lyric.lines = cached.lines; lyric.synced = cached.synced;
    lyric.active = -1; lyric.loading = false; lyric.error = null;
    renderLyricLine(); syncLyric();
    return;
  }
  lyric.lines = []; lyric.synced = false; lyric.active = -1; lyric.loading = true; lyric.error = null;
  renderLyricLine();
  const api = player.ctx && player.ctx.api;
  let data;
  try { data = await api('GET', `/api/music/lyric/${encodeURIComponent(player.sessId || '')}/${encodeURIComponent(uid)}`); }
  catch (err) {
    if (lyric.uid !== uid) return; // 已切歌：丢弃过期响应
    lyric.loading = false; lyric.error = (err && err.message) || '歌词加载失败';
    renderLyricLine();
    return;
  }
  if (lyric.uid !== uid) return; // 已切歌：丢弃过期响应
  const lines = parseLrc(data && data.lrc);
  const synced = !!(data && data.synced) || lines.length > 0;
  lyric.cache.set(uid, { lines, synced });
  // 有界 LRU：Map 按插入序迭代，超上限逐出最旧；不逐出刚写入、后续立即要读的 uid。
  while (lyric.cache.size > LYRIC_CACHE_MAX) {
    const oldest = lyric.cache.keys().next().value;
    if (oldest === uid) break;
    lyric.cache.delete(oldest);
  }
  lyric.lines = lines; lyric.synced = synced; lyric.loading = false; lyric.error = null;
  lyric.active = -1;
  renderLyricLine(); syncLyric();
}

/** 依 currentTime 计算当前句索引（timeupdate 驱动），变化时刷新内联行（未挂载则只更索引）。 */
function syncLyric() {
  const lyric = player.lyric;
  const a = player.audio;
  const t = a ? a.currentTime : 0;
  let idx = -1;
  for (let i = 0; i < lyric.lines.length; i++) { if (lyric.lines[i].t <= t + 0.05) idx = i; else break; }
  if (idx !== lyric.active) { lyric.active = idx; renderLyricLine(); }
}

/** 统一回收：所有 interval + 所有实时流 + 实时态（unmount / 重新 mount 时调用）。
    ★ 播放器**不在此回收**：跨视图继续播放由模块级 player 单例持有。 */
function clearTimers() {
  for (const h of timers) clearInterval(h);
  timers.clear();
  for (const es of Array.from(sseSources)) closeSource(es);
  live.clear();
}

/** 部署状态四态 → 展示元数据。 */
const DEPLOY_META = {
  not_deployed: { light: 'warn', tone: 'warn', label: '尚未安装音频环境' },
  broken: { light: 'error', tone: 'err', label: '音频环境损坏' },
  deployed: { light: 'ok', tone: 'ok', label: '音频环境已就绪' },
  outdated: { light: 'warn', tone: 'warn', label: '音频环境可更新' },
};

/** 安装命令预览（部署区与确认框共用）。 */
const INSTALL_COMMANDS = [
  'python3.12 -m venv ~/.mackit/py/venv',
  '~/.mackit/py/venv/bin/pip install -U pip musicdl',
  '~/.mackit/py/venv/bin/python -c "import musicdl"',
];

// ============================== 无状态小工具 ==============================
/**
 * 秒 → `m:ss`（结果表时长列与播放条计时共用的**唯一**实现）。
 * @param {number} sec
 * @param {boolean} [dashForBad] true → 非法 / 非正值回落 `—`（结果表）；默认回落 `0:00`（播放条计时）。
 */
function fmtClock(sec, dashForBad) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0 || (dashForBad === true && s === 0)) return dashForBad === true ? '—' : '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** 日志等级 → 着色类（队列实时日志与「查看日志」弹窗共用；两处映射不再各自漂移）。 */
function logLevelClass(level) {
  if (level === 'error') return 'diff__del';
  if (level === 'ok') return 'diff__add';
  if (level === 'warn') return 'diff__warn';
  return 'diff__same';
}

/** 是否网络类失败（搜索轮询可重试）：api() 把 fetch 抛错统一包成 NET_UNREACHABLE；无 code 的裸异常同按抖动处理。 */
function isNetErr(err) {
  const code = err && err.code;
  return code === 'NET_UNREACHABLE' || !code;
}

/** 秒 → `1m20s` / `45s`（安装「已用时」展示用；非法值按 0）。 */
function fmtElapsed(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h${String(m % 60).padStart(2, '0')}m`; }
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

function isTerminalTask(status) { return status === 'ok' || status === 'fail' || status === 'cancelled'; }

/** 人类可读字节数（0/非法 → 空串，交由调用方决定占位）。 */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** R3a-1：文件大小列；缺失（0/非法）显 `—`（**绝不显 `0 B`**）。 */
function fmtSize(n) {
  return fmtBytes(n) || '—';
}

/**
 * R3a-1：码率展示。musicdl 的 bitrate 单位统一为 **kbps**（已**移除** v1 的 `/1000` 启发式），
 * 缺失（null/0/非法）返回空串，交由 fmtQuality 决定是否只显编码。
 */
function fmtBitrate(b) {
  const v = Number(b);
  if (!Number.isFinite(v) || v <= 0) return '';
  return `${Math.round(v)}k`;
}

/** 码率是否可得（供 tooltip 判定）。 */
function hasBitrate(row) {
  const v = Number(row && row.bitrate);
  return Number.isFinite(v) && v > 0;
}

/**
 * 格式 / 码率列（R3a-1）：码率可得显 `<编码/扩展名> · <kbps>k`；不可得**只显编码/扩展名**。
 * **绝不显 `0k` 或空白**（缺失整体回落 `—`）。
 */
function fmtQuality(row) {
  const codec = (row && row.codec) ? String(row.codec).toUpperCase()
    : (row && row.ext ? String(row.ext).toUpperCase() : '');
  const br = fmtBitrate(row && row.bitrate);
  return [codec, br].filter(Boolean).join(' · ') || '—';
}

/** 扩展名 → 音质优先级（Q6：flac>wav>m4a/aac>ogg/opus>mp3）。 */
const EXT_RANK = { flac: 6, wav: 5, m4a: 4, aac: 4, ogg: 3, opus: 3, mp3: 2 };

/** 按命名模板渲染一个示例文件名（用于下载确认 / 模板预览）。 */
function applyTemplate(tmpl, row) {
  const r = row || { singers: '周杰伦', songname: '晴天', album: '叶惠美', source: 'QQMusicClient', ext: 'flac' };
  return String(tmpl || '{歌手} - {歌名}.{ext}')
    .split('{歌手}').join(r.singers || '未知歌手')
    .split('{歌名}').join(r.songname || '未知曲目')
    .split('{专辑}').join(r.album || '')
    .split('{来源}').join(String(r.source || '').replace(/MusicClient$/, ''))
    .split('{ext}').join(r.ext || 'mp3');
}

/**
 * 解析 LRC 歌词文本 → `[{ t, text }]`（按时间升序）。
 *
 * 支持 `[mm:ss]` / `[mm:ss.xx]` / `[m:ss.xxx]`，一行多时间轴（`[00:01.00][00:10.00]词`）展开为多条；
 * 无时间轴的行与元数据标签（`[ar:…]` / `[ti:…]`）一律忽略。空文本 → `[]`。
 * @param {string} text
 * @returns {Array<{t:number, text:string}>}
 */
function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [];
    let last = 0;
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3]) / (10 ** m[3].length) : 0;
      times.push(min * 60 + sec + frac);
      last = re.lastIndex;
    }
    if (times.length === 0) continue;
    const lyric = raw.slice(last).trim();
    if (!lyric) continue;
    for (const t of times) out.push({ t, text: lyric });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ============================== 主视图 ==============================
export default {
  id: 'music',
  title: '音乐下载',

  async mount(root, ctx) {
    disposed = false; // ★ 新挂载复位卸载标记（unmount 置 true；addTimer / 异步续跑据此短路）
    clearTimers();
    player.ctx = ctx; // 记住本次上下文（el / api / ui.toast）——后台播放时仍可用
    const app = createApp(root, ctx);
    await app.start();
  },

  // ★ 切走时**不停播**：只回收本视图的 interval/SSE、解绑播放条 UI 引用，并快照会话状态。
  unmount() {
    disposed = true; // ★ 先落标记再清句柄：在途 await 续跑回来后一律短路
    clearTimers();
    detachPlayerUI();
    if (typeof saveSessionFn === 'function') { try { saveSessionFn(); } catch { /* ignore */ } }
  },
};

/**
 * 构造一次视图实例（闭包持有全部状态，便于 unmount 时随计时器一并丢弃）。
 * @param {HTMLElement} root
 * @param {object} ctx 外壳上下文（见 app.js makeCtx）
 */
function createApp(root, ctx) {
  const { el } = ctx;
  const api = ctx.api;

  const head = el('div', { class: 'view-head' }, [
    el('div', {}, [
      el('h1', { text: '音乐下载' }),
      el('div', { class: 'muted', text: '跨 57 个音源搜索并下载 · Python 依赖独立隔离在 ~/.mackit/py，不使用 sudo、不污染系统' }),
    ]),
  ]);
  const body = el('div');
  root.append(head, body);

  const app = {
    // 部署 / 元数据
    deploy: null,
    mountedUsable: undefined,
    sources: null,
    config: null,
    selSources: new Set(),
    // 会话（搜索 / 歌单共用）
    sess: { id: null, kind: 'search', since: 0, status: 'idle', rows: [], counts: {}, error: null, sourcesTotal: 0, netFails: 0 },
    lastKeyword: '',
    pollTimer: null,
    selected: new Map(), // uid -> row（自建表的选中态，跨增量刷新保持）
    expanded: new Set(), // 已展开的专辑 uid
    sort: { key: null, dir: 'desc' }, // R3a/ P1-2：结果表排序（key: 'quality' | 'size' | null）
    sortThs: {}, // R3a/ P1-2：可排序表头的 DOM 引用（key -> { th, arrowEl }），供 syncSortIndicators 刷新箭头
    musicdlUpstream: null, // musicdl 上游版本（PyPI 实时查询结果；deployStatus 只带缓存摘要）
    upstreamShown: false,  // 上游提示当前是否已渲染（翻转时才重绘环境条，避免无谓打断）
    restoredSession: false, // 切回本视图时是否已灌入会话快照（只恢复一次）
    // 任务队列
    tasks: [],
    taskTimer: null,
    seenTerminal: new Set(),
    // DOM 引用
    envBarNode: null,
    kwInput: null,
    urlInput: null,
    srcBadge: null,
    searchBtn: null,
    searchStatusEl: null,
    resEls: null,
    queueEl: null,
    dirPathEl: null,
    dirCardNode: null,
    // 分页：结果区 10 首/页、队列 5 条/页（最新在前）
    resPage: 1,
    qPage: 1,
    // 安装进度 / 实时日志（Bug C）
    installBtn: null,
    submitting: false,
    elapsedNodes: [],
    elapsedTimer: null,
    // 性能设置输入（C3）
    cacheMaxInput: null, concInput: null,
  };

  // ------------------------------ 会话快照（切回本模块恢复搜索结果） ------------------------------
  /** 保存当前会话快照（unmount 时由模块级入口调用）。 */
  function saveSession() {
    if (!app.sess) return;
    lastSession = {
      sess: app.sess,
      lastKeyword: app.lastKeyword,
      lastPerSource: app.lastPerSource,
      selSources: new Set(app.selSources),
      selected: new Map(app.selected),
      expanded: new Set(app.expanded),
      sort: { ...app.sort },
    };
  }
  saveSessionFn = saveSession;

  /** 切回时把快照灌回新实例（只做一次；灌完即清）。 */
  function restoreSession() {
    const s = lastSession;
    if (!s) return;
    app.sess = s.sess;
    app.sess.netFails = 0; // ★ 连续网络失败计数跨视图不继承（只统计同一段轮询内的「连续」失败）
    app.lastKeyword = s.lastKeyword;
    app.lastPerSource = s.lastPerSource;
    app.selSources = new Set(s.selSources);
    app.selected = new Map(s.selected);
    app.expanded = new Set(s.expanded);
    app.sort = { ...s.sort };
    lastSession = null;
  }

  // 音源键名 → 中文标签（loadMeta 时从音源目录回填；未命中回落去后缀缩写）。
  // ★ 必须留在 createApp 闭包内：函数体引用闭包变量 app。放在模块顶层会因 app 未定义
  //   抛 ReferenceError —— 搜索状态栏与结果表从有第一条数据起就整段崩掉（2026-09-20 踩坑）。
  const shortSource = (src) => {
    const s = String(src || '');
    if (!s) return '—';
    const lbl = app.sourceLabels && app.sourceLabels.get(s);
    if (lbl) return lbl;
    return s.replace(/MusicClient$/, '') || '—';
  };

  // ------------------------------ 播放器 UI（引擎状态在模块级 player 单例） ------------------------------
  /** 封面路由 URL（视图结果表用；uid 必含 `#` → 必须 encodeURIComponent）。 */
  function coverUrl(uid) {
    return coverUrlFor(app.sess.id, uid);
  }

  /** 行内封面缩略图：有封面才建 <img>，加载失败回落占位。 */
  function coverThumb(row) {
    if (row.kind !== 'track' || !row.has_cover) return el('div', { class: 'music-cover-thumb is-empty', title: '无封面' });
    const img = el('img', { class: 'music-cover-thumb', src: coverUrl(row.uid), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => {
      const ph = el('div', { class: 'music-cover-thumb is-empty', title: '封面加载失败' });
      if (img.parentNode) img.parentNode.replaceChild(ph, img);
    });
    return img;
  }

  /** 播放单元格：▷ 试听；HLS / 无直链 → 禁用并给出原因。专辑行留空。 */
  function playCell(row) {
    if (row.kind !== 'track') return el('td', { class: 'music-col-play' });
    const hls = row.protocol === 'HLS';
    const bad = row.playable === false;
    const btn = el('button', {
      class: 'btn btn--icon btn--sm music-playbtn', type: 'button', text: '▶',
      title: hls ? '该音源为 HLS，暂不支持在线试听' : (bad ? '无可用在线播放直链' : '在线试听'),
      disabled: hls || bad,
      on: (hls || bad) ? {} : { click: (e) => { e.stopPropagation(); playRow(row); } },
    });
    return el('td', { class: 'music-col-play' }, [btn]);
  }

  /** 播放条（结果卡顶部常驻，sticky）：封面 + 曲目 + 上一首/播放/下一首 + 进度 + 音量 + 词；其下为内联单行歌词。 */
  function renderPlayerBar() {
    const prevBtn = el('button', { class: 'btn btn--icon', type: 'button', text: '|◀', title: '上一首', on: { click: () => playAdjacent(-1) } });
    const playBtn = el('button', { class: 'btn btn--icon music-playbtn music-playbtn--lg', type: 'button', text: '▶', title: '播放', on: { click: () => togglePlay() } });
    const nextBtn = el('button', { class: 'btn btn--icon', type: 'button', text: '▶|', title: '下一首', on: { click: () => playAdjacent(1) } });

    const npCoverEl = el('div', { class: 'music-np__coverwrap' });
    const npTitleEl = el('div', { class: 'music-np__title', text: '未在播放' });
    const npMetaEl = el('div', { class: 'music-np__meta muted' });
    const npInfo = el('div', { class: 'music-np__info' }, [npTitleEl, npMetaEl]);

    const seekEl = el('input', { class: 'music-seek', type: 'range', min: 0, max: 1000, value: 0, disabled: true, 'aria-label': '播放进度' });
    seekEl.addEventListener('pointerdown', () => { player.dragging = true; });
    seekEl.addEventListener('pointerup', () => { player.dragging = false; });
    seekEl.addEventListener('change', () => { player.dragging = false; });
    seekEl.addEventListener('input', () => {
      const a = player.audio;
      if (a && Number.isFinite(a.duration) && a.duration > 0) {
        a.currentTime = (Number(seekEl.value) / 1000) * a.duration;
        syncProgress();
      }
    });
    const curTimeEl = el('span', { class: 'music-time mono', text: '0:00' });
    const durTimeEl = el('span', { class: 'music-time mono', text: '0:00' });
    const prog = el('div', { class: 'music-prog' }, [curTimeEl, seekEl, durTimeEl]);

    const volEl = el('input', { class: 'music-vol', type: 'range', min: 0, max: 100, value: String(Math.round(player.volume * 100)), title: '音量', 'aria-label': '音量' });
    volEl.addEventListener('input', () => { player.volume = Number(volEl.value) / 100; if (player.audio) player.audio.volume = player.volume; });

    const lyricBtn = el('button', { class: 'btn btn--sm music-lyricbtn', type: 'button', text: '词', title: '歌词（点击显示/隐藏当前句）', on: { click: () => toggleLyric() } });

    const npLyricEl = el('div', { class: 'music-np__lyric' });
    const bar = el('div', { class: 'music-player' }, [
      el('div', { class: 'music-player__row' }, [
        npCoverEl,
        npInfo,
        el('div', { class: 'music-np__controls' }, [prevBtn, playBtn, nextBtn]),
        prog,
        el('div', { class: 'music-np__right' }, [el('span', { class: 'muted music-vol__label', text: '音量' }), volEl, lyricBtn]),
      ]),
      npLyricEl,
    ]);
    // ★ 绝不把 audio 插入视图 DOM！
    //   原因：切走时 app.js 的 route() 会执行 `dom.main.innerHTML = ''` 清空视图 DOM，
    //   而 Chrome 会暂停「被移出 document 的正在播放媒体元素」→ 表现为「切模块停播」（QA 第 4 轮实测复现）。
    //   audio 由 ensureAudio()（本文件 ensureAudio）用 ctx.el('audio', …) 一次性创建后**始终保持 detached**，
    //   仅由模块级 player.audio 强引用持有（不会被 GC），故永远不会被移出 document、也不会被暂停。
    // ★ 绑定本视图播放条 DOM 引用：切回时引擎据 player.ui 无缝接管；切走时 detachPlayerUI 置 null。
    player.ui = { playBtn, npCoverEl, npTitleEl, npMetaEl, seekEl, curTimeEl, durTimeEl, volEl, lyricBtn, npLyricEl };
    renderNowPlaying();
    if (lyricBtn) lyricBtn.classList.toggle('is-active', player.lyric.open);
    renderLyricLine();
    syncPlayButton();
    syncProgress();
    syncLyric();
    return bar;
  }

  // ------------------------------ 数据加载 ------------------------------
  /** 加载音源目录 + 配置，并初始化音源勾选。 */
  async function loadMeta() {
    const [src, cfg] = await Promise.all([
      api('GET', '/api/music/sources').catch(() => null),
      api('GET', '/api/music/config').catch(() => null),
    ]);
    app.sources = src || { groups: [], total: 0, defaultSelected: [] };
    // 音源键名 → 中文名映射（结果表「来源」列显示「网易云音乐」而非「Netease」）
    app.sourceLabels = new Map();
    for (const g of (app.sources.groups || [])) {
      for (const s of (g.sources || [])) app.sourceLabels.set(s.name, s.label);
    }
    app.config = cfg || {
      downloadDir: '', nameTemplate: '{歌手} - {歌名}.{ext}', channel: 'auto', sources: [], templateVars: [],
      proxySource: 'homebrew', proxyHttp: '', proxySocks5: '',
      proxyHomebrew: { http: '127.0.0.1:7897', socks5: '127.0.0.1:7897' },
      enhancedSearch: false,
      templatePresets: [
        { id: 'singer-song', label: '歌手 - 歌名', value: '{歌手} - {歌名}.{ext}' },
        { id: 'song-singer', label: '歌名 - 歌手', value: '{歌名} - {歌手}.{ext}' },
      ],
    };
    // sources 语义：null = 从未配置（回落默认勾选）；[] = 用户明确清空（尊重之，不再勾回）
    const initial = Array.isArray(app.config.sources) ? app.config.sources : (app.sources.defaultSelected || []);
    app.selSources = new Set(initial);
  }

  /** 加载 / 刷新部署状态；可用性发生变化时整体重绘。@returns {Promise<boolean>} 本次查询是否成功（供「重新检测」提示口径用）。 */
  async function loadDeploy(force) {
    let d;
    try {
      d = await api('GET', `/api/music/deployStatus${force ? '?force=1' : ''}`);
    } catch (err) {
      if (disposed) return false;
      // ★ 单次查询失败（后端重启 / 网络抖动）**不得**把可用界面整体降级：
      //   保留上一次成功的部署快照，仅「从未成功过」才回落未部署态；不 paint（不清空搜索结果 / 队列），只提示。
      if (app.deploy) {
        app.deploy = { ...app.deploy, error: err }; // mountedUsable 保持不动：一次抖动不得翻转可用性判定
      } else {
        app.deploy = { state: 'not_deployed', usable: false, error: err, disk: {}, python: {}, musicdl: {}, venv: {} };
        app.mountedUsable = false;
        paint();
      }
      ctx.ui.toast('err', (err && err.message) || '检测音频环境失败');
      startQueuePolling(true);
      return false;
    }
    if (disposed) return false;
    app.deploy = d;
    const usable = !!d.usable;
    if (usable === app.mountedUsable) { updateEnvBar(); startQueuePolling(true); refreshUpstream(); return true; }
    app.mountedUsable = usable;
    if (usable && (!app.sources || !app.config)) await loadMeta();
    paint();
    // ★ Bug C：两种态都要轮询 —— 部署态也据此在刷新页面后重新发现并订阅正在跑的安装任务。
    startQueuePolling(true);
    refreshUpstream(); // 非阻塞：deployStatus 只带缓存摘要，这里再拿实时上游版本（纯提示，失败安静）
    return true;
  }

  async function doRefreshDeploy() {
    ctx.ui.toast('info', '正在重新检测…');
    const ok = await loadDeploy(true);
    // ★ 失败时 loadDeploy 已 toast err：这里不再补「已刷新」，避免自相矛盾
    if (ok) ctx.ui.toast('ok', '已刷新');
  }

  // ------------------------------ 任务提交（★ 不走 ctx.runTask） ------------------------------
  async function submitTask(action, params, confirm) {
    const bodyReq = { module: 'music', action, params: params || {} };
    if (confirm === true) bodyReq.confirm = true;
    app.submitting = true;
    updateInstallButton();
    try {
      let res;
      try { res = await api('POST', '/api/tasks', bodyReq); }
      catch (err) { if (!disposed) ctx.ui.toast('err', err.message || '提交任务失败'); return null; }
      if (disposed) return null; // ★ 已卸载：不再订阅实时流 / 起轮询（任务已在后端提交成功）
      const task = res && res.task;
      ctx.ui.toast('ok', `已提交任务：${(task && task.title) || action}`);
      // ★ Bug C：安装 / 卸载任务**立即**订阅实时日志 —— 这类任务可能在 <200ms 内失败，
      //   等 1.5s 的轮询会直接错过日志（用户看到的就只是「点了没反应」）。
      if (task && (action === 'install_env' || action === 'uninstall_env')) {
        mergeTask(task);
        ensureTaskStream(task);
        renderQueue();
      }
      startQueuePolling(true);
      return task;
    } finally {
      app.submitting = false;
      updateInstallButton();
    }
  }

  // ------------------------------ 实时日志流（SSE） ------------------------------
  /**
   * 订阅一个任务的日志流（SSE `GET /api/tasks/<id>/log`），把增量交给回调。
   *
   * 复用视图的回收机制（timers / sseSources）：unmount 或切换任务时统一关闭，
   * 绝不泄漏连接或定时器。处理 hello(backlog) / log / task / done；断流有重连上限，
   * 超限后回落一次性查询（`GET /api/tasks/:id`）并对运行中的任务继续轮询。
   *
   * @param {string} taskId
   * @param {{onBacklog?:(lines:object[])=>void, onLog?:(line:object)=>void,
   *          onTask?:(task:object)=>void, onDone?:(task:object)=>void}} h
   * @returns {{close:()=>void}}
   */
  function openTaskStream(taskId, h) {
    if (disposed) return { close() { /* 已卸载：不建连接、不注册兜底轮询 */ } };
    let closed = false;
    let retries = 0;
    let fallbackTimer = null;
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/log`);
    sseSources.add(es);

    const close = () => {
      if (closed) return;
      closed = true;
      if (fallbackTimer != null) { clearInterval(fallbackTimer); timers.delete(fallbackTimer); fallbackTimer = null; }
      closeSource(es);
    };

    // 断流兜底：SSE 会无限自动重连，若不设上限，任务已不存在 / 服务重启时会永久重试。
    const startFallback = () => {
      if (closed || fallbackTimer != null) return;
      const poll = async () => {
        if (closed) return;
        let t = null;
        try { t = await api('GET', `/api/tasks/${encodeURIComponent(taskId)}`); } catch { /* ignore */ }
        // ★ await 期间可能已收到 done / 已被卸载：再复核一次，避免 onTask / onDone 二次触发
        if (closed) return;
        if (disposed) { close(); return; }
        if (t && t.id) {
          if (h.onTask) h.onTask(t);
          if (isTerminalTask(t.status)) { close(); if (h.onDone) h.onDone(t); return; }
        } else {
          // 任务已不存在（服务重启 / 被清理）：停止兜底，避免空转
          close();
        }
      };
      poll();
      fallbackTimer = addTimer(poll, TASK_FALLBACK_MS);
    };

    es.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'hello') {
        if (Array.isArray(msg.backlog) && h.onBacklog) h.onBacklog(msg.backlog);
        if (msg.task && h.onTask) h.onTask(msg.task);
      } else if (msg.type === 'log') {
        if (msg.line && h.onLog) h.onLog(msg.line);
      } else if (msg.type === 'task') {
        if (msg.task && h.onTask) h.onTask(msg.task);
      } else if (msg.type === 'done') {
        close();
        if (msg.task && h.onTask) h.onTask(msg.task);
        if (h.onDone) h.onDone(msg.task);
      }
    });
    es.onopen = () => { retries = 0; };
    es.onerror = () => {
      if (closed) return;
      if (es.readyState === 2) { startFallback(); return; } // 2 = CLOSED：浏览器已放弃重连
      retries += 1;
      if (retries > SSE_MAX_RETRY) startFallback();
    };

    return { close };
  }

  /** 打开（若尚未打开）某任务的实时流，并绑定到 live 表（回填 backlog / 追加日志 / 收尾）。 */
  function ensureTaskStream(task) {
    if (disposed || !task || !task.id) return;
    const e = liveFor(task.id);
    if (e.stream || e.done) return;
    e.startedAt = task.startedAt || task.createdAt || Date.now();
    e.stream = openTaskStream(task.id, {
      onBacklog: (lines) => { e.lines = lines.slice(-LIVE_LOG_MAX); fillLogBox(task.id); },
      onLog: (line) => {
        e.lines.push(line);
        if (e.lines.length > LIVE_LOG_MAX) e.lines.splice(0, e.lines.length - LIVE_LOG_MAX);
        appendLogLine(task.id, line);
      },
      onTask: (t) => { mergeTask(t); },
      onDone: (t) => { e.done = true; e.stream = null; if (t) mergeTask(t); refreshTasks(); },
    });
  }

  /** 把一份任务快照并入队列并重绘（找不到则追加）。 */
  function mergeTask(t) {
    if (!t || !t.id) return;
    const list = app.tasks || [];
    const i = list.findIndex((x) => x && x.id === t.id);
    if (i >= 0) list[i] = { ...list[i], ...t }; else list.push(t);
    app.tasks = list;
    renderQueue();
  }

  /** 从 live 表重建某任务的日志容器内容（重绘后回填）。 */
  function fillLogBox(id) {
    const e = live.get(id);
    if (!e || !e.logEl) return;
    e.logEl.innerHTML = '';
    if (e.lines.length === 0) { e.logEl.append(logPlaceholderNode()); e.hasPlaceholder = true; }
    else { for (const l of e.lines) e.logEl.append(logLineNode(l)); e.hasPlaceholder = false; }
    e.renderedLines = e.lines.length; // ★ 全量回填后同步游标，后续 appendLogLine 才能接着做增量
    e.logEl.scrollTop = e.logEl.scrollHeight;
  }

  /** 增量追加一行到已挂载的日志容器（若容器存在）；否则只留在 live 表，待下次重绘回填。 */
  function appendLogLine(id, line) {
    const e = live.get(id);
    if (!e || !e.logEl) return;
    if (e.hasPlaceholder || e.lines.length === 1) { e.logEl.innerHTML = ''; e.hasPlaceholder = false; } // 清掉「等待日志…」占位
    e.logEl.append(logLineNode(line));
    // ★ 与 live 表同口径裁剪：超过 LIVE_LOG_MAX 后从 DOM 头部滑出最旧行（不整段重建）。
    //   只用 children + removeChild：`childNodes` / `firstChild` 在视图单测的轻量 DOM 桩里
    //   并不存在（music-install-progress 曾因此整例抛 TypeError），而浏览器与桩件都支持前者。
    while (e.logEl.children && e.logEl.children.length > e.lines.length) {
      const first = e.logEl.children[0];
      if (!first) break;
      e.logEl.removeChild(first);
    }
    e.renderedLines = e.lines.length; // 与 DOM 同步游标
    if (e.pinned !== false) e.logEl.scrollTop = e.logEl.scrollHeight; // 自动吸底（用户上滚则不打扰）
  }

  /** 日志占位行（无时间列——占位行没有 ts，带时间列会渲染成 Invalid Date）。 */
  function logPlaceholderNode() {
    return el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: '等待日志…' })]);
  }

  /** 一条日志 → DOM 行（等宽、按 level 着色；复用 .diff 风格）。 */
  function logLineNode(l) {
    const line = l || {};
    const cls = logLevelClass(line.level);
    return el('div', { class: 'diff__line' }, [
      // 注意不能用 .diff__no（为 diff 行号设计，固定 32px 宽）——装不下 8 字符时间戳会溢出重叠
      el('span', { class: 'music-logts', text: ctx.fmtTime(line.ts) }),
      el('span', { class: cls, text: `[${line.level || 'info'}] ${line.text || ''}` }),
    ]);
  }

  /** 队列里所有已挂载日志容器吸底。 */
  function pinLogs() {
    for (const e of live.values()) {
      if (e.logEl && e.pinned !== false) { try { e.logEl.scrollTop = e.logEl.scrollHeight; } catch { /* ignore */ } }
    }
  }

  // ------------------------------ 绘制：外壳 ------------------------------
  function paint() {
    body.innerHTML = '';
    // ★ 重绘会销毁旧播放条 DOM：先解绑 UI 引用（引擎继续后台播放，不停、不清 src）；
    //   本次渲染末尾的 renderPlayerBar() 会重新绑定到新 DOM → 切回即无缝接管。
    detachPlayerUI();
    app.envBarNode = null;
    app.resEls = null;
    app.queueEl = null;
    app.installBtn = null;

    if (!app.deploy) { body.append(el('div', { class: 'view-loading', text: '正在检测音频环境…' })); return; }
    if (!app.deploy.usable) {
      body.append(renderDeployPanel());
      // ★ Bug C：部署态也必须有安装 / 卸载任务的承载（步骤 + 进度条 + 实时日志 + 失败重试）。
      //   旧实现未就绪时只渲染部署面板，app.queueEl 恒为 null，导致安装进度「无处可显」。
      body.append(renderQueueCard('安装进度'));
      renderQueue();
      return;
    }

    // ★ 切回本视图：把离开时的会话快照灌回（仅一次）——搜索结果 / 勾选 / 音源 / 排序整段还原，无需重新搜索。
    if (lastSession && !app.restoredSession) { restoreSession(); app.restoredSession = true; }

    app.envBarNode = renderEnvBar();
    body.append(app.envBarNode);
    body.append(renderSearchCard());
    body.append(renderResultsCard());
    body.append(renderQueueCard());
    body.append(renderDirCard());

    updateSourceBadge();
    updateSearchStatus();
    renderResults();
    renderQueue();

    // ★ 离开时会话仍在跑：切回后无缝续接轮询（服务端会话未中断，这里只续前端增量拉取）。
    if (app.sess.status === 'running' && app.pollTimer == null) {
      app.pollTimer = addTimer(pollSession, 1000);
      pollSession();
    }
  }

  // ------------------------------ ① 部署区（未就绪 / 损坏） ------------------------------
  function renderDeployPanel() {
    const d = app.deploy || {};
    const meta = DEPLOY_META[d.state] || DEPLOY_META.not_deployed;
    const pyOk = !!(d.python && d.python.found);

    const card = el('div', { class: `music-deploy music-deploy--${meta.tone}` });
    card.append(el('div', { class: 'music-deploy__head' }, [
      ctx.ui.statusLight(meta.light),
      el('span', { class: 'music-deploy__title', text: meta.label }),
    ]));

    const desc = el('div', { class: 'music-deploy__desc' });
    if (d.state === 'broken') {
      desc.append(el('p', { text: '已存在的虚拟环境无法正常导入 musicdl，需要重建。' }));
      if (d.musicdl && d.musicdl.importError) {
        desc.append(el('p', { class: 'muted mono', text: `错误：${d.musicdl.importError}` }));
      }
    } else {
      desc.append(el('p', { text: '本模块用 Python 的 musicdl 库下载音乐。依赖会安装到你的用户目录 ~/.mackit/py，不使用 sudo、不写系统目录，可随时一键卸载。' }));
    }
    desc.append(el('p', {
      class: 'muted',
      text: pyOk
        ? `已检测到 Python ${d.python.version}（${d.python.path}）`
        : '未检测到 Python 3.12+：请先在「Homebrew 管家」安装 python@3.12，或按下方命令手动执行。',
    }));
    card.append(desc);

    card.append(renderCommandList());

    const btns = el('div', { class: 'row music-deploy__acts' });
    app.installBtn = el('button', {
      class: 'btn btn--primary', type: 'button',
      text: d.state === 'broken' ? '修复音频环境' : '安装音频环境',
      on: { click: () => doInstall() },
    });
    btns.append(app.installBtn);
    if (!pyOk) {
      btns.append(el('button', {
        class: 'btn', type: 'button', text: '去 Homebrew 管家装 python@3.12',
        on: { click: () => ctx.navigate('#/brew') },
      }));
    }
    btns.append(el('button', { class: 'btn btn--ghost', type: 'button', text: '重新检测', on: { click: () => doRefreshDeploy() } }));
    card.append(btns);
    updateInstallButton();

    return el('div', { class: 'section' }, [card]);
  }

  /** 是否已有安装 / 卸载任务在跑（用于禁用按钮，防重复提交）。 */
  function isInstalling() {
    return (app.tasks || []).some((t) => (t.action === 'install_env' || t.action === 'uninstall_env')
      && (t.status === 'running' || t.status === 'pending'));
  }

  /** 同步「安装 / 修复」按钮的禁用态与文案，与任务状态一致。 */
  function updateInstallButton() {
    const btn = app.installBtn;
    if (!btn) return;
    const busy = app.submitting === true || isInstalling();
    btn.disabled = busy;
    const broken = app.deploy && app.deploy.state === 'broken';
    btn.textContent = busy ? '安装中…' : (broken ? '修复音频环境' : '安装音频环境');
  }

  /** 安装命令预览块。 */
  function renderCommandList() {
    const box = el('div', { class: 'diff music-cmds' });
    for (const c of INSTALL_COMMANDS) {
      box.append(el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: `$ ${c}` })]));
    }
    box.append(el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: '# 若缺 Python 3.12：brew install python@3.12' })]));
    return box;
  }

  async function doInstall() {
    const d = app.deploy || {};
    const node = el('div', {}, [
      el('p', {
        text: d.state === 'broken'
          ? '将删除并重建虚拟环境，然后重新安装 musicdl。将执行以下命令（全部在 ~/.mackit/py 内，不使用 sudo）：'
          : '将执行以下命令（全部在你的用户目录 ~/.mackit/py 内，不使用 sudo）：',
      }),
      renderCommandList(),
      el('ul', { class: 'music-notes' }, [
        el('li', { text: '占用：约 300–500 MB，另需 ≥ 1.5 GB 可用磁盘' }),
        el('li', { text: '耗时：数分钟，全程需要联网（从 PyPI 下载）' }),
        el('li', { text: '许可：musicdl 采用 PolyForm Noncommercial 1.0.0 —— 仅限非商业用途' }),
        el('li', { text: '可逆：随时可在本页「卸载音频环境」完全删除' }),
      ]),
    ]);
    const okRes = await ctx.ui.modal({
      title: d.state === 'broken' ? '修复音频环境' : '安装音频环境',
      body: node,
      actions: [
        { label: '取消', kind: 'ghost' },
        { label: '开始安装', kind: 'primary', onClick: (c) => c(true) },
      ],
    });
    if (okRes !== true) return;
    await submitTask('install_env', {}, true);
  }

  async function doUninstall() {
    const node = el('div', {}, [
      el('p', { text: '将删除 ~/.mackit/py 下的虚拟环境与 pip 缓存（约 300–500 MB）。' }),
      el('p', { class: 'warn-text', text: '已下载的音乐文件不会被删除。' }),
      el('p', { class: 'muted', text: '之后可在本页重新「安装音频环境」恢复。' }),
    ]);
    const ok = await ctx.ui.confirmDialog({ title: '卸载音频环境', body: node, confirmLabel: '卸载' });
    if (!ok) return;
    await submitTask('uninstall_env', {}, true);
  }

  /**
   * 失败后「重试安装」（一键重发）。
   *
   * 用户已经在失败块上显式点了重试，且该动作此前已确认过一次，这里直接带 confirm:true 重发，
   * 不再二次弹窗；createVenvStep 会自愈掉上次留下的损坏 venv。
   */
  async function retryInstall(t) {
    const action = (t && t.action === 'uninstall_env') ? 'uninstall_env' : 'install_env';
    ctx.ui.toast('info', '正在重试…');
    await submitTask(action, {}, true);
  }

  // ------------------------------ ① 环境条（已就绪 / 可更新 / 上游新版本提示） ------------------------------
  /**
   * musicdl 上游新版本提示（**仅 comparison==='newer' 显示**）：
   * equal / older / 查询失败一律不渲染 —— 安静，不打扰。版本号全部来自数据。
   */
  function upstreamNoticeNode() {
    const u = app.musicdlUpstream || (app.deploy && app.deploy.musicdlUpstream) || null;
    if (!u || u.comparison !== 'newer' || !u.version) return null;
    const installedVer = u.installedVersion
      || (app.deploy && app.deploy.musicdl && app.deploy.musicdl.version)
      || '未知';
    return el('span', { class: 'music-envbar__upstream' }, [
      ctx.ui.badge(`上游有新版本 ${u.version}（已装 ${installedVer}，MacKit 锁定 ${u.target}）`, 'warn'),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: '升级 musicdl',
        title: '走既有的「安装音频环境」任务（升级失败会自动回滚到锁定版本）',
        on: { click: () => doInstall() },
      }),
    ]);
  }

  function renderEnvBar() {
    const d = app.deploy || {};
    const meta = DEPLOY_META[d.state] || DEPLOY_META.deployed;
    const py = (d.python && d.python.version) ? `python ${d.python.version}` : '';
    const ver = (d.musicdl && d.musicdl.version) ? `musicdl ${d.musicdl.version}` : '';
    const summary = [py, ver].filter(Boolean).join(' · ');

    const row = el('div', { class: 'music-envbar__row' }, [
      ctx.ui.statusLight(meta.light),
      el('span', { class: 'music-envbar__label', text: meta.label }),
      el('span', { class: 'muted', text: summary }),
      d.state === 'outdated'
        ? ctx.ui.badge(`可更新（目标 ${d.targetVersion}）`, 'warn')
        : ctx.ui.badge('部署正常', 'ok'),
      upstreamNoticeNode(),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', type: 'button', text: '重新检测', on: { click: () => doRefreshDeploy() } }),
      d.state === 'outdated'
        ? el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '更新', on: { click: () => doInstall() } })
        : null,
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '卸载音频环境', on: { click: () => doUninstall() } }),
    ]);

    return el('div', { class: `section music-envbar music-envbar--${meta.tone}` }, [row]);
  }

  /**
   * 非阻塞刷新 musicdl 上游版本（纯提示，任何失败都安静）。
   * deployStatus 自带的缓存摘要先显示（app.deploy.musicdlUpstream），这里再拿实时结果覆盖。
   */
  async function refreshUpstream() {
    let u = null;
    try { u = await api('GET', '/api/music/musicdlUpstream'); } catch { u = null; }
    if (disposed) return; // ★ 已卸载：不碰 DOM
    app.musicdlUpstream = (u && u.fetchOk) ? u : null;
    // 仅在「要不要显示提示」发生翻转时重绘环境条，避免无谓地打断用户操作
    const show = !!upstreamNoticeNode();
    if (show !== app.upstreamShown) { app.upstreamShown = show; updateEnvBar(); }
  }

  /** 只替换环境条内容（可用性未变时避免整页重绘、丢失搜索态）。 */
  function updateEnvBar() {
    if (!app.envBarNode || !app.envBarNode.parentNode) return;
    const fresh = renderEnvBar();
    app.envBarNode.parentNode.replaceChild(fresh, app.envBarNode);
    app.envBarNode = fresh;
  }

  // ------------------------------ ② 搜索区 ------------------------------
  function renderSearchCard() {
    const kw = el('input', { type: 'text', class: 'music-kw', placeholder: '歌曲 / 歌手 / 专辑关键词，回车即搜', value: app.lastKeyword || '' });
    app.kwInput = kw;
    kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

    app.srcBadge = ctx.ui.badge('0/0');
    const srcBtn = el('button', { class: 'btn', type: 'button', on: { click: () => openSourcesPanel() } }, [
      el('span', { text: '音源' }), app.srcBadge,
    ]);

    app.searchBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '搜索', on: { click: () => { if (app.sess.status === 'running') cancelSession(); else doSearch(); } } });

    // 每源数量上限：默认 5（后端缺省值），可选更大值；值随搜索请求发送 perSource。
    app.perSourceSel = el('select', { class: 'music-persource', title: '每个音源最多返回的结果数' },
      [5, 10, 20, 30].map((n) => el('option', { value: String(n), text: `每源 ${n} 首` })));
    app.perSourceSel.value = String(app.lastPerSource || 5);

    const row1 = el('div', { class: 'row music-search-row' }, [el('div', { class: 'grow' }, [kw]), srcBtn, app.perSourceSel, app.searchBtn]);

    app.urlInput = el('input', { type: 'text', class: 'music-url', placeholder: '粘贴歌单 / 专辑 / 频道链接（可选，解析后与搜索结果同样勾选下载）' });
    const parseBtn = el('button', { class: 'btn', type: 'button', text: '解析歌单', on: { click: () => doPlaylist() } });
    const row2 = el('div', { class: 'row music-search-row' }, [el('div', { class: 'grow' }, [app.urlInput]), parseBtn]);

    app.searchStatusEl = el('div', { class: 'music-search-status muted' });

    return el('div', { class: 'section' }, [ctx.ui.card('搜索', el('div', {}, [row1, row2, app.searchStatusEl]))]);
  }

  async function doSearch() {
    const keyword = (app.kwInput && app.kwInput.value || '').trim();
    if (!keyword) { ctx.ui.toast('warn', '请输入搜索关键词'); return; }
    const sources = [...app.selSources];
    if (sources.length === 0) { ctx.ui.toast('warn', '请至少选择一个音源'); return; }
    app.lastKeyword = keyword;
    const perSource = Number(app.perSourceSel && app.perSourceSel.value) || 5;
    app.lastPerSource = perSource;
    let res;
    try { res = await api('POST', '/api/music/search', { keyword, sources, perSource, enhanced: app.config.enhancedSearch === true }); }
    catch (err) { ctx.ui.toast('err', err.message || '搜索失败'); return; }
    if (disposed) return; // ★ 已卸载：不再起轮询
    startSession('search', res);
  }

  async function doPlaylist() {
    const url = (app.urlInput && app.urlInput.value || '').trim();
    if (!url) { ctx.ui.toast('warn', '请粘贴歌单 / 专辑链接'); return; }
    const sources = [...app.selSources];
    let res;
    try { res = await api('POST', '/api/music/playlist', { url, sources }); }
    catch (err) { ctx.ui.toast('err', err.message || '解析歌单失败'); return; }
    if (disposed) return; // ★ 已卸载：不再起轮询
    startSession('playlist', res);
  }

  function startSession(kind, res) {
    if (disposed) return; // ★ 已卸载：不接管会话、不起轮询（服务端会话仍可被其它入口消费）
    stopPoll();
    lastSession = null; // ★ 发起新会话即作废旧快照：切回时不应再恢复上一次的搜索结果
    app.resPage = 1; // 新会话回到结果第一页
    app.sess = {
      id: res.searchId, kind, since: 0, status: 'running',
      rows: [], counts: { sourcesOk: 0, sourcesFail: 0, songs: 0 }, currentSource: null, error: null,
      sourcesTotal: Number(res.sourcesTotal) || 0, netFails: 0,
    };
    app.selected.clear();
    app.expanded.clear();
    renderResults();
    updateSearchStatus();
    app.pollTimer = addTimer(pollSession, 1000);
    pollSession();
  }

  async function pollSession() {
    const id = app.sess.id;
    if (!id) { stopPoll(); return; }
    let data;
    try { data = await api('GET', `/api/music/search/${encodeURIComponent(id)}?since=${app.sess.since}`); }
    catch (err) {
      if (disposed) return; // ★ 已卸载：不得再触碰 DOM / 状态
      // 取消 / 新会话后到达的过期错误不得覆盖本地状态（放在 stopPoll 之前：否则会误停新会话的轮询）
      if (app.sess.id !== id || app.sess.status === 'cancelled') return;
      // ★ 网络类失败（后端重启 / 瞬时断连）不立即判死：连续达 POLL_NET_RETRY_MAX 次才终态；
      //   业务错误（HTTP 错误码）仍立即失败。计数记在 app.sess 上，成功即归零。
      if (isNetErr(err)) {
        app.sess.netFails = (Number(app.sess.netFails) || 0) + 1;
        if (app.sess.netFails < POLL_NET_RETRY_MAX) return; // 保留轮询，下一拍继续重试
      }
      stopPoll();
      app.sess.status = 'fail';
      app.sess.error = err;
      updateSearchStatus();
      renderResults();
      return;
    }
    // 在途轮询的迟到响应：用户已取消（或已开新会话）时直接丢弃，防止把 cancelled 改回 running
    if (disposed) return;
    if (app.sess.id !== id || app.sess.status === 'cancelled') return;
    app.sess.netFails = 0; // ★ 成功即归零（该计数只统计「连续」失败）
    app.sess.since = Number(data.nextSince) || app.sess.since;
    app.sess.status = data.status || app.sess.status;
    app.sess.counts = data.counts || app.sess.counts;
    app.sess.currentSource = data.currentSource || null;
    app.sess.currentSources = Array.isArray(data.currentSources) ? data.currentSources : [];
    app.sess.rows = Array.isArray(data.rows) ? data.rows : app.sess.rows;
    app.sess.error = data.error || null;
    renderResults();
    updateSearchStatus();
    if (app.sess.status !== 'running') stopPoll();
  }

  function stopPoll() {
    if (app.pollTimer != null) { clearInterval(app.pollTimer); timers.delete(app.pollTimer); app.pollTimer = null; }
  }

  async function cancelSession() {
    const id = app.sess.id;
    if (!id) return;
    try { await api('POST', `/api/music/search/${encodeURIComponent(id)}/cancel`); } catch { /* 忽略 */ }
    // ★ await 期间可能已切走视图 / 已开新会话：与 pollSession 同口径，过期续跑不得停掉新会话的轮询或改状态
    if (disposed) return;
    if (!app.sess || app.sess.id !== id) return;
    stopPoll();
    app.sess.status = 'cancelled';
    // 状态栏与结果区空态都要重绘：emptyResultText() 依赖 status，漏了 renderResults 会残留「正在搜索…」
    updateSearchStatus();
    renderResults();
    ctx.ui.toast('info', '已取消');
  }

  function updateSearchStatus() {
    if (app.searchBtn) {
      const running = app.sess.status === 'running';
      app.searchBtn.textContent = running ? '取消搜索' : '搜索';
      app.searchBtn.classList.toggle('btn--danger', running);
      app.searchBtn.classList.toggle('btn--primary', !running);
    }
    const s = app.searchStatusEl;
    if (!s) return;
    const kind = app.sess.kind;
    if (app.sess.status === 'idle') {
      s.textContent = kind === 'playlist' ? '粘贴链接后点「解析歌单」' : '输入关键词开始搜索';
      return;
    }
    const c = app.sess.counts || {};
    const done = (Number(c.sourcesOk) || 0) + (Number(c.sourcesFail) || 0);
    const total = app.sess.sourcesTotal || 0;
    const songs = (app.sess.rows || []).length;
    if (app.sess.status === 'running') {
      // 并行搜索：可能有多个源同时在跑，全部列出；无则回退单源指示
      const running = (app.sess.currentSources || []).map((x) => shortSource(x));
      const cur = running.length
        ? ` · 正在搜索：${running.join(' / ')}`
        : (app.sess.currentSource ? ` · 正在搜索：${shortSource(app.sess.currentSource)}` : '');
      const enhTag = (app.config && app.config.enhancedSearch) ? '增强 · ' : '';
      s.textContent = kind === 'playlist'
        ? `正在解析歌单… 已解析 ${songs} 首`
        : `${enhTag}搜索中：已返回 ${done}/${total} 个音源${cur} · 命中 ${songs} 首`;
    } else if (app.sess.status === 'done') {
      s.textContent = kind === 'playlist'
        ? `解析完成：共 ${songs} 首（勾选后点「下载选中」）`
        : `搜索完成：${done}/${total} 个音源返回 · 共 ${songs} 首`;
    } else if (app.sess.status === 'cancelled') {
      s.textContent = '已取消';
    } else if (app.sess.status === 'fail') {
      s.textContent = `失败：${(app.sess.error && app.sess.error.message) || '未知错误'}`;
    }
  }

  // ------------------------------ 音源选择面板 ------------------------------
  function updateSourceBadge() {
    if (!app.srcBadge) return;
    const total = (app.sources && Number(app.sources.total)) || 0;
    app.srcBadge.textContent = `已选 ${app.selSources.size}/${total}`;
  }

  function openSourcesPanel() {
    const groups = (app.sources && app.sources.groups) || [];
    const total = (app.sources && Number(app.sources.total)) || 0;
    const draft = new Set(app.selSources);
    const countEl = el('span', { class: 'muted nowrap' });
    const wrap = el('div', { class: 'music-srclist' });
    const syncCount = () => { countEl.textContent = `已选 ${draft.size} / ${total}`; };

    function build() {
      wrap.innerHTML = '';
      for (const g of groups) {
        const itemBoxes = [];
        const all = el('input', { type: 'checkbox' });
        const syncGroup = () => {
          for (const it of itemBoxes) it.cb.checked = draft.has(it.name);
          all.checked = g.sources.length > 0 && g.sources.every((s) => draft.has(s.name));
          syncCount();
        };
        const list = el('div', { class: 'music-srcgroup__list' });
        for (const s of g.sources) {
          const cb = el('input', { type: 'checkbox' });
          itemBoxes.push({ cb, name: s.name });
          cb.addEventListener('change', (e) => { if (e.target.checked) draft.add(s.name); else draft.delete(s.name); syncGroup(); });
          const item = el('label', { class: 'check music-srcitem', title: s.note || '' }, [cb, el('span', { text: s.label })]);
          if (s.drm) item.append(ctx.ui.badge('DRM', 'warn'));
          if (s.radio) item.append(ctx.ui.badge('电台'));
          list.append(item);
        }
        all.addEventListener('change', (e) => {
          for (const s of g.sources) { if (e.target.checked) draft.add(s.name); else draft.delete(s.name); }
          syncGroup();
        });
        const gHead = el('div', { class: 'music-srcgroup__head' }, [
          el('label', { class: 'check' }, [all, el('span', { text: g.label })]),
          el('span', { class: 'grow' }),
          el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '全选', on: { click: () => { g.sources.forEach((s) => draft.add(s.name)); syncGroup(); } } }),
          el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '清空', on: { click: () => { g.sources.forEach((s) => draft.delete(s.name)); syncGroup(); } } }),
        ]);
        syncGroup(); // ★ 构建时必须回填勾选态：否则重开弹窗时已选音源显示为未勾（选择数据其实一直都在）
        wrap.append(el('div', { class: 'music-srcgroup' }, [gHead, list]));
      }
      syncCount();
    }

    const quick = el('div', { class: 'row music-srcquick' }, [
      el('button', { class: 'btn btn--sm', type: 'button', text: `全选 ${total}`, on: { click: () => { groups.forEach((g) => g.sources.forEach((s) => draft.add(s.name))); build(); } } }),
      el('button', { class: 'btn btn--sm', type: 'button', text: '只选大中华区', on: { click: () => { draft.clear(); groups.forEach((g) => { if (g.id === 'china') g.sources.forEach((s) => draft.add(s.name)); }); build(); } } }),
      el('button', { class: 'btn btn--sm', type: 'button', text: '清空', on: { click: () => { draft.clear(); build(); } } }),
      el('span', { class: 'grow' }),
      countEl,
    ]);

    build();
    ctx.ui.modal({
      title: '选择音源',
      width: 'min(760px, 100%)',
      body: el('div', {}, [quick, wrap]),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '应用', kind: 'primary',
          onClick: async (close) => {
            const prev = new Set(app.selSources); // ★ 保存前的勾选：失败时回滚
            app.selSources = draft;
            updateSourceBadge();
            const next = await saveConfig({ sources: [...draft] });
            // ★ saveConfig 失败返回 null（已 toast err）：回滚勾选且不关弹窗，避免界面显示「已应用」而实际未生效
            if (!next) { app.selSources = prev; updateSourceBadge(); return; }
            close(true);
          },
        },
      ],
    });
  }

  // ------------------------------ ③ 结果区（自建表） ------------------------------
  /** 可点击排序的表头（R3a/ P1-2）：点击切换 升/降，箭头指示当前态。 */
  function sortableTh(label, key) {
    // ★ 箭头单独建 <span> 并登记引用：表头只在卡片渲染时创建一次，箭头需后续由
    //   syncSortIndicators() 显式刷新（点击只重绘 tbody，不会重建表头）。
    const arrowEl = el('span', { class: 'music-th-sort__arrow' });
    const th = el('th', { class: 'music-th-sort', title: '点击排序' }, [el('span', { text: label }), arrowEl]);
    (app.sortThs || {})[key] = { th, arrowEl };
    th.addEventListener('click', () => {
      if (app.sort.key === key) app.sort.dir = app.sort.dir === 'asc' ? 'desc' : 'asc';
      else { app.sort.key = key; app.sort.dir = 'desc'; }
      app.resPage = 1; // 排序改变顺序，回到第一页
      renderResults(); // 箭头由 renderResults 内的 syncSortIndicators() 统一刷新
    });
    return th;
  }

  /** 依 app.sort 刷新表头排序指示（⇅ / ↑ / ↓）。表头只在卡片渲染时建一次，故必须显式同步。 */
  function syncSortIndicators() {
    const map = app.sortThs || {};
    for (const key of Object.keys(map)) {
      const { th, arrowEl } = map[key];
      const active = app.sort.key === key;
      arrowEl.textContent = active ? (app.sort.dir === 'asc' ? ' ↑' : ' ↓') : ' ⇅';
      th.classList.toggle('is-active', active);
    }
  }

  function renderResultsCard() {
    app.sortThs = {}; // ★ 卡片可能被 paint() 重建：先清掉指向已销毁节点的旧表头引用
    const tbody = el('tbody');
    const table = el('table', { class: 'table music-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'music-col-check' }, []),
        el('th', { class: 'music-col-cover', text: '封面' }),
        el('th', { text: '歌曲' }),
        el('th', { text: '歌手' }),
        el('th', { text: '专辑' }),
        el('th', { text: '时长' }),
        sortableTh('格式 / 码率', 'quality'),
        sortableTh('大小', 'size'),
        el('th', { text: '来源' }),
        el('th', { class: 'music-col-play', text: '试听' }),
      ])]),
      tbody,
    ]);

    const countEl = el('span', { class: 'muted nowrap' });
    const dlBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '下载选中 0', on: { click: () => downloadSelected() } });
    const toolbar = el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn--sm', type: 'button', text: '全选', on: { click: () => selectAll() } }),
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '清空选择', on: { click: () => { app.selected.clear(); renderResults(); } } }),
      el('span', { class: 'grow' }),
      countEl,
      dlBtn,
    ]);
    const pagerEl = el('div', { class: 'music-pager' });

    app.resEls = { tbody, countEl, dlBtn, pagerEl };

    // ★ C1/C2：播放条常驻在结果卡「工具行」与「表头/表格」之间（用户指定位置，sticky top 保持滚动可见）。
    return el('div', { class: 'section' }, [ctx.ui.card('结果', el('div', {}, [
      toolbar,
      renderPlayerBar(),
      el('div', { class: 'table__scroll' }, [table]),
      pagerEl,
    ]))]);
  }

  function childTracks(uid) {
    return (app.sess.rows || []).filter((r) => r.parentUid === uid);
  }

  function isRowChecked(r) {
    if (r.kind === 'album') {
      const kids = childTracks(r.uid);
      return kids.length > 0 && kids.every((k) => app.selected.has(k.uid));
    }
    return app.selected.has(r.uid);
  }

  function toggleSelect(r, checked) {
    if (r.kind === 'album') {
      for (const c of childTracks(r.uid)) { if (checked) app.selected.set(c.uid, c); else app.selected.delete(c.uid); }
    } else if (checked) app.selected.set(r.uid, r); else app.selected.delete(r.uid);
    renderResults();
  }

  function buildRow(r, depth) {
    const tr = el('tr', { class: `music-row${r.kind === 'album' ? ' is-album' : ''}` });
    const cb = el('input', { type: 'checkbox', checked: isRowChecked(r) });
    cb.addEventListener('change', (e) => toggleSelect(r, e.target.checked));
    tr.append(el('td', { class: 'music-col-check' }, [cb]));
    tr.append(el('td', { class: 'music-col-cover' }, [coverThumb(r)]));
    // 双击结果行 → 在线试听（仅曲目行；点按钮 / 勾选框 / 缩略图不触发）
    tr.addEventListener('dblclick', (e) => {
      if (r.kind !== 'track') return;
      if (e.target && e.target.closest && e.target.closest('button, input, a, img')) return;
      playRow(r);
    });

    const nameCell = el('td', { class: depth > 0 ? 'music-indent' : '' });
    if (r.kind === 'album') {
      const caret = el('button', {
        class: 'btn btn--icon btn--sm music-caret', type: 'button',
        text: app.expanded.has(r.uid) ? '▾' : '▸',
        on: {
          click: () => {
            if (app.expanded.has(r.uid)) app.expanded.delete(r.uid); else app.expanded.add(r.uid);
            renderResults();
          },
        },
      });
      nameCell.append(caret);
    }
    nameCell.append(el('span', { text: r.songname || '（未知曲目）' }));
    if (r.kind === 'album' && r.childrenCount) nameCell.append(ctx.ui.badge(`${r.childrenCount} 集`));
    tr.append(nameCell);

    tr.append(el('td', { text: r.singers || '—' }));
    tr.append(el('td', { text: r.album || '—' }));
    tr.append(el('td', { class: 'nowrap mono', text: fmtClock(r.duration, true) }));
    // 格式 / 码率：码率缺失时加悬浮提示（C2）
    const qCell = el('td', { class: 'nowrap', text: fmtQuality(r) });
    if (!hasBitrate(r)) qCell.title = '该音源搜索阶段未提供码率，下载后可查看实测值';
    tr.append(qCell);
    tr.append(el('td', { class: 'nowrap mono', text: fmtSize(r.filesize) }));
    tr.append(el('td', { class: 'nowrap', text: shortSource(r.source) }));
    tr.append(playCell(r)); // ★ C1：行内「试听」列（专辑行留空；不可播放则禁用）
    return tr;
  }

  /** R3a/ P1-2：确定性比较器 —— 码率降序 → 扩展名优先级 → 大小降序（缺失视为最低）。 */
  function cmpRows(a, b) {
    const dir = app.sort.dir === 'asc' ? 1 : -1;
    if (app.sort.key === 'size') {
      const as = Number.isFinite(a.filesize) ? a.filesize : -1;
      const bs = Number.isFinite(b.filesize) ? b.filesize : -1;
      return (as - bs) * dir;
    }
    // quality
    const ab = hasBitrate(a) ? Number(a.bitrate) : -1;
    const bb = hasBitrate(b) ? Number(b.bitrate) : -1;
    if (ab !== bb) return (ab - bb) * dir;
    const ar = EXT_RANK[String(a.ext || '').toLowerCase()] || 0;
    const br = EXT_RANK[String(b.ext || '').toLowerCase()] || 0;
    if (ar !== br) return (ar - br) * dir;
    const as = Number.isFinite(a.filesize) ? a.filesize : -1;
    const bs = Number.isFinite(b.filesize) ? b.filesize : -1;
    return (as - bs) * dir;
  }

  /** 对一组行按当前排序键排序（未设排序键则保持到达顺序）；浅拷贝，不改动源数组。 */
  function sortedRows(list) {
    const arr = list.slice();
    if (app.sort.key) arr.sort(cmpRows);
    return arr;
  }

  function emptyResultText() {
    const kind = app.sess.kind;
    if (app.sess.status === 'idle') return kind === 'playlist' ? '粘贴歌单 / 专辑链接后点「解析歌单」' : '输入关键词开始搜索（支持 57 个音源）';
    if (app.sess.status === 'running') return kind === 'playlist' ? '正在解析歌单…' : '正在搜索，结果会陆续出现…';
    if (app.sess.status === 'cancelled') return '已取消'; // 与状态栏口径一致（取消后不得再显示「正在搜索…」）
    if (app.sess.status === 'fail') return `搜索失败：${(app.sess.error && app.sess.error.message) || '未知错误'}`;
    return kind === 'playlist' ? '未从该链接解析出曲目' : '没有找到结果，换个关键词试试';
  }

  function renderResults() {
    // ★ 让模块级引擎始终掌握「本视图结果集」：播放列表顺序 / 直链路由据此构建（切视图后仍正确）。
    player.viewSessId = app.sess.id;
    player.rows = app.sess.rows || [];
    const R = app.resEls;
    // ★ 表头只在 renderResultsCard() 创建一次；排序 / 翻页 / 增量刷新 / 切回（快照恢复 app.sort）
    //   四条路径都经此刷新箭头，否则箭头恒为创建时的快照（既有小瑕疵）。
    syncSortIndicators();
    if (!R) return;
    R.tbody.innerHTML = '';
    const rows = app.sess.rows || [];
    // 排序作用于顶层行与各专辑子行（各自排序保两级）；无专辑时等价全表排序
    const tops = sortedRows(rows.filter((r) => !r.parentUid));
    if (tops.length === 0) {
      app.resPage = 1;
      R.tbody.append(el('tr', {}, [el('td', { colspan: '10' }, [el('div', { class: 'muted music-empty-cell', text: emptyResultText() })])]));
    } else {
      // 分页展示（每页 10 首），翻页控件渲染在表格底部
      const pages = Math.max(1, Math.ceil(tops.length / RESULTS_PER_PAGE));
      if (app.resPage > pages) app.resPage = pages;
      if (app.resPage < 1) app.resPage = 1;
      const start = (app.resPage - 1) * RESULTS_PER_PAGE;
      for (const r of tops.slice(start, start + RESULTS_PER_PAGE)) {
        R.tbody.append(buildRow(r, 0));
        if (r.kind === 'album' && app.expanded.has(r.uid)) {
          for (const c of sortedRows(rows.filter((x) => x.parentUid === r.uid))) R.tbody.append(buildRow(c, 1));
        }
      }
      renderPager(R.pagerEl, tops.length, RESULTS_PER_PAGE, app.resPage, (p) => { app.resPage = p; renderResults(); });
    }
    updateResultCount();
  }

  /** 通用翻页条：上一页 / x / y 页 / 下一页（单页时不渲染）。 */
  function renderPager(container, total, perPage, page, onPage) {
    if (!container) return;
    container.innerHTML = '';
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (pages <= 1) return;
    const mk = (text, disabled, fn) => el('button', {
      class: 'btn btn--sm btn--ghost', type: 'button', text, disabled,
      on: disabled ? {} : { click: fn },
    });
    container.append(
      mk('‹ 上一页', page <= 1, () => onPage(page - 1)),
      el('span', { class: 'muted nowrap', text: `第 ${page} / ${pages} 页 · 共 ${total} 条` }),
      mk('下一页 ›', page >= pages, () => onPage(page + 1)),
    );
  }

  function updateResultCount() {
    const R = app.resEls;
    if (!R) return;
    const total = (app.sess.rows || []).length;
    R.countEl.textContent = `共 ${total} 首 · 已选 ${app.selected.size}`;
    R.dlBtn.textContent = `下载选中 ${app.selected.size}`;
    R.dlBtn.disabled = app.selected.size === 0;
  }

  function selectAll() {
    for (const r of (app.sess.rows || [])) if (r.kind === 'track') app.selected.set(r.uid, r);
    renderResults();
  }

  async function downloadSelected() {
    const uids = [...app.selected.keys()];
    if (uids.length === 0) return;
    const dir = (app.config && app.config.downloadDir) || '';
    const tmpl = (app.config && app.config.nameTemplate) || '{歌手} - {歌名}.{ext}';
    const sample = applyTemplate(tmpl, app.selected.values().next().value);
    const node = el('div', {}, [
      el('p', { text: `将下载 ${uids.length} 首到：` }),
      el('div', { class: 'diff' }, [el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: dir || '（未设置，默认 ~/Music/MacKit）' })])]),
      el('p', { class: 'muted', text: `命名模板：${tmpl}` }),
      el('p', { class: 'muted', text: `示例文件名：${sample}` }),
      el('p', { class: 'muted', text: '下载在「音乐下载」独立通道运行，不会阻塞 Homebrew 等任务。' }),
    ]);
    const ok = await ctx.ui.modal({
      title: '开始下载',
      body: node,
      actions: [
        { label: '取消', kind: 'ghost' },
        { label: '开始下载', kind: 'primary', onClick: (c) => c(true) },
      ],
    });
    if (ok !== true) return;
    await submitTask('download', { searchId: app.sess.id, uids, dir, template: tmpl });
  }

  // ------------------------------ ④ 下载队列 / 安装进度 ------------------------------
  function renderQueueCard(title) {
    app.queueEl = el('div', { class: 'music-queue' });
    const toolbar = el('div', { class: 'toolbar' }, [
      el('span', { class: 'muted', text: '安装 / 下载任务（独立通道，不影响其他模块）' }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '刷新', on: { click: () => refreshTasks() } }),
    ]);
    return el('div', { class: 'section' }, [ctx.ui.card(title || '下载队列', el('div', {}, [toolbar, app.queueEl]))]);
  }

  function startQueuePolling(immediate) {
    if (disposed) return; // ★ 卸载后的在途续跑不得再起轮询（addTimer 同时也已短路）
    if (immediate) refreshTasks();
    if (app.taskTimer == null) app.taskTimer = addTimer(refreshTasks, 1500);
  }

  /** 为「运行中 / 关注」的任务打开实时流（幂等；已订阅或已收尾则跳过）。 */
  function ensureStreams() {
    const tasks = app.tasks || [];
    for (const t of tasks) {
      if (t.status === 'running' || t.status === 'pending') ensureTaskStream(t);
    }
    // 关注任务：最近一次安装 / 卸载。即便已终态也订阅一次，把 backlog 拉回来（服务端对终态任务
    // 立即发 hello(backlog)+done 并关闭）——「瞬间失败」的日志也能就此显性化。
    // 但仅限「新」失败（FAIL_EXPAND_MS 内）：更早的历史遗留失败不值得每次进页面都全幅展开。
    const envTasks = tasks.filter((t) => t.action === 'install_env' || t.action === 'uninstall_env');
    if (envTasks.length > 0) {
      const feat = envTasks.reduce((a, b) => ((Number(b.startedAt || b.createdAt) || 0) >= (Number(a.startedAt || a.createdAt) || 0) ? b : a));
      if (!(isTerminalTask(feat.status) && !recentEnvFail(feat))) ensureTaskStream(feat);
    }
  }

  async function refreshTasks() {
    let list;
    try { list = await api('GET', '/api/tasks'); } catch { return; }
    if (disposed) return; // ★ 卸载后迟到的响应：不得再注册轮询 / SSE
    const music = (Array.isArray(list) ? list : []).filter((t) => t && t.module === 'music');
    app.tasks = music;
    // ★ 剪枝：已不在新列表里的任务，实时态（含已分离的日志 DOM 子树）立即丢弃并关流，避免长期驻留
    const ids = new Set(music.map((t) => t && t.id));
    for (const [id, e] of Array.from(live.entries())) {
      if (ids.has(id)) continue;
      if (e && e.stream && typeof e.stream.close === 'function') { try { e.stream.close(); } catch { /* ignore */ } }
      live.delete(id);
    }
    ensureStreams();
    updateInstallButton();
    renderQueue();

    // 安装 / 卸载任务结束后刷新部署状态（可能从「未部署」翻成「已就绪」）
    for (const t of music) {
      const terminal = isTerminalTask(t.status);
      if (!terminal || app.seenTerminal.has(t.id)) continue;
      app.seenTerminal.add(t.id);
      if (t.action === 'install_env' || t.action === 'uninstall_env') loadDeploy(true);
    }

    const active = music.some((t) => t.status === 'running' || t.status === 'pending');
    if (!active && app.taskTimer != null) { clearInterval(app.taskTimer); timers.delete(app.taskTimer); app.taskTimer = null; }
    if (active) ensureElapsedTicker();
    else if (app.elapsedTimer != null) { clearInterval(app.elapsedTimer); timers.delete(app.elapsedTimer); app.elapsedTimer = null; }
  }

  function renderQueue() {
    const box = app.queueEl;
    if (!box) return;
    box.innerHTML = '';
    app.elapsedNodes = [];
    const tasks = app.tasks || [];
    if (tasks.length === 0) { box.append(el('div', { class: 'muted music-empty-cell', text: '暂无音乐任务' })); return; }
    // 分页展示（每页 5 条，列表本身最新在前），避免历史任务把队列拉成长条
    const pages = Math.max(1, Math.ceil(tasks.length / QUEUE_PER_PAGE));
    if (app.qPage > pages) app.qPage = pages;
    if (app.qPage < 1) app.qPage = 1;
    const start = (app.qPage - 1) * QUEUE_PER_PAGE;
    for (const t of tasks.slice(start, start + QUEUE_PER_PAGE)) box.append(buildTaskRow(t));
    if (pages > 1) {
      const pager = el('div', { class: 'music-pager' });
      renderPager(pager, tasks.length, QUEUE_PER_PAGE, app.qPage, (p) => { app.qPage = p; renderQueue(); });
      box.append(pager);
    }
    updateElapsedNodes();
    pinLogs();
  }

  /** 步骤徽章（pending / running / ok / fail / skip / cancelled，逐态可见）。 */
  function renderSteps(steps) {
    const box = el('div', { class: 'music-tasks' });
    for (const s of steps.slice(0, 12)) {
      box.append(el('span', { class: `music-chip music-chip--${s.status || 'pending'}`, text: s.title || s.id || '步骤' }));
    }
    if (steps.length > 12) box.append(el('span', { class: 'muted', text: `… 共 ${steps.length} 步` }));
    return box;
  }

  /** 进度条（task.progress.done/total）；运行中步进时加动效，长步骤也有「进行中」的明确表达。 */
  function renderProgressBar(t, steps) {
    const total = (t.progress && Number(t.progress.total)) || steps.length || 0;
    const doneN = (t.progress && Number(t.progress.done)) || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((doneN / total) * 100))) : 0;
    const running = steps.find((s) => s.status === 'running');
    const bar = el('div', { class: `music-bar${t.status === 'running' ? ' music-bar--active' : ''}` });
    const fill = el('div', { class: 'music-bar__fill' });
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const label = running
      ? `进行中：${running.title || running.id}（${doneN}/${total} 步）`
      : `${doneN}/${total} 步`;
    return el('div', { class: 'music-progress' }, [bar, el('div', { class: 'muted music-progress__label', text: label })]);
  }

  /** 实时日志区（等宽、按 level 着色、自动吸底；内容从 live 表回填，重绘不丢）。 */
  function renderLiveLog(t) {
    const e = liveFor(t.id);
    // ★ 复用已建过的日志容器：队列每 1.5s 重绘一次，重建节点会让 ≤500 行日志整段回填（卡顿源）。
    //   容器被 renderQueue 从 DOM 摘下时仍保留自己的子节点与 scrollTop，重新 append 即原位复活。
    let box = e.logEl;
    if (!box) {
      box = el('div', { class: 'diff music-tasklog music-livlog' });
      e.logEl = box;
      e.renderedLines = 0;
      e.hasPlaceholder = false;
      // 滚动监听只绑一次：pinned = 用户是否仍贴底（后续吸底据此判断，不再无条件重置为 true）
      box.addEventListener('scroll', () => { e.pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 24; });
    }
    const lines = e.lines || [];
    if (e.hasPlaceholder && lines.length > 0) { box.innerHTML = ''; e.hasPlaceholder = false; e.renderedLines = 0; }
    if (lines.length === 0) {
      if (!e.hasPlaceholder) { box.innerHTML = ''; box.append(logPlaceholderNode()); e.hasPlaceholder = true; }
      e.renderedLines = 0;
    } else {
      let rendered = Number(e.renderedLines) || 0;
      // ★ 行数回退（live 表超上限后从头部滑出）：只删 DOM 头部多出的行，不整段重建。
      //   同上：用 children + removeChild（视图单测的 DOM 桩没有 childNodes / firstChild）。
      while (rendered > lines.length && box.children && box.children.length > 0) {
        box.removeChild(box.children[0]);
        rendered -= 1;
      }
      for (let i = rendered; i < lines.length; i++) box.append(logLineNode(lines[i])); // 只追加新行
      e.renderedLines = lines.length;
    }
    // ★ 保留用户上滚位置：只有本来贴底（pinned !== false）才吸底
    if (e.pinned !== false) box.scrollTop = box.scrollHeight;
    return box;
  }

  /** 失败错误块（红）：错误 message + detail + 重试安装 + 完整日志入口。 */
  function renderErrorBlock(t) {
    const err = t.error || {};
    const isEnv = t.action === 'install_env' || t.action === 'uninstall_env';
    const ops = el('div', { class: 'row music-taskerr__ops' });
    if (isEnv) ops.append(el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '重试安装', on: { click: () => retryInstall(t) } }));
    ops.append(el('button', { class: 'btn btn--sm', type: 'button', text: '查看完整日志', on: { click: () => showTaskLog(t.id) } }));
    return el('div', { class: 'music-taskerr' }, [
      el('div', { class: 'music-taskerr__title', text: `${isEnv ? '安装失败' : '任务失败'}：${err.message || '未知错误'}` }),
      err.detail ? el('pre', { class: 'mono music-taskerr__detail', text: String(err.detail) }) : null,
      ops,
    ]);
  }

  function buildTaskRow(t) {
    const steps = Array.isArray(t.steps) ? t.steps : [];
    const done = steps.filter((s) => ['ok', 'fail', 'skip', 'cancelled'].includes(s.status)).length;
    const badgeMap = {
      pending: ['排队中', 'muted'], running: ['运行中', 'auto'],
      ok: ['已完成', 'ok'], fail: ['失败', 'err'], cancelled: ['已取消', 'muted'],
    };
    const [label, kind] = badgeMap[t.status] || ['—', 'muted'];
    const active = t.status === 'running' || t.status === 'pending';

    const ops = el('div', { class: 'row music-taskrow__ops' });
    if (active) {
      if (t.cancellable !== false) {
        ops.append(el('button', { class: 'btn btn--sm btn--danger', type: 'button', text: '取消', on: { click: () => cancelTask(t.id) } }));
      }
    } else {
      ops.append(el('button', { class: 'btn btn--sm', type: 'button', text: '查看日志', on: { click: () => showTaskLog(t.id) } }));
    }

    // 「已用时」：运行中每秒滚动；已结束显示总用时。
    const elapsed = el('span', { class: 'muted nowrap music-taskrow__elapsed' });
    if (active && t.startedAt) { app.elapsedNodes.push({ el: elapsed, from: t.startedAt }); }
    else if (t.startedAt && t.endedAt) elapsed.textContent = `用时 ${fmtElapsed((t.endedAt - t.startedAt) / 1000)}`;

    const headRow = el('div', { class: 'row music-taskrow__head' }, [
      ctx.ui.badge(label, kind),
      el('span', { class: 'music-taskrow__title', text: t.title || t.action || '音乐任务' }),
      elapsed,
      el('span', { class: 'grow' }),
      el('span', { class: 'muted nowrap', text: steps.length ? `${done}/${steps.length} 步` : '' }),
      ops,
    ]);

    const row = el('div', { class: `music-taskrow music-taskrow--${t.status}` }, [headRow]);
    if (steps.length > 0) row.append(renderSteps(steps));

    if (active) {
      row.append(renderProgressBar(t, steps));
      row.append(renderLiveLog(t));
    } else if (t.status === 'fail' && recentEnvFail(t) && !isEnvReady()) {
      // 新失败（FAIL_EXPAND_MS 内）且环境仍未就绪：红色错误块 + 重试 + 实时日志全幅展开，便于就地排查。
      // ★ 环境已就绪时不展开——旧失败记录再挂「重试安装」会误导（环境好的，没有可重试的）。
      row.append(renderErrorBlock(t));
      row.append(renderLiveLog(t));
    } else {
      // 已结束（成功 / 取消 / 历史失败 / 环境已就绪的过时失败）：紧凑行，日志走「查看日志」弹窗
      // （服务端历史本就有界：内存 60 / 接口 20 / 落盘 10 份）。
      if (t.status === 'fail') {
        row.append(el('div', { class: 'muted', text: isEnvReady() ? '失败记录已过时（环境当前已就绪），点击右上「查看日志」回看' : '历史失败任务，点击右上「查看日志」回看详情' }));
      }
    }
    return row;
  }

  /** 环境是否已就绪（部署状态可用）。决定旧失败记录是否还值得展示「重试安装」。 */
  function isEnvReady() {
    return !!(app.deploy && app.deploy.usable);
  }

  /** 失败展开窗口：endedAt 在 FAIL_EXPAND_MS 内的算「新失败」，更早的是历史遗留（紧凑展示，避免每次进页面都被旧失败刷屏）。 */
  const FAIL_EXPAND_MS = 10 * 60_000;
  function recentEnvFail(t) {
    const end = Number(t && t.endedAt) || 0;
    return end > 0 && (Date.now() - end) < FAIL_EXPAND_MS;
  }

  /** 启动「已用时」秒级刷新定时器（仅在存在运行中任务时）。 */
  function ensureElapsedTicker() {
    if (disposed) return; // ★ 卸载后不再起秒级刷新（addTimer 亦会返回 null）
    if (app.elapsedTimer == null) app.elapsedTimer = addTimer(updateElapsedNodes, 1000);
  }

  function updateElapsedNodes() {
    const now = Date.now();
    for (const n of (app.elapsedNodes || [])) {
      if (n && n.el) n.el.textContent = `已用时 ${fmtElapsed((now - n.from) / 1000)}`;
    }
  }

  async function cancelTask(id) {
    try { await api('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`); ctx.ui.toast('info', '已请求取消'); }
    catch (err) { ctx.ui.toast('err', err.message || '取消失败'); }
    refreshTasks();
  }

  async function showTaskLog(id) {
    let rec;
    try { rec = await api('GET', `/api/history/${encodeURIComponent(id)}`); }
    catch (err) { ctx.ui.toast('err', err.message || '读取日志失败'); return; }
    const lines = (rec && rec.log) || [];
    const box = el('div', { class: 'diff music-tasklog' });
    if (lines.length === 0) {
      box.append(el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: '（无日志）' })]));
    } else {
      for (const l of lines) {
        const cls = logLevelClass(l.level);
        box.append(el('div', { class: 'diff__line' }, [
          el('span', { class: 'music-logts', text: ctx.fmtTime(l.ts) }),
          el('span', { class: cls, text: `[${l.level}] ${l.text}` }),
        ]));
      }
    }
    ctx.ui.modal({ title: '任务日志', width: 'min(860px, 100%)', body: box, actions: [{ label: '关闭', kind: 'ghost' }] });
  }

  // ------------------------------ ⑤ 下载目录 ------------------------------
  /** 命名模板预设（单一事实源由后端下发；兜底串与后端 TEMPLATE_PRESETS 一致）。 */
  function templatePresets() {
    const c = app.config || {};
    return (c.templatePresets && c.templatePresets.length) ? c.templatePresets : [
      { id: 'singer-song', label: '歌手 - 歌名', value: '{歌手} - {歌名}.{ext}' },
      { id: 'song-singer', label: '歌名 - 歌手', value: '{歌名} - {歌手}.{ext}' },
    ];
  }

  /** 当前模板命中的预设 id；自由文本返回 'custom'；空值视为预设 A（无损迁移判定，只读）。 */
  function currentTemplateMode() {
    const presets = templatePresets();
    const cur = String((app.config || {}).nameTemplate || '');
    if (cur === '') return presets[0].id;
    const hit = presets.find((p) => p.value === cur);
    return hit ? hit.id : 'custom';
  }

  /** 命名模板字段：三选一分段（两预设 + 自定义），自定义经弹窗编辑。 */
  function renderTemplateField() {
    const c = app.config || {};
    const presets = templatePresets();
    const mode = currentTemplateMode();
    const seg = el('div', { class: 'row music-tmplseg' });
    for (const p of presets) {
      seg.append(el('button', {
        class: `music-tmplseg__btn${mode === p.id ? ' is-active' : ''}`, type: 'button', text: p.label,
        on: { click: () => doSetTemplate(p.value) },
      }));
    }
    seg.append(el('button', {
      class: `music-tmplseg__btn${mode === 'custom' ? ' is-active' : ''}`, type: 'button', text: '自定义',
      on: { click: () => openTemplateModal() },
    }));

    const cur = c.nameTemplate || presets[0].value;
    const tmplShow = el('div', { class: 'mono music-tmpldisp', text: cur, title: cur });
    app.tmplEl = tmplShow;

    return el('div', { class: 'field' }, [
      el('label', { text: '命名模板' }),
      seg,
      el('div', { class: 'muted', text: `预览：${applyTemplate(cur, app.selected.values().next().value)}` }),
      tmplShow,
    ]);
  }

  async function doSetTemplate(value) {
    const next = await saveConfig({ nameTemplate: value });
    if (next) rerenderDirCard();
  }

  /** 代理设置子区（Q8：仅通道=「走代理」时渲染）。 */
  function renderProxySubarea() {
    const c = app.config || {};
    const source = c.proxySource === 'custom' ? 'custom' : 'homebrew';
    const hb = c.proxyHomebrew || {};
    const box = el('div', { class: 'music-proxy' });
    box.append(el('div', { class: 'music-proxy__title', text: '代理设置' }));

    const homeRadio = el('input', { type: 'radio', name: 'music-proxy-src', checked: source === 'homebrew' });
    const custRadio = el('input', { type: 'radio', name: 'music-proxy-src', checked: source === 'custom' });
    const httpInput = el('input', { type: 'text', class: 'music-proxy__input', value: c.proxyHttp || '', placeholder: '127.0.0.1:7890' });
    const socksInput = el('input', { type: 'text', class: 'music-proxy__input', value: c.proxySocks5 || '', placeholder: '127.0.0.1:7891' });

    const homebrewLine = el('div', { class: 'muted music-proxy__homebrew', text: `代理：${hb.http || '127.0.0.1:7897'}（只读，跟随 ~/.brewgo_config）` });
    const customBlock = el('div', { class: 'music-proxy__custom' }, [
      el('div', { class: 'field' }, [el('label', { text: 'HTTP 代理' }), httpInput]),
      el('div', { class: 'field' }, [el('label', { text: 'SOCKS5 代理' }), socksInput]),
      el('div', { class: 'muted music-proxy__hint', text: '主机:端口，不带 http://。SOCKS5 仅用于安装依赖；搜索 / 歌单 / 下载请填 HTTP。' }),
    ]);

    const syncMode = () => {
      const isCustom = custRadio.checked;
      homebrewLine.style.display = isCustom ? 'none' : '';
      customBlock.style.display = isCustom ? '' : 'none';
    };
    homeRadio.addEventListener('change', syncMode);
    custRadio.addEventListener('change', syncMode);

    const modeRow = el('div', { class: 'row music-proxy__mode' }, [
      el('label', { class: 'check' }, [homeRadio, el('span', { text: '跟随 Homebrew' })]),
      el('label', { class: 'check' }, [custRadio, el('span', { text: '自定义' })]),
    ]);

    const saveBtn = el('button', {
      class: 'btn btn--sm btn--primary', type: 'button', text: '保存代理设置',
      on: {
        click: async () => {
          const next = await saveConfig({
            proxySource: custRadio.checked ? 'custom' : 'homebrew',
            proxyHttp: httpInput.value.trim(),
            proxySocks5: socksInput.value.trim(),
          });
          if (next) rerenderDirCard();
        },
      },
    });

    box.append(modeRow, homebrewLine, customBlock, el('div', { class: 'row music-proxy__acts' }, [saveBtn]));
    syncMode();
    return box;
  }

  function renderDirCard() {
    const c = app.config || {};
    app.dirPathEl = el('div', { class: 'mono music-dirpath', text: c.downloadDir || '—' });

    const dirField = el('div', { class: 'field' }, [
      el('label', { text: '下载目录' }),
      app.dirPathEl,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', type: 'button', text: '选择…', on: { click: () => doChooseFolder() } }),
        el('button', { class: 'btn btn--primary', type: 'button', text: '在 Finder 打开', on: { click: () => doOpenFolder() } }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '复制路径', on: { click: () => ctx.ui.copy(c.downloadDir, '已复制下载目录') } }),
      ]),
    ]);

    const tmplField = renderTemplateField();

    // 网络通道：文案收敛为「直连 / 走代理」两项；旧 auto 显示为直连（**存储枚举不变**，改动时才落盘）
    const chSel = el('select', { on: { change: (e) => doSetChannel(e.target.value) } }, [
      el('option', { value: 'direct', text: '直连', selected: c.channel !== 'proxy' }),
      el('option', { value: 'proxy', text: '走代理', selected: c.channel === 'proxy' }),
    ]);
    const chField = el('div', { class: 'field' }, [el('label', { text: '网络通道' }), chSel]);

    // 歌词开关：musicdl 下载时自动旁写 .lrc；关掉则下载完成后删除旁车歌词文件
    const lyrCheck = el('input', { type: 'checkbox', checked: c.saveLyrics !== false, id: 'music-savelyrics' });
    const lyrField = el('div', { class: 'field' }, [
      el('label', { class: 'check', for: 'music-savelyrics' }, [lyrCheck, el('span', { text: '同时下载歌词（.lrc 文件，与音频同名）' })]),
    ]);
    lyrCheck.addEventListener('change', () => doSetSaveLyrics(lyrCheck.checked));

    // 增强搜索（实验）：走第三方代理 API，更快、支持「歌手 - 歌名」组合词；默认关（依赖外部服务）
    const enhCheck = el('input', { type: 'checkbox', checked: c.enhancedSearch === true, id: 'music-enhsearch' });
    const enhField = el('div', { class: 'field' }, [
      el('label', { class: 'check', for: 'music-enhsearch' }, [enhCheck, el('span', { text: '增强搜索（实验）' })]),
      el('div', { class: 'muted music-enh-hint', text: '走第三方代理：搜索更快、支持「歌手 - 歌名」组合词；但依赖外部服务（可能限流/失效），且下载的歌曲不含封面，歌词仅存为 .lrc（不写入音频）。默认关闭，保持离线优先。' }),
    ]);
    enhCheck.addEventListener('change', () => doSetEnhancedSearch(enhCheck.checked));

    // ★ C3：性能设置（缓存上限 + 下载并发）。合法域与后端 store.js 的夹取口径一致：
    //   缓存 128–5120 MB（默认 1024）、并发 1–5（默认 3）。非法输入前端先拦，后端仍会夹取兜底。
    app.cacheMaxInput = el('input', {
      type: 'number', class: 'music-num', min: 128, max: 5120, step: 128,
      value: String(Number.isFinite(c.cacheMaxMb) ? c.cacheMaxMb : 1024),
    });
    app.concInput = el('input', {
      type: 'number', class: 'music-num', min: 1, max: 5, step: 1,
      value: String(Number.isFinite(c.downloadConcurrency) ? c.downloadConcurrency : 3),
    });
    const perfField = el('div', { class: 'field' }, [
      el('label', { text: '性能设置' }),
      el('div', { class: 'row music-setrow' }, [
        el('span', { class: 'muted', text: '缓存上限 (MB)' }), app.cacheMaxInput,
        el('span', { class: 'muted', text: '下载并发' }), app.concInput,
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '保存性能设置', on: { click: () => doSetPerf() } }),
        el('span', { class: 'muted music-enh-hint', text: '缓存上限 128–5120 MB（在线试听的音频临时缓存，超额按最旧清理）；下载并发 1–5。' }),
      ]),
    ]);

    const children = [dirField, tmplField, chField, lyrField, enhField, perfField];
    // Q8：代理设置子区仅在通道=「走代理」时展开
    if (c.channel === 'proxy') children.push(renderProxySubarea());

    app.dirCardNode = el('div', { class: 'section' }, [ctx.ui.card('下载目录', el('div', {}, children))]);
    return app.dirCardNode;
  }

  /** 重绘 ⑤ 下载目录卡（配置变更后原地替换，避免整页重绘、丢失搜索态）。 */
  function rerenderDirCard() {
    const old = app.dirCardNode;
    const fresh = renderDirCard();
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
  }

  async function doSetChannel(value) {
    const next = await saveConfig({ channel: value });
    if (next) rerenderDirCard();
  }

  async function doSetSaveLyrics(value) {
    const next = await saveConfig({ saveLyrics: value === true });
    if (next) ctx.ui.toast('ok', next.saveLyrics ? '将同时保存歌词（对之后的下载生效）' : '将不再保存歌词（对之后的下载生效）');
  }

  async function doSetEnhancedSearch(value) {
    const next = await saveConfig({ enhancedSearch: value === true });
    if (next) ctx.ui.toast('ok', next.enhancedSearch ? '已开启增强搜索（实验）：走第三方代理，更快且支持组合词' : '已关闭增强搜索，恢复离线 musicdl 搜索');
  }

  /** ★ C3：保存性能设置（缓存上限 / 下载并发）。前端先校验范围，后端仍会夹取兜底。 */
  async function doSetPerf() {
    const cache = Number(app.cacheMaxInput && app.cacheMaxInput.value);
    const conc = Number(app.concInput && app.concInput.value);
    if (!Number.isFinite(cache) || cache < 128 || cache > 5120) { ctx.ui.toast('warn', '缓存上限需在 128 – 5120 MB 之间'); return; }
    if (!Number.isFinite(conc) || conc < 1 || conc > 5) { ctx.ui.toast('warn', '下载并发需在 1 – 5 之间'); return; }
    const next = await saveConfig({ cacheMaxMb: Math.round(cache), downloadConcurrency: Math.round(conc) });
    if (next) {
      ctx.ui.toast('ok', `性能设置已保存：缓存上限 ${next.cacheMaxMb} MB · 并发 ${next.downloadConcurrency}`);
      rerenderDirCard(); // 回显（含后端夹取后的实际值）
    }
  }

  async function saveConfig(patch) {
    const c = app.config || {};
    const bodyReq = {
      downloadDir: ('downloadDir' in patch) ? patch.downloadDir : c.downloadDir,
      nameTemplate: ('nameTemplate' in patch) ? patch.nameTemplate : c.nameTemplate,
      channel: ('channel' in patch) ? patch.channel : c.channel,
      sources: ('sources' in patch) ? patch.sources : [...app.selSources],
      saveLyrics: ('saveLyrics' in patch) ? patch.saveLyrics === true : c.saveLyrics !== false,
      enhancedSearch: ('enhancedSearch' in patch) ? patch.enhancedSearch === true : c.enhancedSearch !== false,
    };
    // R0：**仅当本次 patch 显式包含代理字段时**才转发三键（不再无条件回填）。
    // 目的：音乐页自身的「无关保存」（改下载目录 / 切模板 / 切通道）**不得触发后端代理校验**。
    // 否则一旦 config.json 被手工改成 `custom` + 两址皆空，readMackit 会把地址归一为空但
    // source 仍是 custom，此后本页任何保存都会被 422 卡死，只能再手工改文件才能解开。
    // 「代理设置」子区发起保存时会**显式**带上三键（见 renderProxySubarea），故 A8 语义不受影响。
    if ('proxySource' in patch || 'proxyHttp' in patch || 'proxySocks5' in patch) {
      bodyReq.proxySource = ('proxySource' in patch) ? patch.proxySource : c.proxySource;
      bodyReq.proxyHttp = ('proxyHttp' in patch) ? patch.proxyHttp : c.proxyHttp;
      bodyReq.proxySocks5 = ('proxySocks5' in patch) ? patch.proxySocks5 : c.proxySocks5;
    }
    // C3：同代理口径 —— 仅当本次 patch 显式包含性能键时才转发，避免无关保存覆盖后端当前值。
    if ('cacheMaxMb' in patch) bodyReq.cacheMaxMb = patch.cacheMaxMb;
    if ('downloadConcurrency' in patch) bodyReq.downloadConcurrency = patch.downloadConcurrency;
    let next;
    try { next = await api('PUT', '/api/music/config', bodyReq); }
    catch (err) { ctx.ui.toast('err', err.message || '保存失败'); return null; }
    app.config = next;
    if (app.dirPathEl) app.dirPathEl.textContent = next.downloadDir || '—';
    if (app.tmplEl) app.tmplEl.textContent = next.nameTemplate || '';
    return next;
  }

  async function doChooseFolder() {
    try {
      const r = await api('GET', '/api/music/chooseFolder');
      if (r.cancelled) return;
      if (r.path) {
        const dir = r.path.replace(/\/+$/, '') || r.path;
        await saveConfig({ downloadDir: dir });
        ctx.ui.toast(r.writable === false ? 'warn' : 'ok', r.writable === false ? '目录不可写，请换一个' : '已更新下载目录');
      }
    } catch (err) {
      // 失败回落：手输路径（设计 §10 项 7）
      openManualDirModal(err && err.message);
    }
  }

  /** P0-6：在 Finder 打开下载目录（目录不存在由后端自动创建）。 */
  async function doOpenFolder() {
    const dir = (app.config && app.config.downloadDir) || '';
    let res;
    try { res = await api('POST', '/api/music/openFolder', { dir }); }
    catch (err) { ctx.ui.toast('err', err.message || '打开失败'); return; }
    ctx.ui.toast('ok', '已在 Finder 中打开下载目录');
    startQueuePolling(true);
    return res;
  }

  function openManualDirModal(msg) {
    const input = el('input', { type: 'text', value: (app.config && app.config.downloadDir) || '' });
    const node = el('div', {}, [
      el('p', { class: 'muted', text: msg || '无法打开系统目录选择框，请手动输入路径。' }),
      el('div', { class: 'field' }, [el('label', { text: '下载目录（绝对路径）' }), input]),
    ]);
    ctx.ui.modal({
      title: '手动输入下载目录',
      body: node,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存', kind: 'primary',
          onClick: async (close) => {
            const val = input.value.trim();
            if (!val) { ctx.ui.toast('warn', '请填写目录路径'); return; }
            await saveConfig({ downloadDir: val });
            close(true);
          },
        },
      ],
    });
  }

  function openTemplateModal() {
    const c = app.config || {};
    const input = el('input', { type: 'text', value: c.nameTemplate || '{歌手} - {歌名}.{ext}' });
    const preview = el('div', { class: 'muted' });
    const upd = () => { preview.textContent = `示例：${applyTemplate(input.value, app.selected.values().next().value)}`; };
    input.addEventListener('input', upd);
    upd();

    const vars = (c.templateVars && c.templateVars.length) ? c.templateVars : ['{歌手}', '{歌名}', '{专辑}', '{来源}', '{ext}'];
    const varRow = el('div', { class: 'row music-tmplvars' });
    for (const v of vars) {
      varRow.append(el('button', {
        class: 'btn btn--sm btn--ghost', type: 'button', text: v,
        on: { click: () => { input.value += v; upd(); } },
      }));
    }

    const node = el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: '命名模板' }), input]),
      varRow,
      preview,
      el('p', { class: 'muted', text: '非法字符会自动替换为 _；重名自动追加 (1)(2)…' }),
    ]);
    ctx.ui.modal({
      title: '命名模板',
      body: node,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存', kind: 'primary',
          onClick: async (close) => {
            const val = input.value.trim() || '{歌手} - {歌名}.{ext}';
            const next = await saveConfig({ nameTemplate: val });
            if (next) { rerenderDirCard(); close(true); }
          },
        },
      ],
    });
  }

  // ------------------------------ 启动 ------------------------------
  async function start() {
    paint(); // 先给「正在检测…」占位
    await loadDeploy(false);
    refreshTasks();
  }

  return { start };
}
