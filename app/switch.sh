#!/bin/bash
# 在「NapCat 模式」和「我自己的 QQ」之间切换。
#
#   ./switch.sh qq       停掉 NapCat，打开原版 QQ（登你自己的号、传文件）
#   ./switch.sh napcat   关掉 QQ，启动 NapCat + 陪伴体
#   ./switch.sh status   看现在是哪个模式
#
# 为什么需要切换：QQ.app 的数据目录被 macOS 沙箱固定成
# ~/Library/Containers/com.tencent.qq，NapCat 和原版 QQ 共用它。
# 两个 Electron 实例同时用同一份数据会互相干扰，甚至踢掉登录态。

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

NODE="${DSH_NODE:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node}"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi

napcat_running() { pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; }
bot_running()    { pgrep -f "src/bot.js" >/dev/null 2>&1; }

# 判断当前 QQ 进程是不是 NapCat 模式（看有没有 --no-sandbox）
qq_is_napcat() {
  ps aux 2>/dev/null | grep "QQ.app/Contents/MacOS/QQ" | grep -v grep | grep -q -- "--no-sandbox"
}

ACTION="${1:-status}"

case "$ACTION" in

  # ── 切到我自己的 QQ ──
  qq)
    echo
    echo "═══ 切换到原版 QQ ═══"
    echo

    if bot_running; then
      pkill -f "src/bot.js" 2>/dev/null
      sleep 2
      echo "${G}✓${N} 陪伴体已停止"
    else
      echo "${D}·${N} 陪伴体本来就没跑"
    fi

    if napcat_running; then
      echo "${D}·${N} 关闭 NapCat（会退出小号登录，下次自动登录）"
      osascript -e 'quit app "QQ"' 2>/dev/null
      sleep 3
      if napcat_running; then
        pkill -f "QQ.app/Contents/MacOS/QQ" 2>/dev/null
        sleep 2
      fi
      echo "${G}✓${N} NapCat 已关闭"
    fi

    # 等端口释放，避免新实例撞上残留
    for i in $(seq 1 15); do
      lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done

    echo
    echo "${D}·${N} 打开原版 QQ…"
    open -a QQ
    echo
    echo "${G}✓ 现在可以登录你自己的号了${N}"
    echo "${D}  传完文件、用完了，跑 ./switch.sh napcat 切回来${N}"
    echo
    ;;

  # ── 切回 NapCat ──
  napcat)
    echo
    echo "═══ 切换到 NapCat ═══"
    echo

    # 先关 QQ（不管哪种模式）
    if napcat_running; then
      if qq_is_napcat; then
        echo "${D}·${N} NapCat 已经在跑，重启一下确保干净"
      else
        echo "${D}·${N} 关闭原版 QQ"
      fi
      osascript -e 'quit app "QQ"' 2>/dev/null
      sleep 3
      if napcat_running; then
        pkill -f "QQ.app/Contents/MacOS/QQ" 2>/dev/null
        sleep 2
      fi
    fi

    for i in $(seq 1 15); do
      lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done

    echo
    echo "${D}·${N} 交给 start.sh 启动…"
    echo
    exec "$HERE/start.sh"
    ;;

  # ── 看状态 ──
  status)
    echo
    echo "═══ 当前状态 ═══"
    echo

    if ! napcat_running; then
      echo "  QQ      : ${D}未运行${N}"
      echo "  陪伴体  : $(bot_running && echo "${G}运行中${N}" || echo "${D}未运行${N}")"
      echo
      echo "  ${D}启动陪伴体：./start.sh${N}"
      echo "  ${D}用你自己的 QQ：open -a QQ${N}"
      echo
      exit 0
    fi

    if qq_is_napcat; then
      echo "  QQ      : ${G}NapCat 模式${N}（无窗口，小号在后台）"
    else
      echo "  QQ      : ${Y}原版 QQ 模式${N}（你自己的号）"
    fi
    echo "  陪伴体  : $(bot_running && echo "${G}运行中${N}" || echo "${D}未运行${N}")"

    # 小号登录情况
    if lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  OneBot  : ${G}端口 3002 已监听${N}"
    else
      echo "  OneBot  : ${D}端口 3002 未监听（小号可能没登录）${N}"
    fi

    # 主人号
    if [ -f "$HERE/config.json" ] && [ -x "$NODE" ]; then
      OWNER=$("$NODE" -e 'const c=require(process.argv[1]);process.stdout.write((c.allowlist||[]).join(","))' "$HERE/config.json" 2>/dev/null)
      [ -n "$OWNER" ] && echo "  白名单  : $OWNER"
    fi

    echo
    if qq_is_napcat; then
      echo "  ${D}想用你自己的号传文件：./switch.sh qq${N}"
    else
      echo "  ${D}想让她上线：./switch.sh napcat${N}"
    fi
    echo
    ;;

  *)
    echo
    echo "用法："
    echo "  ./switch.sh qq       停 NapCat，开原版 QQ"
    echo "  ./switch.sh napcat   关 QQ，启动 NapCat + 陪伴体"
    echo "  ./switch.sh status   看当前状态"
    echo
    exit 1
    ;;
esac
