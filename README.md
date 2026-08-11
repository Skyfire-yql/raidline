# 团轴 Raidline

面向《魔兽世界》团本的本地优先排轴工具。工作副本保存在浏览器 IndexedDB；只有玩家明确发布时，才会把点击瞬间冻结的计划快照写入对象存储。

![团轴 Raidline 预览](public/og.png)

## vNext v1 模型

Raidline 当前采用全新的严格 v1 格式，不读取或迁移旧 plan v5、catalog v3、旧 IndexedDB 测试数据或旧分享正文。

- `RaidPlanDocument.schemaVersion` 固定为 `1`，包含独立计划标题、遭遇、来源、定义快照、名单和时间轴。
- 技能与机制定义保存在 `definitions`；计划内实例只引用稳定 UUID。目录或 WCL 来源失效后，完整快照仍可使用。
- `roster` 保存稳定成员槽位、多策略组、可选 1–8 小队和成员级技能变体；计划正文不保存服务器或 WCL actor ID。
- `timeline` 分开保存阶段、机制实例、战术任务/说明和技能安排。
- 所有计划时间只持久化为 `TimelineAnchor`：开怪后、阶段开始后，或机制施法开始/命中/结束后的偏移。拖动只修改当前锚点偏移。
- 计划对象按 1 秒对齐；显示范围由可解析内容结束点加 30 秒后自动计算，范围为 2–120 分钟。
- 结构解析拒绝旧版本、未知字段、重复实体 ID、非整秒计划时间和超过 1 MB 的计划；引用循环、悬空引用和职业不匹配由独立语义诊断处理。

## 本地保存与发布

- `plans` 保存工作副本，停止编辑 300ms 后写入；`localRevision` 阻止旧标签页静默覆盖新标签页。
- `snapshots` 每分钟以及发布、目录升级和破坏性操作前建立检查点；每条轴保留 30 个，总量限制为 100 MB。
- `catalogCache` 缓存当前目录，`settings` 只保留主题等设备级界面设置。IndexedDB 升级到 vNext 时会清空旧计划、旧检查点和旧目录缓存。
- 工作副本没有自动云端保存、账号同步或 JSON 文件导入导出。
- 只读地址为 `/s/{shareId}`，编辑入口为 `/s/{shareId}/{editId}`；ID 分别严格使用 16 位和 4 位 `[0-9A-Za-z]`。
- 编辑入口只是把服务器快照复制到当前浏览器。覆盖和删除必须显式操作；编辑 ID 不作为高强度安全凭证。

## 内容目录

仓库内置严格 catalog v1 种子目录：[data/catalog-seed.json](data/catalog-seed.json)。它包含 5 个牧师排轴技能、4 个示例机制和 1 个不含名单或执行安排的 Boss 骨架预设。

应用预设时会把所需机制定义与当前技能定义复制进计划。已发布目录继续按以下对象键保存，并在所有文件写入后更新 current 指针：

```text
catalog/releases/{version}/manifest.json
catalog/releases/{version}/player-skills.json
catalog/releases/{version}/boss-mechanics.json
catalog/releases/{version}/timeline-presets.json
catalog/current.json
```

`/admin` 提供 v1 技能、机制和 Boss 骨架表单，以及校验与显式发布。运行时需要独立管理员配置：

```dotenv
ADMIN_PASSWORD_HASH=<管理员口令的 SHA-256>
ADMIN_SESSION_SECRET=<随机会话签名密钥>
```

## WCL 与导出边界

- `CombatLogSnapshot`、`EncounterConversionProfile`、`PlanImportDraft` 和 `ComparisonRun` 都有提供者无关的严格 v1 契约与 fixture。
- WCL fight 难度只在请求边界临时检查；非史诗战斗以 `UNSUPPORTED_DIFFICULTY` 停止，难度不写入长期结构。
- 战斗快照保留原始毫秒精度；GraphQL DTO、WCL 缩写和插件语法不会进入计划模型。
- 当前阶段不连接真实 WCL、不启动任务队列，也不实现真实对比计算。
- 导出统一使用 `ExportRequest → ExportResult`。首个导出器为 MRT 阅读版；无法可靠表达的阶段触发会产生显式降级警告，阻断错误不会静默输出。

契约 fixture 位于 [data/fixtures](data/fixtures)。

## 本地运行与验证

需要 Node.js 22.13 或更高版本，以及 pnpm。

```bash
pnpm install
pnpm dev
pnpm test:unit
pnpm lint
pnpm build
pnpm test
```

测试覆盖严格读取、锚点解析与循环、自动范围、多策略组与小队、阶段任务与说明、技能充能/施法/引导、目录快照隔离、WCL 边界、16+4 发布规则和发布 API。

## 项目结构与开发入口

Raidline 将“计划数据”“时间轴解析”和“页面展示”分开，便于在不改动编辑器交互的情况下替换存储或增加导入器：

```text
lib/domain/schema.ts       严格 v1 Zod schema 与推导类型
lib/domain/timeline.ts     锚点解析、目标解析、语义诊断
lib/domain/view-model.ts   RaidPlanDocument → TimelineScene
lib/core.ts                计划业务规则、冲突检查、统一导出
lib/catalog.ts             目录校验、预设应用、快照升级
lib/publications.ts        发布对象和 16+4 分享规则
lib/wcl-contract.ts        WCL 边界契约（当前不发起真实网络请求）
app/components/            首页、双栏编辑器、只读页和目录管理
app/api/                   发布、目录和管理员边界
data/catalog-seed.json     内置 v1 目录
data/fixtures/             WCL/导入/对比契约 fixture
tests/                     单元和渲染/API 集成测试
```

详细的依赖边界、数据流和后续里程碑见 [架构说明](docs/architecture.md)；贡献者先阅读 [贡献指南](CONTRIBUTING.md)，AI 或自动化开发先阅读根目录 [AGENTS.md](AGENTS.md)。需求决策以 [需求索引](docs/requirements/INDEX.md) 和当前 vNext 文档为准。

### 修改前的最小流程

1. 运行 `git status -sb`，确认没有覆盖其他人的未提交改动。
2. 阅读相关 schema、业务函数和测试；不要从旧 v5/v3 代码推断兼容行为。
3. 先补充失败测试，再实现改动；领域模型变化必须同时更新 fixture 或往返测试。
4. 运行 `pnpm test:unit`、`pnpm lint`、`pnpm build`，涉及页面或 API 时再运行 `pnpm test`。
5. 在 PR 中说明数据模型影响、迁移/不兼容决策、测试结果和未完成边界。

主分支只接受可审阅的功能提交；日常开发请从 `main` 创建 `codex/<topic>` 或 `<topic>` 分支。不要提交 `.env`、WCL 凭据、管理员口令、生产数据、构建产物或临时分享内容。

## 托管边界

当前 Sites 项目仍只用于私有交互验证，`.openai/hosting.json` 继续提供 `OBJECTS` R2 绑定；本阶段不部署 Sites，也不接入真实 WCL 或大陆服务器数据库。

长期生产目标是中国大陆普通 Linux 服务器。对象存储已经收敛到小型 `ObjectStore` 接口；SQLite、持久数据目录和 WCL 后端将在后续阶段按独立契约实现，不在 vNext v1 对象模型切换中伪装完成。

Raidline 是社区工具，与 Blizzard Entertainment 没有官方关联。
