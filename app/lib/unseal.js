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
 *   - 文件夹递归发现 `.app`（≤5 层，`findApps`），用于把「粘贴的文件夹」展开为可逐项解隔离的目标。
 *   - `-r` 本身即递归，步骤内不再自行递归遍历（避免重复递归）。
 *   - finalize：「全部失败才判 fail；部分成功视为 ok」（对齐批量不中断语义）。
 *
 * 只读查询（2026-09-21 增补）：
 *   - queries.precheck：逐项预检（存在性 / 是否目录 / 隔离状态 / 是否需要管理员 / 发现的 .app）。
 *   - queries.scan：扫描 `/Applications`，找「被隔离 **且** Gatekeeper 拒绝 **且** 用户未批准」
 *     的应用，并附 128px 图标；带 in-flight 去重，单项评估失败只计入 unevaluated、不打断整轮。
 *   - 隔离属性判定收敛到唯一实现 `probeQuarantine`：`.app` 只看 bundle 根（Gatekeeper 的依据），
 *     其它路径保留递归语义。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';
import * as exec from './exec.js';

const { ERR, AppError } = exec;

const QUARANTINE = 'com.apple.quarantine';
const QTN_FLAG_USER_APPROVED = 0x40; // 用户在 Gatekeeper 弹窗点过「打开」后置位
/** 手工粘贴路径时的文件夹展开深度（用户可能给一个套了几层的目录）。 */
const MAX_DEPTH = 5;
/** 扫描 /Applications 的递归深度（`/Applications/Foo.app` 在第 1 层；留几层容套装目录）。 */
const APP_SCAN_DEPTH = 4;
/** 图标 data URI 的进程内缓存上限（path+mtime → URI；FIFO 淘汰）。 */
const ICON_CACHE_MAX = 80;
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
 * 递归发现目录内的 `.app`（≤ maxDepth 层）；命中 `.app` 后不再深入其内部。
 *
 * ★ 2026-09-21 把原先两份逐行同构的实现（`discoverApps` / `listApps`）合并到这里，
 *   两者只差两处语义，用参数表达：
 *   · `skipHidden`：扫描 /Applications 时跳过 `.` 开头的目录（系统隐藏目录里没有用户的
 *     应用，且更省一次遍历）；而「手工粘贴的文件夹展开」要保留隐藏目录，否则用户自己放在
 *     `~/.foo/Bar.app` 的应用会被漏掉。
 *   · 符号链接：`withFileTypes()` 下符号链接既不是目录也不是文件，`/Applications/Safari.app`
 *     正是符号链接 —— 旧实现会静默漏掉它。这里对**以 .app 结尾**的条目额外接受符号链接，
 *     但绝不深入链接内部（避免软链成环导致无限递归）。
 * @param {string} dir
 * @param {{maxDepth?:number, skipHidden?:boolean}} [opts]
 * @returns {string[]}
 */
function findApps(dir, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : MAX_DEPTH;
  const skipHidden = opts.skipHidden === true;
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skipHidden && e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.name.endsWith('.app') && (e.isDirectory() || e.isSymbolicLink())) { out.push(full); continue; }
      if (!e.isDirectory()) continue;
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
      const apps = findApps(p, { maxDepth: MAX_DEPTH, skipHidden: false });
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

/**
 * 探测路径的隔离状态（唯一实现，替代了原先两份口径不同的读取）。
 *
 * @param {string} p
 * @param {{recursive?:boolean}} [opts] recursive=true 时递归任意文件命中即算「有隔离」
 * @returns {Promise<{present:boolean|null, flags:number|null}>}
 *   present：true=有隔离属性、false=没有、null=**无法判定**（命令异常）；
 *   flags  ：仅根级读取且能解析时给出十六进制位掩码，否则 null。
 *
 * ★ 口径说明（2026-09-21 统一）：
 *   · `.app` 包**只看 bundle 根**（`xattr -px`）—— 这正是 Gatekeeper 判定「能不能打开」的依据，
 *     而且一次调用就够；旧预检用 `xattr -r -l` 递归整个包（大应用要遍历几万个文件），
 *     还会和扫描的口径打架（预检说「有隔离」、扫描却不认）。
 *   · 非 .app 路径（用户粘贴的文件 / 文件夹）保留递归语义：用户想知道的是「里面有没有东西被隔离」，
 *     只查根会给出误导性的「无隔离」。
 *   · 根级读取时 `xattr -p` 对「无该属性」返回退出码 1（实测 stderr 为 No such xattr），
 *     故 code!==0 一律按 present=false 处理 —— 与扫描原有行为一致；递归分支保持
 *     「code!==0 → 无法判定」的旧语义（`xattr -l` 对无属性的路径返回 0 + 空输出）。
 */
async function probeQuarantine(p, opts = {}) {
  const recursive = opts.recursive === true;
  try {
    if (!recursive) {
      const r = await exec.run('xattr', ['-px', QUARANTINE, p], { noMirror: true, timeoutMs: 10_000 });
      if (r.code !== 0) return { present: false, flags: null };
      const hex = r.stdout.replace(/\s+/g, '');
      if (!hex) return { present: true, flags: null };
      const token = Buffer.from(hex, 'hex').toString('utf8').split(';')[0];
      const flags = parseInt(token, 16);
      return { present: true, flags: Number.isNaN(flags) ? null : flags };
    }
    const res = await exec.run('xattr', ['-r', '-l', p], { noMirror: true, timeoutMs: 20_000 });
    if (res.code !== 0) return { present: null, flags: null };
    const hit = new RegExp(`(^|\\n)[^\\n]*${QUARANTINE.replace(/\./g, '\\.')}`).test(res.stdout);
    return { present: hit, flags: null };
  } catch { return { present: null, flags: null }; }
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
  // .app 只看 bundle 根（与扫描口径一致、且不用递归整个包）；其它路径保留递归语义
  item.hasQuarantine = (await probeQuarantine(p, { recursive: !p.endsWith('.app') })).present;
  item.needsAdmin = guessNeedsAdmin(p);

  if (item.isDir && !p.endsWith('.app')) {
    const apps = findApps(p, { maxDepth: MAX_DEPTH, skipHidden: false });
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
        // ★ 完整路径随 step 下发（runner.snapshotTask 会展开 step 的自定义字段，历史也一并落盘）：
        //   前端因此不必再用「正在处理:」日志的**位置**去重建路径 —— 丢一行日志就整体错位（2026-09-21 修）。
        path: t.path,
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

/** 图标缓存：`<path>:<mtimeMs>` → data URI（见 ICON_CACHE_MAX）。 */
const iconCache = new Map();

/** 上次硬杀（SIGKILL）可能留下 `.mackit-icon-*.png`；进程内第一次出图标前清一次超 1h 的孤儿。 */
let iconsSwept = false;
function sweepOrphanIcons() {
  if (iconsSwept) return;
  iconsSwept = true;
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of fs.readdirSync(paths.MACKIT_DIR)) {
      if (!name.startsWith('.mackit-icon-') || !name.endsWith('.png')) continue;
      const full = path.join(paths.MACKIT_DIR, name);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 / 读不了都不影响图标生成 */ }
}

/**
 * 取应用主图标，转成 PNG 的 data URI（sips 把最大的 .icns 缩放至 128px）。
 * 取不到（无 .icns / 转换失败）→ null，前端回退到字母头像。
 * @param {string} app
 * @returns {Promise<string|null>}
 */
async function appIconDataUri(app) {
  // 缓存键带上 mtime：应用被更新后图标失效重算，未被更新则直接命中（省掉一次 sips 子进程）
  let mtime = 0;
  try { mtime = fs.statSync(app).mtimeMs; } catch { /* ignore */ }
  const cacheKey = `${app}:${mtime}`;
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;
  sweepOrphanIcons();
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
    const uri = `data:image/png;base64,${buf.toString('base64')}`;
    iconCache.set(cacheKey, uri);
    // FIFO 淘汰（Map 保持插入顺序）：只留最近 ICON_CACHE_MAX 个，避免长会话无限增长
    while (iconCache.size > ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
    return uri;
  } catch { return null; }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

/**
 * GET /api/unseal/scan
 *   → { items:[{name,path,reason,icon}], total, quarantined, blocked, unevaluated }
 *
 * 判定口径：
 *   - 隔离：bundle 根带 `com.apple.quarantine`（见 probeQuarantine 的口径说明）。
 *   - 已批准：quarantine flags 的 0x40 位（USER_APPROVED）置位 —— 用户已在 Gatekeeper 弹窗
 *     点过「打开」，这类应用实际能打开，直接跳过（这是「误报」的根因修复）。
 *   - 无法打开：Gatekeeper 评估 `spctl -a -t exec` 退出码非 0（实测被拒=3、通过=0）。
 *   三者都满足（隔离 + 未批准 + spctl 拒绝）才纳入。
 *   - unevaluated：隔离了、但 spctl 评估本身失败（超时 / 异常 → 无法判定）的项数。**如实报出**，
 *     不猜「能打开」也不猜「打不开」。
 *
 * ★ 扫描只覆盖 `/Applications`（第 1 层），不扫 `~/Applications` —— 这是本功能的既定范围，
 *   按钮文案也写明了；要处理其它位置请走「手工粘贴」。
 */
async function scanApplications() {
  const apps = findApps('/Applications', { maxDepth: APP_SCAN_DEPTH, skipHidden: true });
  /** @type {{app:string,flags:number|null}[]} */
  const quarantined = [];
  // ① 快查隔离属性并解析 flags（实测 33 个应用约 89ms；xattr 是这一步的全部成本）
  await mapLimit(apps, 24, async (app) => {
    const q = await probeQuarantine(app);
    if (q.present) quarantined.push({ app, flags: q.flags });
  });
  // ② 对隔离且未获用户批准的应用做 Gatekeeper 评估（并发限流，避免一次性起上百个 spctl）
  const blocked = [];
  let unevaluated = 0;
  if (quarantined.length) sweepOrphanIcons();
  await mapLimit(quarantined, 16, async ({ app, flags }) => {
    // 用户已批准：Gatekeeper 弹窗已被放行，实际能打开，不再误报
    // flags 为 null 表示解析失败，此时回退到 spctl 评估，避免漏判
    if (Number.isFinite(flags) && (flags & QTN_FLAG_USER_APPROVED)) return;
    let r;
    try {
      // spctl 实测每次 0.7~1.4s（33 次串行 22.5s），是整轮扫描的瓶颈；并发 16 后整轮约 2~6s。
      r = await exec.run('spctl', ['-a', '-t', 'exec', '-vv', app], { noMirror: true, timeoutMs: 15_000 });
    } catch (err) {
      // ★ 单个应用评估失败（超时 / 进程异常）绝不能打断整轮扫描：旧写法没有 try/catch，
      //   一个 15s 超时就会让 Promise.all 整体 reject → 前面几十个应用的结果全丢（2026-09-21 修）。
      //   这里只计入「未评估」，让结果如实呈现。
      unevaluated += 1;
      return;
    }
    if (r.code === 0) return; // 能过 Gatekeeper → 实际能打开，跳过
    const raw = (r.stderr || r.stdout || '').trim();
    // 取最后一行作原因：实测被拒时它是结论行（如 `source=no usable signature`），
    // 而 `origin=…` 那种行只出现在 accepted 的输出里（已被上面跳过）。
    const reason = raw ? raw.split('\n').filter(Boolean).pop() || 'Gatekeeper 拦截' : 'Gatekeeper 拦截';
    const icon = await appIconDataUri(app);
    blocked.push({ name: path.basename(app), path: app, reason, icon });
  });
  blocked.sort((a, b) => a.name.localeCompare(b.name));
  return { items: blocked, total: apps.length, quarantined: quarantined.length, blocked: blocked.length, unevaluated };
}

/** 扫描的 in-flight 去重：重复点击 / 多标签同时请求复用同一次扫描（不再叠加 16 路 spctl）。 */
let scanInflight = null;

export default {
  id: 'unseal',
  actions,
  queries: {
    precheck: queryPrecheck,
    /** 对外入口：带上 in-flight 去重（同一时刻只跑一轮扫描）。 */
    scan: () => {
      if (scanInflight) return scanInflight;
      scanInflight = scanApplications().finally(() => { scanInflight = null; });
      return scanInflight;
    },
  },
};
