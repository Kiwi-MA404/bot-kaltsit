#!/bin/bash
# 切换 QQ 入口到 NapCat（需要 sudo）。
#
#   sudo bash tools/patch.sh            切到 NapCat
#   sudo bash tools/patch.sh --restore  切回原版 QQ
#
# 这条命令之所以必须提权：它改的是
#   /Applications/QQ.app/Contents/Resources/app/package.json
# 属主 root:wheel，macOS 的 rootless 保护会拒绝非特权写入。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${DSH_NODE:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node}"

if [ ! -x "$NODE" ]; then
  echo "找不到 node：$NODE"
  echo "请用 DSH_NODE 指定，例如："
  echo "  sudo DSH_NODE=/path/to/node bash $0 $*"
  exit 1
fi

exec "$NODE" "$HERE/patch-qq.js" "$@"
