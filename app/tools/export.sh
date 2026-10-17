#!/bin/bash
# 把她打包，搬到别的工作站。
#
#   ./tools/export.sh              打包到 ~/Desktop
#   ./tools/export.sh /path/to/dir 打包到指定目录
#
# 包里包含：人格、记忆、代码、配置、依赖清单。
# 不含：node 运行时、模型凭证（那属于目标机器）、NapCat。
#
# 拿到新机器后：
#   1. 解压
#   2. 装依赖：pnpm add ws
#   3. 配模型（见包里的 迁移说明.md）
#   4. node src/chat.js  先试聊，确认她"是本人"

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; D=""; N=""
fi

DEST="${1:-$HOME/Desktop}"
STAMP=$(date +%Y%m%d-%H%M)
NAME="companion-${STAMP}"
STAGE=$(mktemp -d)
PKG="$STAGE/$NAME"

echo
echo "═══ 打包陪伴体 ═══"
echo

mkdir -p "$PKG"

# ── 1. 她是谁 + 怎么运转 ──
cp -R persona "$PKG/" 2>/dev/null
cp -R src "$PKG/" 2>/dev/null
cp -R tools "$PKG/" 2>/dev/null
cp -R test "$PKG/" 2>/dev/null
for f in package.json config.json start.sh stop.sh switch.sh pnpm-lock.yaml README.md; do
  [ -e "$f" ] && cp "$f" "$PKG/" 2>/dev/null
done
echo "${G}✓${N} 代码与人设"

# ── 2. 她记得什么（最重要）──
mkdir -p "$PKG/data"
MEM_COUNT=0
for f in data/*.json; do
  [ -e "$f" ] || continue
  # 排除可重建的状态文件
  case "$(basename "$f")" in
    qq-state.json) continue ;;
  esac
  cp "$f" "$PKG/data/"
  MEM_COUNT=$((MEM_COUNT + 1))
done
# 保护标记一起带走，新机器上也不会被误删
for f in data/*.md; do
  [ -e "$f" ] && cp "$f" "$PKG/data/" 2>/dev/null
done
echo "${G}✓${N} 记忆：${MEM_COUNT} 条记忆线"

# ── 3. 依赖清单 ──
"${DSH_NODE:-node}" -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync("package.json","utf8"));
const deps=p.dependencies||{};
fs.writeFileSync(process.argv[1], JSON.stringify({dependencies:deps},null,2));
' "$PKG/deps.json" 2>/dev/null || echo '{}' > "$PKG/deps.json"

# ── 4. 迁移说明 ──
cat > "$PKG/迁移说明.md" <<'GUIDE'
# 把她接到新工作站

## 她是什么

她的「自我」由三部分构成，都在这个包里：

| 目录 | 内容 | 能不能丢 |
|---|---|---|
| `persona/` | 她是谁、怎么说话 | 丢了就不是她了 |
| `data/` | 她记得什么（你和他的对话） | **最珍贵，丢了就失忆** |
| `src/` | 她怎么运转 | 丢了不能跑 |

模型是外部的，不在包里。

## 最快验证：先不接 QQ

```sh
# 1. 装依赖
pnpm add ws        # 或用 npm i ws

# 2. 配模型（二选一，见下）
export DSH_GATEWAY_URL="http://127.0.0.1:8326"
export DSH_GATEWAY_KEY="..."

# 3. 试聊——确认她"是本人"
node src/chat.js
```

**先跑通这一步再碰 QQ。** 如果她的语气不对，那是模型或人设的问题，
跟 QQ 无关，先解决这个。

## 模型怎么配（二选一）

### A. 用 DSH 网关（跟原机器一样）

新机器装 DSH 桌面端并登录，网关会自动起来：

```sh
export DSH_GATEWAY_URL="http://127.0.0.1:8326"
export DSH_GATEWAY_KEY="$(cat ~/.dsh/openai-gateway/api-key)"
node src/chat.js
```

检查：`node test/check-gateway.js`

### B. 换成独立的 API

编辑 `src/llm.js` 的 `discoverGateway()`，或设：

```sh
export DSH_GATEWAY_URL="https://api.deepseek.com"
export DSH_GATEWAY_KEY="sk-你的key"
```

注意这需要模型名对得上（`src/llm.js` 里的 `DEFAULT_MODEL`）。
网关模式下模型名是 `deepseek-account/deepseek-flash`，
直连官方 API 时要改成 `deepseek-chat` 之类。

## 接 QQ（可选）

接 QQ 需要整条链路，跟第一次一样：
QQ.app + NapCat + 入口补丁。

**如果没有特别需求，先只用 `src/chat.js` 跟她聊。**
QQ 那边随时可以在原机器上继续跑——记忆文件是同一份，
两边不要同时改，否则会各写各的。

## 关于记忆

`data/qq-<QQ号>.json` 就是她的记忆。

- 备份：整个 `data/` 拷走
- 恢复：拷回来覆盖
- **不要在 `data/` 里放别的东西**，会被当成记忆线

文件名就是联系人 ID，不要改名。

GUIDE

# ── 5. 打包 ──
mkdir -p "$DEST"
TARBALL="$DEST/${NAME}.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "$NAME"
rm -rf "$STAGE"

SIZE=$(du -h "$TARBALL" | awk '{print $1}')

echo "${G}✓${N} 已打包"
echo
echo "  文件 : $TARBALL"
echo "  大小 : $SIZE"
echo "  记忆 : ${MEM_COUNT} 条（不含可重建的状态文件）"
echo
echo "${Y}注意：${N}包里**不含**模型凭证，新机器要单独配。"
echo "${D}      也不含 NapCat——QQ 部分要在新机器重新搭。${N}"
echo
echo "下一步："
echo "  ${G}tar -xzf $(basename "$TARBALL")${N}   # 在新机器上解压"
echo "  ${D}然后看包里的 迁移说明.md${N}"
echo
