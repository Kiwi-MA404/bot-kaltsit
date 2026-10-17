#!/bin/bash
# 打开「隐私与安全性 → App 管理」设置页，检查授权状态。
#
# 为什么需要这个：
#   改 /Applications/QQ.app 里的文件会被 macOS 的 App 管理保护拦截，
#   即使 sudo 也会报 EPERM。必须在这里手动允许「终端」。

set -uo pipefail

echo
echo "═══ App 管理授权检查 ═══"
echo

# ── 当前是否已被拦截 ──
# 注意：必须测 QQ.app 内部，不能测 /Applications 根目录。
# 根目录是 drwxrwxr-x root:admin，本来就可写；
# 真正被 App 管理保护挡住的是 app bundle 内部。
APP_DIR="/Applications/QQ.app/Contents/Resources/app"
if [ -d "$APP_DIR" ] && touch "$APP_DIR/.napcat-probe" 2>/dev/null; then
  rm -f "$APP_DIR/.napcat-probe"
  echo "✅ QQ.app 内部可写 —— 权限已经没问题了"
  echo
  echo "直接跑："
  echo "  sudo bash tools/patch.sh"
  echo
  exit 0
fi

echo "❌ QQ.app 内部不可写（被 App 管理保护拦截）"
echo

# ── QQ 入口现状 ──
PKG="/Applications/QQ.app/Contents/Resources/app/package.json"
if [ -f "$PKG" ]; then
  MAIN=$(/usr/bin/python3 -c "import json;print(json.load(open('$PKG'))['main'])" 2>/dev/null \
         || grep -o '"main"[^,]*' "$PKG" 2>/dev/null)
  echo "QQ 当前入口: ${MAIN:-读取失败}"
  echo "（原版是 ./application.asar/app_launcher/index.js）"
  echo
fi

echo "── 需要你做 ──"
echo
echo "  1. 打开 系统设置 → 隐私与安全性 → App 管理"
echo "     （下面会自动帮你打开）"
echo
echo "  2. 把「终端」的开关打开"
echo "     如果列表里没有「终端」，先点一次安装，它会出现在列表里"
echo
echo "  3. 如果还看到「DeepSeek Harness」也在列表里，一起打开（无害）"
echo
echo "  4. 回来后重新跑本窗口里的命令"
echo
read -r -p "按回车打开设置页…" _

open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles" 2>/dev/null \
  || open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles" 2>/dev/null \
  || open -b com.apple.systempreferences 2>/dev/null

echo
echo "设置页已打开。"
echo
echo "授权完成后，回到终端跑这一行验证："
echo
echo "  bash tools/authorize.sh"
echo
echo "看到 ✅ 就说明可以安装了。"
echo
