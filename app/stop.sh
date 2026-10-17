#!/bin/bash
# 把陪伴体和 NapCat 都停掉。
#
#   ./stop.sh
#
# 注意：停掉 NapCat 意味着下次启动要重新登录小号。
# 只想停她、保留 NapCat 登录：Ctrl+C 那个终端里的 start.sh 即可。

set -uo pipefail

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; D=""; N=""
fi

echo
echo "═══ 停止陪伴体 ═══"
echo

# ── 陪伴体 ──
if pgrep -f "src/bot.js" >/dev/null 2>&1; then
  pkill -f "src/bot.js" 2>/dev/null
  sleep 2
  if pgrep -f "src/bot.js" >/dev/null 2>&1; then
    echo "${Y}·${N} 陪伴体没停干净，强制结束"
    pkill -9 -f "src/bot.js" 2>/dev/null
    sleep 1
  fi
  echo "${G}✓${N} 陪伴体已停止"
else
  echo "${D}·${N} 陪伴体本来就没在跑"
fi

# ── 询问是否停 NapCat ──
if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
  echo
  echo "NapCat 还在运行。"
  echo "${D}  留着的好处：下次 ./start.sh 不用重新登录小号${N}"
  echo "${D}  停掉的话：下次启动需要扫码登录${N}"
  echo
  read -r -p "要一起停掉 NapCat 吗？[y/N] " ans

  case "$ans" in
    [yY]|[yY][eE][sS])
      osascript -e 'quit app "QQ"' 2>/dev/null
      sleep 3
      if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
        pkill -f "QQ.app/Contents/MacOS/QQ" 2>/dev/null
        sleep 2
      fi
      echo "${G}✓${N} NapCat 已停止"
      ;;
    *)
      echo "${D}·${N} 保留 NapCat 运行"
      ;;
  esac
else
  echo "${D}·${N} NapCat 本来就没在跑"
fi

echo
