/**
 * MacKit · 备份中心（后端模块）：WebDAV 备份 / 恢复 / 删除
 *
 * 2026-09-16 自动备份（集中备份目录 + Rime 原地 .bak）全部移除；
 * 2026-09-17 手动导出 / 导入本地 JSON 文件也整体移除（前端已无入口）。
 * 至此本模块只剩一条链路：把备份信封上传到**自建 WebDAV**，换电脑或误改配置后
 * 从远程列出 / 下载 / 删除。`applyPayloadSteps` 是「把信封应用到本机」的唯一实现。
 *
 * 备份内容（全部小体量文本；词库 / 模型等大文件不打包，导入后按需重新下载）：
 *   - mackit  : MacKit 设置（channel 全局通道 / autoFallback / autoCleanup）
 *   - brewgo  : ~/.brewgo_config（HTTP / SOCKS5 代理端口、镜像源）
 *   - git     : Git 全局配置（sysinit 白名单 6 键，仅记录非空值）
 *   - github  : 钥匙串 GitHub 凭据（**明文 Token**，用户已确认打入；绝不写日志）
 *   - rime    : Rime 目录下全部 *.custom.yaml 原文（外观 squirrel.custom.yaml、
 *               方案列表 default.custom.yaml、语法模型补丁等）+ 已装 .gram 清单
 *   - rime.userDicts : 用户词典文本（个人词频 / 自造词）——2026-11-23 新增，是唯一
 *               无法重建的数据（配置能重敲、词库能重下、模型能重装，词频丢了就没了）
 *
 * 安全约束：
 *   - Token 只从 `git credential-osxkeychain get` 读取、只经 stdin 写回 `store`，
 *     绝不写入日志（ctx.log 一律不含 Token 字面量）；
 *   - 从 WebDAV 恢复 / 删除远程记录 均为 destructive 动作（重写用户配置或删远程文件），
 *     走 runner 二次确认门；
 *   - WebDAV 凭据独立存 `~/.mackit/webdav.json`（600，明文），只经 Authorization 头传递，
 *     绝不进日志 / 响应 / URL（见 lib/store.js 与 lib/webdav.js）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';
import * as git from './git.js';
import * as webdav from './webdav.js';

const { ERR, AppError } = exec;
const { DAV_ERR } = webdav;

const GIT_KEYS = git.GIT_KEYS;

// ------------------------------ 工具 ------------------------------
const readTextSafe = paths.readTextSafe;

const runGit = git.run;

// ------------------------------ 导出（收集） ------------------------------
/** Rime 目录下需要备份的配置文件清单（*.custom.yaml 原文）。 */
function collectRimeFiles() {
  const out = [];
  try {
    for (const name of fs.readdirSync(paths.RIME_DIR).sort()) {
      if (!name.endsWith('.custom.yaml')) continue;
      const text = readTextSafe(`${paths.RIME_DIR}/${name}`);
      if (text !== null) out.push({ name, text });
    }
  } catch { /* Rime 目录不存在（未安装）→ 空清单 */ }
  return out;
}

/** 已装的语法模型清单（只记名字与大小，模型文件本体不打包）。 */
function collectGrammarModels() {
  const out = [];
  try {
    for (const name of fs.readdirSync(paths.RIME_DIR).sort()) {
      if (!name.endsWith('.gram')) continue;
      try { out.push({ name, size: fs.statSync(`${paths.RIME_DIR}/${name}`).size }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

/** 单个用户词典文本的体积上限（信封总上限 32MB，留足余量）。 */
const USERDICT_MAX_BYTES = 8 * 1024 * 1024;
const DICT_MANAGER = paths.RIME_DICT_MANAGER;

/**
 * 导出用户词典（`*.userdb` LevelDB 目录 → Rime 标准文本）。
 *
 * ★ 2026-11-23 新增。此前备份只含 `*.custom.yaml`，换个电脑，**个人词频与自造词全丢**，
 *   而那是唯一真正无法重建的东西（配置能重敲、词库能重下、模型能重装）。
 *
 * 两个必须绕开的坑（都实测过）：
 *   ① `rime_dict_manager -e` 直接对 ~/Library/Rime 跑会失败：
 *      `Error opening db 'rime_ice' read-only.` —— Squirrel 常驻进程持有 LevelDB 的 LOCK。
 *      解法：把 `*.userdb` **复制**到临时目录，对副本导出（锁不跟随文件）。
 *   ② 这个打包版不是上游参数：`-e <dict> <out.txt>` 要两个参数，`-d` 不支持（会 "invalid arguments."），
 *      并且**以 cwd 作为用户目录**，所以必须 `cwd = 副本目录`。
 *
 * 体积实测：1.0 MB 的 LevelDB → 241 KB 文本 / 12,553 条，进信封毫无压力。
 *
 * @param {object} ctx 任务上下文（仅用于日志）
 * @returns {Promise<Array<{name:string, text:string}>>}
 */
async function collectUserDicts(ctx) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(paths.RIME_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('.userdb'))
      .map((d) => d.name.slice(0, -'.userdb'.length))
      .sort();
  } catch { return out; }                       // Rime 目录不存在（未安装）
  if (!names.length) return out;
  if (!paths.exists(DICT_MANAGER)) {
    ctx.log('warn', '未找到 rime_dict_manager（Squirrel 未安装？），本次备份不含用户词典');
    return out;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mackit-userdb-'));
  try {
    for (const name of names) {
      const work = path.join(tmpRoot, name);
      const outFile = path.join(work, `${name}.userdb.txt`);
      try {
        fs.mkdirSync(work, { recursive: true });
        fs.cpSync(`${paths.RIME_DIR}/${name}.userdb`, path.join(work, `${name}.userdb`), { recursive: true });
      } catch (err) {
        ctx.log('warn', `用户词典 ${name} 复制失败，本次不含该词典：${err && err.message}`);
        continue;
      }
      const res = await exec.run(DICT_MANAGER, ['-e', name, outFile], { cwd: work, noMirror: true, timeoutMs: 180_000 });
      if (res.code !== 0) {
        ctx.log('warn', `用户词典 ${name} 导出失败（退出码 ${res.code}），本次不含该词典：${paths.tailLines(res.stderr)}`);
        continue;
      }
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
      if (!text) { ctx.log('warn', `用户词典 ${name} 导出结果为空，跳过`); continue; }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > USERDICT_MAX_BYTES) {
        ctx.log('warn', `用户词典 ${name} 文本过大（${Math.round(bytes / 1024)} KB），超过单份上限，跳过`);
        continue;
      }
      const count = text.split('\n').filter((l) => l && !l.startsWith('#')).length;
      out.push({ name, text });
      ctx.log('ok', `已导出用户词典 ${name}（${count} 条，${Math.round(bytes / 1024)} KB）`);
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响备份 */ }
  }
  return out;
}

/**
 * 收集备份数据（payload 本体，不含信封）。
 * 含钥匙串里的 GitHub 凭据（明文 Token）—— 只在 webdav_backup 的「收集」步调用，
 * 结果只进上传信封，绝不写日志 / 落盘。
 * @returns {Promise<object>}
 */
async function collectData(ctx) {
  const mackit = store.readMackit();
  const brewgo = store.readBrewgo();
  const gitCfg = {};
  for (const key of GIT_KEYS) {
    const v = await git.config(key);
    if (v !== null && v !== '') gitCfg[key] = v;
  }
  // 用户词典要跑 rime_dict_manager（子进程），放在最后收集，失败只降级不中断备份
  const userDicts = await collectUserDicts(ctx);
  return {
    // 全局网络通道档位一并备份（2026-11-26 起就一个键）：换电脑 / 重装后不用重设。
    mackit: {
      channel: mackit.channel,
      autoFallback: mackit.autoFallback, autoCleanup: mackit.autoCleanup,
    },
    // mirrorRaw 一并备份：自定义镜像（枚举外的自建源 / URL）只存在原始行里，
    // 只带枚举 mirror 的话「备份 → 恢复」会把它悄悄改写成 official。
    brewgo: { httpPort: brewgo.httpPort, socksPort: brewgo.socksPort, mirror: brewgo.mirror, mirrorRaw: brewgo.mirrorRaw },
    git: gitCfg,
    github: await git.readCredential(),
    // userDicts：用户词典文本（个人词频 / 自造词）。唯一无法重建的数据，优先级最高。
    rime: { files: collectRimeFiles(), grammarModels: collectGrammarModels(), userDicts },
  };
}

// -------------------- 信封校验 + 应用（WebDAV 恢复复用） --------------------
/**
 * 校验并归一化备份 payload（纯函数）。不合法抛 PARSE_FAILED。
 * @returns {{createdAt:number, data:object}}
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(ERR.PARSE_FAILED, '备份文件格式不正确：应为 JSON 对象');
  }
  if (payload.app !== 'MacKit') {
    throw new AppError(ERR.PARSE_FAILED, `不是 MacKit 的备份文件（app=${JSON.stringify(payload.app || null)}）`);
  }
  if (payload.version !== 1) {
    throw new AppError(ERR.PARSE_FAILED, `不支持的备份版本：${String(payload.version)}（本机支持 version=1）`);
  }
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError(ERR.PARSE_FAILED, '备份文件缺少 data 字段');
  }
  return { createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : null, data };
}

/** 应用 Rime 配置文件清单（纯文件写入）。 */
function applyRimeFiles(ctx, files) {
  if (!Array.isArray(files) || files.length === 0) { ctx.log('info', '备份中无 Rime 配置文件，跳过'); return; }
  if (!paths.exists(paths.RIME_DIR)) fs.mkdirSync(paths.RIME_DIR, { recursive: true });
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !/^[A-Za-z0-9_.-]+\.custom\.yaml$/.test(f.name)) {
      ctx.log('warn', `跳过非法文件名：${f && f.name}`);
      continue;
    }
    if (typeof f.text !== 'string') {
      // 不静默跳过：否则恢复后「少了一个配置文件」这件事在日志里完全看不出来
      ctx.log('warn', `跳过内容缺失的 Rime 配置：${f && f.name}`);
      continue;
    }
    paths.writeText(`${paths.RIME_DIR}/${f.name}`, f.text);
    ctx.log('ok', `已写入 Rime 配置：${f.name}`);
  }
}

/**
 * 恢复用户词典：落 txt → 挪开现有 userdb → `-i` 导入 → 交给后续「重新部署」加载。
 *
 * ★ 为什么是 `-i` 而不是 `-r`（2026-11-23 实测对比，这点很关键）：
 *   `-r xxx.userdb.txt` 的文本格式与 `-e` 导出**并不对称** —— 导出的 `词\t编码\t频率`
 *   经 `-r` 再导出会变成 `编码\t词\t0`（两列对调、频率归零），等于把词库搞坏。
 *   `-i` 才是对称的：12553 条导出 → 导入 → 再导出，**集合完全一致**。
 *
 * ★ 为什么先 rename 现有 userdb：
 *   Squirrel 常驻进程持有 LevelDB 的 LOCK，直接 `-i` 写原目录会失败。rename 是原子操作，
 *   旧文件句柄继续有效，因此**不需要退出输入法**；新路径不存在时 `-i` 会自己创建 db 并导入。
 *   旧目录只临时挪到 `<name>.userdb.restore-tmp`，**导入成功即删除**（用户明确不要留档）；
 *   导入失败则原样挪回，保证「失败的恢复不改变现状」。
 *
 * @param {object} ctx
 * @param {unknown} dicts 备份里的 rime.userDicts
 */
async function applyUserDicts(ctx, dicts) {
  const list = Array.isArray(dicts) ? dicts : [];
  if (!list.length) { ctx.log('info', '备份中无用户词典，跳过'); return; }
  if (!paths.exists(DICT_MANAGER)) {
    ctx.log('warn', '未找到 rime_dict_manager，无法恢复用户词典（请确认 Squirrel 已安装）');
    return;
  }
  if (!paths.exists(paths.RIME_DIR)) fs.mkdirSync(paths.RIME_DIR, { recursive: true });
  for (const d of list) {
    if (!d || typeof d.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(d.name) || typeof d.text !== 'string') {
      ctx.log('warn', `跳过非法的用户词典条目：${d && d.name}`);
      continue;
    }
    const name = d.name;
    const txtPath = `${paths.RIME_DIR}/${name}.userdb.txt`;
    try { paths.writeText(txtPath, d.text); }
    catch (err) { throw new AppError(ERR.IO_ERROR, `写入 ${name}.userdb.txt 失败`, String(err && err.message)); }

    const dbPath = `${paths.RIME_DIR}/${name}.userdb`;
    // 旧的 db 只**临时**挪开（导入期间腾出路径给新库），成功后立即删除 —— 不保留任何 .bak 留档。
    // 挪开是必需的：Squirrel 常驻持有 LOCK，不腾路径 `-i` 会失败；rename 是原子的，
    // 旧句柄继续有效，所以不需要让输入法退出。
    const parkedPath = `${dbPath}.restore-tmp`;
    let parked = false;
    if (paths.exists(dbPath)) {
      try { fs.rmSync(parkedPath, { recursive: true, force: true }); } catch { /* 上次中断的残留 */ }
      try {
        fs.renameSync(dbPath, parkedPath);
        parked = true;
      } catch (err) {
        throw new AppError(ERR.IO_ERROR, `无法挪开现有词典 ${name}.userdb`, String(err && err.message));
      }
    }

    const res = await exec.run(DICT_MANAGER, ['-i', name, txtPath], { cwd: paths.RIME_DIR, noMirror: true, timeoutMs: 300_000 });
    if (res.code !== 0) {
      // 回滚：失败的恢复不能把现状弄坏。删掉可能生成了一半的新 db，把挪开的旧库放回去。
      try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
      if (parked) {
        try { fs.renameSync(parkedPath, dbPath); ctx.log('warn', `已回滚 ${name}.userdb（导入失败，现有词典不受影响）`); }
        catch { ctx.log('warn', `回滚 ${name}.userdb 失败，原词典仍在 ${parkedPath}`); }
      }
      throw new AppError(ERR.CMD_FAILED, `用户词典 ${name} 导入失败（退出码 ${res.code}）`, paths.tailLines(res.stderr));
    }
    // 成功 → 清理临时挪开的旧库（用户明确不要留档）
    if (parked) { try { fs.rmSync(parkedPath, { recursive: true, force: true }); } catch { /* 占用中，重启后自清 */ } }
    const summary = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    ctx.log('ok', `用户词典 ${name} 已导入${summary ? `（${summary}）` : ''}`);
  }
  ctx.log('info', '下一步「重新部署输入法」会让 Squirrel 加载这份词典');
}

/**
 * 共享步骤生成器：把备份信封「应用到本机」的 7 步（validate / mackit / brewgo /
 * git / github / rime / deploy）。只被 `webdav_restore` 使用，是这条链路的唯一实现。
 *
 * @param {() => object} getPayload 惰性取信封（restore 场景下信封在「下载」步才就绪）
 * @returns {Array<{id:string,title:string,run:(ctx:object)=>Promise<void>}>}
 */
function applyPayloadSteps(getPayload) {
  return [
    {
      id: 'validate', title: '校验备份文件',
      run: async (ctx) => {
        const { createdAt } = validatePayload(getPayload());
        ctx.log('ok', createdAt ? `备份创建于 ${new Date(createdAt).toLocaleString()}` : '备份（无创建时间戳）');
      },
    },
    {
      id: 'mackit', title: '恢复 MacKit 设置',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        if (!data.mackit || typeof data.mackit !== 'object') { ctx.log('info', '备份中无 MacKit 设置，跳过'); return; }
        store.writeMackit(data.mackit);
        ctx.log('ok', 'MacKit 设置已恢复（网络通道 / 失败降级 / 自动清理缓存）');
      },
    },
    {
      id: 'brewgo', title: '恢复代理端口与镜像',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        if (!data.brewgo || typeof data.brewgo !== 'object') { ctx.log('info', '备份中无代理端口配置，跳过'); return; }
        const b = store.writeBrewgo(data.brewgo);
        ctx.log('ok', `已恢复 ~/.brewgo_config：HTTP=${b.httpPort}, SOCKS5=${b.socksPort}, MIRROR=${b.mirror}`);
      },
    },
    {
      id: 'git', title: '恢复 Git 全局配置',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        const git = (data.git && typeof data.git === 'object') ? data.git : null;
        if (!git || Object.keys(git).length === 0) { ctx.log('info', '备份中无 Git 配置，跳过'); return; }
        const installed = await runGit(['--version']);
        if (installed.code !== 0) throw new AppError(ERR.ENV_MISSING, '未检测到 Git，无法恢复 Git 全局配置');
        let applied = 0;
        for (const key of GIT_KEYS) {
          const value = git[key];
          if (value == null || typeof value !== 'string') continue;
          const res = await runGit(['config', '--global', key, value]);
          if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, `设置 ${key} 失败`, res.stderr.trim());
          ctx.log('ok', `git config --global ${key}`);
          applied += 1;
        }
        ctx.log('ok', `Git 全局配置已恢复 ${applied} 项`);
      },
    },
    {
      id: 'github', title: '恢复 GitHub 凭据（钥匙串）',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        const gh = data.github;
        if (!gh || typeof gh !== 'object' || !gh.username || !gh.token) { ctx.log('info', '备份中无 GitHub 凭据，跳过'); return; }
        const res = await git.storeCredential(gh.username, gh.token);
        if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, '写入钥匙串失败', res.stderr.trim());
        ctx.log('ok', `GitHub 凭据已写入钥匙串（用户名 ${String(gh.username)}，Token 不记录）`);
      },
    },
    {
      id: 'rime', title: '恢复 Rime 配置',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        applyRimeFiles(ctx, data.rime && data.rime.files);
        const grams = (data.rime && Array.isArray(data.rime.grammarModels)) ? data.rime.grammarModels : [];
        const missing = grams.filter((g) => g && g.name && !paths.exists(`${paths.RIME_DIR}/${g.name}`));
        if (missing.length) {
          ctx.log('warn', `备份记录了模型文件但本机未安装（模型本体不打包）：${missing.map((g) => g.name).join('、')}——请到「Rime 输入法」重新下载`);
        }
      },
    },
    {
      id: 'userdict', title: '恢复用户词典（个人词频 / 自造词）',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        await applyUserDicts(ctx, data.rime && data.rime.userDicts);
      },
    },
    {
      id: 'deploy', title: '重新部署输入法',
      run: async (ctx) => {
        const { data } = validatePayload(getPayload());
        const hasRime = data.rime && Array.isArray(data.rime.files) && data.rime.files.length > 0;
        // 用户词典也是「必须部署才生效」的变更（Squirrel 在 reload 时才重新加载 userdb）
        const hasUserDict = data.rime && Array.isArray(data.rime.userDicts) && data.rime.userDicts.length > 0;
        if (!hasRime && !hasUserDict) { ctx.log('info', '无 Rime 配置变更，跳过部署'); return; }
        if (!paths.exists(paths.SQUIRREL_BIN)) { ctx.log('warn', '未找到 Squirrel，请手动重新部署（菜单栏「重新部署」）'); return; }
        const res = await exec.run(paths.SQUIRREL_BIN, ['--reload'], { noMirror: true, timeoutMs: 60_000 });
        if (res.code === 0) ctx.log('ok', '重新部署完成');
        else ctx.log('warn', `重新部署命令返回码 ${res.code}，如未生效请手动重新部署`);
      },
    },
  ];
}

// ------------------------------ WebDAV 备份 ------------------------------

/** WebDAV 列表查询（GET /api/webdav/backups）。 */
async function webdavList() {
  const cfg = store.readWebdav();
  if (!cfg.url) return { configured: false, count: 0, items: [] };
  const { count, items } = await webdav.listBackups(cfg, { timeoutMs: 15_000 });
  return {
    configured: true,
    count,
    items: items.map((it) => ({ name: it.name, lastModified: it.lastModified, size: it.size })),
  };
}

const actions = {
  // -------- 备份到 WebDAV（上传信封） --------
  webdav_backup: {
    title: '备份到 WebDAV',
    destructive: false,
    steps: (params) => {
      /** @type {object|null} */
      let cfgRef = null;
      /** @type {object|null} */
      let payloadRef = null;
      /** @type {string|null} */
      let nameRef = null;
      return [
        {
          id: 'config', title: '读取 WebDAV 配置',
          run: async (ctx) => {
            cfgRef = store.readWebdav();
            if (!cfgRef.url) throw new AppError(DAV_ERR.CONFIG, '请先在「WebDAV 设置」中填写服务器地址');
            ctx.log('ok', `目标服务器：${cfgRef.url}（${cfgRef.username ? '已设置账号' : '匿名'}）`);
          },
        },
        {
          id: 'collect', title: '收集本机设置',
          run: async (ctx) => {
            payloadRef = { app: 'MacKit', version: 1, createdAt: Date.now(), data: await collectData(ctx) };
            // ★ readCredential 返回 null 有三种原因：钥匙串里没有（正常）、读取超时、用户拒绝了
            //   授权弹窗。它们无法区分，所以不能无条件宣称「含凭据」——否则用户换机恢复后
            //   发现 Token 缺失，却一直以为备份是完整的（2026-09-25 修）。
            if (payloadRef.data.github) ctx.log('ok', '已收集本机设置（含钥匙串 GitHub 凭据，绝不写日志）');
            else ctx.log('warn', '未读到钥匙串 GitHub 凭据（可能未配置，或读取被拒绝 / 超时）——本次备份不含 Token');
          },
        },
        {
          id: 'ensure', title: '确保远程目录',
          run: async (ctx) => {
            await webdav.ensureCollection(cfgRef, webdav.remoteDirUrl(cfgRef), { signal: ctx.signal });
            ctx.log('ok', '远程目录已就绪');
          },
        },
        {
          id: 'upload', title: '上传备份（PUT）',
          run: async (ctx) => {
            nameRef = (typeof params.name === 'string' && params.name) ? params.name : webdav.buildBackupName();
            if (!webdav.isAllowedBackupName(nameRef)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
            const text = JSON.stringify(payloadRef, null, 2);
            await webdav.uploadBackup(cfgRef, nameRef, text, { signal: ctx.signal });
            ctx.log('ok', `已上传：${nameRef}`);
          },
        },
        {
          id: 'verify', title: '校验上传结果',
          run: async (ctx) => {
            const { items } = await webdav.listBackups(cfgRef, { signal: ctx.signal });
            if (!items.some((it) => it.name === nameRef)) {
              throw new AppError(ERR.CMD_FAILED, '上传后未在远程目录找到该文件，请检查服务器行为');
            }
            ctx.log('ok', `远程已确认：${nameRef}`);
          },
        },
      ];
    },
  },

  // -------- 从 WebDAV 恢复（下载 + 复用导入 7 步） --------
  webdav_restore: {
    title: '从 WebDAV 恢复备份',
    destructive: true,
    steps: (params) => {
      /** @type {object|null} */
      let cfgRef = null;
      /** @type {object|null} */
      let payloadRef = null;
      return [
        {
          id: 'connect', title: '连接 WebDAV',
          run: async (ctx) => {
            cfgRef = store.readWebdav();
            if (!cfgRef.url) throw new AppError(DAV_ERR.CONFIG, '请先在「WebDAV 设置」中填写服务器地址');
            await webdav.testConnection(cfgRef, { signal: ctx.signal });
            ctx.log('ok', `WebDAV 连接正常：${cfgRef.url}`);
          },
        },
        {
          id: 'download', title: '下载备份文件',
          run: async (ctx) => {
            const name = String(params.name || '');
            if (!webdav.isAllowedBackupName(name)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
            const text = await webdav.downloadBackup(cfgRef, name, { signal: ctx.signal });
            try {
              payloadRef = JSON.parse(text);
            } catch (err) {
              throw new AppError(ERR.PARSE_FAILED, '下载到的备份文件不是合法 JSON', String(err && err.message));
            }
            ctx.log('ok', `已下载：${name}`);
          },
        },
        ...applyPayloadSteps(() => payloadRef),
      ];
    },
  },

  // -------- 删除远程记录 --------
  webdav_delete: {
    title: '删除 WebDAV 备份',
    destructive: true,
    steps: (params) => {
      /** @type {object|null} */
      let cfgRef = null;
      const nameRef = String(params.name || '');
      return [
        {
          id: 'guard', title: '校验文件名',
          run: async (ctx) => {
            if (!webdav.isAllowedBackupName(nameRef)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
            ctx.log('ok', `待删除：${nameRef}`);
          },
        },
        {
          id: 'delete', title: '删除远程备份（DELETE）',
          run: async (ctx) => {
            cfgRef = store.readWebdav();
            if (!cfgRef.url) throw new AppError(DAV_ERR.CONFIG, '请先在「WebDAV 设置」中填写服务器地址');
            await webdav.deleteBackup(cfgRef, nameRef, { signal: ctx.signal });
            ctx.log('ok', `已请求删除：${nameRef}`);
          },
        },
        {
          id: 'verify', title: '确认已删除',
          run: async (ctx) => {
            const { items } = await webdav.listBackups(cfgRef, { signal: ctx.signal });
            if (items.some((it) => it.name === nameRef)) {
              throw new AppError(ERR.CMD_FAILED, '删除后该文件仍存在，请检查服务器行为');
            }
            ctx.log('ok', '远程已确认删除');
          },
        },
      ];
    },
  },
};

export default {
  id: 'backup',
  actions,
  queries: {
    webdavList,
  },
};
