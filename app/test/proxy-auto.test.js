/**
 * 代理端口自动切换单测（lib/proxy-auto.js 的纯逻辑 + 本机 socket 探测）。
 *
 * 锁住三件事：
 *   1. **端口知识只有一份**：界面预设必须都在探测候选里，否则会出现「界面让你切到 10808，
 *      自动探测却从不试它」；
 *   2. 「用哪个端口」的判断（effectivePorts）在未探测时如实回落到配置值，不会凭空改道；
 *   3. reset() 后状态确实是空的（保存端口后必须重探，不能复用旧结论）。
 *
 * 真实握手探测（HTTP CONNECT / SOCKS5）需要外网代理，不在这里覆盖；这里只覆盖
 * 「TCP 可达性」这一层 —— 它正是 env 体检提示用的那个。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import * as proxyAuto from '../lib/proxy-auto.js';
import * as paths from '../lib/paths.js';
import * as store from '../lib/store.js';
import { expectedAliasLines } from '../lib/env.js';

test('界面预设的端口必须都在自动探测候选里', () => {
  assert.ok(proxyAuto.PORT_PRESETS.length > 0);
  for (const p of proxyAuto.PORT_PRESETS) {
    assert.ok(proxyAuto.FALLBACK_PORTS.includes(p.http), `${p.label} 的 HTTP 端口 ${p.http} 不在 FALLBACK_PORTS`);
    assert.ok(proxyAuto.FALLBACK_PORTS.includes(p.socks), `${p.label} 的 SOCKS5 端口 ${p.socks} 不在 FALLBACK_PORTS`);
  }
});

test('候选端口无重复且合法', () => {
  assert.equal(new Set(proxyAuto.FALLBACK_PORTS).size, proxyAuto.FALLBACK_PORTS.length);
  for (const p of proxyAuto.FALLBACK_PORTS) assert.ok(store.isValidPort(p), `${p} 不是合法端口`);
});

test('effectivePorts：未探测时如实回落到配置值', () => {
  proxyAuto.reset();
  const cfg = { httpPort: 7897, socksPort: 7890 };
  assert.deepEqual(proxyAuto.effectivePorts(cfg), {
    httpPort: 7897, socksPort: 7890, scheme: 'http', switched: false, ok: false,
  });
});

test('reset() 后状态为空（不得复用旧结论）', () => {
  proxyAuto.reset();
  const s = proxyAuto.current();
  assert.equal(s.at, 0);
  assert.equal(s.ok, false);
  assert.equal(s.switched, false);
  assert.equal(s.port, 0);
});

test('只回「200 已建立」但隧道不通的端口，不算可用代理', async () => {
  // 复刻实测现场：代理客户端进程还在、端口 accept，上游节点已断 ——
  // 它对 CONNECT 照样回 200，然后立刻 reset。只看状态码会误判成可用。
  const server = net.createServer((sock) => {
    sock.on('error', () => { /* 关闭时的 ECONNRESET 忽略 */ });
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
      sock.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await proxyAuto.probePort(port), null);
  await new Promise((resolve) => server.close(resolve));
});

test('只监听不说话（不是代理协议）的端口，也不算可用代理', async () => {
  const server = net.createServer((sock) => { sock.on('error', () => { /* ignore */ }); });  // 不回任何字节
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await proxyAuto.probePort(port), null);
  await new Promise((resolve) => server.close(resolve));
});

test('tcpReachable：监听中的端口 true，关掉后 false', async () => {
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await proxyAuto.tcpReachable(port, 400), true);

  await new Promise((resolve) => server.close(resolve));
  assert.equal(await proxyAuto.tcpReachable(port, 400), false);
});

test('proxyUrl：默认 http，socks5h/socks5 按协议拼接，非法 scheme 回落 http', () => {
  assert.equal(paths.proxyUrl(7897), 'http://127.0.0.1:7897');
  assert.equal(paths.proxyUrl(10808, 'socks5h'), 'socks5h://127.0.0.1:10808');
  assert.equal(paths.proxyUrl(10808, 'socks5'), 'socks5://127.0.0.1:10808');
  assert.equal(paths.proxyUrl(10808, 'ftp'), 'http://127.0.0.1:10808');
});

test('别名里的代理 URL 与通道注入同源', () => {
  const lines = expectedAliasLines(7897);
  assert.ok(lines[1].includes(`http_proxy=${paths.proxyUrl(7897)}`), lines[1]);
  assert.ok(lines[1].includes(`https_proxy=${paths.proxyUrl(7897)}`), lines[1]);
});

test('isValidPort：只认 1–65535 的纯数字', () => {
  for (const ok of ['1', '7897', '65535', 7897]) assert.equal(store.isValidPort(ok), true, String(ok));
  for (const bad of ['0', '65536', '99999', '8080.0', '-1', '12a', '', null, undefined, '  ']) {
    assert.equal(store.isValidPort(bad), false, String(bad));
  }
});
