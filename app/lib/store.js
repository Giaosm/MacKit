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
 * 因此错误码以字面量给出（取值与 exec.js 的 ERR 一致），统一经 paths.mkCodedError 构造。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';


// ★ 本对象是**唯一**默认值事实源：readMackit 的每一处回落都必须引用它，不得写字面量。
const MACKIT_DEFAULTS = Object.freeze({
  // ★ 2026-09-22：通道从「全局一个」改为「每个模块一个档位」（见 lib/netpolicy.js）：
  //   auto（默认，按目标主机自动）/ proxy_first / direct_first，界面上是各模块顶部的小下拉。
  //   原先的全局 defaultChannel 已删除（它是死设置：存/校验/回显/备份都有，却无人读取）。
  brewChannel: 'auto', rimeChannel: 'auto', selfupdateChannel: 'auto',
  autoFallback: true, autoCleanup: true, lastCheckedAt: null, version: 1,
  // Homebrew 元数据自动同步（2026-09-21）：启动后若元数据过期就自动跑一次 `brew update`（实测 1.7~3.2s），
  // 让「可更新 N 项」重开项目即为真值，而不是等用户自己点按钮。可关（计量网络 / 公司代理场景）。
  brewAutoRefreshMeta: true,
  // 上次**成功**同步 brew 元数据的时间戳（节流依据；null = 从未成功过）
  brewMetaRefreshedAt: null,
  // 音乐模块（第 7 模块）配置：默认下载目录 / 命名模板 / 网络通道 / 已选音源
  musicDownloadDir: paths.MUSIC_DEFAULT_DIR,
  musicNameTemplate: '{歌手} - {歌名}.{ext}',
  musicChannel: 'auto',
  // ★ null = 从未配置（前端回落默认勾选）；[] = 用户明确清空（必须尊重，不得回落默认）
  musicSources: null,
  // 是否随音频同时保存歌词 .lrc（musicdl 自动旁写；false = 下载后删除旁车歌词）
  musicSaveLyrics: true,
  // 增强搜索（实验）：走 musicsquare 式第三方代理 API（更快、对「歌手 - 歌名」组合更宽容），
  // 但强依赖外部社区代理，默认关闭，保持「离线 / 零依赖」红线。
  musicEnhancedSearch: false,
  // R0 · 代理配置（v2 增量）：代理地址来源 + 自定义 HTTP / SOCKS5 地址（均 `host:port`，不带 scheme）
  // ★ 与上面 4 个键同口径：**默认值 / 读取 / 写入三处缺一不可**，否则「保存了但没生效」。
  musicProxySource: 'homebrew',
  musicProxyHttp: '',
  musicProxySocks5: '',
  // 在线播放 / 边听边存：音频缓存容量上限（MB，默认 1024，可调 128–5120）
  musicCacheMaxMb: 1024,
  // 下载并发度（默认 3，可调 1–5）；=1 时与「每曲一步」的历史行为一致
  musicDownloadConcurrency: 3,
});
/**
 * 每模块网络通道档位（**唯一值域事实源**，lib/netpolicy.js 从这里取）：
 *   auto（默认，按目标主机）/ proxy_first（优先代理）/ direct_first（优先直连）。
 * 存储键 = `<module>Channel`；哪些模块有开关见 netpolicy.CHANNEL_MODULES。
 */
export const CHANNEL_VALUES = Object.freeze(['auto', 'proxy_first', 'direct_first']);
/** 有通道档位的配置键（与 CHANNEL_MODULES 一一对应，顺序无关）。 */
export const CHANNEL_KEYS = Object.freeze(['brewChannel', 'musicChannel', 'rimeChannel', 'selfupdateChannel']);
/**
 * 音乐模块的**旧值域**（auto / direct / proxy）→ 统一档位。2026-09-22 迁移：
 * 读到旧值即按新值用，下次写回自然升级 —— 老配置文件不用手工改，也不用写迁移脚本。
 */
const LEGACY_MUSIC_CHANNEL = Object.freeze({ auto: 'auto', direct: 'direct_first', proxy: 'proxy_first' });

/**
 * 归一化一个通道档位值。
 * @param {unknown} value
 * @param {boolean} [legacyMusic] 是否允许音乐模块的旧值域
 * @returns {string|null} 合法档位，或 null（调用方回落默认值 / 忽略本次写入）
 */
function normChannel(value, legacyMusic = false) {
  if (CHANNEL_VALUES.includes(value)) return value;
  if (legacyMusic && LEGACY_MUSIC_CHANNEL[value]) return LEGACY_MUSIC_CHANNEL[value];
  return null;
}
/** 音乐模块代理地址来源（v2）：跟随 Homebrew 或自定义 */
const MUSIC_PROXY_SOURCES = Object.freeze(['homebrew', 'custom']);
/** 音频缓存容量（MB）可调区间 */
export const MUSIC_CACHE_MB_MIN = 128;
export const MUSIC_CACHE_MB_MAX = 5120;
/** 下载并发度可调区间 */
export const MUSIC_CONCURRENCY_MIN = 1;
export const MUSIC_CONCURRENCY_MAX = 5;
/**
 * 代理地址校验正则：`host:port`。
 * host 允许 IPv4 / 主机名（`[A-Za-z0-9.\-]+`），port 为 1–5 位数字（范围另判 1–65535）。
 * 该形状天然拒绝 `://`、空格、路径、查询串、中文、回车等非法输入（design v2 §A.1 / Q1）。
 */
const PROXY_ADDR_RE = /^([A-Za-z0-9.\-]+):(\d{1,5})$/;
/** 非法代理地址时的统一可读提示（前端直接 toast 这句）。 */
const PROXY_ADDR_HINT = '请填写 主机:端口，例如 127.0.0.1:7897，不要带 http://';
const MIRROR_IDS = Object.freeze(['official', 'tuna', 'ustc', 'aliyun', 'tencent']);
/**
 * 自定义 MIRROR 值（枚举外，如自建镜像 / 带路径的 URL）的合法字符集。
 * 该值会被原样写进 `MIRROR=<值>`，因此**必须**拒绝换行、`#` 与空白，避免注入新行或注释掉后续配置。
 */
const MIRROR_VALUE_RE = /^[A-Za-z0-9_.:/@?&=%+-]{1,256}$/;

const LOG_KEEP_TASKS = 50;
const LOG_KEEP_DAYS = 30;
/** 任务历史保留条数（用户要求：侧边栏「任务历史」最多只留最近 10 次） */
const HISTORY_KEEP = 10;

// ---------------------------- 通用工具 ----------------------------
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
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
  const text = JSON.stringify(obj, null, 2);
  // ★ 一律 0600：这里写的包含 WebDAV 凭据、备份信封、redact 前的历史与日志。
  //   `writeFileSync` 的 mode 只在**新建**时生效，历史遗留的 0644 临时文件不会被改，
  //   所以再补一次 chmod（失败不致命：目录本身是 0700）。
  const write = (target) => {
    fs.writeFileSync(target, text, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch { /* 权限设置失败不致命 */ }
  };
  try {
    paths.ensureDirs();
    write(tmp);
    try {
      fs.renameSync(tmp, p); // 同目录内 rename 是原子的（首选路径）
    } catch (err) {
      // 实测：脱离终端的常驻进程在这台 macOS 上 rename 会被拒（EPERM，疑似
      // provenance/TCC 策略），但原地覆盖写允许 —— 降级为直接写目标文件。
      // 代价只是丢失「中途崩溃不留半截文件」的原子性保证，可接受。
      if (err && err.code === 'EPERM') {
        write(p);
        try { fs.rmSync(tmp, { force: true }); } catch { /* 已降级，tmp 仅是多余副本 */ }
        return true;
      }
      throw err;
    }
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响报错 */ }
    throw paths.mkCodedError('IO_ERROR', '写入 JSON 文件失败', `${p}: ${err && err.message}`);
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

/**
 * 把任意输入夹取为 [min,max] 内的整数。
 * 非数 / NaN / Infinity → 回落 fallback（用于读取容错：**绝不用非法值覆盖默认**）。
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
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
 *
 * 2026-09-21 增补 `mirrorRaw`：枚举外的自定义镜像值（自建源 / URL）无法用 `mirror` 表达，
 * 于是「备份 → 恢复」只能回落 official，把对端机器上自定义的 MIRROR 覆盖掉。
 * mirrorRaw 是「用户显式给出的原值」，仅在**通过安全字符校验**时生效，优先级高于 mirror。
 */
function normalizeBrewgoInput(v) {
  const httpPort = Number.isInteger(v.httpPort) && v.httpPort >= 1 && v.httpPort <= 65535 ? v.httpPort : 7897;
  const socksPort = Number.isInteger(v.socksPort) && v.socksPort >= 1 && v.socksPort <= 65535 ? v.socksPort : 7897;
  const raw = typeof v.mirrorRaw === 'string' ? v.mirrorRaw.trim() : '';
  // 防注入：这个值会被原样写进 `MIRROR=<值>` 行，因此禁止换行 / # / 空白，
  // 只放行 URL / 主机名 / 常见路径字符。
  const rawOk = raw.length > 0 && raw.length <= 256 && MIRROR_VALUE_RE.test(raw);
  const mirror = rawOk ? raw : (MIRROR_IDS.includes(v.mirror) ? v.mirror : null);
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
    throw paths.mkCodedError('IO_ERROR', '写入 ~/.brewgo_config 失败', String(err && err.message));
  }
  return { httpPort, socksPort, mirror };
}

// ---------------------------- ~/.mackit/config.json ----------------------------

/**
 * `host:port` 是否为合法代理地址（Q1）：形状匹配 **且** 端口在 1–65535。
 * @param {string} s
 * @returns {boolean}
 */
export function isValidProxyAddr(s) {
  const m = PROXY_ADDR_RE.exec(String(s == null ? '' : s));
  if (!m) return false;
  const port = Number.parseInt(m[2], 10);
  return port >= 1 && port <= 65535;
}

/**
 * 归一化代理地址（**唯一校验出口**，design v2 §A.1）：
 *   · 空 / 全空白       → `''`（表示该协议不启用）；
 *   · 合法 `host:port`  → 原样（已 trim）返回；
 *   · 非空但非法        → `''`（调用方按「不启用」处理；**写入口**另有抛错校验见 writeMackit）。
 *
 * 所有代理派生（resolveProxy / resolveInstallProxyEnv / 前端回显）都从这里取值，
 * 杜绝各处自拼代理字符串。
 * @param {unknown} raw
 * @returns {string} 归一化后的 `host:port`，或 `''`
 */
export function normalizeProxyAddr(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return '';
  return isValidProxyAddr(s) ? s : '';
}

/** 读取 MacKit 专属配置（缺失/损坏时回落默认值）。 */
export function readMackit() {
  const raw = readJsonSafe(paths.CONFIG_JSON, {}) || {};
  return {
    // 每模块网络通道档位（缺失/非法 → 默认 auto）。music 额外兼容旧值域（proxy/direct）。
    brewChannel: normChannel(raw.brewChannel) || MACKIT_DEFAULTS.brewChannel,
    musicChannel: normChannel(raw.musicChannel, true) || MACKIT_DEFAULTS.musicChannel,
    rimeChannel: normChannel(raw.rimeChannel) || MACKIT_DEFAULTS.rimeChannel,
    selfupdateChannel: normChannel(raw.selfupdateChannel) || MACKIT_DEFAULTS.selfupdateChannel,
    autoFallback: typeof raw.autoFallback === 'boolean' ? raw.autoFallback : MACKIT_DEFAULTS.autoFallback,
    // 升级完成后是否自动清理缓存：默认 true（对齐用户要求「默认开」）
    autoCleanup: typeof raw.autoCleanup === 'boolean' ? raw.autoCleanup : MACKIT_DEFAULTS.autoCleanup,
    lastCheckedAt: typeof raw.lastCheckedAt === 'number' ? raw.lastCheckedAt : MACKIT_DEFAULTS.lastCheckedAt,
    brewAutoRefreshMeta: typeof raw.brewAutoRefreshMeta === 'boolean' ? raw.brewAutoRefreshMeta : MACKIT_DEFAULTS.brewAutoRefreshMeta,
    brewMetaRefreshedAt: typeof raw.brewMetaRefreshedAt === 'number' ? raw.brewMetaRefreshedAt : MACKIT_DEFAULTS.brewMetaRefreshedAt,
    // 音乐模块。缺失/类型不符一律回落默认值（缺省下载目录、命名模板、通道、音源）。
    musicDownloadDir: typeof raw.musicDownloadDir === 'string' && raw.musicDownloadDir.trim()
      ? raw.musicDownloadDir : MACKIT_DEFAULTS.musicDownloadDir,
    musicNameTemplate: typeof raw.musicNameTemplate === 'string' && raw.musicNameTemplate.trim()
      ? raw.musicNameTemplate : MACKIT_DEFAULTS.musicNameTemplate,

    musicSources: Array.isArray(raw.musicSources)
      ? raw.musicSources.filter((s) => typeof s === 'string' && s.length > 0) : MACKIT_DEFAULTS.musicSources,
    musicSaveLyrics: typeof raw.musicSaveLyrics === 'boolean' ? raw.musicSaveLyrics : MACKIT_DEFAULTS.musicSaveLyrics,
    // 增强搜索（实验）：默认 false；true = 搜索走第三方代理 API（更快、组合词更宽容，但依赖外部服务）
    musicEnhancedSearch: raw.musicEnhancedSearch === true ? true : MACKIT_DEFAULTS.musicEnhancedSearch,
    // R0 · 代理三键（容错读出）：枚举外回落 homebrew；地址经 normalizeProxyAddr 归一（非法即视为空）。
    musicProxySource: MUSIC_PROXY_SOURCES.includes(raw.musicProxySource)
      ? raw.musicProxySource : MACKIT_DEFAULTS.musicProxySource,
    musicProxyHttp: normalizeProxyAddr(raw.musicProxyHttp) || MACKIT_DEFAULTS.musicProxyHttp,
    musicProxySocks5: normalizeProxyAddr(raw.musicProxySocks5) || MACKIT_DEFAULTS.musicProxySocks5,
    // 音频缓存容量上限（MB）与下载并发度：读取时夹取到合法区间，非法/缺失一律回落默认值。
    musicCacheMaxMb: clampInt(raw.musicCacheMaxMb, MUSIC_CACHE_MB_MIN, MUSIC_CACHE_MB_MAX, MACKIT_DEFAULTS.musicCacheMaxMb),
    musicDownloadConcurrency: clampInt(raw.musicDownloadConcurrency, MUSIC_CONCURRENCY_MIN, MUSIC_CONCURRENCY_MAX, MACKIT_DEFAULTS.musicDownloadConcurrency),
    // ★ 2026-09-21：这里原本硬编码字面量（null / 1 / ''），与 MACKIT_DEFAULTS 里的声明各写一份 ——
    //   改了 DEFAULTS 却不生效的经典漂移。全部改回读 DEFAULTS，保持「默认值只有一处」的口径。
    version: MACKIT_DEFAULTS.version,
  };
}

/**
 * 局部更新 MacKit 配置（写后 chmod 600）。
 */
export function writeMackit(patch = {}) {
  paths.ensureDirs();
  const cur = readMackit();
  const next = { ...cur };

  if (patch.autoFallback !== undefined) {
    next.autoFallback = !!patch.autoFallback;
  }
  if (patch.autoCleanup !== undefined) {
    next.autoCleanup = !!patch.autoCleanup;
  }
  if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = typeof patch.lastCheckedAt === 'number' ? patch.lastCheckedAt : null;
  if (patch.brewAutoRefreshMeta !== undefined) next.brewAutoRefreshMeta = !!patch.brewAutoRefreshMeta;
  if (patch.brewMetaRefreshedAt !== undefined) next.brewMetaRefreshedAt = typeof patch.brewMetaRefreshedAt === 'number' ? patch.brewMetaRefreshedAt : null;
  // 音乐模块配置（缺失字段 = 不改写；空串回落默认值）
  if (patch.musicDownloadDir !== undefined) {
    const v = String(patch.musicDownloadDir || '').trim();
    next.musicDownloadDir = v || MACKIT_DEFAULTS.musicDownloadDir;
  }
  if (patch.musicNameTemplate !== undefined) {
    const v = String(patch.musicNameTemplate || '').trim();
    next.musicNameTemplate = v || MACKIT_DEFAULTS.musicNameTemplate;
  }
  // 每模块网络通道：非法值一律忽略（保持原值），与其它枚举字段同口径；music 兼容旧值域。
  for (const key of CHANNEL_KEYS) {
    if (patch[key] === undefined) continue;
    const v = normChannel(patch[key], key === 'musicChannel');
    if (v) next[key] = v;
  }
  if (patch.musicSources !== undefined && Array.isArray(patch.musicSources)) {
    next.musicSources = patch.musicSources.filter((s) => typeof s === 'string' && s.length > 0);
  }
  if (patch.musicSaveLyrics !== undefined && typeof patch.musicSaveLyrics === 'boolean') {
    next.musicSaveLyrics = patch.musicSaveLyrics;
  }
  if (patch.musicEnhancedSearch !== undefined && typeof patch.musicEnhancedSearch === 'boolean') {
    next.musicEnhancedSearch = patch.musicEnhancedSearch;
  }
  // R0 · 代理三键（v2）：写入 + 校验。**仅当本次 patch 含任一代理字段时才校验**，
  // 避免「保存下载目录」这类无关 patch 因存量非法值被误拦。
  if (patch.musicProxySource !== undefined || patch.musicProxyHttp !== undefined || patch.musicProxySocks5 !== undefined) {
    // 代理来源：枚举内才改，枚举外保持原值（与 musicChannel 同口径）
    const source = (patch.musicProxySource !== undefined && MUSIC_PROXY_SOURCES.includes(patch.musicProxySource))
      ? patch.musicProxySource : cur.musicProxySource;
    // 地址：本次给了就用本次的（trim），否则沿用原值
    const http = patch.musicProxyHttp !== undefined ? String(patch.musicProxyHttp == null ? '' : patch.musicProxyHttp).trim() : cur.musicProxyHttp;
    const socks = patch.musicProxySocks5 !== undefined ? String(patch.musicProxySocks5 == null ? '' : patch.musicProxySocks5).trim() : cur.musicProxySocks5;
    // 逐字段校验：非空但非法 → 抛 PARSE_FAILED（→ HTTP 422），**不写盘**
    if (http !== '' && !isValidProxyAddr(http)) {
      throw paths.mkCodedError('PARSE_FAILED', PROXY_ADDR_HINT, `musicProxyHttp=${http}`);
    }
    if (socks !== '' && !isValidProxyAddr(socks)) {
      throw paths.mkCodedError('PARSE_FAILED', PROXY_ADDR_HINT, `musicProxySocks5=${socks}`);
    }
    // 跨字段：选「自定义」时两址皆空 → 拦截（A8）
    if (source === 'custom' && http === '' && socks === '') {
      throw paths.mkCodedError('PARSE_FAILED', '选择「自定义」代理时，请至少填写一个协议地址（HTTP 或 SOCKS5）', '');
    }
    next.musicProxySource = source;
    next.musicProxyHttp = http;
    next.musicProxySocks5 = socks;
  }
  // 在线播放缓存上限（MB）与下载并发度：非法值回落**当前值**（不抛错，也不写坏），合法值夹取到区间。
  if (patch.musicCacheMaxMb !== undefined) {
    const n = Number(patch.musicCacheMaxMb);
    next.musicCacheMaxMb = Number.isFinite(n)
      ? clampInt(n, MUSIC_CACHE_MB_MIN, MUSIC_CACHE_MB_MAX, cur.musicCacheMaxMb)
      : cur.musicCacheMaxMb;
  }
  if (patch.musicDownloadConcurrency !== undefined) {
    const n = Number(patch.musicDownloadConcurrency);
    next.musicDownloadConcurrency = Number.isFinite(n)
      ? clampInt(n, MUSIC_CONCURRENCY_MIN, MUSIC_CONCURRENCY_MAX, cur.musicDownloadConcurrency)
      : cur.musicDownloadConcurrency;
  }
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

export function logFilePath(taskId) { return path.join(paths.LOGS_DIR, `${taskId}.log`); }

/** 追加一行日志（逐行 JSON）。 */
export function appendLog(taskId, line) {
  const file = logFilePath(taskId);
  const text = JSON.stringify(line) + '\n';
  // mode 只在**创建**时生效：日志里可能含 WebDAV 地址、包名、本机路径，
  // 与 config.json / webdav.json / history 同口径收紧到仅本人可读。
  const opts = { encoding: 'utf8', mode: 0o600 };
  // ★ 此处不再逐行 paths.ensureDirs()：一次 brew upgrade 会打上千行日志，而 ensureDirs
  //   每次要发 4 条 mkdirSync —— 纯白白的系统调用。目录在进程启动时已建好，只有在被外部
  //   删掉（用户清理 ~/.mackit）时才补建一次重试。
  try {
    fs.appendFileSync(file, text, opts);
    return;
  } catch (err) {
    const code = err && err.code;
    if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') return; // 其它错误不阻断任务
  }
  try {
    paths.ensureDirs();
    fs.appendFileSync(file, text, opts);
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

export function readHistory(taskId) {
  const t = readJsonSafe(historyFilePath(taskId), null);
  return t && typeof t === 'object' ? t : null;
}

/**
 * 保留策略：任务日志「最近 50 个任务 或 30 天，先到者为准」。
 * ★ 只扫日志目录：历史由 writeHistory 自己收尾（那里会调 pruneHistory）。
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

export function getCached(key) {
  const obj = readJsonSafe(cachePath(key), null);
  if (!obj || typeof obj.at !== 'number') return null;
  return { value: obj.value, at: obj.at };
}

export function setCached(key, value) {
  paths.ensureDirs();
  writeJsonSafe(cachePath(key), { value, at: Date.now() });
}
