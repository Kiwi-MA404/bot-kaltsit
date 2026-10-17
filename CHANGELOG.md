# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-17

首次公开发布。

### 新增

- **陪伴体核心**：人设 + 长期记忆 + 时间感合成回复
- **NapCat 接入**：OneBot 11 协议，支持私聊/群聊/自动重连
- **长期记忆 v2**：结构化事实，带状态/来源/版本链/时效
  - 区分 preference / attribute / observation / event
  - 矛盾检测与信念修订（旧事实标记 `superseded`，保留审计链）
  - 观察与偏好分离，避免瞬时场景污染长期偏好
- **提醒系统**：定时提醒调度，支持从对话中自动解析
  - 她说「几点叫你」时自动兑现承诺
  - 提醒触发后写入记忆，避免重复提醒
- **离线补偿**：停机期间的消息，启动后按原始时间补回
- **三种模型后端**：
  - `dsh` — DeepSeek Harness 本机网关
  - `workbuddy` — WorkBuddy 命令行
  - `ollama` — 本地 Ollama（无需账号，离线可用）
- **一键安装**：`install.sh` 自动部署 NapCat、配置 QQ 入口、交互式选择模型后端
- **运维工具**：
  - `memory-doctor.js` — 记忆冲突体检
  - `prune-history.js` — 精准修剪对话历史
  - `auto-clean.js` — 自动清理混乱对话
  - `reminder-cli.js` — 提醒管理
  - `setup-ollama.js` — Ollama 一键接入

### 安全

- 发布包不含任何聊天记忆数据
- 不含真实 QQ 号、昵称、本机路径
- NapCat 安装包附带 SHA256 校验

### 已知限制

- 仅支持 macOS
- 需要自行安装 QQ 客户端
- Ollama 本地模型的中文质量弱于云端模型
