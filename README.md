# bot-kalsit · 长期记忆陪伴体

一个能长期陪伴的 QQ 对话体。装好之后，她会在 QQ 里跟你聊天、记事、设提醒。

![License](https://img.shields.io/badge/license-MIT-blue)

![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## 项目简介

**这不是一个「问一句答一句」的聊天机器人。** 它试图解决一个更具体的问题：**让 AI 在长期相处中保持记忆一致、人格稳定、时间感真实。**

### 它解决的问题

| 常见问题                         | 本项目的做法                                                    |
| ---------------------------- | --------------------------------------------------------- |
| 用户说过「不喜欢牛奶」，几轮后 AI 又建议喝牛奶    | 记忆分 preference/observation，写入前做矛盾检测，旧事实标记 superseded 而非覆盖 |
| AI 拿旧状态质疑用户（「不是去睡了吗 怎么又刚睡醒」） | 观察按类别归档、带时间戳渲染，同类新状态顶掉旧的                                  |
| AI 说「两点半叫你」但到点什么都没发生         | 从她的回复里识别承诺，真的设上提醒；触发后写入记忆防重复                              |
| 停机期间的消息全丢                    | 启动时拉取历史，按**原始时间**补回（不是当前时间）                               |
| AI 编造时间（「现在才九点四十」）           | 时间锚点贴在用户消息最前面，并附已算好的提醒状态                                  |

### 技术栈

| 层     | 技术                                                               |
| ----- | ---------------------------------------------------------------- |
| 运行时   | Node.js ≥ 20（ESM）                                                |
| QQ 接入 | [NapCat](https://github.com/NapNeko/NapCatQQ) 4.18.38（OneBot 11） |
| 通信    | WebSocket（ws 8.22.0）                                             |
| 模型    | 三选一：DSH 网关 / WorkBuddy / 本地 Ollama                               |
| 存储    | 文件型 JSON（按联系人分文件），无数据库依赖                                         |
| 平台    | 仅 macOS                                                          |

### 核心特性

- **结构化长期记忆**：事实带类型、状态、来源、置信度、有效期；支持版本链与审计
- **人格与人设分离**：`persona/` 决定怎么说话，`data/` 存记忆，改人设不动代码
- **人格稳定性校准**：短回复落点示范 + 简短度自查，避免「越聊越短越敷衍」
- **离线消息补偿**：停机期间的对话不会丢，启动后按原时间补回
- **提醒与承诺兑现**：支持从对话解析提醒，也会兑现自己说过的「我叫你」
- **一键部署**：自动铺 NapCat、切 QQ 入口、配 WebSocket、初始化记忆结构
- **三种模型后端**：含完全离线的 Ollama，无需任何账号

### 适合谁

- 想自己搭一个有长期记忆的陪伴体，而不是接一个通用聊天 API
- 关心「记忆一致性」这个具体工程问题
- 有 macOS + QQ 小号，愿意花 20 分钟部署

---

## 一、包里有什么 / 没有什么

先看清这一点，能省掉大半的困惑。

### ✅ 包里已包含

| 组件         | 说明                                                                             |
| ---------- | ------------------------------------------------------------------------------ |
| **陪伴体主程序** | `app/` 下全部源码                                                                   |
| **NapCat** | `vendor/napcat/` 下的安装包（Shell 34M + Framework 35M + Installer），离线可用，带 SHA256 校验 |
| **ws 依赖**  | `app/node_modules/ws`，无需联网 npm install                                         |

### ❌ 包里不含，需要你自备

| 组件              | 为什么                                       | 怎么准备                                                   |
| --------------- | ----------------------------------------- | ------------------------------------------------------ |
| **QQ（Mac 版）**   | NapCat 寄生在 QQ 里才能运行，且 QQ 是有版权的商业软件，不能随包分发 | 从 [im.qq.com](https://im.qq.com) 下载安装，版本 **7.0.2 或更高** |
| **Node.js 20+** | 运行时                                       | `brew install node` 或 [nodejs.org](https://nodejs.org) |
| **模型服务**        | 陪伴体本身不含模型，必须外接                            | Ollama（免费）/ DSH / WorkBuddy，见下节                        |

### 模型服务（三选一，必须有一个）

没有模型，她能收消息但不会说话。三种接法：

| 方式                   | 需要装什么                                | 账号     | 配置                       |
| -------------------- | ------------------------------------ | ------ | ------------------------ |
| **A. Ollama 本地模型** ⭐ | [Ollama](https://ollama.com) + 拉一个模型 | ❌ 不需要  | `"backend": "ollama"`    |
| **B. DSH 本机网关**      | DeepSeek Harness 桌面端，保持运行            | ✅ 需要登录 | `"backend": "dsh"`       |
| **C. WorkBuddy**     | WorkBuddy 并登录                        | ✅ 需要账号 | `"backend": "workbuddy"` |

> ⭐ **如果你只有一台空白电脑、没有任何模型账号，选 A（Ollama）。**  
> 它完全本地运行，不需要注册、不需要联网、不需要付费。
>
> ⚠️ DSH 和 WorkBuddy **都不在本包内**，需要目标机自行安装。

#### A. Ollama 本地模型（推荐给空白机器）

```bash
# 1. 安装 Ollama
brew install ollama
brew services start ollama        # 后台常驻

# 2. 拉一个中文模型（约 4.7GB，首次需要下载）
ollama pull qwen2.5:7b

# 3. 一键接入
cd app && node tools/setup-ollama.js
```

脚本会自动检测、试跑、并写入 `config.json`。

| 模型            | 内存需求   | 说明            |
| ------------- | ------ | ------------- |
| `qwen2.5:7b`  | ~5GB   | 中文效果最好，**推荐** |
| `qwen2.5:3b`  | ~2.5GB | 轻量，质量略降       |
| `llama3.1:8b` | ~6GB   | 英文强，中文一般      |
| `gemma2:9b`   | ~7GB   | 综合均衡          |

> 7B 模型实际需要约 8GB 可用内存。内存不够就换 3b。

#### B / C. DSH 或 WorkBuddy

```json
// DSH
"backend": "dsh"

// WorkBuddy
"backend": "workbuddy",
"model": "workbuddy/deepseek-v4.1-flash"
```

---

## 二、前置条件

| 软件            | 要求                         | 是否随包               |
| ------------- | -------------------------- | ------------------ |
| **macOS**     | 12 或更高                     | —                  |
| **Node.js**   | 20 或更高                     | ❌ 自备               |
| **QQ（Mac 版）** | 7.0.2 或更高                  | ❌ 自备               |
| **模型服务**      | Ollama ✓ / DSH / WorkBuddy | ❌ 自备（Ollama 免费）    |
| **一个 QQ 小号**  | —                          | ❌ 自备（用来当机器人，建议新注册） |
| **NapCat**    | 4.18.38                    | ✅ 已含               |

> 如果你装过 DeepSeek Harness，它自带 Node，安装脚本会自动找到，不用另外装。

### 关于脚本里的 `DeepSeek Harness.app` 路径

部分脚本（`install.sh`、`app/start.sh`、`app/tools/*.sh` 等）里会出现形如：

```
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node
```

**这是有意保留的兜底路径，不影响普通用户。**

脚本查找 Node 的顺序是：

1. 环境变量 `DSH_NODE`
2. **`PATH` 里的 `node`** ← 用 Homebrew/nvm 装的 Node 走这条
3. DeepSeek Harness 自带路径 ← 只有装了 DSH 才会命中
4. `/usr/local/bin/node`
5. `/opt/homebrew/bin/node`

普通用户装好 Node 后命中第 2 条，根本不会走到第 3 条。保留它只是为了兼容已经装了 DSH 的环境。

## 三、安装

```bash
cd companion-release
./install.sh
```

安装过程会做这些事：

1. 检查 Node.js / QQ 是否就绪
2. 安装依赖（`ws` 已随包，无需联网）
3. 生成 `app/config.json`
4. **选择模型后端**（Ollama / DSH / WorkBuddy，交互式询问）
5. 初始化空的 `app/data/` 目录
6. 把 NapCat（QQ 协议端）部署进 QQ 容器
7. 切换 QQ 启动入口到 NapCat（**需要输入管理员密码**）
8. 写好 NapCat 的 WebSocket 配置（端口 3002）

> 第 4 步如果选 Ollama，脚本会自动检测、试跑、并写好配置。  
> 想跳过交互：`COMPANION_MODEL_BACKEND=ollama ./install.sh`

安装完成后，**必须先填配置**再启动：

```bash
# 编辑 app/config.json，把 allowlist 换成你要聊的 QQ 号
open -e app/config.json
```

```json
"allowlist": [123456789]
```

> 填谁，她就只回谁。留空数组 `[]` = 不回复任何人。  
> 这里填你自己的 QQ 号（大号），小号是机器人本体。

## 四、首次启动

```bash
cd app
./start.sh
```

启动脚本会依次：

1. 拉起 QQ（NapCat 模式）
2. 等 WebSocket 端口就绪
3. 初始化记忆结构
4. 自动清理混乱对话
5. 后台启动陪伴体，日志写入 `logs/bot.log`

### 扫码登录小号

**第一次必须先扫码**，否则她连不上 QQ：

1. 浏览器打开 <http://127.0.0.1:6099/webui/>
2. 用**小号**扫码登录
3. 登录成功后不要关 QQ

### 验证是否正常

开三个终端分别跑：

```bash
# 1. NapCat WebSocket 在监听（陪伴体靠它连 QQ）
lsof -nP -iTCP:3002 -sTCP:LISTEN

# 2. NapCat WebUI 在监听（扫码登录用）
lsof -nP -iTCP:6099 -sTCP:LISTEN

# 3. 看她的实时日志
tail -f app/logs/bot.log
```

两个端口都在监听、日志里出现 `[napcat] 已连接` 和 `[bridge] 就绪`，就说明装好了。

### 确认能收发消息

用你的大号给小号发一句「在吗」。

- 日志出现 `[qq-你的号] 他：在吗` → 收到了
- 日志出现 `[qq-你的号] 她：...`，QQ 里也收到回复 → 通了

如果收到消息但没回复，检查 `app/config.json` 的 `allowlist` 里有没有你的号。

## 五、日常使用

```bash
cd app

./start.sh              # 启动（后台运行，日志在 logs/bot.log）
./stop.sh               # 停止（会问要不要连 NapCat 一起停）
./start.sh --foreground # 前台运行，日志直接打在终端（调试用）
```

常用工具：

```bash
# 看她记得你什么
node tools/memory-doctor.js --contact qq-你的号

# 检查记忆冲突
node tools/memory-doctor.js --all --conflicts

# 查看/管理提醒
node tools/reminder-cli.js --all
node tools/reminder-cli.js --contact qq-你的号 --add "23:00" "该睡了"

# 清理某段混乱对话
node tools/prune-history.js --contact qq-你的号 --list
```

## 六、常见问题

### 端口 3002 没监听

说明 NapCat 没跑起来或没登录。

```bash
# 1. 确认 QQ 在跑
pgrep -fl "QQ.app"

# 2. 看 NapCat 登录状态
open http://127.0.0.1:6099/webui/

# 3. 如果提示未登录，扫码登录

# 4. 还是不行，跑诊断
node tools/deploy.js check
```

### 需要重新扫码

停掉 NapCat 后，下次启动就要重新登录：

```bash
cd app && ./start.sh
# 然后打开 http://127.0.0.1:6099/webui/ 扫码
```

想避免反复扫码：**只停陪伴体、不停 NapCat**。

```bash
# 只停陪伴体
pkill -f "src/bot.js"

# 再启动
cd app && ./start.sh
```

### 她不回复

按顺序排查：

1. `tail -f app/logs/bot.log` 看有没有 `他：...`
   - 没有 → 消息没进来，是 NapCat 掉线，去看 3002 端口
   - 有 → 继续下一步
2. 检查 `app/config.json` 的 `allowlist` 是否包含了你的 QQ 号
3. 日志里有 `chat 4xx/5xx` → 模型网关问题，见下一条

### 提示模型报错（402 / 401 / 502 / 连不上）

陪伴体本身不含模型，需要外部模型服务。三种方式：

**A. Ollama 本地模型（无账号，免费）**

```bash
brew install ollama && brew services start ollama
ollama pull qwen2.5:7b
cd app && node tools/setup-ollama.js
```

连不上排查：

```bash
curl http://127.0.0.1:11434/api/tags   # 有模型列表 = 正常
ollama list                            # 看装了哪些模型
brew services list | grep ollama       # 看服务是否在跑
```

**B. 走 DSH 本机网关**

```json
"backend": "dsh"
```

需要本机装 **DeepSeek Harness 桌面端**并保持运行。网关地址 `127.0.0.1:8326`。

**C. 走 WorkBuddy**

```json
"backend": "workbuddy",
"model": "workbuddy/deepseek-v4.1-flash"
```

需要先登录 WorkBuddy：`node tools/workbuddy-login.sh`

> 402 = 余额不足 / 额度用完；401 = 未授权（需要登录）；502/429 = 上游繁忙，会自动重试。  
> Ollama 报超时通常是模型首次加载慢，等一会儿再试，或换更小的模型。

### 无头绪时先跑诊断

```bash
cd app
node tools/deploy.js check
```

会逐项检查 QQ、NapCat、配置、端口。

### 只想先在本地跟她聊，不接 QQ

```bash
cd app
node src/chat.js
```

输入 `/facts` 看她记得什么，`/quit` 退出。

## 七、目录说明

```
companion-release/
├── install.sh          ← 安装脚本（跑一次）
├── README.md           ← 本文件
├── app/                ← 陪伴体主程序
│   ├── start.sh        ← 启动
│   ├── stop.sh         ← 停止
│   ├── config.json     ← 配置（安装时生成，需填 allowlist）
│   ├── config.example.json
│   ├── src/            ← 源码
│   ├── persona/        ← 人设（改这里改变她怎么说话）
│   ├── tools/          ← 运维工具
│   ├── data/           ← 记忆数据（安装时为空）
│   └── logs/           ← 运行日志
└── vendor/napcat/      ← NapCat 安装包（已校验）
```

## 八、安全提示

- `app/data/` 里存的是**真实聊天记录**（记忆、提醒、历史）
- 分享或备份这个目录前，确认里面没有你不希望外传的内容
- `app/config.json` 里有你的 QQ 号，也注意别外传
- 本发布包**已清空所有历史数据**，`data/` 是空的

## 九、数据迁移

想把这台机器的记忆搬到新机器：

```bash
# 旧机器
cp -R app/data /path/to/backup/

# 新机器（装好之后）
cp -R /path/to/backup/data/* app/data/
```

`data/` 里包含 `qq-*.json`（记忆）、`qq-state.json`（运行状态）、`reminders.json`（提醒）。  
搬运时先 `./stop.sh`，搬完再 `./start.sh`。
