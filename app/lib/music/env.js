/**
 * MacKit · 音乐模块 · Python 环境探测（设计文档 §6）
 *
 * 纯只读：只做「解释器 / venv / musicdl / 磁盘」四项探测，不联网、不写盘、不 sudo。
 * 探测结果缓存 60s（force 可绕过），避免每次打开页面都重新起 python 探针。
 *
 * ★ 边界纪律：本文件是「懒探测」的执行者 —— 只有 env 查询被调用时才起子进程；
 *   服务启动与其余 7 个模块绝不因为它而引入任何 Python 依赖（P0-7）。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as paths from '../paths.js';
import * as exec from '../exec.js';

/** 安装所需的磁盘余量下限（约 1.5 GB；musicdl 及传递依赖 300–500MB + 余量） */
const NEED_BYTES = 1_500_000_000;
/** 单个解释器版本探针的超时（探针不联网，2.5s 足够） */
const PROBE_TIMEOUT_MS = 2_500;
/** musicdl 导入探针的超时（import 可能较慢，见设计 §10 项 1） */
const IMPORT_TIMEOUT_MS = 30_000;
/** 探测结果缓存时长 */
const CACHE_TTL_MS = 60_000;
/**
 * venv 可用性探针（`venvPy -c` / `venvPip --version`）的超时。
 * 半死的 venv 可能长时间无输出，必须给两个探针都设上限，避免把安装流程卡死。
 */
const VENV_PROBE_TIMEOUT_MS = 15_000;

/** 探针通用环境：静音告警、不写 __pycache__ */
const PROBE_ENV = Object.freeze({ PYTHONWARNINGS: 'ignore', PYTHONDONTWRITEBYTECODE: '1' });

/** @type {{at:number, value:object|null}} */
let cache = { at: 0, value: null };

/** 清空缓存（安装 / 卸载 / 设置变更后调用）。 */
export function invalidate() { cache = { at: 0, value: null }; }

/**
 * 目录可用字节数（Node 内建 statfs；目录不存在时回退到最近的存在祖先）。
 * @param {string} dir
 * @returns {number|null}
 */
export function diskFreeBytes(dir) {
  for (const p of [dir, path.dirname(dir || ''), paths.HOME, '/']) {
    if (!p) continue;
    try {
      const st = fs.statfsSync(p);
      return Number(st.bavail) * Number(st.bsize);
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 解析 `MAJOR.MINOR.PATCH` 版本串；失败返回 null。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(version, major, minor) {
  const p = parseVersion(version);
  if (!p) return false;
  if (p[0] !== major) return p[0] > major;
  return p[1] >= minor;
}

function marker(text, key) {
  const m = new RegExp(`${key}=([^\\s]+)`).exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * 探一个解释器路径的版本（执行 `-c` 打印标记，不联网）。
 * @param {string} pyPath
 * @returns {Promise<{ok:boolean, version:string|null}>}
 */
async function probePythonVersion(pyPath) {
  const code = "import sys;sys.stdout.write('MACKITPYVER='+'.'.join(map(str,sys.version_info[:3])))";
  const res = await exec.runSafe(pyPath, ['-c', code], {
    env: PROBE_ENV, noMirror: true, timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (res.code !== 0) return { ok: false, version: null };
  const v = marker(res.stdout, 'MACKITPYVER');
  return { ok: !!v, version: v };
}

/**
 * 探测可用于建 venv 的 Python 3.12+ 解释器（探测顺序见 paths.findPython312；此处补版本号）。
 * @returns {Promise<{found:boolean, version:string|null, path:string|null,
 *                    candidates:Array<{path:string, version:string|null}>}>}
 */
export async function findPython312() {
  const base = paths.findPython312();
  const existing = base.candidates.filter((c) => paths.exists(c.path));
  const probed = await Promise.all(existing.map(async (c) => {
    const r = await probePythonVersion(c.path);
    return { path: c.path, version: r.version };
  }));
  let chosen = null;
  for (const c of probed) {
    if (versionAtLeast(c.version, 3, 12)) { chosen = c; break; }
  }
  return {
    found: !!chosen,
    version: chosen ? chosen.version : null,
    path: chosen ? chosen.path : null,
    candidates: probed,
  };
}

/**
 * 探测用的内嵌 Python 代码。★ 必须 `import sys` 在前——曾因漏写导致
 * NameError: name 'sys' is not defined（真实安装验证步骤 100% 失败，测试难以覆盖，
 * 见 test/music-probe-code.test.js 的行为级守护）。
 */
export const MUSICDL_PROBE_CODE =
  "import sys,musicdl;sys.stdout.write('MACKITMUSICDL='+str(getattr(musicdl,'__version__','unknown')))";

/**
 * 探测 venv 内 musicdl 是否可导入及其版本。
 * @returns {Promise<{installed:boolean, version:string|null, importError:string|null}>}
 */
export async function probeMusicdl() {
  if (!paths.exists(paths.MUSIC_VENV_PY)) {
    return { installed: false, version: null, importError: null };
  }
  const res = await exec.runSafe(paths.MUSIC_VENV_PY, ['-c', MUSICDL_PROBE_CODE], {
    env: PROBE_ENV, noMirror: true, timeoutMs: IMPORT_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    const first = paths.tailLines(res.stderr || res.stdout, 1) || '导入 musicdl 失败';
    return { installed: false, version: null, importError: first.slice(0, 200) };
  }
  const v = marker(res.stdout, 'MACKITMUSICDL');
  return { installed: true, version: v, importError: null };
}

// ---------------------------------------------------------------------------
// 虚拟环境管理（建 venv / 可用性自检 / 自愈）—— 第 8 模块安装流程专用
//
// ★ 为什么这些逻辑放在 env.js 而非 music.js：它们全都是「环境」的读写与探测，与 detect()
//   同源；music.js 的 createVenvStep 只负责「编排 + 日志」。下沉到这里既让步骤保持精简，
//   也便于单测直接驱动（注入 run，无需真实子进程 / 真实解释器）。
// ---------------------------------------------------------------------------

/** stdlib 目录名匹配：python3 / python3.12 等。 */
const STDLIB_RE = /^python3(\.\d+)?$/;

/**
 * 解释器路径 → 真实路径（消除 uv / pyenv / asdf / Homebrew 的符号链接）。
 *
 * ★ Bug A 的关键：本机唯一的 Python 3.12 由 uv 提供，`~/.local/bin/python3.12` 是指向
 *   `~/.local/share/uv/python/cpython-3.12.x-…/bin/python3.12` 的**符号链接**。用符号链接
 *   路径建 venv 时，CPython 会把 `pyvenv.cfg` 的 `home` 写成「符号链接所在目录」
 *   （该目录通常只有符号链接、没有 lib/python3.x），于是 venv 内每个 python 都起不来
 *   （ModuleNotFoundError: No module named 'encodings'）→ ensurepip 必然失败 → 装不上 pip。
 *
 * 只在路径存在时 realpath；失败一律回落原值（不抛）。
 * @param {string} p
 * @returns {string}
 */
export function realInterpreterPath(p) {
  const s = String(p || '');
  if (!s) return s;
  try { return fs.realpathSync(s); } catch { return s; }
}

/**
 * `<binDir>/../lib` 下是否存在 stdlib 目录（python3 / python3.x）。
 *
 * 用来判断一个「解释器目录」是否是真正带 stdlib 的 prefix —— venv 的 `home` 指向它时必须成立。
 * @param {string} binDir
 * @returns {boolean}
 */
export function hasStdlibNear(binDir) {
  const d = String(binDir || '');
  if (!d) return false;
  try {
    return fs.readdirSync(path.join(d, '..', 'lib')).some((n) => STDLIB_RE.test(n));
  } catch { return false; }
}

/**
 * 修正 venv 的 pyvenv.cfg：把 `home` 指向**真实**解释器所在目录（Bug A 修复）。
 *
 * ★ 只在「当前 home 目录没有 stdlib」且「真实解释器目录有 stdlib」时才改写：
 *   · Homebrew / python.org 等正常安装（home 已正确）→ 检测到有 stdlib → **绝不改动**；
 *   · uv / 手工符号链接（home 被写成只有符号链接的目录）→ 改为真实目录。
 * 这样既修好坏 venv，又绝不会误伤任何本来就正常的 venv。
 *
 * @param {string} venvDir venv 目录（如 ~/.mackit/py/venv）
 * @param {string} realPy 真实解释器路径（realInterpreterPath 的结果）
 * @param {(level:string, text:string)=>void} [log]
 * @returns {{changed:boolean, reason:string, from:string|null, to:string|null}}
 */
export function repairVenvHome(venvDir, realPy, log = () => {}) {
  const cfgPath = path.join(String(venvDir || ''), 'pyvenv.cfg');
  if (!paths.exists(cfgPath)) return { changed: false, reason: 'no-cfg', from: null, to: null };
  const realDir = path.dirname(String(realPy || ''));
  let text;
  try { text = fs.readFileSync(cfgPath, 'utf8'); } catch { return { changed: false, reason: 'read-failed', from: null, to: null }; }
  const m = /^home\s*=\s*(.*)$/m.exec(text);
  if (!m) return { changed: false, reason: 'no-home', from: null, to: null };
  const curHome = m[1].trim();
  if (hasStdlibNear(curHome)) return { changed: false, reason: 'home-ok', from: curHome, to: realDir };
  if (!hasStdlibNear(realDir)) return { changed: false, reason: 'real-no-stdlib', from: curHome, to: realDir };
  if (curHome === realDir) return { changed: false, reason: 'same', from: curHome, to: realDir };
  try { fs.writeFileSync(cfgPath, text.replace(/^home\s*=.*$/m, `home = ${realDir}`), 'utf8'); }
  catch { return { changed: false, reason: 'write-failed', from: curHome, to: realDir }; }
  log('info', `已修正虚拟环境 home：${curHome} → ${realDir}`);
  return { changed: true, reason: 'repaired', from: curHome, to: realDir };
}

/**
 * 判定一个已存在的 venv 是否**真的可用**，并给出不可用原因。
 *
 * ★ Bug B：部署状态为 broken 时前端承诺「删除并重建」，但旧实现只要 venv 目录存在就跳过创建，
 *   导致损坏的 venv 被「跳过创建」、后续 pip 步骤必然失败 —— 「修复」按钮形同虚设。
 *   这里给出可用性判定，作为 createVenvStep 自愈（不可用即重建）的依据。
 *
 * ★ 判据必须能覆盖「pip 文件在、但 pip 真的跑不起来」的半死 venv，且必须与**真实安装路径一致**。
 *   旧判据只看「pip 文件存在」+「venv 内 python 能 import sys」：
 *   `bin/pip` 存在但 pip 半装/损坏时会被误判为可用 → 永远跳过重建 → pipInstallStep 必失败
 *   → 「修复」永远修不好。故补一条探针，直接 spawn **安装步骤真正执行的那个可执行文件**：
 *
 *     1) 廉价短路：`bin/pip` 文件不存在 → 直接不可用（省一次子进程）；
 *     2) `venvPy -c 'import sys'` —— venv 内解释器能否启动（坏 home 时这里就挂，是与 pip 无关的另一类失败面）；
 *     3) `venvPip --version`      —— 直接跑 `bin/pip`（console script），**与 pipInstallStep 完全同一条路径**。
 *
 *   三步都带超时（VENV_PROBE_TIMEOUT_MS）：半死的 venv 可能长时间无输出，
 *   不能让它把整个安装流程阻塞住。任一步失败即返回，附带人类可读的 reason 供日志。
 *
 * ★ 为什么第 3 步**必须**探 `venvPip` 本身，而不能探 `venvPy -m pip --version`：
 *   pipInstallStep 执行的是 `venv/bin/pip install …` 这个 **console script**，其 shebang 是**绝对路径**、
 *   且依赖**可执行位**。`python -m pip` 只加载 pip 模块、完全绕过脚本本身，二者**并不等价**，存在漏判窗口：
 *     · venv 被搬迁（`mv venv venv-moved`，HOME / 路径变化）→ 脚本 shebang 指向的旧解释器已不存在
 *       → `bin/pip` 报 ENOENT（exit=-1 / CMD_FAILED），而此时 `python -m pip --version` 仍 exit=0；
 *     · `chmod -x bin/pip`（备份 / 云同步 / FAT 卷解压后丢可执行位）→ `bin/pip` 直接起不来，`python -m pip` 仍通。
 *   这两类构造下若只探 `python -m pip`，就会误判「可用」→ 跳过重建 → pipInstallStep 必失败 → 永远修不好
 *   （= Bug B 同类复发）。直接探 `venvPip` **同时覆盖**「pip 模块坏」与「脚本形态坏（shebang / 可执行位）」两类失败面。
 *   （`bin/pip` 位于 `~/.mackit/py/**`，exec 白名单层 2 放行，可直接 spawn；`bin/pip` 缺失已由第 1 步短路兜住。）
 *
 * @param {{venvPy:string, venvPip:string, run:Function}} o
 * @returns {Promise<{usable:boolean, reason:string}>}
 */
export async function venvUsable({ venvPy, venvPip, run }) {
  if (!paths.exists(venvPip)) return { usable: false, reason: 'pip 文件缺失' };
  try {
    const r = await run(venvPy, ['-c', 'import sys'], { noMirror: true, timeoutMs: VENV_PROBE_TIMEOUT_MS });
    if (!r || r.code !== 0) return { usable: false, reason: 'venv 内 python 无法启动' };
  } catch {
    return { usable: false, reason: 'venv 内 python 无法启动' };
  }
  try {
    // ★ 探测的就是安装步骤要执行的那个可执行文件本身（bin/pip console script），
    //   而非 `venvPy -m pip`——后者绕过脚本形态，会漏判 shebang / 可执行位失败。
    const p = await run(venvPip, ['--version'], { noMirror: true, timeoutMs: VENV_PROBE_TIMEOUT_MS });
    if (!p || p.code !== 0) return { usable: false, reason: 'pip 无法运行' };
  } catch {
    return { usable: false, reason: 'pip 无法运行' };
  }
  return { usable: true, reason: '' };
}

/**
 * 确保指定 venv 存在且可用（Bug A + Bug B 的修复核心）。全部子进程经注入的 `run`（= ctx.exec.run）。
 *
 * 流程：
 *   1) realpath 解释器（消除符号链接；仅用于修正 home，**不作为 spawn 目标**——exec 白名单
 *      只放行「受信任解释器目录」内的路径，符号链接所在的宿主 bin 目录在名单内，其真实目录不在，
 *      直接 spawn realpath 会被 exec 拒绝；真正需要真实路径的只是 pyvenv.cfg 的 home）；
 *   2) 已有 venv → 可用才跳过；不可用 → **删除并重建**（删除范围严格限定 venvDir）；
 *   3) `解释器 -m venv --without-pip`（先不装 pip：符号链接场景下 venv 内 ensurepip 必失败）；
 *   4) 修正 pyvenv.cfg 的 home（见 repairVenvHome）；
 *   5) `venv/bin/python -m ensurepip` 安装 pip。
 *
 * @param {{interpreterPath:string, venvDir:string, run:Function,
 *          log?:(level:string,text:string)=>void}} o
 * @returns {Promise<{rebuilt:boolean, realInterpreter:string}>}
 */
export async function ensureVenv({ interpreterPath, venvDir, run, log = () => {} }) {
  const py = String(interpreterPath || '');
  const dir = String(venvDir || '');
  if (!py || !dir) throw new exec.AppError(exec.ERR.ENV_MISSING, '缺少解释器或目标目录');
  if (typeof run !== 'function') throw new exec.AppError(exec.ERR.CMD_FAILED, '缺少执行接口');

  const venvPy = path.join(dir, 'bin', 'python');
  const venvPip = path.join(dir, 'bin', 'pip');
  const realPy = realInterpreterPath(py);
  const onLine = (line, which) => { const t = String(line || '').trim(); if (t) log(which === 'stderr' ? 'warn' : 'info', t); };

  // ② 已有 venv：可用才跳过；不可用则删除重建（自愈）。删除范围严格限定 dir，绝不触碰用户音乐目录。
  if (paths.exists(venvPy)) {
    const v = await venvUsable({ venvPy, venvPip, run });
    if (v.usable) {
      log('ok', `虚拟环境已存在且可用，跳过创建：${dir}`);
      return { rebuilt: false, realInterpreter: realPy };
    }
    log('warn', `检测到已有虚拟环境不可用（${v.reason}），将删除重建：${dir}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      throw new exec.AppError(exec.ERR.IO_ERROR, `无法删除损坏的虚拟环境：${dir}`, String(err && err.message));
    }
  }

  // ① UI 展示仍用用户看得懂的路径；这里在日志里点明真实解释器路径，便于排查符号链接类问题。
  if (realPy !== py) log('info', `使用真实解释器路径：${realPy}（原：${py}）`);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log('info', `执行：${py} -m venv --without-pip ${dir}`);
  const res = await run(py, ['-m', 'venv', '--without-pip', dir], { noMirror: true, onLine });
  if (res.code !== 0 || !paths.exists(venvPy)) {
    throw new exec.AppError(exec.ERR.CMD_FAILED, '创建虚拟环境失败',
      paths.tailLines(res.stderr) || paths.tailLines(res.stdout));
  }

  // ④ 修正 home（符号链接解释器场景；正常安装不受影响）
  repairVenvHome(dir, realPy, log);

  // ⑤ 用 venv 内 python 初始化 pip（等价于 `python -m venv` 默认执行的 ensurepip 步骤）
  log('info', '正在初始化 pip（ensurepip）…');
  const pipRes = await run(venvPy, ['-m', 'ensurepip', '--upgrade', '--default-pip'], { noMirror: true, onLine });
  if (pipRes.code !== 0 || !paths.exists(venvPip)) {
    throw new exec.AppError(exec.ERR.CMD_FAILED, '初始化 pip 失败（虚拟环境不可用）',
      paths.tailLines(pipRes.stderr) || paths.tailLines(pipRes.stdout));
  }
  log('ok', `虚拟环境已就绪：${dir}`);
  return { rebuilt: true, realInterpreter: realPy };
}

/**
 * 音乐环境总状态（设计 §3.4 EnvStatus）。
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<object>}
 */
export async function detect(opts = {}) {
  if (!opts.force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const python = await findPython312();
  const venvExists = paths.exists(paths.MUSIC_VENV_PY);
  const musicdl = venvExists
    ? await probeMusicdl()
    : { installed: false, version: null, importError: null };
  const bridge = { path: paths.MUSIC_BRIDGE, exists: paths.exists(paths.MUSIC_BRIDGE) };
  const free = diskFreeBytes(paths.PY_DIR);
  const disk = { freeBytes: free, needBytes: NEED_BYTES };

  // 三态判定（§6.3）：
  //   ready     : venv 存在 && musicdl 可导入 && 有可用 3.12+ 解释器
  //   broken    : venv 存在但 musicdl 导入失败（需「修复」= 重建 venv）
  //   not_ready : 尚未安装（缺解释器 / 缺 venv）
  let status = 'not_ready';
  if (venvExists && musicdl.installed && python.found) status = 'ready';
  else if (venvExists && !musicdl.installed) status = 'broken';

  const value = {
    status,
    python,
    venv: {
      exists: venvExists,
      path: paths.MUSIC_VENV,
      pythonPath: venvExists ? paths.MUSIC_VENV_PY : null,
    },
    musicdl,
    bridge,
    disk,
  };
  cache = { at: Date.now(), value };
  return value;
}
