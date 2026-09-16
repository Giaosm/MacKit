#!/bin/bash
# ============================================================================
#  MacKit · 双击启动器
#
#  职责（依据《MacKit-架构设计.md》§3.14）：
#    1. 定位 node 可执行文件（优先 /opt/homebrew/bin/node）
#    2. 若服务已在运行（runtime.json + /api/health 通）→ 直接开浏览器并退出
#    3. 否则后台拉起 server.js（重定向到 ~/.mackit/server.out）
#    4. 轮询 runtime.json 拿到实际端口（最长 5s）
#    5. open http://127.0.0.1:<实际端口>
#    6. 退出（终端窗口随干净退出关闭，不常驻）
#
#  说明：本脚本只负责启动与打开浏览器，不做任何业务逻辑。
# ============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

MACKIT_DIR="$HOME/.mackit"
RUNTIME_JSON="$MACKIT_DIR/runtime.json"
SERVER_OUT="$MACKIT_DIR/server.out"
SERVER_JS="$SCRIPT_DIR/server.js"

mkdir -p "$MACKIT_DIR"

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
    open "http://127.0.0.1:${EXISTING_PORT}"
    exit 0
  fi
  # 端口有记录但服务已死 → 清理过期运行态
  rm -f "$RUNTIME_JSON"
fi

# ------------------------------ 3. 后台拉起服务 ------------------------------
# 删除旧运行态，避免读到上一次的端口
rm -f "$RUNTIME_JSON"

nohup "$NODE_BIN" "$SERVER_JS" >> "$SERVER_OUT" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

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

# ------------------------------ 5. 打开浏览器 ------------------------------
open "http://127.0.0.1:${PORT}"

# ------------------------------ 6. 退出 ------------------------------
exit 0
