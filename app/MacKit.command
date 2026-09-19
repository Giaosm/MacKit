#!/bin/bash
# ============================================================================
#  MacKit · 双击启动器
#
#  职责：
#    1. 定位 node 可执行文件（优先 /opt/homebrew/bin/node）
#    2. 若服务已在运行（runtime.json + /api/health 通）→ 直接把界面调到前台并退出
#    3. 否则后台拉起 server.js（重定向到 ~/.mackit/server.out）
#    4. 轮询 runtime.json 拿到实际端口（最长 5s）
#    5. 把界面调到前台
#    6. 退出（终端窗口随干净退出关闭，不常驻）
#
#  关于「调到前台」：不直接用 `open` —— 那是 Chrome 系浏览器每次新开一个标签页的元凶
#  （从 Dock 反复点图标就会攒出一堆标签，服务其实还是同一个）。实际策略见 app/open-ui.sh：
#  优先聚焦已经打开同一地址的标签，失败再回落 open。这里只做「存在就调用、缺失就 open」的转发。
#
#  说明：本脚本只负责启动与打开界面，不做任何业务逻辑。
# ============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

MACKIT_DIR="$HOME/.mackit"
RUNTIME_JSON="$MACKIT_DIR/runtime.json"
SERVER_OUT="$MACKIT_DIR/server.out"
SERVER_JS="$SCRIPT_DIR/server.js"
OPEN_UI="$SCRIPT_DIR/open-ui.sh"

mkdir -p "$MACKIT_DIR"

# ------------------------------ 打开界面 ------------------------------
# 具体策略在 open-ui.sh 里；那个文件缺失或不可执行时退回最朴素的 open。
open_ui() {
  if [ -x "${OPEN_UI}" ]; then
    "${OPEN_UI}" "${1}"
  else
    open "${1}"
  fi
}

# ------------------------------ 1. 定位 node ------------------------------
# 不写死任何机器的用户名/架构：先试两代 Homebrew 前缀（Apple Silicon / Intel），
# 再回落到 PATH（覆盖 nvm、官网 pkg、自定义安装等）。
NODE_BIN=""
for NODE_CAND in "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
  if [ -x "$NODE_CAND" ]; then
    NODE_BIN="$NODE_CAND"
    break
  fi
done
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 Node.js。请先安装：brew install node"
  echo "   （或从 https://nodejs.org 下载安装后重试）"
  echo ""
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
fi

if [ ! -f "$SERVER_JS" ]; then
  echo "❌ 未找到 server.js：$SERVER_JS"
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
fi

# ------------------------ 从 runtime.json 读取端口 ------------------------
read_port() {
  if [ -f "$RUNTIME_JSON" ]; then
    # 不依赖 jq：用 sed 抽取 "port": <number>
    sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RUNTIME_JSON" | head -n 1
  fi
}

# ------------------------------ 2. 已在运行？ ------------------------------
EXISTING_PORT="$(read_port)"
if [ -n "${EXISTING_PORT}" ]; then
  if curl -sf "http://127.0.0.1:${EXISTING_PORT}/api/health" >/dev/null 2>&1; then
    open_ui "http://127.0.0.1:${EXISTING_PORT}"
    exit 0
  fi
  # 端口有记录但服务已死 → 清理过期运行态
  rm -f "$RUNTIME_JSON"
fi

# ---------------------- 2.1 启动锁（防重复拉起） ----------------------
# 为什么需要：server.js 只在 listening 之后才写 runtime.json（1~2 秒）。
# 这个窗口内再双击一次，上面的检查会误判「未在运行」而再拉起一个 server；
# 第二个撞 EADDRINUSE 后顺延端口并覆盖同一个 runtime.json —— 两个进程同时读写 ~/.mackit。
#
# 用 mkdir 的原子性做锁：成功即持锁，失败说明另一个启动流程正在跑。
# 锁目录里写 pid 与时间戳，pid 确认已死时算陈旧锁（见 take_lock）。
LOCK_DIR="$MACKIT_DIR/start.lock"
LOCK_HELD=""

# 释放锁：只有自己持锁时才删，避免把别人的锁误删。
release_lock() {
  if [ -n "${LOCK_HELD}" ]; then
    rm -rf "${LOCK_DIR}" 2>/dev/null || true
    LOCK_HELD=""
  fi
}
trap release_lock EXIT

# 真正拿锁：mkdir 成功即持锁，并写入 pid / 时间戳（0 = 成功）。
acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    LOCK_HELD="yes"
    printf '%s\n' "$$" > "${LOCK_DIR}/pid" 2>/dev/null || true
    date '+%Y-%m-%d %H:%M:%S' > "${LOCK_DIR}/started-at" 2>/dev/null || true
    return 0
  fi
  return 1
}

# 拿锁：0 = 已持锁；1 = 别人正在启动。
# 陈旧锁自愈的三条规则（宁可多提示一次，也不要误删活跃锁）：
#   · 锁里有 pid 且进程还活着        → 活跃，等
#   · 锁里有 pid 但进程已死          → 陈旧，清掉重试
#   · 锁里没有可读 pid（mkdir 后被 SIGKILL 打断）→ 只有锁目录 mtime 超过 60 秒才当陈旧，
#     否则可能是「刚 mkdir、还没写 pid」的一瞬，删了会放进第二个启动流程
take_lock() {
  acquire_lock && return 0
  local holder
  holder="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  case "${holder}" in
    '')
      if [ -n "$(find "${LOCK_DIR}" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
        rm -rf "${LOCK_DIR}" 2>/dev/null || true
        acquire_lock && return 0
      fi
      return 1
      ;;
    *[!0-9]*) return 1 ;;
  esac
  kill -0 "${holder}" 2>/dev/null && return 1
  rm -rf "${LOCK_DIR}" 2>/dev/null || true
  acquire_lock && return 0
  return 1
}

if ! take_lock; then
  echo "⏳ MacKit 正在启动中，请稍候再双击（若长时间无响应，请查看日志：$SERVER_OUT）"
  exit 0
fi

# 拿到锁后再查一次：覆盖「上面检查完 → 拿锁成功」之间的窗口期。
# 若另一个流程刚好已经起好服务，就直接开界面；锁由 EXIT trap 释放。
LOCK_PORT="$(read_port)"
if [ -n "${LOCK_PORT}" ]; then
  if curl -sf "http://127.0.0.1:${LOCK_PORT}/api/health" >/dev/null 2>&1; then
    open_ui "http://127.0.0.1:${LOCK_PORT}"
    exit 0
  fi
fi

# ------------------------------ 3. 后台拉起服务 ------------------------------
# 删除旧运行态，避免读到上一次的端口
rm -f "$RUNTIME_JSON"

# server.out 轮转：超过 1MB 先归档成 server.out.1（覆盖旧归档），再让新进程追加。
# 放在 spawn 之前 —— helper 是以 "a" 打开这个路径的，先挪走才能从空文件重新写。
if [ -f "$SERVER_OUT" ]; then
  SERVER_OUT_SIZE="$(stat -f%z "$SERVER_OUT" 2>/dev/null || echo 0)"
  if [ "${SERVER_OUT_SIZE:-0}" -gt 1048576 ] 2>/dev/null; then
    mv -f "$SERVER_OUT" "$SERVER_OUT.1" 2>/dev/null || true
  fi
fi

# 用 node 自己 spawn 一个 detached 子进程来起服务。
#   为什么不能直接 `nohup node server.js &`：nohup 只忽略 SIGHUP，进程仍留在当前会话里、
#   仍占着这个终端（ps 的 TTY 列还是 ttys000）—— 连 `</dev/null` 也只能改 fd 0 的指向，
#   改不了「控制终端」（那是会话属性）。而 Terminal 只要看到还有进程挂在这个 tty 上，
#   就不会自动关窗口，表现就是「脚本早就退出了，终端还赖着不走」。
#   detached 会走 setsid()：新会话、无控制终端（实测 TTY 列变成 ??），窗口该关就关。
#   不用 setsid 命令（macOS 没带），也不用 perl / python3（不是本项目的前提依赖）；
#   node 是运行前提，一定在。helper 只负责启动并把 pid 打给外层。
SERVER_PID="$("$NODE_BIN" -e '
  const fs = require("node:fs");
  const { spawn } = require("node:child_process");
  const [outFile, bin, script] = process.argv.slice(1);
  const fd = fs.openSync(outFile, "a");
  const cp = spawn(bin, [script], { detached: true, stdio: ["ignore", fd, fd] });
  cp.unref();
  process.stdout.write(String(cp.pid));
' "$SERVER_OUT" "$NODE_BIN" "$SERVER_JS")"

if [ -z "${SERVER_PID}" ]; then
  echo "❌ MacKit 服务启动失败，请查看日志：$SERVER_OUT"
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
fi

# ------------------------------ 4. 轮询端口 ------------------------------
PORT=""
i=0
while [ "$i" -lt 50 ]; do   # 50 * 0.1s = 5s
  PORT="$(read_port)"
  if [ -n "${PORT}" ]; then
    break
  fi
  # 若进程已退出，直接失败（锁由 EXIT trap 释放）
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "❌ MacKit 服务启动失败，请查看日志：$SERVER_OUT"
    echo "按回车键关闭…"
    read -r _ || true
    exit 1
  fi
  sleep 0.1
  i=$((i + 1))
done

if [ -z "${PORT}" ]; then
  # 超时：端口一直没写出来，但进程可能还活着 —— 必须把它收回来，
  # 否则留下一个没有 runtime.json 的孤儿服务挂在后台。
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  j=0
  while [ "$j" -lt 20 ]; do   # 最多再等 2s
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
    j=$((j + 1))
  done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$RUNTIME_JSON"
  echo "❌ 等待服务端口超时（5s），请查看日志：$SERVER_OUT"
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
fi

# ------------------------------ 5. 打开界面 ------------------------------
open_ui "http://127.0.0.1:${PORT}"

# ------------------------------ 6. 退出 ------------------------------
exit 0
