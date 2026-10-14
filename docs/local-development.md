# 本地开发与数据运维

## 配置

项目不要求运行时 `.env` 文件。需要覆盖默认值时，可参考根目录 `.env.example`：

```bash
DATA_DIR=/path/to/local/fitness-coach-data PORT=3001 npm run dev:server
```

- `DATA_DIR`：本机数据根目录，默认 `data`。
- `PORT`：本地 API 端口，默认 `3001`。
- 服务固定绑定 `127.0.0.1`。

启动会解析并校验数据目录的真实路径。符号链接形式的数据根目录，以及指向根目录外部的数据库、密钥、`images` 或 `backups` 路径会被拒绝。

## 常用命令

```bash
npm install
npm run dev
npm run dev:server
npm run dev:web
npm run db:migrate
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run db:migrate` 是幂等的。应用启动也会执行迁移，不会删除已有记录。

## 数据边界

- SQLite、图片、备份和模型密钥默认只写入 `DATA_DIR`。
- 保存业务记录不会调用模型。
- 饮食识别只在用户主动触发时发送选中餐次的图片和文字。
- 阶段建议默认发送档案、结构化记录和有限摘要，默认发送 0 张历史图片。
- 用户明确开启图片复核时，建议请求最多选择 5 张相关图片并检查总大小。
- 网络或模型失败不会删除本地原图、餐次、确认数据或既有报告。
- 请求日志只包含 request id、方法、无查询字符串的路径、状态、耗时和错误码，不记录请求体、Authorization、API Key、图片 base64 或完整模型响应。

模型服务商可能保存或处理所发送的数据；使用前应检查所配置服务商的隐私和保留政策。

## 备份格式

设置页创建的备份保存在 `DATA_DIR/backups/backup-*.tar.gz`。归档仅包含：

```text
manifest.json
schema-version.json
database/fitness-coach.sqlite
images/...
```

`manifest.json` 记录格式版本、创建时间、schema 版本、图片包含状态及每个文件的大小和 SHA-256。服务会在原子重命名发布前校验归档、数据库 schema、图片引用、文件大小和摘要。

以下内容不会进入归档：

- `model-api-key.secret`
- `.env*`
- `runtime-config.*`
- 旧备份和临时文件
- 符号链接或数据目录外部文件

## 恢复备份

当前版本不提供覆盖运行中数据的恢复 API，避免误操作。恢复应在服务停止时进行：

1. 停止本地服务。
2. 保留当前 `DATA_DIR` 的独立副本，不要直接覆盖唯一副本。
3. 在临时目录解压备份并检查 `manifest.json`、`schema-version.json` 和文件摘要。
4. 将 `database/fitness-coach.sqlite` 复制为新数据目录根下的 `fitness-coach.sqlite`。
5. 将归档中的 `images/` 复制到新数据目录的 `images/`。
6. 创建空的 `backups/`，或另行复制希望保留的历史备份。
7. 不要从其他位置复制旧 API Key；启动后在设置页重新配置。
8. 使用新的 `DATA_DIR` 启动服务，检查健康接口、档案、餐次图片、确认食物和历史报告。

若图片文件缺失，应用保留餐次和结构化数据并显示缺失提示，不应删除数据库记录。

## JSON 导出

JSON 导出包含显式允许的数据库表和 schema 版本。默认不包含图片；设置页勾选后，图片以 base64 写入导出文件。无论是否包含图片，导出都不读取或包含 API Key、密钥文件、备份和运行时配置。

JSON 导出用于检查和迁移数据，不是可直接覆盖 `DATA_DIR` 的自动恢复格式。

## 限制与错误排查

- 单张上传图片最大 10 MiB。
- JSON 和 multipart 请求分别有明确的 11 MiB 请求体上限。
- 单餐识别最多 12 张图片，聚合大小最大 20 MiB。
- 显式建议图片复核最多 5 张，聚合大小最大 20 MiB。
- AI 请求有超时；仅网络失败和 HTTP 5xx 进行有限重试。401、403 和其他 4xx 不重试。
- 页面错误可包含安全的错误码和 request id，便于关联本机日志。
- 错误 API Key 通常返回认证错误；密钥不会写入错误响应或日志。
- 超大文件返回 HTTP 413，不创建图片引用。
- 数据目录或子路径为符号链接时，服务会拒绝启动或拒绝文件操作。

## 发布前检查

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

不要把 `data/`、数据库、图片、备份、`.env`、运行时配置或密钥文件加入源代码目录中的交付内容。
