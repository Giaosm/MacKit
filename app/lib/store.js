/**
 * MacKit · 持久化层
 *
 * 依据《MacKit-架构设计.md》§3.10 与 Part B §8.9 / §8.11，交付总监决策 A1 / A4：
 *   - ~/.brewgo_config 是代理端口 / 镜像源的唯一事实源，格式不变；
 *     ★ A1：写回改为「原地更新变更键」，保留所有注释与未知键（不再整文件重写）。
 *   - ~/.mackit/config.json 仅存 MacKit 新增项，权限 600。
 *   - 两套保留策略互相独立：任务日志(50 任务/30 天)、任务历史(最近 10 次/30 天)。
 *     （2026-09-16 起自动备份已全部移除：集中备份与 Rime 原地备份删除，
 *      配置迁移唯一入口是「备份中心」的手动导出/导入，见 lib/backup.js。）
 *
 * 本文件只使用 node:fs / node:path，不引入 child_process，也不引入 exec.js（避免循环依赖）；
 * 因此错误码以字面量给出（取值与 §3.2 一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';

// 与 §3.2 一致（此处不 import exec.js，避免 exec → store → exec 循环）
const E_IO = 'IO_ERROR';

/** MacKit 配置默认值 */
const MACKIT_DEFAULTS = Object.freeze({ defaultChannel: 'auto', autoFallback: true, autoCleanup: true, lastCheckedAt: null, version: 1 });
const MIRROR_IDS = Object.freeze(['official', 'tuna', 'ustc', 'aliyun', 'tencent']);
const CHANNEL_POLICIES = Object.freeze(['direct_first', 'proxy_first', 'auto']);

/** 保留策略常量（§8.11） */
export const LOG_KEEP_TASKS = 50;
export const LOG_KEEP_DAYS = 30;
/** 任务历史保留条数（用户要求：侧边栏「任务历史」最多只留最近 10 次） */
export const HISTORY_KEEP = 10;

// ---------------------------- 通用工具 ----------------------------
/** 构造带 code 的 Error（形态与 exec.js 的 AppError 兼容）。 */
function mkErr(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
// 统一实现见 lib/paths.js（2026-09-16 收敛 6 份重复）
const readTextSafe = paths.readTextSafe;
function readJsonSafe(p, fallback) {
  const text = readTextSafe(p);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
function writeJsonSafe(p, obj) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (err) {
    throw mkErr(E_IO, '写入 JSON 文件失败', `${p}: ${err && err.message}`);
  }
}
/**
 * 列出目录下的文件。
 * @param {string} dir 目录
 * @param {string|null} ext 扩展名过滤（如 '.json'），null 表示不过滤
 * @param {boolean} [includeDot=false] 是否包含点文件（如 .zshrc）；默认 false，保持既有调用方语义不变
 */
function listFiles(dir, ext, includeDot = false) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => (includeDot ? true : !n.startsWith('.')))
      .filter((n) => (ext ? n.endsWith(ext) : true))
      .map((n) => path.join(dir, n));
  } catch { return []; }
}

// ---------------------- ~/.brewgo_config（事实源，格式不变） ----------------------

/** 读取 brewgo 配置（复刻 load_config 容错：跳过空行与注释、端口须纯数字、MIRROR 须在枚举内）。 */
export function readBrewgo() {
  const result = { httpPort: 7897, socksPort: 7897, mirror: 'official', hadMirrorKey: false, exists: false };
  const text = readTextSafe(paths.BREWGO_CONFIG);
  if (text === null) return result;
  result.exists = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'PROXY_HTTP_PORT' || key === 'PROXY_SOCKS5_PORT') {
      if (/^[0-9]+$/.test(value)) {
        const n = Number.parseInt(value, 10);
        if (n >= 1 && n <= 65535) {
          if (key === 'PROXY_HTTP_PORT') result.httpPort = n; else result.socksPort = n;
        }
      }
    } else if (key === 'MIRROR') {
      result.hadMirrorKey = true;
      if (MIRROR_IDS.includes(value)) result.mirror = value;
    }
  }
  return result;
}

/** 校验并归一化 brewgo 写入值。 */
function normalizeBrewgoInput(v) {
  const httpPort = Number.isInteger(v.httpPort) && v.httpPort >= 1 && v.httpPort <= 65535 ? v.httpPort : 7897;
  const socksPort = Number.isInteger(v.socksPort) && v.socksPort >= 1 && v.socksPort <= 65535 ? v.socksPort : 7897;
  const mirror = MIRROR_IDS.includes(v.mirror) ? v.mirror : 'official';
  return { httpPort, socksPort, mirror };
}

/**
 * 原地更新 ~/.brewgo_config 的变更键（A1）：逐行扫描命中键原地改值，
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
    ['MIRROR', mirror],
  ]);
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
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && wants.has(m[2])) {
      out.push(`${m[2]}=${wants.get(m[2])}`);
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
    throw mkErr(E_IO, '写入 ~/.brewgo_config 失败', String(err && err.message));
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
    url: typeof raw.url === 'string' ? raw.url.trim() : WEBDAV_DEFAULTS.url,
    username: typeof raw.username === 'string' ? raw.username : WEBDAV_DEFAULTS.username,
    password: typeof raw.password === 'string' ? raw.password : WEBDAV_DEFAULTS.password,
    allowInsecureTLS: raw.allowInsecureTLS === true,
    version: 1,
  };
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
  try { fs.appendFileSync(logFilePath(taskId), JSON.stringify(line) + '\n', 'utf8'); } catch { /* 日志写失败不阻断任务 */ }
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

/** 保留策略（§8.11）：日志「最近 50 个任务 或 30 天，先到者为准」；任务历史「最近 10 次 或 30 天」。 */
export function pruneLogs() {
  pruneByPolicy(paths.LOGS_DIR, '.log', LOG_KEEP_TASKS);
  pruneByPolicy(paths.HISTORY_DIR, '.json', HISTORY_KEEP);
}

/** 只保留最近 HISTORY_KEEP 份任务历史（按 mtime 倒序）。 */
export function pruneHistory() {
  pruneByPolicy(paths.HISTORY_DIR, '.json', HISTORY_KEEP);
}

function pruneByPolicy(dir, ext, keepCount = LOG_KEEP_TASKS) {
  const files = listFiles(dir, ext);
  if (files.length === 0) return;
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const withStat = files.map((f) => ({ f, m: safeStat(f)?.mtimeMs || 0 }));
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

export default {
  LOG_KEEP_TASKS, LOG_KEEP_DAYS, HISTORY_KEEP,
  readBrewgo, writeBrewgo,
  readMackit, writeMackit,
  readWebdav, writeWebdav, publicWebdav, redactParams,
  appendLog, readLog, logFilePath,
  writeHistory, listHistory, readHistory,
  pruneLogs, pruneHistory,
  getCached, setCached,
};
