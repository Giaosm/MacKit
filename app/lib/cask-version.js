/**
 * MacKit · cask 应用版本判定（2026-10-09 从 lib/brew.js 抽出）
 *
 * 为什么单独成文件：这一段（读 .app 真实版本 → 判「是否就是 cask 那一版」→ 探上游版本）
 * 是 Homebrew 管家里最容易出错、也最值得测的逻辑 —— 2026-09-22 的「brew 反向降级」与
 * 2026-10-08 的「升级漏报」两次事故都出在这里。抽出来后 `test/cask-version.test.js`
 * 可以对纯函数直接断言，不必为了验一条比较规则去起整个 brew 模块。
 *
 * 依赖注入：通道策略由调用方传入（brew.js 的 brewPolicy），本文件只保留一个按目标主机判的
 * 兜底实现，避免把「配置从哪读」也一并搬进来（那会让这个文件依赖 store 与用户配置）。
 */
import path from 'node:path';

import * as exec from './exec.js';
import { bareChannel, policyForHost, policyForUrl, resolvePolicy } from './netpolicy.js';
import { compare, parseStrict, samePrefix, sameVersion } from './version.js';

/**
 * 兜底通道策略：URL 按主机名、裸字符串按主机判，再套 brew 模块档位。
 * @param {string} target URL 或主机名
 * @returns {'proxy_first'|'direct_first'}
 */
export function defaultPolicy(target) {
  const auto = typeof target === 'string' && /[:/]/.test(target) ? policyForUrl(target) : policyForHost(target);
  return resolvePolicy('brew', auto);
}

/** 上游版本探测的缓存 TTL：成功 6h。 */
export const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * 探测**失败**（没拿到 tag）时的短 TTL（10min）。
 * 与成功分开：一次代理抖动不该让某应用 6 小时不再参与「上游已有新版本」提示，
 * 但也不能每次刷新都去连环撞墙，10 分钟是二者之间的折中。
 */
export const UPSTREAM_FAIL_TTL_MS = 10 * 60 * 1000;
/** 上游版本缓存：key → { at, tag }。成功 6h / 失败 10min 内不重复联网。 */
const upstreamCache = new Map();

/**
 * 从 cask 的 url 认出 GitHub 仓库（`https://github.com/<owner>/<repo>/releases/...`）。
 * @param {string} url
 * @returns {string|null} 'owner/repo'
 */
export function githubRepoFromCaskUrl(url) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//i.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 读 .app 的真实已装版本：**短版本 + build 号**（CFBundleShortVersionString / CFBundleVersion）。
 * 两个都要，理由见 sameAsCask()。读不到短版本 → null（调用方回退 brew 口径）。
 * @param {string|null} appTarget 形如 /Applications/Clash Verge.app
 * @returns {Promise<{short:string,build:string|null}|null>}
 */
export async function readAppVersion(appTarget) {
  if (!appTarget) return null;
  const plist = path.join(appTarget, 'Contents', 'Info.plist');
  const read = async (key) => {
    try {
      const r = await exec.run('plutil', ['-extract', key, 'raw', '-o', '-', plist],
        { noMirror: true, timeoutMs: 10_000 });
      const v = String(r.stdout || '').trim();
      return r.code === 0 && v ? v : null;
    } catch { return null; }
  };
  const [short, build] = await Promise.all([read('CFBundleShortVersionString'), read('CFBundleVersion')]);
  return short ? { short, build } : null;
}

/**
 * 带**单次查询缓存**的 {@link readAppVersion}。
 * 同一次 queryOutdated 里，同一个 cask 会在 ①「纠偏 brew 假阳性」与 ②「上游探测」两处各问一次；
 * 不缓存就要多跑一倍 plutil（本机 17 个 auto_updates 应用 ≈ 多 34 个子进程）。
 * @param {string|null} appTarget 形如 /Applications/Input Source Pro.app
 * @param {Map<string,Promise<{short:string,build:string|null}|null>>} cache 本次查询内复用
 * @returns {Promise<{short:string,build:string|null}|null>}
 */
export function readAppVersionCached(appTarget, cache) {
  if (!appTarget) return Promise.resolve(null);
  const hit = cache.get(appTarget);
  if (hit) return hit;
  const p = readAppVersion(appTarget);
  cache.set(appTarget, p);
  return p;
}

/**
 * 应用是否**已经就是** cask 记录的那一版 —— 据此剔除 brew 的假阳性（「应用早自更新到位、
 * 只是 brew 记账没跟上」）。
 *
 * ★ 为什么不能只比短版本前缀（2026-09-25 实测踩到，本机 wechat 上翻车）：
 *   cask 版本常把 build / commit 拼在后面，且各家拼法**不止一种**：
 *     · codebuddy-cn：cask `4.12.1.39217423,757a5b2f` —— 应用的 build 被拼在**逗号之前**那一截里；
 *     · wechat      ：cask `4.1.15.22,270102`       —— 应用的 build 就是**逗号之后**那一截。
 *   只比短版本前缀，两者都会被判成「已是最新」；只判「短版本.build 是逗号前那截的前缀」，
 *   则只覆盖得了前一种写法（拼出来的串必然比逗号前那截长 → 主流写法恒判不等）。
 *   所以下面按 A / B / C 三种约定逐条判，任何一条成立才算「已经就是这一版」；
 *   都不成立就**仍然列出**交给 brew 升级（宁可多提，不可漏报 —— 漏报会让用户永远停在旧版）。
 *
 * @param {string} appShort 应用 CFBundleShortVersionString
 * @param {string|null} appBuild 应用 CFBundleVersion
 * @param {string} caskVer cask 的 version（可能形如 `x.y.z,hash`）
 * @returns {boolean}
 */
export function sameAsCask(appShort, appBuild, caskVer) {
  const build = String(appBuild || '').trim();
  const short = String(appShort || '').trim();
  if (!short) return false;
  const [verPart = '', buildPart = ''] = String(caskVer || '').split(',');
  const ver = verPart.trim();
  const buildSeg = buildPart.trim();
  // 约定 A：应用的 build 被拼在**逗号之前**那一截里（codebuddy-cn `4.12.1.39217423,757a5b2f`）
  if (build && build !== short && samePrefix(`${short}.${build}`, ver)) return true;
  // 约定 B：逗号后那一截就是应用的 build（wechat `4.1.15.22,270102`）。
  //   要求「短版本是逗号前那截的前缀」+「build 与逗号后那截完全相等」双条件：
  //   对 wechat 成立、对真落后的旧版本（build 270100 ≠ 270102）不成立 → 不漏报。
  if (buildSeg && build && build === buildSeg && samePrefix(short, ver)) return true;
  // 约定 C：应用没有可用的 build 号（或与短版本相同）→ 只能按短版本判定。两步判，兼顾不误吞与不误报：
  //   ① **前三段相同**即同一版：cask 常把发布号拼在补丁号之后（codebuddy-cn 是
  //      `4.12.1.39217423,757a5b2f`，而应用只有 4.12.1）→ 差异只是 build 元数据。
  //      这条同时覆盖「应用段数更多」（应用其实更新）→ 隐藏即避免降级，方向是安全的。
  //   ② 前三段判不出来（应用如 `1.2` 只有两段、没有补丁号）时，退回 {@link sameVersion}
  //      的**完整相等**判定（容忍尾部补零）→ `1.2` vs `1.2.5` 不相等 → 照常列出升级。
  // 有独立 build 但逗号后为空的情况下刻意**不**判定相等（宁可多提，不可漏报）。
  if (!build || build === short) {
    const a = parseStrict(short);
    const b = parseStrict(ver);
    if (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return true;
    if (sameVersion(short, ver)) return true;
  }
  return false;
}

/**
 * 探上游最新 release tag。
 * ★ 用 GitHub 的 `releases/latest` **302 重定向**取 tag，不走 API —— 不需要 token、没有
 *   60 次/小时的速率限制（本项目此前正是被 API 限流挡住过），且一次往返就够（不 -L 跟随，只读 location）。
 * @param {string} repo 'owner/repo'
 * @param {(target:string) => 'proxy_first'|'direct_first'} [policy] 通道策略（缺省按主机判）
 * @returns {Promise<string|null>} 形如 'v2.5.5'
 */
export async function probeUpstreamTag(repo, policy = defaultPolicy) {
  if (!repo) return null;
  const key = repo.toLowerCase();
  const hit = upstreamCache.get(key);
  if (hit) {
    const ttl = hit.tag ? UPSTREAM_TTL_MS : UPSTREAM_FAIL_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.tag;
  }
  let tag = null;
  try {
    const res = await exec.run('curl',
      ['-s', '-I', '--max-time', '15', `https://github.com/${repo}/releases/latest`],
      { channel: bareChannel(policy('github.com')), noMirror: true, timeoutMs: 20_000 });
    const m = /^location:\s*\S*\/releases\/tag\/([^\s]+)/im.exec(res.stdout || '');
    if (m) tag = decodeURIComponent(m[1].trim());
  } catch { /* 探测失败不影响主列表 */ }
  // 失败也写缓存（tag=null，走 UPSTREAM_FAIL_TTL_MS 的短 TTL），避免每次刷新都打一遍
  upstreamCache.set(key, { at: Date.now(), tag });
  return tag;
}

/**
 * 读 .app 自带的更新源地址（Sparkle 的 `SUFeedURL`）。读不到 = 该应用不用 Sparkle 自更新。
 *
 * ★ 为什么必须支持它（2026-10-08，用户报的 input-source-pro）：很多 cask 的 `url` / `homepage`
 *   都**不是 GitHub**（input-source-pro 走 `inputsource.pro`），而 {@link githubRepoFromCaskUrl}
 *   只认 cask url 里的 github.com —— 于是「cask 自己没跟上上游」这条提示对**整类应用**失效。
 *   而这类应用基本都带 SUFeedURL（homebrew-cask 写 livecheck 用的就是同一个源，可互证）。
 * @param {string|null} appTarget 形如 /Applications/Input Source Pro.app
 * @returns {Promise<string|null>} 形如 https://inputsource.pro/stable/appcast.xml
 */
export async function readAppFeedUrl(appTarget) {
  if (!appTarget) return null;
  const plist = path.join(appTarget, 'Contents', 'Info.plist');
  try {
    const r = await exec.run('plutil', ['-extract', 'SUFeedURL', 'raw', '-o', '-', plist],
      { noMirror: true, timeoutMs: 10_000 });
    const v = String(r.stdout || '').trim();
    return r.code === 0 && /^https?:\/\//i.test(v) ? v : null;
  } catch { return null; }
}

/**
 * 从 Sparkle appcast（XML）里取**最新稳定版**短版本号。
 *
 * 解析口径：
 *   · 只看 `<item>` 块内的 `sparkle:shortVersionString`（属性写法与子元素写法都认）；
 *   · 跳过带 `sparkle:channel` 的 item —— 那是 beta / alpha 等具名通道，Sparkle 默认通道
 *     不会装它们，拿 beta 当「有新版本」会造成误报。
 * 纯函数（只看文本、无副作用）。
 * @param {string} xml
 * @returns {string|null}
 */
export function appcastLatestVersion(xml) {
  let best = null;
  for (const raw of String(xml == null ? '' : xml).split(/<item[\s>]/i).slice(1)) {
    const item = raw.split(/<\/item>/i)[0];
    if (/<sparkle:channel[\s>]/i.test(item)) continue;
    const m = /sparkle:shortVersionString\s*=\s*"([^"]+)"/i.exec(item)
      || /<sparkle:shortVersionString[^>]*>([^<]+)</i.exec(item);
    const v = m ? m[1].trim() : '';
    if (!v) continue;
    if (!best || compare(v, best) > 0) best = v;
  }
  return best;
}

/**
 * 探应用更新源（appcast）里的最新稳定版。缓存与 {@link probeUpstreamTag} 共用
 * （成功 6h / 失败 10min），key 加 `appcast:` 前缀避免撞车。
 *
 * ★ 通道不能只看 feed 的主机（2026-10-08 实测）：`inputsource.pro/stable/appcast.xml` 直连返回的
 *   307 指向 **GitHub release 资产**，而那条腿在国内直连不通 —— 按主机判会走「直连优先」，
 *   于是先白等满 `--max-time` 才换通道（实测让整次「重查可更新项」从 3s 涨到 23s）。
 *   所以先用一次很轻的 HEAD 解析跳转目标，按**最终主机**选通道；HEAD 失败或无 location 时
 *   退回按原主机判。
 * @param {string|null} feedUrl
 * @param {(target:string) => 'proxy_first'|'direct_first'} [policy] 通道策略（缺省按主机判）
 * @returns {Promise<string|null>} 形如 '2.13.1'
 */
export async function probeAppcastLatest(feedUrl, policy = defaultPolicy) {
  if (!feedUrl) return null;
  const key = `appcast:${feedUrl}`;
  const hit = upstreamCache.get(key);
  if (hit) {
    const ttl = hit.tag ? UPSTREAM_TTL_MS : UPSTREAM_FAIL_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.tag;
  }
  let tag = null;
  try {
    // ① 先看跳到哪（HEAD 很轻；不 -L，只读 location 头）
    let p = policy(feedUrl);
    try {
      const head = await exec.run('curl', ['-s', '-I', '--max-time', '8', feedUrl],
        { noMirror: true, timeoutMs: 12_000, channel: bareChannel(p) });
      const loc = /^location:\s*(\S+)/im.exec(head.stdout || '');
      if (loc) p = policy(loc[1].trim());
    } catch { /* HEAD 失败 → 就用按原主机判的策略 */ }
    // ② 按最终目标选通道取正文（仍留「走不通自动换另一条」的兜底）
    const res = await exec.runWithChannel(p, '探测应用更新源', 'curl',
      ['-fsSL', '--compressed', '--max-time', '20', feedUrl],
      { noMirror: true, timeoutMs: 45_000 });
    if (res.code === 0) tag = appcastLatestVersion(res.stdout);
  } catch { /* 探测失败不影响主列表 */ }
  upstreamCache.set(key, { at: Date.now(), tag });
  return tag;
}
