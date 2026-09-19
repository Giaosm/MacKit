#!/bin/bash
# ============================================================================
#  MacKit · 把界面调到前台（由 MacKit.command 调用，也可单独执行调试）
#
#  用法：
#    open-ui.sh <url>                        正常使用：聚焦已有标签，失败则 open
#    open-ui.sh --print-script <族> <app名>   只打印构造好的 AppleScript（调试/语法校验用）
#
#  为什么需要它：
#    `open <url>` 在 Chrome / Edge 系浏览器上一律新开标签页 —— 从 Dock 反复点图标，
#    标签就一个个攒起来（服务其实是同一个，端口也没变）。Safari 反而会复用，
#    所以「点几次攒几个标签」只在 Chromium 系上出现。
#
#  这里改成：问系统「默认浏览器是谁」→ 用 AppleScript 找**已经打开同一地址**的标签
#    并聚焦它 → **顺手强制刷新一次** → 找不到才新建。Safari 与 Chromium 系的 AppleScript
#    接口不同，各写一份。
#
#  ★ 为什么必须刷新（2026-09-20 踩坑）：界面是原生 JS 多文件、浏览器只在本页加载时取一次。
#    只聚焦不刷新的话，服务端更新后旧标签里跑的还是**旧版界面代码**——用户以为「重新双击
#    图标 = 拿到新界面」，实际什么都没变，排障时极具迷惑性。代价：刷新会丢弃页面内的
#    未提交状态（输入框内容、进行中的搜索展示），换来「每次从图标进入都是最新界面」。
#
#  ★ 为什么脚本是「拼接」出来的而不是写死的 heredoc：
#    AppleScript 里 `tell application <变量>` 在**编译期拿不到该应用的字典**，
#    于是 window / tab / active tab index 这些术语全都解析不了
#    （实测报错 -2740 "A property can't go after this identifier"）。
#    所以浏览器名必须是字面量 —— 只能运行时拼进去。
#
#  兜底原则（重要）：浏览器不支持 / 未获授权 / 识别失败 / 任何意外 →
#    静默回落 `open <url>`，行为与改造前完全一致。绝不因为「想聚焦」而打不开界面。
#
#  关于授权：首次会弹一次「MacKit 想要控制 Google Chrome」的系统自动化授权，
#    点「允许」即可；点「不允许」则此后一直走 open 兜底，功能不受影响只是会新开标签。
#
#  ★ 书写纪律：变量一律 ${VAR} 花括号形式（中文标点紧跟变量名会被 bash 当成标识符字符）。
# ============================================================================

set -u

# ---------------------------- 识别默认浏览器 ----------------------------
# LaunchServices 记录的 https 默认处理器 bundle id；读不到就输出空。
default_browser_id() {
  local plist="${HOME}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"
  [ -f "${plist}" ] || return 0
  # plutil -p 输出里，同一个字典项内 LSHandlerRoleAll 与 LSHandlerURLScheme 相邻：
  # 记住最近一个 RoleAll，遇到 https 就配对输出。（awk 脚本在单引号内，$3 是字段而非 shell 变量。）
  plutil -p "${plist}" 2>/dev/null | awk '
    /"LSHandlerRoleAll"/   { role = $3; gsub(/"/, "", role) }
    /"LSHandlerURLScheme"/ { if ($3 ~ /https/) { print role; exit } }
  '
}

# bundle id → .app 名（如 "Google Chrome"）；找不到输出空。
# 用 LaunchServices 反查而不是写死映射表：换浏览器 / 用 Edge、Brave 等都不用改脚本。
#
# 这里刻意**不用 mdfind**：实测这台机器上 kMDItemCFBundleIdentifier 查不到任何 app
# （Spotlight 索引不全）；而且记录里的大小写（com.google.chrome）与 app 实际值
# （com.google.Chrome）还不一致，精确匹配本来就会漏。
# `path to application id` 走 LaunchServices 解析，上面两种情况都能正确处理。
app_name_of_bundle() {
  local bundle_id="${1}"
  local path
  [ -n "${bundle_id}" ] || return 0
  path="$(osascript -e "POSIX path of (path to application id \"${bundle_id}\")" 2>/dev/null)"
  path="${path%/}"   # 返回形如 /Applications/Google Chrome.app/
  if [ -n "${path}" ]; then
    basename "${path}" .app
  fi
}

# ---------------------------- 构造 AppleScript ----------------------------
# ${1} = safari | chromium，${2} = 浏览器 app 名（会作为字面量内插，见文件头说明）
# 目标 URL 不在这里内插：它由 `osascript - <url>` 经 argv 传入，避免转义风险。
build_applescript() {
  local family="${1}" app="${2}"

  if [ "${family}" = "safari" ]; then
    cat <<SCRIPT
on run argv
  set target to item 1 of argv
  tell application "${app}"
    set wIdx to 0
    set tIdx to 0
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        if (URL of t) starts with target then
          set wIdx to wi
          set tIdx to ti
          exit repeat
        end if
      end repeat
      if wIdx > 0 then exit repeat
    end repeat
    if wIdx > 0 then
      set current tab of window wIdx to tab tIdx of window wIdx
      set index of window wIdx to 1
      set URL of tab tIdx of window wIdx to target
    else
      if (count of windows) is 0 then make new document
      set URL of current tab of front window to target
    end if
    activate
  end tell
end run
SCRIPT
  else
    cat <<SCRIPT
on run argv
  set target to item 1 of argv
  tell application "${app}"
    set wIdx to 0
    set tIdx to 0
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        if (URL of t) starts with target then
          set wIdx to wi
          set tIdx to ti
          exit repeat
        end if
      end repeat
      if wIdx > 0 then exit repeat
    end repeat
    if wIdx > 0 then
      set active tab index of window wIdx to tIdx
      set index of window wIdx to 1
      tell tab tIdx of window wIdx to reload
    else
      if (count of windows) is 0 then make new window
      tell window 1 to make new tab with properties {URL:target}
    end if
    activate
  end tell
end run
SCRIPT
  fi
}

# ---------------------------- 聚焦 / 新建 ----------------------------
# ${1} = safari | chromium，${2} = 浏览器 app 名，${3} = 目标 URL
# 返回 0 表示「已处理妥当」（含新建标签），非 0 表示调用方需要兜底。
focus_existing_tab() {
  local family="${1}" app="${2}" url="${3}"
  local script pid code i

  script="$(build_applescript "${family}" "${app}")"

  # 输出重定向到 /dev/null：别让 osascript 攥着调用方的终端（tty），
  # 否则从终端启动时那个窗口要等它退出才可能关闭。
  osascript - "${url}" <<< "${script}" >/dev/null 2>&1 &
  pid=$!

  # 首次使用会弹「MacKit 想要控制 XXX」的系统授权框，而授权框会**阻塞** osascript。
  # 万一用户没注意到弹窗（或点了忽略），进程就一直挂着、界面也出不来 ——
  # 视觉上就是「点了图标没反应」。所以设个上限，超时按「没处理」处理，由调用方回落 open。
  #
  # 这里用轮询而不是 `( sleep 10; kill ... ) &`：后者 kill 掉的是子 shell，
  # 里面那个 sleep 会变成孤儿继续跑，而且继承着调用方的 tty ——
  # 正是「脚本明明执行完了，终端却迟迟不退」的元凶之一。
  i=0
  while [ "${i}" -lt 100 ]; do        # 100 × 0.1s = 10s
    kill -0 "${pid}" 2>/dev/null || break
    sleep 0.1
    i=$((i + 1))
  done

  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
    return 1
  fi

  wait "${pid}"
  code=$?
  return "${code}"
}

# ------------------------------ 调试入口 ------------------------------
# 只输出脚本正文，供 osacompile 做语法校验（不执行、不触发自动化授权）。
if [ "${1:-}" = "--print-script" ]; then
  if [ "$#" -lt 3 ]; then
    echo "用法：open-ui.sh --print-script <safari|chromium> <浏览器 App 名>" >&2
    exit 2
  fi
  build_applescript "${2}" "${3}"
  exit 0
fi

# ------------------------------ 主流程 ------------------------------
URL="${1:-}"
if [ -z "${URL}" ]; then
  echo "用法：open-ui.sh <url>" >&2
  exit 2
fi

BROWSER_ID="$(default_browser_id)"
BROWSER_APP="$(app_name_of_bundle "${BROWSER_ID}")"

case "${BROWSER_APP}" in
  Safari)                                       FAMILY="safari" ;;
  *Chrome*|*Chromium*|*Edge*|*Brave*|*Vivaldi*) FAMILY="chromium" ;;
  *)                                            FAMILY="" ;;
esac

if [ "${FAMILY}" = "safari" ] && focus_existing_tab "safari" "${BROWSER_APP}" "${URL}"; then
  exit 0
fi

if [ "${FAMILY}" = "chromium" ] && focus_existing_tab "chromium" "${BROWSER_APP}" "${URL}"; then
  exit 0
fi

# 兜底：不支持的浏览器 / 未授权 / 上面任何一步失败 —— 与改造前一致
open "${URL}"
