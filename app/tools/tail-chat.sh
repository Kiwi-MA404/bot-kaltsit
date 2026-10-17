#!/bin/bash
# 实时看她在 QQ 里说了什么。
#
#   cd companion && ./tools/tail-chat.sh              # 看所有账号
#   ./tools/tail-chat.sh 1234567890                   # 只看某个号
#
# 原理：直接盯 data/qq-*.json 的变化，读出新增的对话。
# 为什么不用日志：她的输出走的是管道，没落盘。
# 记忆文件是唯一可靠的事实来源——她说了什么，一定写在这里。

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${DSH_NODE:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node}"

if [ -t 1 ]; then
  U=$'\033[38;5;80m'; A=$'\033[38;5;114m'; D=$'\033[2m'
  T=$'\033[38;5;245m'; R=$'\033[0m'; B=$'\033[1m'
else
  U=""; A=""; D=""; T=""; R=""; B=""
fi

FILTER="${1:-}"

# 防手滑：从别处复制命令时容易把行尾注释一起带上（"…sh  # 看所有账号"），
# 那样过滤器会变成 "#"，什么都匹配不到，看起来就像"消息没显示"。
# 只认数字，其余一律当没给过滤器处理。
case "$FILTER" in
  "" ) ;;
  *[!0-9]* )
    echo
    echo "  ⚠ 参数 '$FILTER' 不像 QQ 号，已忽略（当作显示全部）。"
    echo "    正确用法：./tools/tail-chat.sh 1234567890"
    FILTER=""
    ;;
esac

DATA="$HERE/data"

if [ ! -d "$DATA" ]; then
  echo "找不到 data 目录：$DATA"
  exit 1
fi

echo
echo "${B}═══ 她的对话（实时）═══${R}"
echo "${D}  监听 $DATA"
[ -n "$FILTER" ] && echo "${D}  只显示：$FILTER"
echo "${D}  格式：[QQ尾号] 谁  内容      每个号一个颜色${R}"
echo "${D}  退出：Ctrl+C${R}"
echo

# 用 node 做一个常驻监听：每 1 秒扫一遍所有记忆文件，
# 只打印新增的行。比 inotify/fswatch 可靠，macOS 上也不用装东西。
"$NODE" -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
const filter = process.argv[2] || "";

const U = "\x1b[38;5;80m", A = "\x1b[38;5;114m", D = "\x1b[2m", R = "\x1b[0m";

// 已见过的（role + 时间戳 + 内容）指纹，避免重复打印
const seen = new Set();
const fileLen = new Map();   // 文件 -> 上次读到的 history 长度

// 每个账号分配一个稳定颜色，方便一眼看出是谁在聊
const ID_COLORS = [
  "\x1b[38;5;208m", // 橙
  "\x1b[38;5;141m", // 紫
  "\x1b[38;5;44m",  // 青
  "\x1b[38;5;205m", // 粉
  "\x1b[38;5;154m", // 黄绿
  "\x1b[38;5;203m", // 红
];
const tagIndex = new Map();
function tagOf(id) {
  if (!tagIndex.has(id)) tagIndex.set(id, tagIndex.size);
  return tagIndex.get(id);
}

function fp(h) { return `${h.role}|${h.at}|${h.content}`; }

function scan(initial) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^qq-\d+\.json$/.test(f)); }
  catch { return; }

  for (const f of files) {
    const id = f.replace(/^qq-/, "").replace(/\.json$/, "");
    if (filter && !id.includes(filter)) continue;

    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch { continue; }

    const hist = j.history || [];
    const prev = fileLen.has(f) ? fileLen.get(f) : -1;

    if (initial) {
      // 首次只记录，不打印历史（否则刷屏）
      hist.forEach(h => seen.add(fp(h)));
      fileLen.set(f, hist.length);
      continue;
    }

    if (hist.length === prev) continue;
    fileLen.set(f, hist.length);

    // 打印新增的
    for (const h of hist) {
      const k = fp(h);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = new Date(h.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

      // 标出是哪个号在聊。多个人同时聊的时候，这一列是分辨的关键。
      // 尾号取后 4 位：够区分，又不会把整屏撑爆。
      const tail = id.slice(-4);
      const tag = ID_COLORS[tagOf(id) % ID_COLORS.length];
      const who = h.role === "user" ? `${U}他${R}` : `${A}她${R}`;

      console.log(`${D}${t}${R} ${tag}[${tail}]${R} ${who}  ${h.content}`);
    }
  }
}

scan(true);
console.log(`${D}已就绪，等她说话…${R}\n`);
setInterval(() => scan(false), 1000);
' "$DATA" "$FILTER"
