#!/bin/bash
# 一条命令，把她叫起来。
#
#   cd companion && ./start.sh
#
# 默认后台运行，日志写在 logs/bot.log，退出终端也不停。
# 前台调试：./start.sh --foreground
#
# 做三件事：
#   1. 检查 NapCat（QQ）在不在跑，不在就拉起来
#   2. 等 NapCat 的 WebSocket 就绪
#   3. 启动陪伴体
#
# 停止：./stop.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

NODE="${DSH_NODE:-}"
# 依次尝试：环境变量 → PATH 里的 node → DSH 自带 → 常见安装位置
# （迁移到没有 DSH 的机器上时，靠 PATH 里的 node 也能跑）
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" ]; then
    NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
  elif [ -x "/usr/local/bin/node" ]; then
    NODE="/usr/local/bin/node"
  elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE="/opt/homebrew/bin/node"
  else
    NODE=""
  fi
fi
CONFIG="$HERE/config.json"

FOREGROUND=0
for a in "$@"; do
  if [ "$a" = "--foreground" ] || [ "$a" = "-f" ]; then
    FOREGROUND=1
  fi
done

# ── 颜色（终端不支持时自动降级）──
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi

echo
echo "═══ 启动陪伴体 ═══"
echo

# ── 0. 前置检查 ──
if [ ! -x "$NODE" ]; then
  echo "${R}✗ 找不到 node${N}"
  echo "  请安装 Node.js 20+（brew install node 或 https://nodejs.org）"
  echo "  或用环境变量指定：DSH_NODE=/path/to/node ./start.sh"
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  echo "${R}✗ 找不到 config.json${N}"
  exit 1
fi

# 读配置（用 node 解析，避免 jq 依赖）
read -r WS_PORT WS_MODE ALLOW_COUNT INIT_ON < <(
  "$NODE" -e '
    const c = require(process.argv[1]);
    const n = c.napcat || {};
    process.stdout.write([
      n.port ?? 3002,
      n.mode ?? "ws",
      (c.allowlist || []).length,
      (c.initiate && c.initiate.enabled) ? "1" : "0"
    ].join(" "));
  ' "$CONFIG" 2>/dev/null || echo "3002 ws 0 0"
)

# ── 1. NapCat ──
NAPCAT_RUNNING=0
if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
  NAPCAT_RUNNING=1
  echo "${G}✓${N} NapCat 已在运行"
else
  echo "${Y}·${N} NapCat 未运行，正在启动…"
  open -a QQ --args --no-sandbox 2>/dev/null

  # 等它起来（最多 40 秒）
  for i in $(seq 1 40); do
    if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
      echo "${G}✓${N} NapCat 已启动"
      NAPCAT_RUNNING=1
      break
    fi
    sleep 1
  done

  if [ "$NAPCAT_RUNNING" = "0" ]; then
    echo "${R}✗ NapCat 启动失败${N}"
    echo "  手动试试：open -a QQ --args --no-sandbox"
    echo "  首次使用需要先登录，见 README"
    exit 1
  fi
fi

# ── 2. 等 WebSocket 就绪 ──
echo "${D}  等待 NapCat 的 WebSocket（端口 ${WS_PORT}）…${N}"
READY=0
for i in $(seq 1 40); do
  if lsof -nP -iTCP:"$WS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" = "0" ]; then
  echo "${R}✗ 端口 $WS_PORT 没有监听${N}"
  echo
  echo "  常见原因："
  echo "    · 小号还没登录 —— 打开 http://127.0.0.1:6099/webui/ 扫码"
  echo "    · 登录过期了"
  echo "    · onebot11.json 里的适配器没启用"
  echo
  echo "  也可以先跑诊断："
  echo "    \"$NODE\" tools/deploy.js check"
  exit 1
fi
echo "${G}✓${N} NapCat WebSocket 就绪"

# ── 3. 清理旧的陪伴体进程 ──
if pgrep -f "src/bot.js" >/dev/null 2>&1; then
  echo "${Y}·${N} 发现已运行的陪伴体，先停掉"
  pkill -f "src/bot.js" 2>/dev/null
  sleep 2
fi

# ── 3.4 记忆结构升级（v2，幂等）──
echo "${D}  检查记忆结构…${N}"
"$NODE" tools/migrate-memory-v2.js "$HERE/data/"

# ── 3.45 自动清理混乱对话 ──
#
# 每次启动前跑一遍，防止「错乱对话」留在最近 40 条窗口里继续污染后续生成。
# 实测踩过：她拿旧状态质疑他（"不是刚说去了吗 怎么又起来了"），
# 这种对话一旦进了历史，模型会照着它继续跑偏。
#
# 会清三类：重复条目、时间倒序、时间错位质问。
# 只摘坏的那几条，不清空历史；改动前自动备份到 data/backup/。
echo "${D}  检查混乱对话…${N}"
"$NODE" tools/auto-clean.js --quiet 2>&1 | sed "s/^/    /"

# ── 3.5 摘要体检（每天一次）──
#
# 摘要是长期记忆的唯一载体，出了错很难发现 —— 实测踩过：
# 摘要把"今天早上吃的面"写成"次日吃的"，她后面就当成昨天的事。
# 所以每天启动时顺手查一遍，有问题就自动重写。
#
# 用时间戳文件记录上次检查，避免每次重启都跑（会消耗 token）。
SUMMARY_STAMP="$HERE/data/.summary-checked"
NEED_CHECK=1
if [ -f "$SUMMARY_STAMP" ]; then
  LAST=$(cat "$SUMMARY_STAMP" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  # 24 小时内检查过就跳过
  if [ $((NOW - LAST)) -lt 86400 ]; then
    NEED_CHECK=0
  fi
fi

if [ "$NEED_CHECK" = "1" ]; then
  echo "${D}  检查摘要…${N}"
  CHECK_OUT=$("$NODE" tools/check-summary.js 2>&1)
  if echo "$CHECK_OUT" | grep -q "全部正常"; then
    echo "${G}✓${N} 摘要正常"
  elif echo "$CHECK_OUT" | grep -q "发现"; then
    echo "${Y}·${N} 摘要有问题，正在重写…"
    "$NODE" tools/fix-summary.js 2>&1 | grep -E "已写回|无需处理|处理了" | sed "s/^/    /"
  else
    echo "${D}  （检查跳过）${N}"
  fi
  date +%s > "$SUMMARY_STAMP"
fi

# ── 4. 启动 ──
echo
if [ "$ALLOW_COUNT" = "0" ]; then
  echo "${Y}⚠ 白名单是空的——她不会回复任何人${N}"
  echo "${D}  在 config.json 的 allowlist 里填上你的 QQ 号${N}"
  echo
fi

echo "${D}  模式 $WS_MODE | 端口 $WS_PORT | 白名单 $ALLOW_COUNT 人 | 主动发起 $([ "$INIT_ON" = "1" ] && echo 开 || echo 关)${N}"
echo "${D}  Ctrl+C 只停她；./stop.sh 两个都停${N}"
echo
echo "────────────────────────────────────────"

# 日志目录与轮转
LOG_DIR="$HERE/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/bot.log"
LOG_OLD="$LOG_DIR/bot.log.old"

# 如果当前日志超过 20MB，就轮转一次
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 20971520 ]; then
  mv -f "$LOG_FILE" "$LOG_OLD"
  echo "${D}  日志已轮转（旧的：$LOG_OLD）${N}"
fi

if [ "$FOREGROUND" = "1" ]; then
  echo "${D}  前台运行，日志同时输出到终端和 ${LOG_FILE}${N}"
  echo "────────────────────────────────────────"
  "$NODE" src/bot.js 2>&1 | tee -a "$LOG_FILE"
  EXIT=$?
else
  echo "${D}  后台运行，日志写入 ${LOG_FILE}${N}"
  echo "${D}  前台调试：./start.sh --foreground${N}"
  echo "────────────────────────────────────────"
  nohup "$NODE" src/bot.js >> "$LOG_FILE" 2>&1 &
  PID=$!
  sleep 2
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "${G}✓${N} 陪伴体已在后台启动（PID ${PID}）"
    echo "${D}  查看日志：tail -f logs/bot.log${N}"
    echo "${D}  停止：./stop.sh${N}"
    exit 0
  else
    echo "${R}✗${N} 陪伴体启动失败，看日志：${LOG_FILE}"
    exit 1
  fi
fi

echo "────────────────────────────────────────"
if [ "$EXIT" = "130" ] || [ "$EXIT" = "0" ]; then
  echo
  echo "陪伴体已停止。"
  echo "${D}NapCat 还在跑。要重开她：./start.sh${N}"
  echo "${D}要全停：./stop.sh${N}"
else
  echo
  echo "${R}陪伴体异常退出（退出码 ${EXIT}）${N}"
  echo "${D}常见原因看上面的日志；诊断：\"$NODE\" tools/deploy.js check${N}"
fi
echo
