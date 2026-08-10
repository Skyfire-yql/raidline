# 团轴 Raidline

面向《魔兽世界》团本的本地优先排轴工具。工作副本保存在浏览器 IndexedDB；只有玩家明确点击发布时，才会把当时冻结的 JSON 快照写入 Sites R2。

![团轴 Raidline 预览](public/og.png)

## 数据模型

- `plans` 保存当前工作副本，编辑停止 300ms 后写入；`localRevision` 阻止旧标签页静默覆盖新标签页。
- `snapshots` 每分钟以及发布、应用预设、目录升级和破坏性操作前建立检查点；每条轴保留 30 个，历史总量限制为 100MB。
- `catalogCache` 缓存技能、Boss 机制和时间轴预设；`settings` 保留设备级设置。
- 工作副本没有自动云端保存、账户同步或 JSON 文件导入导出。
- 单条计划在本地保存和发布前都执行 v5 结构校验，并限制为 1MB；v1–v4 内容会在浏览器中迁移到 v5。
- 计划不保存难度、固定战斗时长或时间吸附设置；阶段与注释是独立时间轴对象，所有对象按 1 秒对齐。
- 时间轴根据最后一个对象自动加 30 秒并向上取整，范围为 2–120 分钟；`1×` 始终适配可用区域。

## 发布链接

- 只读：`/s/{shareId}`，其中 `shareId` 是严格的 16 位 `[0-9A-Za-z]`。
- 编辑入口：`/s/{shareId}/{editId}`，其中 `editId` 是额外 4 位 `[0-9A-Za-z]`。
- 首次发布和“发布为新链接”创建全新对象；“覆盖当前链接”只在玩家明确选择时替换原对象。
- 编辑链接只是把服务器版本复制到当前浏览器继续本地编辑；分享页“复制到我的轴”不会继承原发布关联。
- R2 只保留每条链接的最新版，并采用最后发布者生效；编辑 ID 不是安全凭证，没有 PIN、恢复密钥、锁定或穷举保护。

## 内容目录

仓库内置种子目录位于 `data/catalog-seed.json`。已发布版本按以下对象键保存，并在全部文件写入后更新 `catalog/current.json`：

```text
catalog/releases/{version}/manifest.json
catalog/releases/{version}/player-skills.json
catalog/releases/{version}/boss-mechanics.json
catalog/releases/{version}/timeline-presets.json
```

`/admin` 提供条目表单、复制、启停、校验、时间轴预览和显式发布。运行时需要：

目录 v3 支持技能施法类型、充能层数、专精归属、关键天赋变体、计算限制和核准来源。内置 `builtin-seed-v3` 以 12.1 牧师的 5 个排轴技能作为首个完整样板；其数据在正式服与 Blizzard 主来源完成交叉复核前保持“待正式服复核”，其余技能保持“数值待补”。同一成员的同一技能只能选择一个天赋版本，计划会保存目录快照，不会被后续目录静默修改。

```dotenv
ADMIN_PASSWORD_HASH=<一次性管理员初始口令的 SHA-256>
ADMIN_SESSION_SECRET=<随机会话签名密钥>
```

明文初始口令不写入仓库或运行时配置。

## 本地运行

需要 Node.js 22.13 或更高版本，以及 pnpm。

```bash
pnpm install
pnpm dev
```

Vinext/Miniflare 会按 `.openai/hosting.json` 提供本地 `OBJECTS` R2 绑定。生产环境同样只需要 R2，不需要数据库或迁移。

## 验证

```bash
pnpm test:unit
pnpm lint
pnpm build
pnpm test
```

测试覆盖 v1–v4→v5、目录 v1/v2→v3、专精过滤、成员级天赋变体、串行充能恢复、引导技能区间、来源核准、自动时间范围、精确 16+4 Base62 ID，以及 R2 创建、读取、覆盖、新链接和删除行为。

## 部署

项目使用 React、Vinext、Cloudflare Worker 与 Sites R2。`.openai/hosting.json` 将 `d1` 设为 `null`，将 R2 绑定命名为 `OBJECTS`。R2 访问集中在 `lib/object-store.ts`，可用同接口替换。

Raidline 是社区工具，与 Blizzard Entertainment 没有官方关联。
