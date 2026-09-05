# Raidline 贡献指南

感谢参与 Raidline。项目采用严格 vNext v1 模型，核心编辑体验已经稳定；Vashnik 正式服规则、跨样本目录骨架和三样本端到端验收已完成。全局玩家技能导入已接通 13 职业的匿名成员、关键技能和团队增益，仍有 17 条提取规则及技能数值待核验，详见 [第 4 步实施记录](docs/player-skill-extraction-v1.md)。快照持久化、对比分析、生产服务器存储和实际计时插件导出仍是后续里程碑。贡献时请保持领域模型清楚、边界可替换和现有双栏交互稳定。

## 开始之前

- 使用 Node.js `22.13+` 和 pnpm `11+`。
- 先阅读 [README](README.md)、[架构说明](docs/architecture.md)、[需求索引](docs/requirements/INDEX.md) 和当前 vNext 需求文档。
- 先运行 `git status -sb`。不要重置、覆盖或删除不属于当前任务的改动。
- 从 `main` 创建主题分支；建议使用 `codex/<topic>`，例如 `codex/wcl-contracts`。

## 本地开发

```bash
pnpm install
pnpm dev
```

本地页面默认由 Vinext 提供。仓库当前不维护托管平台部署配置；不要擅自增加部署接线，也不要向第三方环境上传正式 WCL 凭据、生产数据或唯一备份。

真实 WCL 探针和导入使用根目录 `.env.local` 中的 `WCL_CLIENT_ID` 与 `WCL_CLIENT_SECRET`。该文件已经被 Git 忽略；凭据只能由服务端边界读取，禁止通过 `VITE_`、`NEXT_PUBLIC_`、页面 props、日志或 fixture 暴露。

## 验证命令

按改动范围运行以下命令：

```bash
pnpm test:unit  # 领域模型、时间轴、目录、发布和契约测试
pnpm lint       # ESLint
pnpm build      # 生产构建
pnpm test       # 单元测试 + 构建 + 页面/API 集成测试
```

提交前至少要通过 `pnpm test:unit`、`pnpm lint` 和 `pnpm build`。修改路由、发布、目录或组件时必须再运行 `pnpm test`。测试失败时在 PR 中写明失败命令、原因和是否与本次改动有关。

## 改动边界

### 领域模型

- `lib/domain/schema.ts` 是 v1 结构的唯一运行时入口；Zod schema 同时提供 TypeScript 类型。
- 计划、目录、WCL 快照和导出契约必须保持提供者无关。不要把 React、IndexedDB、SQLite、文件系统、WCL GraphQL DTO 或插件语法放进领域 schema。
- 计划内定义必须是快照。目录更新或来源删除不能静默改变既有计划。
- 时间只把 `TimelineAnchor` 作为持久化真值；全局显示时间是派生值。
- 不添加旧 v1–v5 的运行时迁移器或宽松 `normalize(any)`。旧文档应得到明确的不支持错误。

### 页面和存储

- 时间轴组件消费 `TimelineScene`，不要让它直接读取完整计划对象。
- 本地编辑先写 IndexedDB；发布是显式动作。编辑计划不能因为打开页面而产生服务器写请求。
- 服务端文件存储通过 `ObjectStore` 接口访问；不要在业务逻辑中扩散具体托管平台或文件系统 API。
- 现有首页、双栏编辑器、拖拽、缩放、主题、只读分享和 MRT 阅读版是稳定工作流。视觉调整要有对应的浏览器回归验证。

### WCL 与导出

- 正式服调研与回归采用 API-first：公开排行页面只负责发现 report/fight，正式元数据、master data、phaseTransitions 和事件证据优先通过官方 WCL v2 API 获取；兼容研究源不得成为默认或生产数据源。
- 网站提供只读报告/战斗/阶段探针和导入预览。事件分页前检查史诗难度、精确 encounter profile 与独立全局玩家 profile；每页核验报告 revision，不拼接不同版本。不请求或读取角色名；响应只含匿名机制、职业 A/B 槽位、按核准条件确认的技能、团队增益和严格 plan 预览，不返回原始事件、actors 或快照。用户选择后只创建浏览器本地新计划，不合并、不对比、不写服务器。
- 玩家技能规则与 Boss 规则独立版本化；当前全局修订 v2 仅对反魔法领域允许成功施法确认，其余仍需对应生效证据。不要因为合成测试通过就把待核准规则启用或将技能数值标为 verified。
- `wcl:download`、`wcl:review` 与 `wcl:convert` 只用于开发者本地完整事件研究/转换模拟，原始分页、玩家姓名、清洗快照、导入草稿和本地计划产物必须留在被 Git 忽略的 `work/`。
- 当前兼容测试源只用于没有自有 WCL 凭据时制作 PTR 研究材料，不能成为生产导入依赖；正式接入必须回到 Raidline 自有服务端凭据和可替换 WCL 边界。
- WCL 难度只在请求边界判断；非史诗战斗必须在持久化前返回 `UNSUPPORTED_DIFFICULTY`。
- 导入结果必须先作为候选草稿展示，用户确认后才复制进计划；来源删除后计划仍可用。
- 计划内不保存 MRT、Kaze、NSRT 或 STT 语法；新增格式请实现 `ExportRequest → ExportResult` 导出器，并显式报告警告、遗漏和阻断错误。

## 提交与 Pull Request

提交应小而完整，提交信息使用简短的动词短语，例如 `Add strict catalog fixture validation`。一个提交不要同时包含无关的格式化或依赖升级。

PR 描述至少包含：

- 改了什么，以及为什么需要改。
- 是否改变 plan/catalog schema、存储边界或分享兼容行为。
- 新增或更新了哪些测试和 fixture。
- 已运行的验证命令及结果。
- 明确列出尚未实现的部分和后续建议。

不要提交 `.env`、访问令牌、管理员口令、WCL 原始响应、生产数据库、`dist/`、`.vinext/` 或临时日志。发现安全问题请不要创建公开 issue，先通过仓库所有者提供的私下渠道报告。

## AI 接手任务

给自动化开发者的约束集中在根目录 [AGENTS.md](AGENTS.md)。AI 开始工作时应先输出将修改的范围，完成后提供文件清单、测试结果、已知缺口和下一步，不得把“构建通过”当作真实 WCL、生产存储或插件导入已经完成。
