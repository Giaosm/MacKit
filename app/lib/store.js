/**
 * MacKit · 持久化层
 *
 *   - ~/.brewgo_config 是代理端口 / 镜像源的唯一事实源，格式不变；
 *     ★ 写回采用「原地更新变更键」，保留所有注释与未知键（不整文件重写）。
 *   - ~/.mackit/config.json 仅存 MacKit 新增项，权限 600。
 *   - 两套保留策略互相独立：任务日志（50 任务 / 30 天）、任务历史（最近 10 次 / 30 天）。
 *     （2026-09-16 起自动备份已全部移除：集中备份与 Rime 原地备份删除；
 *      配置迁移的唯一入口是「备份中心」的 WebDAV 备份，见 lib/backup.js。）
 *
 * 本文件只使用 node:fs / node:path，不引入 child_process，也不引入 exec.js（避免循环依赖）；
 * 因此错误码以字面量给出（取值与 exec.js 的 ERR 一致），统一经 paths.mkCodedError 构造
 * （2026-09-19 起全项目只有那一份实现）。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';


/** MacKit 配置默认值 */
const MACKIT_DEFAULTS = Object.freeze({ defaultChannel: 'auto', autoFallback: true, autoCleanup: true, lastCheckedAt: null, version: 1 });
const MIRROR_IDS = Object.freeze(['official', 'tuna', 'ustc', 'aliyun', 'tencent']);
const CHANNEL_POLICIES = Object.freeze(['direct_first', 'proxy_first', 'auto']);

/** 保留策略常量 */
const LOG_KEEP_TASKS = 50;
const LOG_KEEP_DAYS = 30;
/** 任务历史保留条数（用户要求：侧边栏「任务历史」最多只留最近 10 次） */
const HISTORY_KEEP = 10;

// ---------------------------- 通用工具 ----------------------------
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
// 统一实现见 lib/paths.js（2026-09-16 收敛 6 份重复）
const readTextSafe = paths.readTextSafe;
function readJsonSafe(p, fallback) {
  const text = readTextSafe(p);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 * 直接覆盖写若在中途崩溃（断电 / 被 kill）会留下半截 JSON —— 而这里写的是配置、
 * WebDAV 凭据与任务历史，宁可多一次 rename 也不要写出坏文件。
 * 临时文件用 `.tmp` 后缀，不会被 listFiles(dir, '.json') 扫进来。
 */
function writeJsonSafe(p, obj) {
  const tmp = `${p}.tmp`;
  try {
    paths.ensureDirs();
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p); // 同目录内 rename 是原子的
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响报错 */ }
    throw paths.mkCodedError(E_IO, '写入 JSON 文件失败', `${p}: ${err && err.message}`);
  }
}
/**
 * 列出目录下的文件（跳过点文件与 .tmp 临时文件）。
 * @param {string} dir 目录
 * @param {string|null} ext 扩展名过滤（如 '.json'），null 表示不过滤
 */
function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .filter((n) => (ext ? n.endsWith(ext) : true))
      .map((n) => path.join(dir, n));
  } catch { return []; }
}

// ---------------------- ~/.brewgo_config（事实源，格式不变） ----------------------

/**
 * 去掉值后面的行尾注释（`7897 # http` → `7897`）。
 * 与 writeBrewgo 的 trailingComment 配对：写入时保留注释，读取时必须能跳过它，
 * 否则 MacKit 自己写出来的 `PORT=7897 # http` 会解析失败并静默回落默认值。
 */
function stripValueComment(v) {
  const s = String(v == null ? '' : v);
  const i = s.indexOf('#');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** 读取 brewgo 配置（容错：跳过空行与注释、端口须纯数字、MIRROR 须在枚举内）。 */
export function readBrewgo() {
  const result = { httpPort: 7897, socksPort: 7897, mirror: 'official', mirrorRaw: null, hadMirrorKey: false, exists: false };
  const text = readTextSafe(paths.BREWGO_CONFIG);
  if (text === null) return result;
  result.exists = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = stripValueComment(line.slice(eq + 1));
    if (key === 'PROXY_HTTP_PORT' || key === 'PROXY_SOCKS5_PORT') {
      if (/^[0-9]+$/.test(value)) {
        const n = Number.parseInt(value, 10);
        if (n >= 1 && n <= 65535) {
          if (key === 'PROXY_HTTP_PORT') result.httpPort = n; else result.socksPort = n;
        }
      }
    } else if (key === 'MIRROR') {
      result.hadMirrorKey = true;
      // 原值一并带出：枚举外的自定义镜像（如自建源）不再被静默丢弃 —— 保存端口时
      // 若调用方没显式给 mirror，writeBrewgo 会原样保留那一行（见 writeBrewgo 注释）。
      result.mirrorRaw = value;
      if (MIRROR_IDS.includes(value)) result.mirror = value;
    }
  }
  return result;
}

/**
 * 校验并归一化 brewgo 写入值。
 * `mirror` 缺省（undefined）= **本次不改写 MIRROR 行**；只有界面上显式选了镜像才传值。
 * （2026-09-19 修：此前一律回落 'official' 并整行写回，用户在文件里自定义的镜像值
 *   只要改一次端口就会被静默改成 official。）
 */
function normalizeBrewgoInput(v) {
  const httpPort = Number.isInteger(v.httpPort) && v.httpPort >= 1 && v.httpPort <= 65535 ? v.httpPort : 7897;
  const socksPort = Number.isInteger(v.socksPort) && v.socksPort >= 1 && v.socksPort <= 65535 ? v.socksPort : 7897;
  const mirror = MIRROR_IDS.includes(v.mirror) ? v.mirror : null;
  return { httpPort, socksPort, mirror };
}

/**
 * 取出 `KEY=值 # 注释` 里的行尾注释（含前导空格）；没有则返回空串。
 * 用于原地改值时保留用户写的注释（值只可能是端口号 / 镜像 id，不会含 #）。
 */
function trailingComment(rest) {
  const i = String(rest || '').indexOf('#');
  return i < 0 ? '' : ` ${String(rest).slice(i).trim()}`;
}

/**
 * 原地更新 ~/.brewgo_config 的变更键：逐行扫描命中键原地改值，
 * MIRROR 不存在则追加到末尾；保留所有注释行与未知键。
 */
export function writeBrewgo(v) {
  const { httpPort, socksPort, mirror } = normalizeBrewgoInput(v);
  paths.ensureDirs();
  const target = paths.BREWGO_CONFIG;
  const existing = readTextSafe(target);

  const wants = new Map([
    ['PROXY_HTTP_PORT', String(httpPort)],
    ['PROXY_SOCKS5_PORT', String(socksPort)],
  ]);
  if (mirror) wants.set('MIRROR', mirror);   // 缺省时不动 MIRROR 行
  const foundKeys = new Set();

  let lines;
  if (existing === null) {
    lines = ['# BrewGo 配置文件'];
  } else {
    lines = existing.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }

  const out = [];
  for (const line of lines) {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && wants.has(m[2])) {
      // 只换值，行尾注释原样保留（此前整行重写会把 `PORT=7897 # http` 的注释吞掉）
      out.push(`${m[2]}=${wants.get(m[2])}${trailingComment(m[3])}`);
      foundKeys.add(m[2]);
    } else {
      out.push(line);
    }
  }
  for (const [key, val] of wants) {
    if (!foundKeys.has(key)) out.push(`${key}=${val}`);
  }

  try {
    fs.writeFileSync(target, out.join('\n') + '\n', 'utf8');
  } catch (err) {
    throw paths.mkCodedError(E_IO, '写入 ~/.brewgo_config 失败', String(err && err.message));
  }
  return { httpPort, socksPort, mirror };
}

// ---------------------------- ~/.mackit/config.json ----------------------------

/** 读取 MacKit 专属配置（缺失/损坏时回落默认值）。 */
export function readMackit() {
  const raw = readJsonSafe(paths.CONFIG_JSON, {}) || {};
  return {
    defaultChannel: CHANNEL_POLICIES.includes(raw.defaultChannel) ? raw.defaultChannel : MACKIT_DEFAULTS.defaultChannel,
    autoFallback: typeof raw.autoFallback === 'boolean' ? raw.autoFallback : MACKIT_DEFAULTS.autoFallback,
    // 升级完成后是否自动清理缓存：默认 true（对齐用户要求「默认开」）
    autoCleanup: typeof raw.autoCleanup === 'boolean' ? raw.autoCleanup : MACKIT_DEFAULTS.autoCleanup,
    lastCheckedAt: typeof raw.lastCheckedAt === 'number' ? raw.lastCheckedAt : null,
    version: 1,
  };
}

/**
 * 局部更新 MacKit 配置（写后 chmod 600）。
 */
export function writeMackit(patch = {}) {
  paths.ensureDirs();
  const cur = readMackit();
  const next = { ...cur };

  if (patch.defaultChannel !== undefined && CHANNEL_POLICIES.includes(patch.defaultChannel)) {
    next.defaultChannel = patch.defaultChannel;
  }
  if (patch.autoFallback !== undefined) {
    next.autoFallback = !!patch.autoFallback;
  }
  if (patch.autoCleanup !== undefined) {
    next.autoCleanup = !!patch.autoCleanup;
  }
  if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = typeof patch.lastCheckedAt === 'number' ? patch.lastCheckedAt : null;
  next.version = 1;

  writeJsonSafe(paths.CONFIG_JSON, next);
  try { fs.chmodSync(paths.CONFIG_JSON, 0o600); } catch { /* 权限设置失败不致命 */ }
  return next;
}

// --------------------------- ~/.mackit/webdav.json ---------------------------
//
// WebDAV 备份凭据独立存放（**不放 config.json**）：writeMackit() 只反序列化 5 个已知键，
// 任何未知键都会在下一次改设置时被静默丢弃；独立文件彻底避开这个坑，且无需改动既有语义。
// 文件权限 600、密码明文（与既有备份信封含明文 Token 的立场一致，用户已确认）。

/** WebDAV 配置默认值。 */
const WEBDAV_DEFAULTS = Object.freeze({ url: '', username: '', password: '', allowInsecureTLS: false, version: 1 });

/** 读取 WebDAV 配置（缺文件/字段缺失/类型不符 → 逐字段回落默认值）。 */
export function readWebdav() {
  const raw = readJsonSafe(paths.WEBDAV_JSON, {}) || {};
  return {
    url: stripUrlCredentials(typeof raw.url === 'string' ? raw.url.trim() : WEBDAV_DEFAULTS.url),
    username: typeof raw.username === 'string' ? raw.username : WEBDAV_DEFAULTS.username,
    password: typeof raw.password === 'string' ? raw.password : WEBDAV_DEFAULTS.password,
    allowInsecureTLS: raw.allowInsecureTLS === true,
    version: 1,
  };
}

/**
 * 去掉 URL 里内嵌的 userinfo（`https://user:pass@host/dav` → `https://host/dav`）。
 *
 * ★ 为什么要在读的时候就剥掉：WebDAV 认证走独立的用户名/密码字段，URL 里的 userinfo
 *   **根本不参与认证**（lib/webdav.js 发请求只取 hostname/port/pathname），但 backup.js
 *   会把整个 url 打进任务日志、publicWebdav() 还会把它回填到设置弹窗 —— 等于把密码
 *   明文写进 ~/.mackit/logs/*.log 并显示在界面上。写入口（lib/webdav.js 的 parseDavUrl
 *   与 /api/webdav/config）会直接拒绝这种写法并提示填到密码栏；这里是对历史遗留值的兜底。
 * @param {string} raw
 * @returns {string}
 */
function stripUrlCredentials(raw) {
  const s = String(raw || '');
  if (!s.includes('@')) return s;
  try {
    const u = new URL(s);
    if (!u.username && !u.password) return s;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch { return s; }
}

/**
 * 局部更新 WebDAV 配置并写盘（写后 chmod 600）。
 * `password` 字段**缺省 = 不修改**（前端留空表示保持原密码）；显式传入（含空串）才覆盖。
 * @returns {{url:string,username:string,password:string,allowInsecureTLS:boolean,version:number}}
 */
export function writeWebdav(patch = {}) {
  paths.ensureDirs();
  const cur = readWebdav();
  const next = { ...cur };

  if (patch.url !== undefined) next.url = String(patch.url || '').trim();
  if (patch.username !== undefined) next.username = String(patch.username == null ? '' : patch.username);
  if (patch.password !== undefined) next.password = String(patch.password == null ? '' : patch.password);
  if (patch.allowInsecureTLS !== undefined) next.allowInsecureTLS = !!patch.allowInsecureTLS;
  next.version = 1;

  writeJsonSafe(paths.WEBDAV_JSON, next);
  try { fs.chmodSync(paths.WEBDAV_JSON, 0o600); } catch { /* 权限设置失败不致命 */ }
  return next;
}

/**
 * 脱敏的 WebDAV 配置（供 API 下发）——**永不含 password**。
 * @returns {{url:string,username:string,hasPassword:boolean,allowInsecureTLS:boolean}}
 */
export function publicWebdav() {
  const c = readWebdav();
  return {
    url: c.url,
    username: c.username,
    hasPassword: !!c.password,
    allowInsecureTLS: c.allowInsecureTLS,
  };
}

// --------------------------- 日志（落盘）+ 历史 ---------------------------

/** 日志文件路径。 */
export function logFilePath(taskId) { return path.join(paths.LOGS_DIR, `${taskId}.log`); }

/** 追加一行日志（逐行 JSON）。 */
export function appendLog(taskId, line) {
  paths.ensureDirs();
  // mode 只在**创建**时生效：日志里可能含 WebDAV 地址、包名、本机路径，
  // 与 config.json / webdav.json / history 同口径收紧到仅本人可读。
  try {
    fs.appendFileSync(logFilePath(taskId), JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* 日志写失败不阻断任务 */ }
}

/** 读取某任务日志（跳过损坏行，按 seq 升序）。 */
export function readLog(taskId) {
  const text = readTextSafe(logFilePath(taskId));
  if (text === null) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.seq === 'number') out.push(obj);
    } catch { /* 跳过损坏行 */ }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** 历史文件路径。 */
function historyFilePath(taskId) { return path.join(paths.HISTORY_DIR, `${taskId}.json`); }

/**
 * 敏感参数键：绝不落盘、也绝不出现在对外快照里。
 *
 * 任务历史是**明文 JSON**，而这些 params 携带凭据：
 *   - token    ← 系统初始化「GitHub 凭据」
 *   - password ← WebDAV 配置
 *   - payload  ← 备份信封（内含明文 GitHub Token 与 Rime 配置原文）
 */
const REDACTED_PARAM_KEYS = Object.freeze(['token', 'password', 'secret', 'payload']);

/**
 * 任务参数脱敏：敏感键替换为占位符，其余键原样保留。
 *
 * 与 publicWebdav() 同属「对外投影」职责，两个必经之处：
 *   1) writeHistory   —— 落盘前（历史文件是明文 JSON）
 *   2) snapshotTask   —— 任何对外快照（emit / getTask / listTasks）之前
 * 内存里的 rec.task.params 保持原样，执行步骤照旧拿得到真实值（见 runner.makeBaseCtx）。
 */
export function redactParams(params) {
  if (!params || typeof params !== 'object') return params;
  let hit = false;
  const safe = { ...params };
  for (const key of REDACTED_PARAM_KEYS) {
    if (safe[key] !== undefined) { safe[key] = '[已隐去]'; hit = true; }
  }
  return hit ? safe : params;
}

/**
 * 写入任务历史（完整 Task），并立即按「最近 HISTORY_KEEP 次」裁剪。
 *
 * 与 backup() 的 D1 修复同因：保留策略只有在真正的写入路径上执行才会生效。
 * 任务历史若不在这里裁剪，~/.mackit/history 会随使用次数无限增长。
 */
export function writeHistory(task) {
  if (!task || typeof task.id !== 'string') return;
  paths.ensureDirs();
  const file = historyFilePath(task.id);
  writeJsonSafe(file, { ...task, params: redactParams(task.params) });
  // 与 config.json / webdav.json 同口径：历史里可能含 paths、包名等本机信息，收紧到仅本人可读。
  try { fs.chmodSync(file, 0o600); } catch { /* 权限设置失败不致命 */ }
  try { pruneHistory(); } catch { /* 保留策略失败不影响历史本身 */ }
}

/** 列出任务历史摘要（按开始时间倒序）。 */
export function listHistory() {
  const out = [];
  for (const file of listFiles(paths.HISTORY_DIR, '.json')) {
    const t = readJsonSafe(file, null);
    if (!t || typeof t.id !== 'string') continue;
    out.push({
      id: t.id,
      seq: typeof t.seq === 'number' ? t.seq : 0,
      module: t.module,
      action: t.action,
      title: t.title || t.action || '',
      status: t.status,
      startedAt: t.startedAt ?? t.createdAt ?? null,
      endedAt: t.endedAt ?? null,
      counts: t.counts || { ok: 0, fail: 0, skip: 0 },
    });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.seq - a.seq);
  return out;
}

/** 读取某任务完整历史。 */
export function readHistory(taskId) {
  const t = readJsonSafe(historyFilePath(taskId), null);
  return t && typeof t === 'object' ? t : null;
}

/**
 * 保留策略：任务日志「最近 50 个任务 或 30 天，先到者为准」。
 *
 * ★ 只扫日志目录：历史由 writeHistory 自己收尾（那里会调 pruneHistory），
 *   原先这里再扫一遍 history，等于每次任务收尾把同一目录读两遍（2026-09-18 收敛）。
 */
export function pruneLogs() {
  pruneByPolicy(paths.LOGS_DIR, '.log', LOG_KEEP_TASKS);
}

/** 只保留最近 HISTORY_KEEP 份任务历史（按 mtime 倒序）。 */
function pruneHistory() {
  pruneByPolicy(paths.HISTORY_DIR, '.json', HISTORY_KEEP);
}

function pruneByPolicy(dir, ext, keepCount = LOG_KEEP_TASKS) {
  const files = listFiles(dir, ext);
  if (files.length === 0) return;
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
  // stat 失败（权限 / 竞态）时**跳过该文件**，而不是把 mtime 当 0 直接归入「超 30 天」删除
  const withStat = files
    .map((f) => ({ f, m: safeStat(f)?.mtimeMs ?? null }))
    .filter((x) => x.m !== null);
  const remain = [];
  for (const item of withStat) {
    if (item.m < cutoff) {
      try { fs.rmSync(item.f, { force: true }); } catch { /* ignore */ }
    } else {
      remain.push(item);
    }
  }
  remain.sort((a, b) => b.m - a.m);
  for (const item of remain.slice(keepCount)) {
    try { fs.rmSync(item.f, { force: true }); } catch { /* ignore */ }
  }
}

// -------------------------------- 缓存 --------------------------------
function cachePath(key) {
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(paths.CACHE_DIR, `${safe}.json`);
}

/** 读取缓存项。 */
export function getCached(key) {
  const obj = readJsonSafe(cachePath(key), null);
  if (!obj || typeof obj.at !== 'number') return null;
  return { value: obj.value, at: obj.at };
}

/** 写入缓存项。 */
export function setCached(key, value) {
  paths.ensureDirs();
  writeJsonSafe(cachePath(key), { value, at: Date.now() });
}
