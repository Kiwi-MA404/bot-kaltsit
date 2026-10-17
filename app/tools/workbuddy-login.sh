#!/bin/bash
# 打开 WorkBuddy CLI 并引导你完成登录。
#
#   ./tools/workbuddy-login.sh
#
# 为什么需要单独登录：
#   WorkBuddy 的**图形界面**和**命令行**各自保存登录态。
#   GUI 登录不会自动同步给 CLI，CLI 需要自己走一次 /login。
#
# 登录一次就够了，之后 test/check-workbuddy.js 应该能通过。

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CLI="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
NODE="${DSH_NODE:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node}"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi

echo
echo "═══ WorkBuddy CLI 登录 ═══"
echo

if [ ! -f "$CLI" ]; then
  echo "${R}✗ 找不到 WorkBuddy CLI：$CLI${N}"
  echo "  确认 WorkBuddy 装在这个位置。"
  exit 1
fi

if [ ! -x "$NODE" ]; then
  echo "${R}✗ 找不到 node：$NODE${N}"
  echo "  设置 DSH_NODE 环境变量。"
  exit 1
fi

# 先看是否已经登录
if "$NODE" "$HERE/test/check-workbuddy.js" >/dev/null 2>&1; then
  echo "${G}✓ 已经登录过了${N}，不需要重复登录。"
  echo
  echo "  直接验证："
  echo "    \"$NODE\" test/check-workbuddy.js"
  echo
  exit 0
fi

echo "${Y}检测到 CLI 还没登录。${N}"
echo
echo "接下来会打开 WorkBuddy CLI 的交互界面。在里面："
echo
echo "  1. 输入 ${G}/login${N} 然后回车"
echo "  2. 按提示完成授权（可能会打开浏览器）"
echo "  3. 登录成功后输入 ${G}/exit${N} 退出"
echo
echo "${D}  这个界面是 TUI，用键盘操作。如果显示乱码，"
echo "${D}  把终端窗口拉大一点再试。${N}"
echo
read -r -p "按回车启动…" _

echo
echo "${D}── 进入 WorkBuddy CLI ──${N}"
echo

# CLI 需要 PATH 里有 node
export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$CLI"
