#!/bin/bash
# ============================================================================
#  MacKit · 安装脚本（双击运行一次）
#
#  做完这些事：
#    1. 补上可执行位、清掉隔离属性
#       （git clone 会保留权限；GitHub 的 Download ZIP 解压后 x 位会丢、还会带
#         com.apple.quarantine，双击必然打不开）
#    2. 在 /Applications/MacKit.app 生成一个最小的 .app 外壳
#       —— 与其他软件同处一个目录；真不可写才回落到 ~/Applications 并说明原因
#    3. 在外壳里记录本仓库的绝对路径（Contents/Resources/repo-path）
#    4. 把 assets/MacKit.icns 装进外壳，并刷新 LaunchServices 与图标缓存
#    5. 清掉另一处位置遗留的旧副本，避免「启动台里出现两个 MacKit」
#    6. 若程序目录落在 macOS 的受保护目录里（下载 / 桌面 / 文稿 / iCloud），
#       安装后给出明确警告 —— 那里会让 Dock 启动失败，见文件末尾的说明。
#
#  为什么是 .app 外壳而不是直接把 app/MacKit.command 拖进 Dock：
#    - .command 只是脚本，进不了「启动台」，Spotlight 也搜不到名字；
#    - 从 .app 启动没有终端窗口 —— 只有启动失败时才回落到终端显示错误。
#
#  幂等：可以反复运行。先在临时目录把外壳整套建好、最后整体换上，
#        中途失败不会在 /Applications 里留下半个 app。
#
#  ★ 书写纪律：本文件所有变量引用一律写成 ${VAR} 花括号形式。
#    中文标点（，。）紧跟变量名时，bash 在某些 locale 下会把全角字符的首字节
#    当成标识符字符，于是 `$HOME，` 被解析成变量 `$HOME，` 而报 unbound variable。
#    加花括号可彻底规避。
# ============================================================================

set -u
# 说明：本脚本与 uninstall.command 之间有几段逐字相同的代码（bundle id 校验、LSREGISTER 路径、
# 图标缓存清理、runtime.json 读取）。这是**有意**的：两个双击脚本必须各自独立可跑，
# 不 source 任何外部文件（历史上曾因外部依赖缺失而无法卸载）。改动其一请同步另一个。


SYSTEM_APPS="/Applications"
REPO_DIR="$(cd "$(dirname "${0}")" && pwd)"
LAUNCHER="${REPO_DIR}/app/MacKit.command"
ICON_SRC="${REPO_DIR}/assets/MacKit.icns"
FALLBACK_BUNDLE="${HOME}/Applications/MacKit.app"
EXPECT_BUNDLE_ID="local.mackit.launcher"

die() {
  echo ""
  echo "❌ ${1}"
  echo ""
  echo "按回车键关闭…"
  read -r _ || true
  exit 1
}

# 判断某个 .app 是不是本脚本装出来的（用于「清理旧副本」时避免误删同名软件）
is_mackit_bundle() {
  [ -f "${1}/Contents/Resources/repo-path" ] \
    && [ "$(plutil -extract CFBundleIdentifier raw -o - "${1}/Contents/Info.plist" 2>/dev/null)" = "${EXPECT_BUNDLE_ID}" ]
}

# ------------------------------ 1. 校验仓库完整性 ------------------------------
if [ ! -f "${LAUNCHER}" ]; then
  die "没找到启动器：${LAUNCHER}
   请确认本脚本位于 MacKit 仓库根目录（解压 / 克隆出来就是），且 app/ 目录完整。"
fi

# ------------------------ 2. 修复可执行位与隔离属性 ------------------------
chmod +x "${LAUNCHER}" 2>/dev/null || true
chmod +x "${0}" 2>/dev/null || true
xattr -dr com.apple.quarantine "${REPO_DIR}" 2>/dev/null || true

# ---------------------- 3. 检查是否落在 TCC 受保护目录 ----------------------
# macOS 会拦住「非授权 app」访问这几个目录。我们的 .app 是本地生成的、没签名，
# 从 Dock / 启动台启动时属于"非授权"，于是读不到程序目录里的 server.js，
# 表现就是点图标没反应、或者终端被拉起来闪一下（外壳的失败回退）。
# 这不是能靠改脚本绕开的：只要程序目录在里面，launchd 启动的进程就够不着它。
PROTECTED_DIR=""
case "${REPO_DIR}/" in
  "${HOME}/Downloads/"*)                   PROTECTED_DIR="下载" ;;
  "${HOME}/Desktop/"*)                     PROTECTED_DIR="桌面" ;;
  "${HOME}/Documents/"*)                   PROTECTED_DIR="文稿" ;;
  "${HOME}/Library/Mobile Documents/"*)    PROTECTED_DIR="iCloud 云盘" ;;
esac

# ------------------------------ 4. 选择安装位置 ------------------------------
# 首选 /Applications（和别的软件一样）。macOS 上它是 root:admin + drwxrwxr-x，
# 管理员账号本来就对组可写 —— 所以通常不需要任何授权。
if [ -w "${SYSTEM_APPS}" ]; then
  TARGET="${SYSTEM_APPS}/MacKit.app"
  FALLBACK_NOTE=""
else
  TARGET="${FALLBACK_BUNDLE}"
  FALLBACK_NOTE="yes"
fi

# ------------------------ 5. 先在临时目录把外壳建好 ------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mackit.install.XXXXXX")" || die "无法创建临时目录。"
trap 'rm -rf "${STAGE}"' EXIT
BUNDLE="${STAGE}/MacKit.app"

mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources" || die "无法创建外壳目录。"

# 5.1 仓库路径单独存一个文件：路径里可能有空格 / 中文 / 特殊字符，
#     内插进脚本正文需要转义，存文件则完全规避（$(cat) 会去掉尾部换行）。
printf '%s\n' "${REPO_DIR}" > "${BUNDLE}/Contents/Resources/repo-path"

# 5.2 应用图标：直接拷仓库里的 .icns（由 tools/make-icon.mjs 生成，可重新生成）。
#     缺了只是回落系统默认图标、不影响使用，所以失败只告警不中断。
if [ -f "${ICON_SRC}" ]; then
  cp "${ICON_SRC}" "${BUNDLE}/Contents/Resources/AppIcon.icns" \
    || echo "⚠️ 图标拷贝失败，将使用系统默认图标（不影响使用）"
fi

# 5.3 Info.plist：静态内容，不做任何插值。
#     不设 LSUIElement —— 要保证它在启动台里能被看到；进程秒退，不会常驻 Dock。
cat > "${BUNDLE}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>MacKit</string>
	<key>CFBundleDisplayName</key>
	<string>MacKit</string>
	<key>CFBundleIdentifier</key>
	<string>local.mackit.launcher</string>
	<key>CFBundleExecutable</key>
	<string>MacKit</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

# 5.4 外壳可执行文件：静态内容，路径从 repo-path 读，不内插。
cat > "${BUNDLE}/Contents/MacOS/MacKit" <<'SHELL'
#!/bin/bash
# 由仓库根的 install.command 生成 —— 请勿手改（重跑 install.command 会覆盖）。
#
# 职责：把启动动作转交给仓库里的 app/MacKit.command。
#
# 为什么这里要自己接管输出与退出码：
#   从 LaunchServices 启动（点 Dock / 启动台）时没有终端，启动器写的东西一律看不见，
#   一旦出错，用户只会看到「图标闪一下就没了」，完全无从下手。所以：
#     - 每次执行都追加一行到 ~/.mackit/app-launch.log（含退出码与全部输出）；
#     - 失败时弹系统对话框指出原因，而不是 `open -a Terminal` —— 后者会把 Terminal
#       拉起来并且**常驻 Dock**（窗口关了 app 也不会退），很容易被误读成
#       「程序没退干净」。终端只在连对话框都弹不出来时才作为最后手段。
set -u

CONTENTS_DIR="$(cd "$(dirname "${0}")/.." && pwd)"
REPO_DIR="$(cat "${CONTENTS_DIR}/Resources/repo-path" 2>/dev/null)"
LAUNCHER="${REPO_DIR}/app/MacKit.command"
LAUNCH_LOG="${HOME}/.mackit/app-launch.log"

dialog() {
  # 双引号会截断 AppleScript 字面量，替换成单引号（路径里几乎不会出现）
  local q="'" msg="${1//'"'/${q}}"
  osascript -e "display dialog \"${msg}\" buttons {\"好\"} default button 1 with icon caution with title \"MacKit\"" >/dev/null 2>&1
}

# 统一收尾：记日志 + 出错弹窗（弹不出来才退回终端），然后带着原退出码退出。
finish() {
  local code="${1}" out="${2}" detail="" size=0

  mkdir -p "$(dirname "${LAUNCH_LOG}")" 2>/dev/null || true

  # 日志轮转：超过 1MB 就先归档成 app-launch.log.1（覆盖旧归档）再继续追加，
  # 免得每次启动都往里塞、无限增长。stat 读不到就按 0 处理，不能因此挡了启动。
  if [ -f "${LAUNCH_LOG}" ]; then
    size="$(stat -f%z "${LAUNCH_LOG}" 2>/dev/null || echo 0)"
    if [ "${size:-0}" -gt 1048576 ] 2>/dev/null; then
      mv -f "${LAUNCH_LOG}" "${LAUNCH_LOG}.1" 2>/dev/null || true
    fi
  fi

  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') 退出码=${code} ==="
    if [ -s "${out}" ]; then cat "${out}"; fi
  } >> "${LAUNCH_LOG}" 2>/dev/null || true

  if [ "${code}" -ne 0 ]; then
    if [ -s "${out}" ]; then detail="

$(tail -n 5 "${out}")"; fi
    if ! dialog "MacKit 启动失败（退出码 ${code}）。${detail}

完整日志：${LAUNCH_LOG}"; then
      open -a Terminal "${LAUNCHER}"
    fi
  fi

  if [ -n "${out}" ]; then rm -f "${out}"; fi
  exit "${code}"
}

if [ -z "${REPO_DIR}" ] || [ ! -f "${LAUNCHER}" ]; then
  dialog "找不到 MacKit 程序目录：\n${LAUNCHER}\n\n如果移动过文件夹，请在新位置重新运行 install.command。"
  exit 1
fi

# 仓库被移动 / 拷贝导致权限位丢失时，这里兜一次
if [ ! -x "${LAUNCHER}" ]; then
  chmod +x "${LAUNCHER}" 2>/dev/null || true
fi

# 这里没有 install.command 的 die（本文件是独立脚本），所以失败时直接报错退出。
# 必须检查：mktemp 失败时 OUT 为空，`> ""` 只会静默失败，日志与失败弹窗全都会丢。
OUT="$(mktemp -t mackit-launch)" || { echo "❌ 无法创建临时文件" >&2; exit 1; }
"${LAUNCHER}" > "${OUT}" 2>&1
finish "$?" "${OUT}"
SHELL

chmod +x "${BUNDLE}/Contents/MacOS/MacKit" || die "无法为外壳设置可执行权限。"

# ------------------------------ 6. 换上新外壳 ------------------------------
# ★ 覆盖安装前先确认 ${TARGET} 是本脚本的产物：同一脚本的「清理旧副本」与
#   uninstall.command 都用 is_mackit_bundle（repo-path + CFBundleIdentifier）判定，
#   这里若直接 rm -rf，会把别人的同名 app 静默删掉。
if [ -e "${TARGET}" ] && ! is_mackit_bundle "${TARGET}"; then
  die "安装目标已存在，且不是 MacKit 安装脚本生成的 app，已停止安装以免误删：
   ${TARGET}
   请先手动移走 / 改名该 app（或确认无用后自行删除），再重跑本脚本。"
fi
# 回落目录 ${HOME}/Applications 不一定存在：cp -R 不会自建父目录，必须先建。
mkdir -p "$(dirname "${TARGET}")" || die "无法创建 ${TARGET%/*}"
rm -rf "${TARGET}" || die "无法替换 ${TARGET}（可能被占用，退出后重试）。"
cp -R "${BUNDLE}" "${TARGET}" || die "无法写入 ${TARGET}。"

if [ "${FALLBACK_NOTE}" = "yes" ]; then
  echo "→ 已安装到 ${TARGET}"
  echo "  （${SYSTEM_APPS} 不可写，所以放到了用户目录；启动台 / Spotlight 一样能搜到。）"
else
  echo "→ 已安装到 ${TARGET}"
fi

# ------------------------------ 7. 清理另一处的旧副本 ------------------------------
# 早期版本装在 ~/Applications，换位置后若不清掉，启动台里会出现两个 MacKit。
if [ "${TARGET}" = "${FALLBACK_BUNDLE}" ]; then
  OLD_COPY="${SYSTEM_APPS}/MacKit.app"
else
  OLD_COPY="${FALLBACK_BUNDLE}"
fi
if [ -e "${OLD_COPY}" ]; then
  if is_mackit_bundle "${OLD_COPY}"; then
    if rm -rf "${OLD_COPY}" 2>/dev/null; then
      echo "→ 已清理旧副本：${OLD_COPY}"
    else
      echo "⚠️ 旧副本删除失败（属主可能是 root）：请手动执行 sudo rm -rf '${OLD_COPY}'"
    fi
  else
    echo "⚠️ ${OLD_COPY} 不是本脚本安装的，已保留（请自行确认）"
  fi
fi

# ------------------------------ 8. 刷新系统缓存 ------------------------------
touch "${TARGET}"   # 催一下 Finder / 启动台 / Spotlight 的索引

# 强制重新注册到 LaunchServices：否则「启动台」与图标缓存可能仍记着上一次的样子，
# 典型症状是「明明有图标却显示成白纸」。系统自带工具，失败不影响安装。
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "${TARGET}" >/dev/null 2>&1 || true
fi

# 用户级图标缓存（iconservices）：删掉 + 重启代理即可即时重建，不影响其他操作。
# 用 find 而不是裸通配符 —— 无匹配时通配符会把字面量原样传给 rm（虽被吞掉但不干净）。
find "${HOME}/Library/Caches" -maxdepth 1 -name 'com.apple.iconservices*' -exec rm -rf {} + 2>/dev/null || true
killall iconservicesagent 2>/dev/null || true

# ------------------------------ 9. 自检与提示 ------------------------------
if [ ! -x "${TARGET}/Contents/MacOS/MacKit" ]; then
  die "外壳生成失败：${TARGET}"
fi

echo ""
echo "✅ 安装完成"
echo ""
echo "   应用位置：${TARGET}"
echo "   程序目录：${REPO_DIR}"
echo ""
echo "   打开方式：启动台，或 Spotlight（⌘ + 空格）搜索「MacKit」；"
echo "            也可以把上面那个 app 直接拖进 Dock。"
echo "   （以后移动或改名了程序目录，重跑一次本脚本即可。）"
echo "   （若之前把 MacKit 拖进过 Dock，图标要移除后重新拖才会更新。）"

if [ -n "${PROTECTED_DIR}" ]; then
  echo ""
  echo "   ⚠️ 注意：程序目录在 macOS 的受保护目录（${PROTECTED_DIR}）里"
  echo "      ${REPO_DIR}"
  echo ""
  echo "      从 Dock / 启动台点图标时，系统会拦住 MacKit 读这个目录，"
  echo "      导致启动失败（表现为点一下没反应，或者终端被拉起来闪一下）。"
  echo "      Terminal 里有权限，所以「双击 .command」反而正常 —— 这会掩盖问题。"
  echo ""
  echo "      解决办法：把整个 MacKit 文件夹移到不受保护的位置，例如"
  echo "         mv \"${REPO_DIR}\" \"${HOME}/MacKit\""
  echo "      然后在新位置重新双击一次本脚本。"
fi
echo ""

printf '现在就打开 MacKit？[Y/n] '
read -r ANSWER || ANSWER=""
case "${ANSWER}" in
  ""|y|Y|yes|YES) open "${TARGET}" ;;
esac

exit 0
