#!/bin/bash
# 一条命令完成 QQ 接入的最后一步。
#
# 这个脚本做两件事：
#   1. 打开安装器（这一步需要你点「安装」并输入管理员密码）
#   2. 等你装完，自动写 onebot11.json 网络配置
#
# 为什么第 1 步不能自动化：安装要改写 /Applications/QQ.app，
# 而它归 root:wheel 所有，必须管理员授权。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPANION="$(cd "$HERE/.." && pwd)"
WORKSPACE="$(cd "$COMPANION/.." && pwd)"
INSTALLER="$WORKSPACE/vendor/napcat/installer/NapCatInstaller.app"
NAPCAT_DIR="$HOME/Library/Containers/com.tencent.qq/Data/Documents/napcat"

DSH_NODE="${DSH_NODE:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node}"

if [ ! -x "$DSH_NODE" ]; then
  echo "找不到 node：$DSH_NODE"
  echo "请设置 DSH_NODE 环境变量指向可用的 node。"
  exit 1
fi

echo
echo "═══ 陪伴体 · QQ 接入 ═══"
echo

# ── 已有配置就直接跳到最后 ──
if [ -f "$NAPCAT_DIR/config/onebot11.json" ]; then
  echo "检测到 NapCat 已安装且已有配置。"
  echo
  exec "$DSH_NODE" "$HERE/deploy.js" config
fi

# ── 如果已安装但还没配置 ──
if [ -d "$NAPCAT_DIR" ]; then
  echo "检测到 NapCat 目录已存在，直接配置网络。"
  echo
  exec "$DSH_NODE" "$HERE/deploy.js" config --force
fi

# ── 还没安装 ──
if [ ! -d "$INSTALLER" ]; then
  echo "找不到安装器：$INSTALLER"
  exit 1
fi

echo "接下来会打开 NapCat 安装器。要做的事："
echo
echo "  1. 选 NapCat 版本"
echo "  2. 下载线路选「镜像」（直连只有 65KB/s，镜像约 400KB/s）"
echo "  3. 点安装，输入管理员密码"
echo "  4. 装完回到这个终端，按回车继续"
echo
read -r -p "按回车打开安装器…" _

open "$INSTALLER"

echo
echo "安装器已打开。"
echo "装完后（QQ 会自动启动），回到这里按回车。"
echo
read -r -p "装好了，继续配置？" _

echo

# ── 等 NapCat 目录出现（安装器可能在退出后才写完）──
for i in $(seq 1 30); do
  if [ -d "$NAPCAT_DIR" ]; then
    break
  fi
  sleep 1
done

if [ ! -d "$NAPCAT_DIR" ]; then
  echo "还没检测到 NapCat 目录："
  echo "  $NAPCAT_DIR"
  echo
  echo "可能原因："
  echo "  · 安装还没完成"
  echo "  · 安装器选了不同版本，目录名不同"
  echo
  echo "装完后手动跑："
  echo "  \"$DSH_NODE\" \"$HERE/deploy.js\" config --force"
  exit 1
fi

echo "已检测到 NapCat 目录。"
echo

exec "$DSH_NODE" "$HERE/deploy.js" config --force
