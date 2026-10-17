#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  陪伴体 · 一键安装脚本
#
#  在发布包根目录执行：
#      ./install.sh
#
#  做这些事：
#    1. 检查前置条件（macOS / Node.js / QQ）
#    2. 安装 ws 依赖
#    3. 部署 NapCat 到 QQ 容器
#    4. 切换 QQ 入口（需要管理员密码）
#    5. 生成 config.json（首次）
#    6. 初始化 data/ 目录
#    7. 写入 NapCat 的 onebot11 配置（端口 3002）
#
#  安装完成后用 ./app/start.sh 启动。
# ═══════════════════════════════════════════════════════════════

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app"
VENDOR="$HERE/vendor/napcat"

# ── 颜色 ──
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; B=""; D=""; N=""
fi

ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
err()  { echo "${R}✗${N} $*"; }
step() { echo; echo "${B}[$1]${N} $2"; }

echo
echo "${B}═══ 陪伴体 · 安装 ═══${N}"
echo

# ─────────────────────────────────────────────────────────────
# 0. 前置检查
# ─────────────────────────────────────────────────────────────
step 0 "检查前置条件"

# macOS
if [ "$(uname)" != "Darwin" ]; then
  err "只支持 macOS（当前：$(uname)）"
  exit 1
fi
ok "macOS $(sw_vers -productVersion 2>/dev/null)"

# Node.js：优先 DSH_NODE，其次 PATH 里的 node，最后找常见位置
find_node() {
  if [ -n "${DSH_NODE:-}" ] && [ -x "$DSH_NODE" ]; then
    echo "$DSH_NODE"; return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node; return
  fi
  for p in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node"; do
    if [ -x "$p" ]; then echo "$p"; return; fi
  done
}

NODE="$(find_node)"
if [ -z "${NODE:-}" ]; then
  err "找不到 Node.js"
  echo
  echo "  请先安装 Node.js 20 或更高版本："
  echo "    brew install node"
  echo "  或从 https://nodejs.org 下载安装包"
  echo
  echo "  装好后重新运行：./install.sh"
  echo "  如果装在非标准位置，用环境变量指定："
  echo "    DSH_NODE=/path/to/node ./install.sh"
  exit 1
fi

NODE_VER="$("$NODE" -v 2>/dev/null)"
NODE_MAJOR="$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  err "Node.js 版本太低：$NODE_VER（需要 >= 20）"
  exit 1
fi
ok "Node.js $NODE_VER  ($NODE)"

# QQ 已安装？
if [ ! -d "/Applications/QQ.app" ]; then
  err "没有找到 /Applications/QQ.app"
  echo
  echo "  请先安装 QQ（Mac 版）：https://im.qq.com/"
  echo "  装好后重新运行：./install.sh"
  exit 1
fi
QQ_VER="$(defaults read /Applications/QQ.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '未知')"
ok "QQ $QQ_VER"

# vendor 包完整性
for f in NapCat.Shell.zip NapCat.Framework.zip; do
  if [ ! -f "$VENDOR/$f" ]; then
    err "缺少 $VENDOR/$f"
    echo "  发布包可能不完整，请重新解压。"
    exit 1
  fi
done
ok "NapCat 安装包完整"

# ─────────────────────────────────────────────────────────────
# 1. 安装依赖
# ─────────────────────────────────────────────────────────────
step 1 "安装 Node 依赖"

if [ -d "$APP/node_modules/ws" ]; then
  ok "ws 依赖已随包提供，无需联网安装"
else
  warn "包内没有 ws，尝试用 npm 安装…"
  cd "$APP"
  if command -v npm >/dev/null 2>&1; then
    npm install --omit=dev 2>&1 | tail -5
    if [ -d "$APP/node_modules/ws" ]; then
      ok "依赖安装完成"
    else
      err "依赖安装失败"
      exit 1
    fi
  else
    err "找不到 npm，且包内没有预装 ws"
    exit 1
  fi
  cd "$HERE"
fi

# ─────────────────────────────────────────────────────────────
# 2. 生成 config.json
# ─────────────────────────────────────────────────────────────
step 2 "生成配置文件"

if [ -f "$APP/config.json" ]; then
  warn "config.json 已存在，保留不动"
  echo "${D}   （想重置：删掉它再跑一次 ./install.sh）${N}"
else
  cp "$APP/config.example.json" "$APP/config.json"
  ok "已从模板生成 config.json"
  echo "${D}   下一步需要填 allowlist（你要聊的 QQ 号）${N}"
fi

# ─────────────────────────────────────────────────────────────
# 2.5 选择模型后端
# ─────────────────────────────────────────────────────────────
step 2.5 "配置模型服务"

# 自动探测：Ollama 是否在跑
OLLAMA_UP=0
if command -v ollama >/dev/null 2>&1 || curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    OLLAMA_UP=1
  fi
fi

echo
echo "  陪伴体需要一个模型来源，三选一："
echo
echo "    ${B}1) Ollama 本地模型${N}  无需任何账号，完全离线"
echo "       ${D}适合：没有 DSH / WorkBuddy 账号的机器${N}"
echo
echo "    ${B}2) DSH 本机网关${N}     需要装 DeepSeek Harness 桌面端"
echo "       ${D}适合：已经装了 DSH 的机器${N}"
echo
echo "    ${B}3) WorkBuddy${N}        需要装 WorkBuddy 并登录"
echo "       ${D}适合：有 WorkBuddy 账号的机器${N}"
echo

DEFAULT_CHOICE="2"
if [ "$OLLAMA_UP" = "1" ]; then
  DEFAULT_CHOICE="1"
  echo "  ${G}检测到 Ollama 正在运行${N}"
  echo
fi

if [ -n "${COMPANION_MODEL_BACKEND:-}" ]; then
  CHOICE="$COMPANION_MODEL_BACKEND"
  echo "  （由环境变量 COMPANION_MODEL_BACKEND 指定：$CHOICE）"
else
  read -r -p "  选择 [1/2/3，回车默认 $DEFAULT_CHOICE]： " CHOICE
  CHOICE="${CHOICE:-$DEFAULT_CHOICE}"
fi

case "$CHOICE" in
  1|ollama)
    echo
    if "$NODE" "$APP/tools/setup-ollama.js"; then
      ok "已配置为本地 Ollama"
    else
      warn "Ollama 配置未完成"
      echo "${D}   稍后手动配置：cd app && node tools/setup-ollama.js${N}"
      echo "${D}   现在继续完成 QQ 接入，配置好模型再启动。${N}"
    fi
    ;;
  3|workbuddy)
    echo
    if [ -f "$APP/config.json" ]; then
      "$NODE" -e '
        const fs=require("fs");
        const p=process.argv[1];
        const c=JSON.parse(fs.readFileSync(p,"utf8"));
        c.backend="workbuddy";
        c.model="workbuddy/deepseek-v4.1-flash";
        fs.writeFileSync(p, JSON.stringify(c,null,2));
      ' "$APP/config.json"
      ok "已设为 WorkBuddy"
      echo "${D}   需要先登录：cd app && node tools/workbuddy-login.sh${N}"
    fi
    ;;
  *)
    ok "使用 DSH 本机网关（默认）"
    echo "${D}   需要目标机已装 DeepSeek Harness 并保持运行${N}"
    ;;
esac

# ─────────────────────────────────────────────────────────────
# 3. 初始化 data 目录
# ─────────────────────────────────────────────────────────────
step 3 "初始化数据目录"

mkdir -p "$APP/data" "$APP/logs"
# 记忆结构由 start.sh 里的 migrate-memory-v2.js 首次启动时自动初始化
if [ -f "$APP/data/README.md" ]; then
  ok "data/ 已就绪（空，无历史数据）"
else
  ok "data/ 已创建"
fi

# ─────────────────────────────────────────────────────────────
# 4. 部署 NapCat
# ─────────────────────────────────────────────────────────────
step 4 "部署 NapCat"

NAPCAT_DOC="$HOME/Library/Containers/com.tencent.qq/Data/Documents"
NAPCAT_DIR="$NAPCAT_DOC/napcat"
LOADER="$NAPCAT_DOC/loadNapCat.js"

if [ -f "$NAPCAT_DIR/napcat.mjs" ] && [ -f "$LOADER" ]; then
  ok "NapCat 已部署过，跳过"
else
  # QQ 必须完全退出才能改
  if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
    warn "QQ 正在运行，正在退出…"
    osascript -e 'quit app "QQ"' 2>/dev/null || true
    sleep 3
    if pgrep -f "QQ.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
      err "QQ 退不掉，请手动退出后重试"
      exit 1
    fi
  fi

  echo "${D}   解压 NapCat 到 QQ 容器…${N}"
  mkdir -p "$NAPCAT_DOC"
  rm -rf "$NAPCAT_DIR"
  mkdir -p "$NAPCAT_DIR"
  if ! unzip -q -o "$VENDOR/NapCat.Shell.zip" -d "$NAPCAT_DIR"; then
    err "解压失败"
    exit 1
  fi

  if [ ! -f "$NAPCAT_DIR/napcat.mjs" ]; then
    err "解压后缺少 napcat.mjs，包可能损坏"
    exit 1
  fi
  ok "NapCat 已解压（$(find "$NAPCAT_DIR" -type f | wc -l | tr -d ' ') 个文件）"

  # 写 loader
  cat > "$LOADER" <<LOADER_EOF
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// NapCat 用 NAPCAT_WORKDIR 决定配置/日志/缓存放哪。
process.env.NAPCAT_WORKDIR = path.join(__dirname, 'napcat');

const loadNapcat = process.argv.includes('--no-sandbox');
const pkg = require('/Applications/QQ.app/Contents/Resources/app/package.json');

if (loadNapcat) {
  (async () => {
    await import(pathToFileURL(path.join(__dirname, 'napcat/napcat.mjs')).href);
  })();
} else {
  require('/Applications/QQ.app/Contents/Resources/app/app_launcher/index.js');
  setImmediate(() => {
    if (global.launcher && global.launcher.installPathPkgJson) {
      global.launcher.installPathPkgJson.main = ((version) => {
        if (version >= 29271) return './application.asar/app_launcher/index.js';
        if (version >= 28060) return './application/app_launcher/index.js';
        return './app_launcher/index.js';
      })(pkg.buildVersion);
    }
  });
}
LOADER_EOF
  ok "已写入 loadNapCat.js"
fi

# ─────────────────────────────────────────────────────────────
# 5. 切换 QQ 入口（需要 sudo）
# ─────────────────────────────────────────────────────────────
step 5 "切换 QQ 入口到 NapCat（需要管理员密码）"

if "$NODE" -e '
  const fs=require("fs");
  const p="/Applications/QQ.app/Contents/Resources/app/package.json";
  try {
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    process.exit(String(j.main||"").includes("loadNapCat")?0:1);
  } catch { process.exit(1); }
' 2>/dev/null; then
  ok "QQ 入口已指向 NapCat，跳过"
else
  echo "${D}   接下来会要求输入管理员密码（改的是 /Applications/QQ.app）${N}"
  echo
  if sudo "$NODE" "$APP/tools/patch-qq.js"; then
    ok "QQ 入口已切换"
  else
    err "切换失败"
    echo "  可以手动执行："
    echo "    sudo \"$NODE\" \"$APP/tools/patch-qq.js\""
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────
# 6. 写入 onebot11 配置（端口 3002）
# ─────────────────────────────────────────────────────────────
step 6 "配置 NapCat 网络（WebSocket 端口 3002）"

# 启动一次 NapCat 让它生成默认配置结构
if [ ! -f "$NAPCAT_DIR/config/onebot11.json" ]; then
  echo "${D}   首次启动 NapCat 生成默认配置…${N}"
  open -a QQ --args --no-sandbox 2>/dev/null || true
  for i in $(seq 1 40); do
    [ -f "$NAPCAT_DIR/config/onebot11.json" ] && break
    sleep 1
  done
  sleep 2
  osascript -e 'quit app "QQ"' 2>/dev/null || true
  sleep 3
fi

if "$NODE" "$APP/tools/deploy.js" config --force 2>&1 | tail -12; then
  ok "onebot11.json 已配置"
else
  warn "自动配置失败，稍后可用以下命令重试："
  echo "    \"$NODE\" \"$APP/tools/deploy.js\" config --force"
fi

# ─────────────────────────────────────────────────────────────
# 完成
# ─────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────"
echo "${G}${B}安装完成${N}"
echo
echo "  ${B}下一步：${N}"
echo "    1. 编辑 ${B}app/config.json${N}，把 allowlist 改成你要聊的 QQ 号"
echo "       ${D}例如：\"allowlist\": [123456789]${N}"
echo
echo "    2. 启动："
echo "       ${B}cd app && ./start.sh${N}"
echo
echo "    3. 首次启动需要扫码登录小号："
echo "       浏览器打开 ${B}http://127.0.0.1:6099/webui/${N}"
echo "       用要当机器人的小号扫码"
echo
echo "    4. 验证："
echo "       ${D}lsof -nP -iTCP:3002 -sTCP:LISTEN${N}   # NapCat WebSocket"
echo "       ${D}lsof -nP -iTCP:6099 -sTCP:LISTEN${N}   # NapCat WebUI"
echo "       ${D}tail -f app/logs/bot.log${N}          # 看她实时在说什么"
echo
echo "  ${D}完整说明见 README.md${N}"
echo "────────────────────────────────────────────────"
echo
