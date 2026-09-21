/**
 * MacKit · 应用解隔离（后端模块）
 *
 * 语义移植自原 `shell/unseal.sh`（参考脚本已于 2026-09-16 从仓库移除，本文件为该功能的唯一事实源）。
 *
 * 关键约束：
 *   - 路径规范化：剥离首尾引号（拖拽常见）、去掉 `~`、去空白；空/不存在给出明确错误。
 *   - 执行：先普通权限 `xattr -dr com.apple.quarantine <path>`；
 *     仅当普通执行非 0 时才降级为图形授权 `osascriptAdmin`。
 *     （实测：无隔离属性时 `xattr -dr` 返回 0，故不会误弹授权框。）
 *   - 取消：授权框返回 -128 → 抛 AUTH_CANCELLED → runner 记为 skip（**不算失败**，不阻断其余项）。
 *   - 文件夹递归发现 `.app`（≤5 层），用于把「拖入的文件夹」展开为可逐项解隔离的目标。
 *   - `-r` 本身即递归，步骤内不再自行递归遍历（避免重复递归）。
 *   - finalize：「全部失败才判 fail；部分成功视为 ok」（对齐批量不中断语义）。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';
import * as exec from './exec.js';

const { ERR, AppError } = exec;

const QUARANTINE = 'com.apple.quarantine';
const QTN_FLAG_USER_APPROVED = 0x40; // 用户在 Gatekeeper 弹窗点过「打开」后置位
const MAX_DEPTH = 5;
const XATTR_TIMEOUT = 120_000;
const ADMIN_TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// 路径规范化与发现
// ---------------------------------------------------------------------------

/**
 * 规范化一个输入路径：剥离首尾引号 / 去空白 / 展开 `~`。
 * 依次：去空白 → 剥离首尾引号 → 再去空白 → 展开 `~`。
 * @param {string|{path?:string}} raw
 * @returns {string}
 */
function cleanPath(raw) {
  let s = raw;
  if (s && typeof s === 'object') s = s.path;
  s = String(s == null ? '' : s);
  s = s.trim();
  s = s.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  if (s.startsWith('~')) s = paths.HOME + s.slice(1);
  return s;
}

/**
 * 递归发现目录内的 `.app`（≤ maxDepth 层）；发现 .app 后不再深入其内部。
 * @param {string} dir
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function discoverApps(dir, maxDepth = MAX_DEPTH) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.name.endsWith('.app')) { out.push(full); continue; }
      walk(full, depth + 1);
    }
  };
  walk(dir, 1);
  return out;
}

function expandTargets(inputs) {
  const targets = [];
  const seen = new Set();
  for (const raw of inputs) {
    const p = cleanPath(raw);
    if (!p) continue;
    if (!fs.existsSync(p)) { targets.push({ input: cleanPath(raw), path: p, missing: true }); continue; }
    let st;
    try { st = fs.statSync(p); } catch { targets.push({ input: p, path: p, missing: true }); continue; }
    const push = (t) => { if (!seen.has(t)) { seen.add(t); targets.push({ input: p, path: t, missing: false }); } };
    if (st.isDirectory() && !p.endsWith('.app')) {
      const apps = discoverApps(p, MAX_DEPTH);
      if (apps.length > 0) for (const a of apps) push(a);
      else push(p); // 无 .app 的文件夹：直接对文件夹本身（`-r` 递归）执行
    } else {
      push(p);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// 只读查询：预检
// ---------------------------------------------------------------------------

/** 判断路径是否带隔离属性（递归）；无法判定返回 null。 */
async function readQuarantine(p) {
  try {
    const res = await exec.run('xattr', ['-r', '-l', p], { noMirror: true, timeoutMs: 20_000 });
    if (res.code !== 0) return null;
    // ★ 2026-09-21：原先这里还有一条 `|| res.stdout.includes(QUARANTINE)` 兜底 ——
    //   但上面的正则已覆盖「行内任意位置出现该属性」（`[^\n]*` + `^|\n`），恒为超集，
    //   那条分支永远走不到，属死代码，删除以免让人误以为两个判据语义不同。
    return new RegExp(`(^|\\n)[^\\n]*${QUARANTINE.replace(/\./g, '\\.')}`).test(res.stdout);
  } catch { return null; }
}

/** 尽力而为判断是否需要管理员权限（文件不可写 → 大概率需要）。 */
function guessNeedsAdmin(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return false; } catch { return true; }
}

/**
 * 预检单个输入 → PrecheckItem。
 * @param {string} raw
 * @returns {Promise<object>}
 */
async function precheckOne(raw) {
  const input = String(raw == null ? '' : raw);
  const p = cleanPath(raw);
  const item = { input, path: p, exists: false, isDir: false, hasQuarantine: null, needsAdmin: null };
  if (!p) { item.note = '路径为空'; return item; }
  if (!fs.existsSync(p)) { item.note = '路径不存在'; return item; }

  item.exists = true;
  try { item.isDir = fs.statSync(p).isDirectory(); } catch { item.isDir = false; }
  item.hasQuarantine = await readQuarantine(p);
  item.needsAdmin = guessNeedsAdmin(p);

  if (item.isDir && !p.endsWith('.app')) {
    const apps = discoverApps(p, MAX_DEPTH);
    item.discovered = apps;
    if (apps.length === 0) item.note = '未发现 .app，将直接对文件夹执行';
    else item.note = `发现 ${apps.length} 个 .app`;
  }
  return item;
}

/**
 * GET /api/unseal/precheck?paths=a|b|c → { items: PrecheckItem[] }
 * @param {{paths?:string[]}} params
 */
async function queryPrecheck(params) {
  const list = Array.isArray(params && params.paths) ? params.paths : [];
  const items = [];
  for (const raw of list) items.push(await precheckOne(raw));
  return { items };
}

// ---------------------------------------------------------------------------
// 动作：解隔离
// ---------------------------------------------------------------------------
const actions = {
  /** 解隔离（批量；文件夹递归展开 .app） */
  unseal_paths: {
    title: '解隔离',
    destructive: false,
    steps: (params) => {
      const inputs = Array.isArray(params && params.paths) ? params.paths : [];
      const targets = expandTargets(inputs);
      if (targets.length === 0) {
        return [{
          id: 'noop', title: '无待处理路径',
          run: async (ctx) => { ctx.log('warn', '未提供任何有效路径'); },
        }];
      }
      return targets.map((t, i) => ({
        id: `unseal_${i}`,
        title: t.missing ? `路径不存在 ${t.path}` : `解隔离 ${path.basename(t.path)}`,
        run: async (ctx) => {
          if (t.missing) {
            ctx.log('error', `路径不存在：${t.path}`);
            throw new AppError(ERR.NOT_FOUND, `路径不存在：${t.path}`);
          }
          ctx.log('info', `正在处理: ${t.path}`);

          // ① 普通权限（-dr 递归删除）
          const r1 = await ctx.exec.run('xattr', ['-dr', QUARANTINE, t.path], { noMirror: true, timeoutMs: XATTR_TIMEOUT });
          if (r1.code === 0) { ctx.log('ok', '已成功移除隔离属性'); return; }

          // ② 降级为图形授权
          ctx.log('warn', '普通权限不足，需要管理员授权...');
          const cmd = `xattr -dr ${QUARANTINE} ${ctx.exec.posixQuote(t.path)}`;
          const r2 = await ctx.exec.osascriptAdmin(cmd, { timeoutMs: ADMIN_TIMEOUT });
          if (r2.cancelled) {
            // -128：用户取消授权 → 记为 skip，不中断其余项
            throw new AppError(ERR.AUTH_CANCELLED, '用户取消授权');
          }
          if (r2.code === 0) { ctx.log('ok', '已成功移除隔离属性（管理员权限）'); return; }
          throw new AppError(ERR.CMD_FAILED, '移除隔离属性失败，请重试', (r2.stderr || r1.stderr || '').trim());
        },
      }));
    },
    finalize: (task, { log }) => {
      const { ok, fail, skip } = task.counts;
      // 取消优先：不得把已取消的任务改写为 ok
      if (task.status === 'cancelled') {
        log('info', `任务已取消：成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
        return;
      }
      // 全失败才判 fail；部分成功视为 ok（对齐批量不中断语义）
      // 注：与 brew.finalizeBatch 的条件**刻意不同** —— 那里额外要求 skip===0（按「未跳过项是否全失败」判），
      // 而解隔离场景「有失败且无成功」就应该判 fail，不该因为还有被跳过项而显示为 ok。
      if (fail > 0 && ok === 0) {
        task.status = 'fail';
      } else {
        task.status = 'ok';
        task.error = null;
      }
      log('info', `处理完成：成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
      if (ok > 0 && fail > 0) log('warn', '部分应用已解隔离；失败项可复制路径后重试');
      if (ok === 0 && fail === 0) log('warn', '没有任何应用被处理（可能已全部取消授权）');
    },
  },
};

// ---------------------------------------------------------------------------
// 只读查询：扫描 /Applications，找出「被隔离且无法打开」的应用
// ---------------------------------------------------------------------------

/**
 * 递归列出目录下的 .app（≤ maxDepth 层）；命中 .app 后不再深入其内部。
 * @param {string} dir
 * @param {number} maxDepth
 * @returns {string[]}
 */
function listApps(dir, maxDepth) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (!e.isDirectory()) continue;
      if (e.name.endsWith('.app')) { out.push(full); continue; }
      walk(full, depth + 1);
    }
  };
  walk(dir, 1);
  return out;
}

/**
 * 简易并发限流：最多 limit 个 fn 同时进行。
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, i:number) => Promise<void>} fn
 */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  const n = Math.min(Math.max(limit, 1), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * 读取 .app 的 quarantine flags（十六进制位掩码）。
 * 返回值：
 *   - null：无隔离属性；
 *   - NaN：有隔离属性但格式无法解析；
 *   - 整数：解析后的 flags。
 * 通过 `xattr -px` 读取，把 hex 转回字符串后取第一段分号前的 flags。
 * @param {string} app
 * @returns {Promise<number|null>}
 */
async function readQuarantineFlags(app) {
  try {
    const r = await exec.run('xattr', ['-px', QUARANTINE, app], { noMirror: true, timeoutMs: 10_000 });
    if (r.code !== 0) return null;
    const hex = r.stdout.replace(/\s+/g, '');
    if (!hex) return NaN;
    const str = Buffer.from(hex, 'hex').toString('utf8');
    const token = str.split(';')[0];
    const flags = parseInt(token, 16);
    return Number.isNaN(flags) ? NaN : flags;
  } catch { return null; }
}

/**
 * 取应用主图标，转成 PNG 的 data URI（sips 把最大的 .icns 缩放至 128px）。
 * 取不到（无 .icns / 转换失败）→ null，前端回退到字母头像。
 * @param {string} app
 * @returns {Promise<string|null>}
 */
async function appIconDataUri(app) {
  const resDir = path.join(app, 'Contents', 'Resources');
  /** @type {{full:string, size:number}[]} */
  let candidates = [];
  try {
    const walk = (d, depth) => {
      if (depth > 2) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        try {
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (e.name.toLowerCase().endsWith('.icns')) {
            const st = fs.statSync(full);
            if (st.size > 0) candidates.push({ full, size: st.size });
          }
        } catch { /* ignore */ }
      }
    };
    walk(resDir, 1);
  } catch { /* ignore */ }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.size - a.size);
  const icns = candidates[0].full;
  const tmp = path.join(paths.MACKIT_DIR, `.mackit-icon-${process.pid}-${Date.now()}.png`);
  try {
    paths.ensureDirs();
    const r = await exec.run('sips', ['-s', 'format', 'png', icns, '--resampleHeightWidth', '128', '128', '--out', tmp], { noMirror: true, timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    const buf = fs.readFileSync(tmp);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

/**
 * GET /api/unseal/scan → { items:[{name,path,reason,icon}], total, quarantined, blocked }
 *
 * 判定口径：
 *   - 隔离：`xattr -p com.apple.quarantine <app>` 退出码 0（属性存在）。
 *   - 已批准：quarantine flags 的 0x40 位（USER_APPROVED）置位，表示用户已在 Gatekeeper
 *     弹窗点过「打开」或系统设置里点过「仍要打开」——这类应用实际能打开，直接跳过。
 *   - 无法打开：Gatekeeper 评估 `spctl -a -t exec` 退出码非 0（被拦截 / 无签名 / 损坏）。
 *   三者都满足（隔离 + 未批准 + spctl 拒绝）才纳入。
 */
async function scanApplications() {
  const apps = listApps('/Applications', 4);
  /** @type {{app:string,flags:number|null}[]} */
  const quarantined = [];
  // ① 快查隔离属性并解析 flags（xattr -px 输出 hex，解析成位掩码）
  await mapLimit(apps, 24, async (app) => {
    const flags = await readQuarantineFlags(app);
    if (flags != null) quarantined.push({ app, flags });
  });
  // ② 对隔离且未获用户批准的应用做 Gatekeeper 评估（并发限流，避免一次性起上百个 spctl）
  /** @type {object[]} */
  const blocked = [];
  await mapLimit(quarantined, 16, async ({ app, flags }) => {
    // 用户已批准：Gatekeeper 弹窗已被放行，实际能打开，不再误报
    // flags 为 NaN 表示解析失败，此时回退到 spctl 评估，避免漏判
    if (Number.isFinite(flags) && (flags & QTN_FLAG_USER_APPROVED)) return;
    const r = await exec.run('spctl', ['-a', '-t', 'exec', '-vv', app], { noMirror: true, timeoutMs: 15_000 });
    if (r.code === 0) return; // 能过 Gatekeeper → 实际能打开，跳过
    const raw = (r.stderr || r.stdout || '').trim();
    const reason = raw ? raw.split('\n').filter(Boolean).pop() || 'Gatekeeper 拦截' : 'Gatekeeper 拦截';
    const icon = await appIconDataUri(app);
    blocked.push({ name: path.basename(app), path: app, reason, icon });
  });
  blocked.sort((a, b) => a.name.localeCompare(b.name));
  return { items: blocked, total: apps.length, quarantined: quarantined.length, blocked: blocked.length };
}

export default {
  id: 'unseal',
  actions,
  queries: {
    precheck: queryPrecheck,
    scan: scanApplications,
  },
};
