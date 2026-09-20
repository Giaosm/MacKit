/**
 * MacKit · 系统初始化（后端模块）
 *
 * 语义移植自原 `shell/proxy.sh`（参考脚本已于 2026-09-16 从仓库移除，本文件为该功能的唯一事实源）。
 *
 * 关键约束：
 *   - 移除别名只删除 alias 定义块，绝不删除注释行（用 env.computeAliasRemovalRange）
 *   - 源码不得出现任何个人信息字面量；建议值一律运行时生成
 *   - 改代理端口不自动改 Git 代理，仅返回提示
 *   - Token 只写钥匙串，绝不落盘、绝不进日志
 */

import fs from 'node:fs';
import os from 'node:os';
import * as paths from './paths.js';
import * as store from './store.js';
import * as env from './env.js';
import * as exec from './exec.js';
import * as git from './git.js';

const { ERR, AppError } = exec;

/** 允许写入的 Git 全局配置键（白名单，防止任意键注入；唯一事实源见 lib/git.js） */
const GIT_KEYS = git.GIT_KEYS;

// ------------------------------ 工具 ------------------------------
const readText = paths.readTextSafe;
const writeText = paths.writeText;

/** 生成首次运行的占位建议值：一律不含任何姓氏/邮箱/GitHub ID 字面量。 */
function suggestions(port) {
  let userName = '';
  try { userName = os.userInfo().username || ''; } catch { userName = ''; }
  return {
    'user.name': userName,
    'user.email': '',
    'safe.directory': '*',
    'http.proxy': `http://127.0.0.1:${port}`,
    'https.proxy': `http://127.0.0.1:${port}`,
    'credential.helper': 'osxkeychain',
  };
}

function rcFileOf() {
  const s = env.detectShell();
  return { kind: s.kind, rcFile: s.rcFile };
}

/** 删除 proxy/unproxy 的 alias 定义块（逐次重算范围，绝不删注释行）。 */
function removeAliasBlocks(text, names) {
  let cur = text;
  for (const name of names) {
    const range = env.computeAliasRemovalRange(cur, name);
    if (!range) continue;
    const lines = cur.split('\n');
    cur = lines.slice(0, range.start).concat(lines.slice(range.end + 1)).join('\n');
  }
  return cur;
}

/** 覆盖模式：先移除旧块，再追加期望的单行别名。 */
function buildAliasReplaced(text, port) {
  const cleaned = removeAliasBlocks(text, ['proxy', 'unproxy']).replace(/\s+$/, '');
  return `${cleaned}\n\n${env.expectedAliasLines(port).join('\n')}\n`;
}

/** 行级 LCS diff（rc 文件仅数十行，O(n*m) 足够）。 */
function diffLines(a, b) {
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** 归一化 Git 变更项（数组或对象皆可，键必须在白名单内）。 */
function normalizeChanges(params) {
  const out = [];
  if (Array.isArray(params.changes)) {
    for (const it of params.changes) if (it && it.key) out.push({ key: String(it.key), value: it.value == null ? '' : String(it.value) });
  } else if (params.changes && typeof params.changes === 'object') {
    for (const [k, v] of Object.entries(params.changes)) out.push({ key: k, value: v == null ? '' : String(v) });
  }
  return out.filter((c) => GIT_KEYS.includes(c.key));
}

// ------------------------------ 只读查询 ------------------------------
async function queryState() {
  const { kind, rcFile } = rcFileOf();
  const cfg = store.readBrewgo();
  const text = rcFile ? readText(rcFile) : null;
  const analysis = env.analyzeRc(text, cfg.httpPort);

  const gitInfo = {
    installed: false, // 由下方 dirExistsIsGit() 覆盖
    userName: await git.config('user.name'),
    userEmail: await git.config('user.email'),
    safeDirectory: await git.config('safe.directory'),
    httpProxy: await git.config('http.proxy'),
    httpsProxy: await git.config('https.proxy'),
    credentialHelper: await git.config('credential.helper'),
  };
  const gitInstalled = await dirExistsIsGit();
  gitInfo.installed = gitInstalled;

  const sug = suggestions(cfg.httpPort);
  const gitForm = GIT_KEYS.map((key) => ({
    key, label: key,
    current: gitInfo[keyToField(key)],
    placeholder: sug[key],
  }));

  const tokenExistsFlag = gitInstalled ? await git.credentialExists() : false;

  return {
    shell: { kind, rcFile },
    alias: {
      rcFile,
      existing: analysis.existing,
      willWrite: analysis.willWrite,
      matchesExpected: analysis.matchesExpected,
      multiline: analysis.multiline,
      present: analysis.present,
    },
    git: gitInfo,
    gitForm,
    tokenExists: tokenExistsFlag,
    proxyPorts: { http: cfg.httpPort, socks5: cfg.socksPort },
  };
}

function keyToField(key) {
  return {
    'user.name': 'userName',
    'user.email': 'userEmail',
    'safe.directory': 'safeDirectory',
    'http.proxy': 'httpProxy',
    'https.proxy': 'httpsProxy',
    'credential.helper': 'credentialHelper',
  }[key];
}

async function dirExistsIsGit() {
  const res = await safeGit(['--version']);
  return res.code === 0;
}

async function queryAliasPreview(params) {
  const mode = ['keep', 'replace', 'remove'].includes(params.mode) ? params.mode : 'keep';
  const { rcFile } = rcFileOf();
  const text = rcFile ? readText(rcFile) : null;
  const cfg = store.readBrewgo();
  if (text === null) {
    return { mode, rcFile, existing: [], willWrite: env.expectedAliasLines(cfg.httpPort), diff: [], note: '未找到 shell 配置文件' };
  }
  const analysis = env.analyzeRc(text, cfg.httpPort);
  let nextText = text;
  if (mode === 'replace') nextText = buildAliasReplaced(text, cfg.httpPort);
  else if (mode === 'remove') nextText = removeAliasBlocks(text, ['proxy', 'unproxy']);

  return {
    mode,
    rcFile,
    existing: analysis.existing,
    willWrite: analysis.willWrite,
    diff: diffLines(text.split('\n'), nextText.split('\n')),
    note: mode === 'remove' ? '仅移除 proxy/unproxy 别名定义块，注释行不会被删除' : '',
  };
}

// ------------------------------ Git 执行 ------------------------------
const safeGit = git.run;

// ------------------------------ 动作定义 ------------------------------
const actions = {
  /** 写入 / 覆盖 / 移除代理别名（覆盖与移除为危险操作） */
  apply_alias: {
    title: '应用代理别名',
    destructive: true,
    steps: (params) => {
      const mode = ['keep', 'replace', 'remove'].includes(params.mode) ? params.mode : 'keep';
      return [{
        id: 'alias', title: '代理别名',
        run: async (ctx) => {
          const { kind, rcFile } = rcFileOf();
          if (!rcFile) {
            throw new AppError(ERR.ENV_MISSING, '未识别到 zsh / bash，无法自动写入，请按「手工内容」自行添加');
          }
          if (!fs.existsSync(rcFile)) {
            throw new AppError(ERR.NOT_FOUND, `配置文件不存在：${rcFile}`);
          }
          ctx.log('info', `检测到 ${kind}，将操作 ${rcFile}`);
          if (mode === 'keep') { ctx.log('ok', '已选择「保留原样」，未做任何修改'); return; }

          // ★ readText 读失败（EACCES / 被 sudo 创建为 root 属主 / IO 错误）返回 null。
          //   此前写成 `|| ''`：一旦读不到就把「空字符串」当成原文，随后 writeText 会
          //   把用户的 .zshrc **整份覆盖**成几行别名 —— 属于不可逆的数据破坏。
          //   brew.js 的同一写入点已有同款护栏，这里补齐（2026-09-21 修）。
          const text = readText(rcFile);
          if (text === null) {
            throw new AppError(ERR.IO_ERROR, `无法读取 ${rcFile}，已中止以免覆盖你的配置`,
              '请检查该文件权限（例如是否为 root 属主），或改用「保留原样」手动添加');
          }
          const cfg = store.readBrewgo();

          let next;
          if (mode === 'replace') {
            next = buildAliasReplaced(text, cfg.httpPort);
            ctx.log('info', '将写入单行版 proxy / unproxy 别名（端口 ' + cfg.httpPort + '）');
          } else {
            const removed = ['proxy', 'unproxy'].map((n) => env.computeAliasRemovalRange(text, n)).filter(Boolean);
            for (const r of removed) {
              for (const line of r.lines) ctx.log('info', `  移除: ${line}`);
            }
            next = removeAliasBlocks(text, ['proxy', 'unproxy']);
            ctx.log('info', '仅移除 alias 定义块，注释行全部保留');
          }
          writeText(rcFile, next);
          ctx.log('ok', mode === 'replace' ? '代理别名已覆盖更新' : '代理别名已移除');
          ctx.log('info', `生效命令：source ${rcFile}`);
        },
      }];
    },
  },

  /** 应用 Git 全局配置变更（只应用发生变化的项） */
  apply_git_config: {
    title: '应用 Git 全局配置变更',
    destructive: true,
    steps: (params) => [{
      id: 'git_config', title: 'Git 全局配置',
      run: async (ctx) => {
        const installed = await safeGit(['--version']);
        if (installed.code !== 0) {
          throw new AppError(ERR.ENV_MISSING, '未检测到 Git，请先运行 `brew install git` 或从官网下载安装');
        }
        const changes = normalizeChanges(params);
        if (changes.length === 0) { ctx.log('warn', '没有需要应用的变更项'); return; }
        let applied = 0;
        for (const { key, value } of changes) {
          const cur = await git.config(key);
          if ((cur === null && value === '') || cur === value) {
            ctx.log('info', `跳过未变更项：${key}`);
            continue;
          }
          ctx.log('info', `git config --global ${key} ${key.includes('proxy') ? value : JSON.stringify(value)}`);
          const res = await safeGit(['config', '--global', key, value]);
          if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, `设置 ${key} 失败`, res.stderr.trim());
          applied += 1;
        }
        ctx.log('ok', `已应用 ${applied} 条变更（共提交 ${changes.length} 项）`);
      },
    }],
  },

  /** 写入 GitHub Token 到钥匙串（不落盘） */
  store_token: {
    title: '写入 GitHub Token',
    destructive: true,
    steps: (params) => [{
      id: 'token', title: '写入钥匙串',
      run: async (ctx) => {
        const username = String(params.username || '').trim();
        const token = String(params.token || '');
        if (!username) throw new AppError(ERR.PARSE_FAILED, '未提供用户名');
        if (!token) throw new AppError(ERR.PARSE_FAILED, '未提供 Token');

        const exists = await git.credentialExists();
        ctx.log('info', exists ? '检测到已有 GitHub 凭据，将覆盖' : '未检测到凭据，将新建');
        ctx.log('info', `目标用户名：${username}（Token 不回显、不记录）`);

        // git credential-osxkeychain store：Token 经 stdin 传入，绝不写入日志/文件
        const res = await git.storeCredential(username, token);
        if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, '写入钥匙串失败', res.stderr.trim());
        ctx.log('ok', 'GitHub Token 已写入 macOS 钥匙串（仅钥匙串，无任何落盘）');
      },
    }],
  },

  /** 保存代理端口（非危险；不自动改 Git 代理，只回提示） */
  set_proxy_ports: {
    title: '保存代理端口',
    destructive: false,
    steps: (params) => [{
      id: 'save_ports', title: '保存代理端口',
      run: async (ctx) => {
        const cur = store.readBrewgo();
        // 非纯数字输入一律忽略、保持原值
        const httpPort = /^[0-9]+$/.test(String(params.httpPort)) ? Number(params.httpPort) : cur.httpPort;
        const socks5Port = /^[0-9]+$/.test(String(params.socksPort)) ? Number(params.socksPort) : cur.socksPort;
        // 不传 mirror：本次只改端口，MIRROR 行原样保留（含自定义的枚举外镜像）
        store.writeBrewgo({ httpPort, socksPort: socks5Port });
        ctx.log('ok', `已保存到 ~/.brewgo_config：HTTP=${httpPort}, SOCKS5=${socks5Port}`);
        // 不自动改 Git 代理，仅提示
        const gp = await git.config('http.proxy');
        const want = `http://127.0.0.1:${httpPort}`;
        if (gp && gp !== want) {
          ctx.log('warn', `Git 全局代理仍为 ${gp}，如需同步请在「系统初始化 → Git 全局配置」中修改`);
        } else if (!gp) {
          ctx.log('info', `Git 全局代理未设置；如需使用请在「系统初始化 → Git 全局配置」中设为 ${want}`);
        }
      },
    }],
  },
};

export default {
  id: 'sysinit',
  actions,
  queries: {
    state: queryState,
    aliasPreview: queryAliasPreview,
  },
};
