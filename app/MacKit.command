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

# ------------------------------ 3. 后台拉起服务 ------------------------------
# 删除旧运行态，避免读到上一次的端口
rm -f "$RUNTIME_JSON"

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
  # 若进程已退出，直接失败
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
  echo "❌ 等待服务端口超时（5s），请查看日志：$SERVER_OUT"
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
fi

# ------------------------------ 5. 打开界面 ------------------------------
open_ui "http://127.0.0.1:${PORT}"

# ------------------------------ 6. 退出 ------------------------------
exit 0
