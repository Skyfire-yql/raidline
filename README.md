# 团轴 Raidline

面向《魔兽世界》团本的个人排轴工具。支持手动编排、公开 WCL 战报导入、团队技能冲突提醒、只读分享、MRT 文本与 JSON 备份。

## 本地开发

1. 安装 Node.js 22.13 或更高版本。
2. 运行 `npm ci`。
3. 复制 `.env.example` 为 `.env.local`；如需 WCL 导入，填写 WCL Client ID 与 Client Secret。
4. 运行 `npm run dev`，访问终端显示的本地地址。

空白排轴不依赖 WCL 凭据。首次调用计划接口时，本地 D1 会自动创建开发用表；正式部署使用 `drizzle/` 中的迁移。

## 测试与构建

- `npm run test:unit`：核心规则、WCL 地址与事件分页测试。
- `npm run build`：生成 Cloudflare Worker 兼容的生产构建。
- `npm test`：完整测试与服务端渲染检查。

## 数据与安全

- 计划正文存于 Cloudflare D1，浏览器存储只保存这台设备上的最近入口和编辑密钥。
- 编辑恢复链接中的密钥只存在 URL fragment；服务器仅保存 SHA-256 哈希。
- WCL Client Secret 仅作为服务端环境变量使用，禁止提交到 GitHub。
- 首版仅支持公开 WCL 战报，站点默认私有发布。

## 部署

项目使用 Vinext、React、Drizzle 与 Cloudflare D1，可通过 OpenAI Sites 发布，也可以迁移到兼容的 Cloudflare Workers 环境。部署前需应用 `drizzle/` 数据库迁移并配置 WCL 环境变量。

Raidline 是社区工具，与 Blizzard Entertainment 或 Warcraft Logs 无官方关联。
