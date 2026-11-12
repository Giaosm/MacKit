/**
 * MacKit · 代理端口自动切换（2026-11-12）
 *
 * 问题：`~/.brewgo_config` 里只有一组端口（默认 7897）。用户换代理客户端后（Clash 7897 →
 * v2rayN 10808），MacKit 的代理通道就整条不通，而界面上只显示「🔴 不可达」——用户得自己去
 * 猜端口、改配置、再回来。这里让它在**配置端口不通时自动挑一个真能用的**，无需人工切换。
 *
 * 判定「能用」不是只看端口有没有人监听（监听着的东西可能是别的服务），而是真的通过它建一条
 * 隧道：向 `www.google.com:443` 发 **HTTP CONNECT**（拿到 200 才算 HTTP 代理），
 * 失败再试 **SOCKS5 握手**（成功则这个端口是纯 SOCKS5 代理，对应 `socks5h://`）。
 * 两种都失败 → 该端口记为不可用。
 *
 * ★ 顺序永远「配置端口优先」：配置可用时行为与之前完全一致，不会凭空改道。
 * ★ 只改**本进程内**的生效端口，不写 `~/.brewgo_config` —— 那是用户与 brewgo 共用的配置，
 *   静默改写会影响命令行里的 brewgo。界面上会如实显示「当前实际走哪个端口」。
 * ★ 结果缓存 {@link TTL_MS}：避免每条命令都探一遍；配置变更（端口数字变了）会强制重探。
 *
 * ★★ 本文件是「本机代理端口」的**唯一事实源**（2026-11-12 收敛）：
 *   - {@link FALLBACK_PORTS}：探测候选。env 的体检提示、界面预设都读它，不再各自维护一份；
 *   - {@link PORT_PRESETS}：④ 代理端口卡的「常用组合」（由 sysinit.state 下发给前端渲染）；
 *   - {@link effectivePorts}：「用哪个端口 + 用什么协议」的唯一判断（env 快照与 exec 共用）；
 *   - {@link tcpReachable}：纯 TCP 可达性探测（env 的 availablePorts 提示用）；
 *   - 代理 URL 的拼接统一走 {@link paths.proxyUrl}，本文件不手拼 `http://host:port`。
 */

import net from 'node:net';

import * as paths from './paths.js';
import * as store from './store.js';

/** 常见代理客户端端口（顺序即优先级，排在配置端口之后）。 */
export const FALLBACK_PORTS = Object.freeze([7897, 7890, 10808, 10809, 1080, 8889, 6152, 6153]);

/**
 * 「常用组合」预设：只填输入框，**不自动保存** —— 端口是全局生效的配置，
 * 静默改掉会让用户在不知情的情况下把所有联网动作切到另一个代理上。
 *
 * 10808：v2rayN / v2rayU 等客户端的默认端口，新一代客户端多为「混合端口」
 * （HTTP 与 SOCKS5 都在这一个口上，实测 curl 用 http:// 与 socks5h:// 都能通）；
 * 也有的客户端把 HTTP 放 10809、SOCKS5 放 10808，于是给了两个预设。
 *
 * 这里的端口必须都在 {@link FALLBACK_PORTS} 内（test/proxy-auto.test.js 有用例守着），
 * 否则会出现「提示切到这个口能通、自动探测却从不试它」。
 */
export const PORT_PRESETS = Object.freeze([
  { id: 'clash-7897', label: 'Clash 7897', http: 7897, socks: 7897, title: 'Clash / Mihomo / Clash Verge 默认混合端口' },
  { id: 'v2rayn-10808', label: 'v2rayN 10808', http: 10808, socks: 10808, title: 'v2rayN / v2rayU 默认端口（混合端口：HTTP 与 SOCKS5 同口）' },
  { id: 'v2rayn-10809-10808', label: 'v2rayN 10809 + 10808', http: 10809, socks: 10808, title: 'HTTP 与 SOCKS5 分开的客户端：HTTP 10809、SOCKS5 10808' },
  { id: 'socks5-1080', label: '通用 SOCKS5 1080', http: 1080, socks: 1080, title: 'ss-local / 通用 SOCKS5 客户端默认端口' },
]);

/** 复用探测结果的时间窗口。 */
const TTL_MS = 30_000;
/** 单端口单协议探测超时。 */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * 空状态（探测前的初值，也是 reset() 的结果）。
 * @returns {{at:number, port:number, scheme:'http'|'socks5h', configured:number, switched:boolean, ok:boolean}}
 */
function emptyState() {
  return { at: 0, port: 0, scheme: 'http', configured: 0, switched: false, ok: false };
}

/**
 * 当前生效状态。
 * @type {{at:number, port:number, scheme:'http'|'socks5h', configured:number, switched:boolean, ok:boolean}}
 */
let state = emptyState();
/** 正在进行的探测（并发去重，见 ensure）。 */
let inflight = null;
/** 作废代次：reset() 递增，用于丢弃「配置已改但结果还在飞」的过期探测（与 env.js 同款用法）。 */
let generation = 0;

/**
 * 建一条到本机代理端口的连接，连上后交给 `onConnect` 做协议交互。
 *
 * ★ 三种探测（HTTP CONNECT / SOCKS5 握手 / 纯 TCP 可达）原先各写一份
 *   `net.connect` + settled 标志 + destroy + setTimeout 的骨架，收敛到这里。
 * ★ 必须同时监听 `close`：纯 SOCKS5 端口收到 HTTP 报文通常直接关连接，只等 `error`
 *   或超时的话会白等满 {@link PROBE_TIMEOUT_MS}。
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @param {(sock: import('node:net').Socket, done: (ok:boolean)=>void) => void} onConnect
 * @returns {Promise<boolean>} 连接成功且 `done(true)` 才算 true
 */
function withSocket(port, timeoutMs, onConnect) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: paths.PROXY_HOST, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('error', () => done(false));
    sock.once('close', () => done(false));
    sock.once('connect', () => onConnect(sock, done));
  });
}

/**
 * 用 HTTP CONNECT 探一次：能拿到 200 说明该端口能当 HTTP 代理。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeHttpProxy(port) {
  return withSocket(port, PROBE_TIMEOUT_MS, (sock, done) => {
    let buf = '';
    sock.write('CONNECT www.google.com:443 HTTP/1.1\r\nHost: www.google.com:443\r\nProxy-Connection: keep-alive\r\n\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      done(/^HTTP\/1\.[01] 200/i.test(buf.slice(0, nl)));
    });
  });
}

/**
 * 用最小 SOCKS5 握手（无认证）探一次：`05 01 00` → `05 00` → CONNECT 到 google:443 → `05 00`。
 * 成功说明该端口是纯 SOCKS5 代理（只能用 socks5h:// 访问）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeSocksProxy(port) {
  return withSocket(port, PROBE_TIMEOUT_MS, (sock, done) => {
    const host = Buffer.from('www.google.com');
    let buf = Buffer.alloc(0);
    let stage = 0;
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) { done(false); return; }
        buf = buf.subarray(2);
        stage = 1;
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([0x01, 0xbb]),   // 端口 443
        ]));
        return;
      }
      if (buf.length < 2) return;
      done(buf[0] === 0x05 && buf[1] === 0x00);
    });
  });
}

/**
 * 探测单个端口可用的协议。
 *
 * ★ 两种探测**并发**发起，但 **HTTP 优先**：混合端口（Clash 7897 这类）两者都通，
 *   `http://` 对 curl / git 更通用，结果必须是确定的 http 而不是「谁先回算谁」。
 * ★ 早退：HTTP 成功就立刻返回（SOCKS 那一路会在自身的超时/关闭里自行收尾）。
 *
 * @param {number} port
 * @returns {Promise<'http'|'socks5h'|null>}
 */
async function probe(port) {
  const socksP = probeSocksProxy(port);
  if (await probeHttpProxy(port)) return 'http';
  return (await socksP) ? 'socks5h' : null;
}

/**
 * 纯 TCP 可达性（不发任何数据）：端口上「有人在听」≠ 它能当代理。
 * 供 env.networkTest 的 availablePorts 提示使用。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function tcpReachable(port, timeoutMs = 400) {
  return withSocket(port, timeoutMs, (_sock, done) => done(true));
}

/**
 * 确保「当前生效端口」是最新的（TTL 内直接复用）。
 *
 * 端口顺序：配置端口 → {@link FALLBACK_PORTS}。**全都不通时回落到配置端口**（保持原有报错
 * 行为，由上层把「代理不可用」如实告诉用户，而不是随便指一个死端口）。
 *
 * @param {{force?:boolean}} [opts] force=true 忽略 TTL。已有探测在飞时仍复用它 ——
 *   正在算的就是最新结果，再起一轮只会重复开 socket。
 * @returns {Promise<typeof state>}
 */
export async function ensure({ force = false } = {}) {
  const cfg = store.readBrewgo();
  const now = Date.now();
  const fresh = state.at > 0 && now - state.at < TTL_MS && state.configured === cfg.httpPort;
  if (!force && fresh) return state;
  // 并发去重：首屏 env 体检与后台任务的 proxy 通道经常同时触发，没有这层会把同一批端口
  // 重复探一遍（env.js 的 snapshot 有同款 inflight，动机相同）。
  if (inflight) return inflight;
  const p = doProbe(cfg).finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

/**
 * 真正探一轮并写入 state。
 * @param {{httpPort:number}} cfg
 * @returns {Promise<typeof state>}
 */
async function doProbe(cfg) {
  const gen = generation;

  // ★ 配置端口优先且**短路**：先单独探配置端口，通了就到此为止。
  //   此前把配置端口和 8 个候选一起 Promise.all，即使配置正常也要并发开 8 条 TCP、
  //   对着一堆没开代理的本地端口做 CONNECT / SOCKS 握手（其中「有人监听但不是代理」的端口
  //   还要各等满 1.5s 超时）。正常用户每 30s 就白付一次这种开销。
  const configuredScheme = await probe(cfg.httpPort);
  let hit = configuredScheme ? { port: cfg.httpPort, scheme: configuredScheme } : null;
  if (!hit) {
    const cands = FALLBACK_PORTS.filter((p) => p !== cfg.httpPort);
    // 配置端口不通才探候选；results 顺序 = FALLBACK_PORTS 顺序，故 find 取到的就是最优优先级
    const results = await Promise.all(cands.map(async (port) => ({ port, scheme: await probe(port) })));
    hit = results.find((r) => r.scheme) || null;
  }

  // 探测期间配置被改过（reset 提升 generation）→ 这轮结果已过期，不写回
  if (gen !== generation) return state;

  state = {
    at: Date.now(),
    configured: cfg.httpPort,
    port: hit ? hit.port : cfg.httpPort,
    scheme: hit ? /** @type {'http'|'socks5h'} */ (hit.scheme) : 'http',
    switched: !!hit && hit.port !== cfg.httpPort,
    ok: !!hit,
  };
  return state;
}

/** 读取缓存（同步，供 buildEnv 这类同步路径使用）。 */
export function current() {
  return state;
}

/**
 * 「实际生效的代理端口 + 协议」—— **唯一判断点**（env 的体检快照、exec 的通道共用）。
 *
 * 读的是 {@link current} 缓存：同步路径（exec.buildEnv）不能等探测，刷新由 {@link ensure} 负责。
 *
 * @param {{httpPort:number, socksPort:number}} cfg
 * @returns {{httpPort:number, socksPort:number, scheme:'http'|'socks5h', switched:boolean, ok:boolean}}
 */
export function effectivePorts(cfg) {
  if (state.ok && state.switched) {
    // 自动切换后只有一个端口可用（HTTP 与 SOCKS5 都在它身上），协议由探测结果决定
    return { httpPort: state.port, socksPort: state.port, scheme: state.scheme, switched: true, ok: true };
  }
  // 未切换：配置里那一对就是权威值。协议仍取探测结论 —— 配置端口本身可能就是
  // **纯 SOCKS5** 代理（没有 HTTP 入口），写成 http:// 会直接「代理不可达」。
  // 没探到任何可用端口时按 http 语义走（保持原有报错行为，由上层如实报「不可达」）。
  return {
    httpPort: cfg.httpPort,
    socksPort: cfg.socksPort,
    scheme: state.ok ? state.scheme : 'http',
    switched: false,
    ok: state.ok,
  };
}

/** 作废缓存：端口配置被改动后调用，让下一次探测重新开始（含丢弃正在飞的那一次）。 */
export function reset() {
  generation += 1;
  state = emptyState();
  inflight = null;
}
