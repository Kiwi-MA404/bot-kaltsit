# 贡献指南

感谢你有兴趣改进这个项目。

## 提 Issue

- 先搜索已有 issue，避免重复
- Bug 报告请附：macOS 版本、Node 版本、`app/logs/bot.log` 相关片段
- **不要粘贴真实聊天记录、QQ 号、token**

## 提 Pull Request

1. Fork 本仓库
2. 从 `main` 建分支：`git checkout -b fix/your-topic`
3. 改完跑测试：

   ```bash
   cd app
   node test/catchup.js
   ```

4. 提交时说明改了什么、为什么改
5. 发起 PR，描述里写清复现步骤（如有 bug）

## 代码约定

- 2 空格缩进，单引号，加分号
- 注释用中文，解释「为什么」而不是「做了什么」
- 改动记忆相关逻辑前，先读 `CLAUDE.md`
- 改完必须在干净数据目录下验证一次

## 绝不提交的内容

| 禁止 | 原因 |
|------|------|
| `app/data/` 下任何文件 | 真实聊天记录 |
| `app/config.json` | 含个人 QQ 号 |
| `.env` / `*.pem` / `*.key` | 凭据 |
| 真实对话原文 | 隐私 |
| 真实 QQ 号、昵称 | 隐私 |

`.gitignore` 已覆盖以上内容。提交前请自查：

```bash
git status --short
git ls-files | grep -E "app/data/.*\.json|app/config\.json$"
```

第二条命令应输出为空。

## 许可证

提交的代码将按本项目 [MIT License](LICENSE) 授权。
