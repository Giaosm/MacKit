/**
 * MacKit · 前端外壳（无框架）
 *
 *   - 单页 + 哈希路由（#/dashboard|#/brew|#/dsh|#/music|#/sysinit|#/rime|#/unseal|#/backups）
 *   - 视图注册表：每个 web/views/*.js 默认导出 { id, title, mount(root, ctx), unmount?() }
 *     （侧边栏图标由本文件 NAV 提供，视图不自带 icon）
 *   - 状态单一来源在后端：本文件只做订阅/渲染，不推断任务状态
 *   - API 客户端（统一错误对象）+ SSE 客户端（按 seq 去重、Last-Event-ID 补齐）
 *   - 共享组件：toast / modal / confirmDialog / diff / dataTable / 状态灯 / 空态 / 卡片 / kv
 *   - 零外部资源：图标全部内联 SVG，字体/配色走 style.css 的 CSS 变量
 *
 * ★ 视图扩展方式（加一行即可）：
 *   1) VIEW_MODULES 已预置 6 个 id → 动态 import()（缺失的视图会被安全跳过并提示"开发中"）；
 *      继续新增视图：在 VIEW_MODULES 与 NAV 各加一行即可。
 *   2) 视图通过 ctx 使用外壳能力，契约见下方 makeCtx（只暴露视图实际需要的成员）。
 */

import { fmtRel } from './reltime.js';
import { diffMetaState } from './meta-state.js';

// ============================== 常量 ==============================
const DEFAULT_PORT = 18080;
const HEALTH_POLL_MS = 15_000;
const TOAST_MS = 4200;

/** 内联 SVG 图标（零外链）。 */
const ICON = {
  home: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  beer: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h9v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M15 10h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/><path d="M6 8V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v2"/></svg>',
  gear: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H2.8a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1V4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.9 11h.1a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4.9z"/></svg>',
  ime: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h1M11 9h1M15 9h2"/><path d="M7 13h10"/></svg>',
  lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  backups: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  // DeepSeek Harness：终端窗口（dsh web / plugin 都从命令行来）
  dsh: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
  // 音乐下载：双音符
  music: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
};

/** 侧边栏导航（外壳自身定义；视图可自带 title 覆盖）。 */
const NAV = [
  { id: 'dashboard', title: '总览', icon: ICON.home },
  { id: 'brew', title: 'Homebrew 管家', icon: ICON.beer },
  { id: 'dsh', title: 'DeepSeek Harness', icon: ICON.dsh },
  { id: 'music', title: '音乐下载', icon: ICON.music },
  { id: 'sysinit', title: '系统初始化', icon: ICON.gear },
  { id: 'rime', title: 'Rime 输入法', icon: ICON.ime },
  { id: 'unseal', title: '应用解隔离', icon: ICON.lock },
  { id: 'backups', title: '备份中心', icon: ICON.backups },
];

/**
 * ★ 视图注册表：加一行即可挂载一个新视图。
 * 8 个视图（dashboard / brew / dsh / music / sysinit / rime / unseal / backups）均已实现；对应文件缺失时会安全降级为"开发中"提示。
 */
const VIEW_MODULES = {
  dashboard: () => import('./views/dashboard.js'),
  brew: () => import('./views/brew.js'),
  dsh: () => import('./views/dsh.js'),
  music: () => import('./views/music.js'),
  sysinit: () => import('./views/sysinit.js'),
  rime: () => import('./views/rime.js'),
  unseal: () => import('./views/unseal.js'),
  backups: () => import('./views/backups.js'),
};

// ============================== DOM 引用 ==============================
const $ = (id) => document.getElementById(id);
const dom = {
  nav: $('nav'), main: $('main'),
  serviceStatus: $('serviceStatus'), serviceText: $('serviceText'),
  btnShutdown: $('btnShutdown'),
  historyList: $('historyList'), btnHistoryRefresh: $('btnHistoryRefresh'),
  logDrawer: $('logDrawer'), btnLogToggle: $('btnLogToggle'), logTaskLabel: $('logTaskLabel'),
  chkAutoScroll: $('chkAutoScroll'), btnLogClear: $('btnLogClear'), btnLogCopy: $('btnLogCopy'),
  btnLogOpen: $('btnLogOpen'), logBody: $('logBody'), logList: $('logList'),
  shutdownVeil: $('shutdownVeil'), veilTitle: $('shutdownVeilTitle'), veilText: $('shutdownVeilText'),
  toastHost: $('toastHost'), modalHost: $('modalHost'),
};

// ============================== 全局状态（仅缓存，非事实源） ==============================
const state = {
  task: null,
  running: false, currentTaskId: null, history: [],
  view: null, viewInstance: null,
  /** Homebrew 元数据同步状态（/api/health 的 brewMeta；视图用 ctx.state.brewMeta 读、订 'brewmeta' 事件） */
  brewMeta: null,
};

// ============================== 事件总线 ==============================
const bus = new Map();
function on(event, handler) {
  if (!bus.has(event)) bus.set(event, new Set());
  bus.get(event).add(handler);
  return () => { const s = bus.get(event); if (s) s.delete(handler); };
}
function emit(event, ...args) {
  const s = bus.get(event);
  if (s) for (const fn of Array.from(s)) { try { fn(...args); } catch (e) { console.error(e); } }
}

// ============================== 元素工具 ==============================
/**
 * 极简 DOM 构造器。
 * @param {string} tag
 * @param {Object} [props] class/text/html/on:{ev:fn}/dataset 等，或直接作为 DOM 属性
 * @param {Array|Node|string} [children]
 */
function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'html') n.innerHTML = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, String(v));
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
const fmtTime = (ms) => { try { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; } };
const fmtDateTime = (ms) => { try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; } };
/** 字节数 → 人类可读（B / KB / MB / GB）；null / 非有限 / 负数 → '—'。 */
function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================== API 客户端 ==============================
/**
 * 统一请求：成功返回 data；失败抛 ErrObj { code, message, detail? }。
 * @param {'GET'|'POST'|'PUT'} method
 * @param {string} path
 * @param {Object} [body]
 */
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opt); }
  catch (err) { throw { code: 'NET_UNREACHABLE', message: '无法连接后端服务', detail: String(err && err.message) }; }
  let json = null;
  try { json = await res.json(); } catch { throw { code: 'PARSE_FAILED', message: '响应不是合法 JSON' }; }
  if (!json || json.ok !== true) throw (json && json.error) || { code: 'CMD_FAILED', message: `请求失败（HTTP ${res.status}）` };
  return json.data;
}

// ============================== 共享组件 ==============================
function toast(level, text) {
  const lvl = ['ok', 'warn', 'err'].includes(level) ? level : 'info';
  const node = el('div', { class: `toast toast--${lvl}`, text });
  dom.toastHost.append(node);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 200); }, TOAST_MS);
}

/** 共享剪贴板：空文本忽略；成功 toast('ok', okMsg) / 失败 toast('warn', …)。 */
async function copyText(text, okMsg = '已复制') {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('ok', okMsg); }
  catch { toast('warn', '复制失败，请手动选择'); }
}

/** 端口字符串校验：纯数字且 1–65535。 */
const portOk = (v) => /^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

/**
 * 当前打开的弹窗关闭器。同屏只允许一个弹窗：
 * 叠加打开时若不结算旧的，会遗留一个 document keydown 监听 + 一个永不 resolve 的 Promise。
 */
let activeModalClose = null;

/** 通用弹窗；actions 为 [{label, kind?, onClick?(close)}]。 */
function modal({ title, body, actions = [], danger = false, width }) {
  return new Promise((resolve) => {
    if (activeModalClose) { try { activeModalClose(null); } catch { /* ignore */ } }
    const card = el('div', { class: 'modal' });
    if (width) card.style.width = width;
    card.append(el('div', { class: `modal__head${danger ? ' dot-err' : ''}` }, [danger ? '⚠ ' : '', title]));
    const bodyNode = el('div', { class: 'modal__body' });
    if (body && body.nodeType) bodyNode.append(body); else bodyNode.append(el('div', { text: body || '' }));
    card.append(bodyNode);
    let closed = false;
    const close = (val) => {
      if (closed) return;              // 幂等：叠加打开时可能被新旧两条路径同时调用
      closed = true;
      dom.modalHost.hidden = true; dom.modalHost.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (activeModalClose === close) activeModalClose = null;
      resolve(val);
    };
    activeModalClose = close;
    const foot = el('div', { class: 'modal__foot' });
    const acts = actions.length ? actions : [{ label: '关闭', kind: 'ghost' }];
    for (const a of acts) {
      foot.append(el('button', {
        class: `btn${a.kind ? ' btn--' + a.kind : ''}`, type: 'button', text: a.label,
        on: { click: () => { if (a.onClick) { a.onClick(close); } else close(); } },
      }));
    }
    card.append(foot);
    dom.modalHost.hidden = false; dom.modalHost.innerHTML = ''; dom.modalHost.append(card);
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    dom.modalHost.onclick = (e) => { if (e.target === dom.modalHost) close(null); };
  });
}

/** 二次确认弹窗基座（供危险操作使用）→ Promise<boolean>。 */
function confirmDialog({ title, body, confirmLabel = '确认', danger = true }) {
  return modal({
    title, body, danger,
    actions: [
      { label: '取消', kind: 'ghost', onClick: (c) => { c(false); } },
      { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (c) => { c(true); } },
    ],
  }).then((v) => v === true);
}

/** 逐行 diff 渲染（lines = [{type:'same'|'add'|'del', text}]）。 */
function diffView(lines) {
  const wrap = el('div', { class: 'diff' });
  const prefix = { add: '+', del: '-', same: ' ' };
  (lines || []).forEach((l, i) => {
    const t = ['add', 'del', 'same'].includes(l.type) ? l.type : 'same';
    wrap.append(el('div', { class: 'diff__line' }, [
      el('span', { class: 'diff__no', text: String(i + 1) }),
      el('span', { class: `diff__${t}`, text: `${prefix[t]} ${l.text}` }),
    ]));
  });
  return wrap;
}

const statusLight = (st) => el('span', { class: `light light--${['ok', 'warn', 'error'].includes(st) ? st : 'warn'}`, title: ({ ok: '正常', warn: '需注意', error: '异常' })[st] || '' });
const badge = (text, kind) => el('span', { class: `badge${kind ? ' badge--' + kind : ''}`, text });

function emptyState({ icon = '·', title, text, actions = [] }) {
  const box = el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon', text: icon }),
    el('div', { class: 'empty__title', text: title }),
    text ? el('div', { class: 'muted', text }) : null,
  ]);
  if (actions.length) {
    const row = el('div', { class: 'row' });
    for (const a of actions) row.append(el('button', { class: `btn${a.kind ? ' btn--' + a.kind : ''}`, type: 'button', text: a.label, on: { click: a.onClick || (() => {}) } }));
    box.append(row);
  }
  return box;
}

const kv = (k, v) => el('div', { class: 'kv' }, [el('span', { class: 'kv__k', text: k }), el('span', { class: 'kv__v' }, [v && v.nodeType ? v : String(v == null ? '—' : v)])]);

function card(title, content, { light = null, extra = null } = {}) {
  const head = el('div', { class: 'card__head' }, [el('div', { class: 'card__title' }, [light ? statusLight(light) : null, title])]);
  if (extra) head.append(extra);
  return el('div', { class: 'card' }, [head, content]);
}

/**
 * 通用表格（搜索 + 多选 + 全选 + 空态）。
 * columns: [{key, label, render?(row)}]；rowKey?(row,i)；selectable；searchable；emptyText。
 * 返回 { el, getSelectedRows() }。setRows 只供内部初始化使用，不对外暴露
 * （对外暴露的 getSelected / setRows 全仓无调用方，已移除）。
 */
function dataTable(cfg) {
  const { columns = [], rows = [], rowKey = (r, i) => String(i), selectable = false, searchable = false, searchPlaceholder = '搜索…', emptyText = '无数据' } = cfg;
  const selected = new Set();
  let items = [];
  const filter = { q: '' };
  const tbody = el('tbody');
  const headCb = selectable ? el('input', { type: 'checkbox', title: '全选' }) : null;
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, [selectable ? el('th', { style: 'width:36px' }, [headCb]) : null, ...columns.map((c) => el('th', { text: c.label }))])]),
    tbody,
  ]);
  const countEl = el('span', { class: 'muted nowrap' });
  const toolbar = el('div', { class: 'toolbar' }, [
    searchable ? el('input', { type: 'search', placeholder: searchPlaceholder, style: 'max-width:220px', on: { input: (e) => { filter.q = e.target.value.trim().toLowerCase(); render(); } } }) : null,
    el('span', { class: 'grow' }), countEl,
  ]);
  const visible = () => (filter.q ? items.filter((it) => columns.map((c) => it.row[c.key]).join(' ').toLowerCase().includes(filter.q)) : items);
  const getSelectedRows = () => items.filter((it) => selected.has(it.key)).map((it) => it.row);
  function syncHead() { if (!headCb) return; const v = visible(); headCb.checked = v.length > 0 && v.every((it) => selected.has(it.key)); headCb.disabled = v.length === 0; }
  function render() {
    const vis = visible();
    tbody.innerHTML = '';
    if (vis.length === 0) tbody.append(el('tr', {}, [el('td', { colspan: String(columns.length + (selectable ? 1 : 0)), class: 'muted', text: emptyText })]));
    for (const it of vis) {
      const tr = el('tr');
      if (selectable) tr.append(el('td', {}, [el('input', { type: 'checkbox', checked: selected.has(it.key), on: { change: (e) => { if (e.target.checked) selected.add(it.key); else selected.delete(it.key); syncHead(); } } })]));
      for (const c of columns) {
        const v = c.render ? c.render(it.row) : String(it.row[c.key] == null ? '' : it.row[c.key]);
        tr.append(el('td', {}, [v && v.nodeType ? v : String(v)]));
      }
      tbody.append(tr);
    }
    syncHead();
    countEl.textContent = selectable ? `已选 ${selected.size} / 共 ${vis.length}` : `共 ${vis.length}`;
  }
  function setRows(r) { items = (r || []).map((row, i) => ({ row, key: String(rowKey(row, i)) })); selected.clear(); render(); }
  if (headCb) headCb.addEventListener('change', (e) => { for (const it of visible()) { if (e.target.checked) selected.add(it.key); else selected.delete(it.key); } render(); });
  setRows(rows);
  return { el: el('div', {}, [toolbar, el('div', { class: 'table__scroll' }, [table])]), getSelectedRows };
}

// ============================== 日志抽屉 ==============================
const logSeen = new Set();
let logOrder = [];
// 前端自己的 DOM/数组上限（与后端 runner 的 RING_MAX 同为 2000，但两者是独立的上限：
// 后端管内存缓冲，这里管浏览器侧 —— 实时日志逐条推送，不设上限会把数组与 DOM 节点堆爆）。
const LOG_MAX = 2000;
/**
 * 空态占位。★ 只在 JS 里渲染一份：原先 index.html 写死了这个 <li id="logEmpty">，
 * 而 clearLogs() 直接清空 innerHTML 把它一并删掉且不再补回 —— 清一次屏，空态文案就永久消失。
 */
function showLogEmpty() {
  dom.logList.innerHTML = '';
  dom.logList.append(el('li', { class: 'loglist__empty', text: '暂无日志 · 任务开始后日志会实时显示在这里' }));
}
function appendLogLine(line) {
  if (!line || logSeen.has(line.seq)) return;
  logSeen.add(line.seq); logOrder.push(line);
  const ph = dom.logList.querySelector('.loglist__empty');
  if (ph) ph.remove();
  const li = el('li', { class: `logline logline--${line.level}` }, [
    el('span', { class: 'logline__ts', text: fmtTime(line.ts) }),
    el('span', { class: 'logline__lvl', text: ({ info: 'ℹ', ok: '✓', warn: '⚠', error: '✗' })[line.level] || 'ℹ' }),
    el('span', { class: 'logline__text', text: line.text }),
  ]);
  dom.logList.append(li);
  // 环形裁剪：同步丢掉最旧的数组项与对应的 DOM 节点（整份日志另有落盘文件可查）
  while (logOrder.length > LOG_MAX) {
    const old = logOrder.shift();
    if (old) logSeen.delete(old.seq);
    const first = dom.logList.firstElementChild;
    if (first) first.remove();
  }
  if (dom.chkAutoScroll.checked) dom.logBody.scrollTop = dom.logBody.scrollHeight;
  emit('log', line);
}
function clearLogs() { logSeen.clear(); logOrder = []; showLogEmpty(); }
function setLogTaskLabel(text) { dom.logTaskLabel.textContent = text; }
function openLogDrawer() { dom.logDrawer.classList.remove('logdrawer--collapsed'); dom.btnLogToggle.setAttribute('aria-expanded', 'true'); }
async function openLogFile() {
  const tid = state.currentTaskId || (state.task && state.task.id);
  const p = state.task && state.task.logPath;
  const path = p || (tid ? `~/.mackit/logs/${tid}.log` : '');
  await modal({
    title: '任务日志文件', body: el('div', {}, [
      el('p', { text: '日志已全量落盘（不受内存环形缓冲限制）。在 Finder 中按 ⌘⇧G 粘贴以下路径即可定位：' }),
      el('div', { class: 'diff' }, [el('div', { class: 'diff__line', text: path || '（当前无任务）' })]),
    ]),
    actions: [
      { label: '复制路径', kind: 'primary', onClick: async (c) => { await copyText(path, '日志路径已复制'); c(null); } },
      { label: '关闭', kind: 'ghost' },
    ],
  });
}

// ============================== 任务订阅（SSE） ==============================
/** SSE 自动重连次数上限：超过则改用一次性查询兜底（防止永久重连 + attach 的 Promise 悬空）。 */
const SSE_MAX_RETRY = 5;
/**
 * 订阅（或恢复订阅）一个任务的日志流。
 * @param {string} taskId
 * @param {{onDone?:Function}} [opts]
 * @returns {Promise<any>} 终态 task
 */
function attach(taskId, opts = {}) {
  return new Promise((resolve) => {
    state.currentTaskId = taskId;
    state.running = true;
    const es = new EventSource(`/api/tasks/${taskId}/log`);
    let settled = false;
    const finish = (task) => { if (settled) return; settled = true; es.close(); resolve(task); };
    es.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'hello') {
        if (msg.task) { state.task = msg.task; state.running = !isTerminal(msg.task.status); emit('task', msg.task); setLogTaskLabel(taskLabel(msg.task)); }
        for (const l of msg.backlog || []) appendLogLine(l);
      } else if (msg.type === 'log') appendLogLine(msg.line);
      else if (msg.type === 'task') {
        state.task = msg.task; state.running = !isTerminal(msg.task.status);
        emit('task', msg.task); setLogTaskLabel(taskLabel(msg.task));
      } else if (msg.type === 'done') {
        state.task = msg.task; state.running = false; state.currentTaskId = null;
        emit('task', msg.task); emit('done', msg.task); setLogTaskLabel(taskLabel(msg.task));
        refreshHistory();
        if (opts.onDone) { try { opts.onDone(msg.task); } catch (e) { console.error(e); } }
        finish(msg.task);
      }
    });
    // 断流兜底：一次性拉取任务终态。SSE 会无限自动重连，若不设上限，
    // 任务已不存在（404）或服务重启时，旧连接会一直重试且 attach 的 Promise 永久悬空。
    let retries = 0;
    // 连接成功（含自动重连成功）→ 复位重试计数。否则长任务（brew 升级 / 400MB 模型下载）
    // 期间累计的几次偶发闪断就会把上限耗光，之后即使网络已恢复也不再跟随日志。
    es.onopen = () => {
      if (settled || retries === 0) return;
      retries = 0;
      pollHealth(); // 顺带把顶栏从「日志流中断…」恢复成真实服务状态
    };
    const fallback = async () => {
      let t = null;
      // api() 已把响应解包到 data，而 /api/tasks/:id 返回的**就是任务对象本身**
      // （不是 { task }）。若在这里再取一次 .task 会恒为 undefined，t 恒为 null。
      try { const r = await api('GET', `/api/tasks/${encodeURIComponent(taskId)}`); t = r && typeof r === 'object' && r.id ? r : null; }
      catch { setService('err', '日志流已断开'); }
      if (t) {
        state.task = t; state.running = !isTerminal(t.status);
        emit('task', t); setLogTaskLabel(taskLabel(t));
        if (isTerminal(t.status)) {
          state.currentTaskId = null; emit('done', t); refreshHistory();
          // 「更新 MacKit」跑完 → 立刻体检一次：后端代码若已换新，横幅要马上出现，
          // 不必等下一个 15s 轮询（用户刚点完更新，正是最需要看到「需要重启」的时刻）。
          if (t.action === 'update') pollHealth();
          if (opts.onDone) { try { opts.onDone(t); } catch (e) { console.error(e); } }
        } else setService('warn', '日志流已断开，任务仍在后台运行');
      } else {
        // ★ 连兜底查询也失败：必须复位运行态。否则 state.running 永久停在 true，
        //   之后每次 runTask 都会被首行的「有任务正在运行」挡掉，用户只能刷新页面。
        //   （后端 runner 本身有串行队列，前端放行不会造成并发执行。）
        state.running = false;
        state.currentTaskId = null;
      }
      finish(t);
    };
    es.onerror = () => {
      if (settled) return;
      // readyState 已 CLOSED = 浏览器放弃重连（任务不存在 / 服务已退出）→ 立即兜底
      if (es.readyState === EventSource.CLOSED) { fallback(); return; }
      retries += 1;
      if (retries > SSE_MAX_RETRY) { fallback(); return; }  // 连续中断超上限 → 兜底，不再无限重试
      setService('warn', `日志流中断，正在重连…（${retries}/${SSE_MAX_RETRY}）`);
    };
  });
}

/** 发起任务：POST → attach。confirm=true 满足后端的危险操作校验。 */
async function runTask(module, action, params = {}, opts = {}) {
  if (state.running) { toast('warn', '有任务正在运行，请等待结束或取消后再试'); return null; }
  const body = { module, action, params };
  if (opts.confirm === true) body.confirm = true;
  let submitted;
  try { submitted = await api('POST', '/api/tasks', body); }
  catch (err) { toast('err', err.message || '提交任务失败'); throw err; }
  const t = submitted.task;
  clearLogs();
  state.task = t; state.running = true;
  emit('task', t); setLogTaskLabel(taskLabel(t)); openLogDrawer();
  appendLogLine({ seq: 0, ts: Date.now(), level: 'info', text: `任务已提交：${t.title}` });
  return attach(submitted.taskId, opts);
}

const isTerminal = (s) => s === 'ok' || s === 'fail' || s === 'cancelled';
const taskLabel = (t) => t ? `${t.title} · ${{ pending: '排队中', running: '运行中', ok: '已完成', fail: '失败', cancelled: '已取消' }[t.status] || t.status}` : '暂无任务';

// ============================== 历史 ==============================
async function refreshHistory() {
  try { state.history = await api('GET', '/api/history'); } catch { state.history = []; }
  renderHistory();
}
function renderHistory() {
  dom.historyList.innerHTML = '';
  if (!state.history.length) { dom.historyList.append(el('li', { class: 'history__empty', text: '📋 暂无任务记录' })); startRelTimer(); return; }
  // 条数上限由后端 store.HISTORY_KEEP 在写盘时裁剪（/api/history 返回的已是最多 10 条），前端不重复设限
  for (const h of state.history) {
    const dot = h.status === 'ok' ? 'dot-ok' : h.status === 'fail' ? 'dot-err' : 'muted';
    dom.historyList.append(el('li', {}, [el('button', {
      class: 'history__item', type: 'button',
      title: `${fmtDateTime(h.startedAt)}${h.seq ? ` · 任务 #${h.seq}` : ''}`,
      on: { click: () => showHistory(h) },
    }, [
      el('span', { class: `history__dot ${dot}` }),
      el('span', { class: 'history__label', text: h.title || h.action }),
      el('span', {
        class: 'history__time',
        dataset: { rel: String(h.startedAt || 0) },
        text: h.startedAt ? fmtRel(h.startedAt) : '',
      }),
    ])]));
  }
  startRelTimer();
}

// 相对时间自动刷新：只改 textContent，绝不重渲染整个列表（否则会打断用户点击/hover）
const REL_TICK_MS = 30_000;
let relTimer = null;
function refreshRelTimes() {
  for (const node of dom.historyList.querySelectorAll('[data-rel]')) {
    const ts = Number(node.dataset.rel);
    const next = ts ? fmtRel(ts) : '';
    if (node.textContent !== next) node.textContent = next;
  }
}
function startRelTimer() {
  if (relTimer !== null) return;
  relTimer = setInterval(() => { if (!document.hidden) refreshRelTimes(); }, REL_TICK_MS);
}
async function showHistory(h) {
  if (state.running) {
    toast('warn', '有任务正在运行，日志抽屉正跟随实时任务；结束后再查看历史');
    return;
  }
  clearLogs(); openLogDrawer(); setLogTaskLabel(`${h.startedAt ? fmtDateTime(h.startedAt) + ' · ' : ''}${h.title} · ${{ ok: '已完成', fail: '失败', cancelled: '已取消' }[h.status] || h.status}`);
  try {
    const rec = await api('GET', `/api/history/${encodeURIComponent(h.id)}`);
    for (const l of (rec.log || [])) appendLogLine(l);
    state.task = rec.task || null;
  } catch (err) { toast('err', err.message || '读取日志失败'); }
}

// ============================== 服务状态 ==============================
// 「服务已关闭」遮罩期间的快速探测定时器（常规轮询 15s，对「刚被重新拉起」来说太慢）
let veilPollTimer = null;

function setService(level, text) {
  dom.serviceStatus.className = `service-status is-${level}`;
  dom.serviceText.textContent = text;
}
/** 最近一次 /api/health 结果（needsRestart 等由它驱动横幅）。 */
let lastHealth = null;

async function pollHealth() {
  try {
    const d = await api('GET', '/api/health');
    lastHealth = d;
    syncHealthBanners();
    // Homebrew 元数据自动同步（启动后服务端会跑一次 `brew update`，实测 1.7~3.2s）：
    //   ① 状态广播给视图（显示「元数据同步于 X」/「正在同步」/「上次同步失败」）；
    //   ② 元数据**刚被同步成功**时强制重算体检 —— 于是「可更新 N 项」当场变真值，
    //      用户重开项目什么都不用点。判定用纯函数（比较时间戳，不看 refreshing 跳变，
    //      原因见 meta-state.js：15s 轮询大概率错过 ~2s 的中间态）。
    const prevMeta = state.brewMeta;
    state.brewMeta = d.brewMeta || null;
    emit('brewmeta', state.brewMeta);
    const dm = diffMetaState(prevMeta, state.brewMeta);
    if (dm.refreshed) {
      toast('ok', 'Homebrew 元数据已同步');
      refreshEnv(true).catch(() => { /* 体检失败已有 toast */ });
    } else if (dm.failed) {
      toast('warn', `Homebrew 元数据同步失败：${(state.brewMeta && state.brewMeta.lastError) || '原因见服务日志'}`);
    }
    // 服务回来了，页面却还停在「服务已关闭」遮罩上 —— 说明用户点了关闭服务后，
    // 又从启动台/Dock 把 MacKit 打开了，而浏览器复用的就是这个旧标签页（启动器会优先
    // 聚焦已打开同一地址的标签）。页面自己不会醒，这里推一把重载回正常界面。
    // 地址栏里的 hash 会保留，视图不丢。
    if (!dom.shutdownVeil.hidden) { location.reload(); return; }
    if (d.port && d.port !== DEFAULT_PORT) setService('warn', `服务运行中 · 127.0.0.1:${d.port}（${DEFAULT_PORT} 被占用，已顺延）`);
    else setService('ok', `服务运行中 · 127.0.0.1:${d.port || DEFAULT_PORT}`);
  } catch (err) {
    setService('err', '服务不可用');
  }
}

// ============================== 「代码已换新」横幅 ==============================
/**
 * 「更新 MacKit」只改磁盘上的文件，于是有两种「看起来更新了、其实没生效」：
 *   ① 后端：常驻服务的内存模块不会重新加载 → 需要重启服务（带「立即重启」）；
 *   ② 前端：已打开的页面里跑的还是加载那一刻的 JS → 需要刷新页面（带「刷新页面」）。
 * 界面自己看不出这两点，所以我们用 /api/health 的两个时间戳判断后挂横幅。
 */
const PAGE_LOADED_AT = Date.now(); // 本页面加载时刻（与后端 mtime 同一台机器的时钟）
/** 判定前端过期的容差：更新与刷新几乎同时发生时，避免误报（同机时钟，3s 足够）。 */
const FRONTEND_STALE_SKEW_MS = 3000;
/** kind → 横幅节点（route() 会清空 main，故需要登记以便重申 / 移除）。 */
const healthBanners = new Map();

/** 挂 / 撤某类横幅；spec 为 null 表示撤下。 */
function setHealthBanner(kind, spec) {
  const cur = healthBanners.get(kind);
  if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
  healthBanners.delete(kind);
  if (!spec) return;
  const node = el('div', { class: 'warn-box restart-banner' }, [
    el('div', { class: 'restart-banner__text' }, [
      el('div', { text: spec.text }),
      spec.sub ? el('div', { class: 'muted', text: spec.sub }) : null,
    ]),
    el('button', { class: 'btn btn--primary btn--sm', type: 'button', text: spec.action, on: { click: spec.onClick } }),
  ]);
  healthBanners.set(kind, node);
  dom.main.insertBefore(node, dom.main.firstChild);
}

/** 依据最近一次 /api/health 结果同步两类横幅。 */
function syncHealthBanners() {
  if (!dom.main) return;
  const h = lastHealth || {};
  // 前端过期（刷新即可）：web/ 最近改动晚于本页面加载时刻
  const webAt = Number(h.webChangedAt) || 0;
  setHealthBanner('frontend', webAt > PAGE_LOADED_AT + FRONTEND_STALE_SKEW_MS ? {
    text: '前端文件已更新，当前页面仍在运行旧版本 —— 刷新页面即可加载新界面。',
    sub: `前端改动于 ${fmtTime(webAt)}，本页面加载于 ${fmtTime(PAGE_LOADED_AT)}`,
    action: '刷新页面',
    onClick: () => location.reload(),
  } : null);
  // 后端过期（必须重启）：先插前端那条、再插这条 → 重启提示排在更靠上的位置
  const files = Array.isArray(h.changedFiles) ? h.changedFiles : [];
  const list = files.length ? files.slice(0, 3).join('、') + (files.length > 3 ? ` 等 ${files.length} 个文件` : '') : '后端代码';
  setHealthBanner('backend', h.needsRestart ? {
    text: '后端代码已更新，当前服务仍在运行旧版本 —— 需要重启 MacKit 才会生效。',
    sub: `变更：${list}`,
    action: '立即重启',
    onClick: restartService,
  } : null);
}

/** 显示服务遮罩（关闭 / 重启共用），文案由调用方给。 */
function showVeil(title, text) {
  if (dom.veilTitle) dom.veilTitle.textContent = title;
  if (dom.veilText) dom.veilText.textContent = text;
  dom.shutdownVeil.hidden = false;
  // 用户很可能马上又从启动台把 MacKit 点开，而浏览器复用的正是这个标签页。
  // 常规轮询 15s 太慢（会让人以为点了没反应），遮罩期间把探测间隔压到 2s。
  if (!veilPollTimer) veilPollTimer = setInterval(pollHealth, 2000);
}

// ============================== 关闭 / 重启服务 ==============================
async function shutdown() {
  if (state.running && state.task) {
    const ok = await confirmDialog({
      title: `有任务正在运行`,
      body: el('div', {}, [
        el('p', { text: `关闭服务将终止「${state.task.title}」。` }),
        el('p', { class: 'muted', text: '取消后已完成的步骤不会回滚。' }),
      ]),
      confirmLabel: '终止任务并关闭服务',
    });
    if (!ok) return;
  }
  try { await api('POST', '/api/shutdown'); } catch { /* 服务可能已退出 */ }
  showVeil('服务已关闭', 'MacKit 后台服务已停止，可以关闭此标签页。需要时再次双击 MacKit.command 即可重新打开。');
}

/**
 * 受控重启：后端会先拉起一个 detached 的新服务进程，再退出旧进程。
 * 前端只需显示遮罩 —— 遮罩期间 pollHealth 每 2s 探测一次，服务回来后自动 reload。
 */
async function restartService() {
  const running = state.running && state.task;
  const okd = await confirmDialog({
    title: running ? '有任务正在运行' : '重启 MacKit 服务？',
    body: el('div', {}, [
      el('p', { text: running ? `重启服务将终止「${state.task.title}」。` : '将用磁盘上的最新代码重新启动后台服务，页面会自动刷新。' }),
      el('p', { class: 'muted', text: running ? '取消后已完成的步骤不会回滚。' : '服务会重启约 1–3 秒；正在跑的任务（若有）会被终止。' }),
    ]),
    confirmLabel: running ? '终止任务并重启' : '立即重启',
  });
  if (!okd) return;
  try { await api('POST', '/api/restart'); } catch (err) { toast('err', err.message || '重启请求失败'); return; }
  showVeil('正在重启 MacKit…', '后台服务正在用最新代码重新启动，页面会自动刷新。若 10 秒后仍未恢复，请重新双击 app/MacKit.command。');
}

// ============================== 路由 + 视图注册 ==============================
function buildNav() {
  dom.nav.innerHTML = '';
  for (const item of NAV) {
    dom.nav.append(el('button', {
      class: `nav__item${state.view === item.id ? ' is-active' : ''}`, type: 'button', dataset: { view: item.id },
      on: { click: () => { location.hash = `#/${item.id}`; } },
    }, [el('span', { class: 'nav__icon', html: item.icon }), el('span', { text: item.title })]));
  }
}
function hashView() {
  const raw = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  // 必须走 hasOwnProperty：直接 VIEW_MODULES[raw] 会让 #/constructor、#/toString、
  // #/__proto__ 命中 Object.prototype 上的成员而被当成合法视图 id。
  return Object.prototype.hasOwnProperty.call(VIEW_MODULES, raw) ? raw : 'dashboard';
}
let routeToken = 0;
async function route() {
  // 竞态令牌：快速切换视图时会有多次 route 并发挂在 await 上，
  // 不校验令牌的话，先完成的 mount 会覆盖后者的 viewInstance → 前者订阅永不回收。
  const token = ++routeToken;
  const id = hashView();
  if (state.viewInstance && typeof state.viewInstance.unmount === 'function') {
    try { state.viewInstance.unmount(); } catch (e) { console.error(e); }
  }
  state.view = id; state.viewInstance = null; buildNav();
  dom.main.innerHTML = '';
  dom.main.append(el('div', { class: 'view-loading', text: '正在载入…' }));
  let mod;
  try { mod = await VIEW_MODULES[id](); }
  catch (err) {
    dom.main.innerHTML = '';
    dom.main.append(emptyState({ icon: '🚧', title: '该视图尚未实现', text: `views/${id}.js 加载失败或不存在（${err && err.message}）。` }));
    return;
  }
  const view = mod && mod.default;
  if (!view || typeof view.mount !== 'function') {
    dom.main.innerHTML = '';
    dom.main.append(emptyState({ icon: '🚧', title: '视图契约不完整', text: `views/${id}.js 需默认导出 { id, title, mount(root, ctx) }。` }));
    return;
  }
  if (view.title) { const item = NAV.find((n) => n.id === id); if (item) item.title = view.title; buildNav(); }
  dom.main.innerHTML = '';
  const root = el('div');
  dom.main.append(root);
  // 上面那句 innerHTML='' 连横幅节点一起摘掉了（节点仍在 Map 里但已脱离 DOM），
  // 这里清掉登记并按最新体检结果重申。
  healthBanners.clear();
  syncHealthBanners();
  const subs = [];
  const viewCtx = makeCtx(subs);
  const teardown = () => {
    // 必须先快照再遍历：makeCtx 的解绑器会把自己从 subs 移出，直接 for...of 边遍历边删
    // 会跳过一半条目，导致订阅泄漏。
    for (const u of subs.slice()) { try { u(); } catch { /* ignore */ } }
    if (typeof view.unmount === 'function') { try { view.unmount(); } catch (e) { console.error(e); } }
  };
  try { await view.mount(root, viewCtx); }
  catch (err) { root.append(el('div', { class: 'err-box', text: `视图渲染失败：${err && err.message}` })); console.error(err); }
  // 已被更新的路由取代：本次 mount 的订阅不属于当前视图，就地回收，绝不挂到 viewInstance
  if (token !== routeToken) { teardown(); return; }
  state.viewInstance = { unmount: teardown };
}

// ============================== ctx（视图上下文） ==============================
function makeCtx(subs) {
  return {
    api, el, state, navigate: (h) => { location.hash = h; },
    runTask,
    // 解绑器被主动调用时同步从视图级 subs 移出：视图/面板自己解绑（如 brew 的
    // releasePanelSubs）后条目若仍留在 subs，会无界增长且闭包一直持有已卸载的 DOM。
    on: (ev, fn) => {
      const off = on(ev, fn);
      const u = () => { try { off(); } finally { const i = subs.indexOf(u); if (i >= 0) subs.splice(i, 1); } };
      subs.push(u); return u;
    },
    refreshEnv: refreshEnv,
    fmtTime, fmtDateTime, fmtRel, fmtSize,
    ui: { toast, modal, confirmDialog, diffView, dataTable, statusLight, badge, empty: emptyState, kv, card, copy: copyText, portOk },
  };
}
async function refreshEnv(force) {
  try {
    const e = await api('GET', '/api/env' + (force ? '?force=1' : ''));
    emit('env', e); return e;
  } catch (err) { toast('err', err.message || '环境体检失败'); throw err; }
}

// ============================== 启动 ==============================
async function recoverTasks() {
  try {
    const tasks = await api('GET', '/api/tasks');
    const running = tasks.find((t) => t.status === 'running' || t.status === 'pending');
    if (running) {
      state.task = running; setLogTaskLabel(taskLabel(running)); openLogDrawer();
      appendLogLine({ seq: 0, ts: Date.now(), level: 'info', text: `检测到正在运行的任务「${running.title}」，已重新订阅日志…` });
      attach(running.id);
    }
  } catch { /* 忽略 */ }
}

function boot() {
  buildNav();
  dom.btnLogToggle.addEventListener('click', () => {
    const collapsed = dom.logDrawer.classList.toggle('logdrawer--collapsed');
    dom.btnLogToggle.setAttribute('aria-expanded', String(!collapsed));
  });
  clearLogs(); // 首屏空态由 JS 生成（index.html 里不再存一份文案，见 showLogEmpty）
  dom.btnLogClear.addEventListener('click', clearLogs);
  dom.btnLogCopy.addEventListener('click', async () => {
    const text = logOrder.map((l) => `${fmtTime(l.ts)} [${l.level}] ${l.text}`).join('\n');
    await copyText(text, '已复制全部日志');
  });
  dom.btnLogOpen.addEventListener('click', openLogFile);
  // 刷新按钮必须有可见反馈（本项目硬性要求，曾出过「点了没反应」）：
  // 图标按钮改不了文案，用「禁用 + 图标旋转 + is-busy」表达忙碌态。
  dom.btnHistoryRefresh.addEventListener('click', async () => {
    const btn = dom.btnHistoryRefresh;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    try { await refreshHistory(); } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
    }
  });
  dom.btnShutdown.addEventListener('click', shutdown);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRelTimes(); });
  pollHealth();
  setInterval(pollHealth, HEALTH_POLL_MS);
  refreshHistory();
  route();
  recoverTasks();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
