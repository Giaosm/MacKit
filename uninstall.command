#!/bin/bash
# ============================================================================
#  MacKit · 卸载脚本（双击运行）—— install.command 的逆操作
#
#  做这些事：
#    1. 停掉正在运行的后台服务（POST /api/shutdown 优雅退出 → 兜底 SIGTERM/SIGKILL）
#    2. 删掉安装时生成的 .app 外壳（/Applications 与 ~/Applications 两处都查）
#    3. 询问是否连 ~/.mackit/ 一起删（默认保留 —— 里面有配置与 WebDAV 凭据）
#
#  边界（重要）：
#    - **不删程序目录**：那是你自己克隆下来的文件夹，不属于「安装」的产物。
#    - **不删** ~/.brewgo_config（代理端口 / 镜像源，与旧脚本共用）、
#      shell 配置里的别名与 brew shellenv、钥匙串里的 GitHub 凭据
#      —— 这些是功能写入的，不是安装产物，脚本末尾会列出让你自行决定。
#    - 删外壳前先验明正身（CFBundleIdentifier + repo-path 双重校验），
#      避免同名 app 被误删。
#
#  幂等：外壳不存在时只是提示，不会报错。
#
#  ★ 书写纪律：本文件所有变量引用一律写成 ${VAR} 花括号形式。
#    中文标点（，。）紧跟变量名时，bash 在某些 locale 下会把全角字符的首字节
#    当成标识符字符，于是 `$MACKIT_DIR，` 被解析成变量 `$MACKIT_DIR，` 而报
#    unbound variable。加花括号可彻底规避。
# ============================================================================

set -u
# 说明：本脚本与 install.command 之间有几段逐字相同的代码（bundle id 校验、LSREGISTER 路径、
# 图标缓存清理、runtime.json 读取）。这是**有意**的：两个双击脚本必须各自独立可跑，
# 不 source 任何外部文件（历史上曾因外部依赖缺失而无法卸载）。改动其一请同步另一个。


SYSTEM_APPS="/Applications"
EXPECT_BUNDLE_ID="local.mackit.launcher"
MACKIT_DIR="${HOME}/.mackit"
RUNTIME_JSON="${MACKIT_DIR}/runtime.json"

# 候选位置：现行版本装 /Applications，早期版本装在 ~/Applications（换过位置）。
# 用换行分隔而非数组：bash 3.2 下空数组配 set -u 会报 unbound。
CANDIDATES="${SYSTEM_APPS}/MacKit.app
${HOME}/Applications/MacKit.app"

die() {
  echo ""
  echo "❌ ${1}"
  echo ""
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
}

# 判断某个 .app 是不是 install.command 装出来的（避免误删同名软件）
is_mackit_bundle() {
  [ -f "${1}/Contents/Resources/repo-path" ] \
    && [ "$(plutil -extract CFBundleIdentifier raw -o - "${1}/Contents/Info.plist" 2>/dev/null)" = "${EXPECT_BUNDLE_ID}" ]
}

# ------------------------------ 1. 停止后台服务 ------------------------------
read_runtime_field() {  # ${1} = 数字字段名
  [ -f "${RUNTIME_JSON}" ] || return 0
  sed -n "s/.*\"${1}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "${RUNTIME_JSON}" | head -n 1
}

alive() {  # ${1} = 端口
  [ -n "${1}" ] && curl -sf --max-time 1 "http://127.0.0.1:${1}/api/health" >/dev/null 2>&1
}

PORT="$(read_runtime_field port)"
PID="$(read_runtime_field pid)"

if alive "${PORT}"; then
  echo "→ 正在停止后台服务（端口 ${PORT}）…"
  # 优雅退出：取消运行中任务 → 关 SSE → 关服务 → 删 runtime.json
  curl -sf --max-time 3 -X POST "http://127.0.0.1:${PORT}/api/shutdown" >/dev/null 2>&1 || true
  i=0
  while [ "${i}" -lt 30 ]; do   # 3s
    alive "${PORT}" || break
    sleep 0.1
    i=$((i + 1))
  done

  # 兜底：优雅退出没生效时才动 kill。先确认这个 pid 确实是 node，
  # 否则 pid 可能已被系统复用给别的进程（杀错比杀不掉更糟）。
  if alive "${PORT}" && [ -n "${PID}" ] && ps -p "${PID}" -o command= 2>/dev/null | grep -q 'node'; then
    echo "　优雅退出超时，改为终止进程 ${PID}…"
    kill -TERM "${PID}" 2>/dev/null || true
    sleep 1
    alive "${PORT}" && kill -9 "${PID}" 2>/dev/null || true
  fi

  if alive "${PORT}"; then
    echo "　⚠️ 服务似乎仍在运行（端口 ${PORT}），可稍后手动检查：lsof -i :${PORT}"
  else
    echo "　服务已停止。"
  fi
else
  echo "→ 后台服务未在运行，跳过。"
fi

# 服务已停（或本来就没跑）就清掉运行态残留；仍在跑则保留，免得启动器找不到实例再拉一个。
if ! alive "${PORT}"; then
  rm -f "${RUNTIME_JSON}"
fi

# ------------------------ 2. 找出本脚本装过的外壳 ------------------------
# 先只做校验、不删：万一两个位置都没有或校验不过，后面的删除环节就是空转。
TARGETS=""
while IFS= read -r path; do
  [ -n "${path}" ] || continue
  [ -e "${path}" ] || continue
  if is_mackit_bundle "${path}"; then
    TARGETS="${TARGETS}${path}
"
  else
    echo "⚠️ ${path} 看起来不是本脚本安装的（校验未通过），已为你保留。"
    echo "   若确是你手动创建的，请自己确认后再删除。"
  fi
done <<CANDIDATES
${CANDIDATES}
CANDIDATES

# ------------------------------ 3. 删除外壳 ------------------------------
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [ -z "${TARGETS}" ]; then
  echo "→ 未发现本脚本安装的外壳（未安装或已删除），跳过。"
else
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    # 先注销再删，免得启动台 / Dock 留着已经消失的条目
    [ -x "${LSREGISTER}" ] && "${LSREGISTER}" -u "${path}" >/dev/null 2>&1 || true
    if rm -rf "${path}" 2>/dev/null; then
      echo "→ 已删除外壳：${path}"
    else
      echo "⚠️ 删除失败：${path}（属主可能是 root）—— 请手动执行 sudo rm -rf '${path}'"
    fi
  done <<TARGETS
${TARGETS}
TARGETS

  # 催一下 Finder / 启动台刷新，并清掉用户级图标缓存（会自动重建）
  touch "${SYSTEM_APPS}" 2>/dev/null || true
  if [ -d "${HOME}/Applications" ]; then
    touch "${HOME}/Applications" 2>/dev/null || true
  fi
  # 用 find 而不是裸通配符 —— 无匹配时通配符会把字面量原样传给 rm（虽被吞掉但不干净）。
  find "${HOME}/Library/Caches" -maxdepth 1 -name 'com.apple.iconservices*' -exec rm -rf {} + 2>/dev/null || true
  killall iconservicesagent 2>/dev/null || true
fi

# ------------------------------ 4. 询问是否删除运行数据 ------------------------------
if [ -d "${MACKIT_DIR}" ]; then
  echo ""
  echo "运行数据在 ${MACKIT_DIR}，包含：配置、任务日志与历史、环境探测缓存、"
  echo "WebDAV 备份凭据（明文，权限 600）。"
  printf '连这些数据一起删除吗？[y/N] '
  read -r ANSWER || ANSWER=""
  case "${ANSWER}" in
    y|Y|yes|YES)
      rm -rf "${MACKIT_DIR}" && echo "→ 已删除 ${MACKIT_DIR}" ;;
    *)
      echo "→ 已保留 ${MACKIT_DIR}（重新安装后会接着用）" ;;
  esac
fi

# ------------------------------ 5. 收尾说明 ------------------------------
echo ""
echo "✅ 卸载完成"
echo ""
echo "   还留在系统里的东西（都是功能写入的，不是安装产物，按需自行处理）："
echo "   · 程序目录本身 —— 你克隆下来的文件夹，直接删即可"
echo "   · shell 配置里的别名与 brew shellenv（~/.zshrc / ~/.zprofile / ~/.bash_profile）"
echo "   · 钥匙串里的 GitHub 凭据（钥匙串访问 → 搜 github.com）"
echo "   · ~/.brewgo_config（代理端口 / 镜像源，与旧脚本共用）"
echo ""
echo "   如果之前把 MacKit.app 拖进过 Dock，图标会失效，右键「从程序坞中移除」即可。"
echo "   想装回来：双击仓库里的 install.command。"
echo ""

echo "按回车键关闭…"
read -r _ || true
exit 0
