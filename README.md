# Fitness Coach

本项目是单人使用的本地网页健身记录与 AI 阶段建议工具。React 页面和 Node.js API 都在本机运行，结构化数据保存在本机 SQLite，饮食图片保存在本机目录。

保存档案、体重、餐次、训练、身体反馈或日状态只写本机，不调用模型。只有用户主动点击“识别这餐”或确认生成阶段建议后，服务端才访问配置的 OpenAI 兼容接口。

## 当前范围

- 支持桌面浏览器中的本地网页，不是移动端 App。
- 支持单一 OpenAI 兼容模型配置。
- 不包含登录、多用户、线上数据库、云同步、自动后台分析或多模型。
- AI 输出是健身辅助信息，不是医疗诊断。持续、加重或明显不适应停止相关训练并寻求专业评估。

## 环境要求

- Node.js 22 或兼容版本
- npm
- 本机可写的数据目录

## 启动

```bash
npm install
npm run db:migrate
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。本地 API 默认监听 `http://127.0.0.1:3001`，不会绑定到外网地址。

也可以先构建，再由本地服务同时提供 API 和网页：

```bash
npm run build
npm run dev:server
```

浏览器打开 `http://127.0.0.1:3001`。

## 本机数据

默认数据目录为项目下的 `data/`，可通过 `DATA_DIR` 改为任意本机绝对或相对目录。服务启动时会创建：

```text
fitness-coach.sqlite       SQLite 数据库
images/                    饮食原图
backups/                   本地 tar.gz 备份
model-api-key.secret       权限限制为当前用户的模型密钥文件
```

API Key 不写入 SQLite，不出现在普通设置响应、报告、JSON 导出、备份 manifest 或备份归档中。恢复备份后需要重新配置 API Key。

## 备份与导出

设置页提供：

- 创建本地备份：原子生成包含 SQLite 快照、图片、schema 版本和 manifest 的 `tar.gz` 文件。
- 导出 JSON：默认不包含图片；可明确选择将本机图片以 base64 放入导出文件。
- 清除 API Key：删除独立的本机密钥文件。

备份和导出都不包含 API Key。恢复步骤及归档校验说明见 [`docs/local-development.md`](docs/local-development.md)。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

端到端测试使用本机临时数据目录和 mock AI endpoint，不调用真实模型，也不会生成真实 API Key、真实图片或项目内运行时数据。

更多开发、迁移、限制和故障处理信息见 [`docs/local-development.md`](docs/local-development.md)。
