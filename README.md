# 团轴 Raidline

面向《魔兽世界》团本的个人排轴与机制压力计算工具。可以从零编排，也可以导入公开的 Warcraft Logs（WCL）战报，再围绕 Boss 机制安排团队减伤、外部技能、个人减伤和治疗爆发。

![团轴 Raidline 预览](public/og.png)

## 当前功能

- 表格式工作台：成员/技能表、可转置时间轴、属性与计算表，左右面板可收起，手机端使用抽屉
- 跟随系统、亮色和深色三档主题，页面绘制前应用并按当前设备记忆
- 时间横向/人员纵向与时间纵向/人员横向两种视图；桌面和手机分别记忆方向与缩放
- 时间轴内 `Ctrl + 滚轮`指针锚定缩放，另有按钮和滑杆；施法段、效果段、零长度与未知长度分开表达
- schema v2 团队分组和目标系统：全团、自定义分组、职责、具体成员或跟随机制
- 机制直接伤害、持续跳伤、物理/魔法类型、目标范围、施法长度与持续时间
- 统一防御计算：免疫 → 多项减伤乘算 → 吸收盾 → 实际伤害；支持共享盾、逐人盾和最大生命提升
- 按成员计算相邻机制压力、最高个人治疗需求、团队伤害和致死阈值；不维护血条，也不扣除计划治疗
- 团队、外部和个人技能；个人减伤固定作用施放者，并检查职业、目标上限、读条、GCD、冷却和覆盖范围
- 内置正式服核心技能框架，数值默认留空；保留旧计划数据并在读取时迁移 v1 → v2
- 内置“连续 AoE 压力示例”，以及存储在当前设备 IndexedDB 的完整个人预设，支持 JSON 导入、导出和删除
- 800ms 自动保存、撤销/重做、恢复链接、只读分享、MRT 文本与计划 JSON 导出
- 公开 WCL 战报预览和导入；无法可靠取得的伤害与时间字段保持未知，不制造计算结果

## 项目状态

Raidline v2 已完成。站点默认以仅所有者可见的方式发布，因此外部访客暂时无法打开匿名只读分享链接。大秘境、账号体系、公开社区与实时多人协作尚未加入。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm ci
```

复制 `.env.example` 为 `.env.local`。如需使用 WCL 导入，再填写 WCL Client ID 与 Client Secret；空白排轴和手动计算不依赖这些凭据。

```bash
npm run dev
```

随后访问终端中显示的本地地址。首次调用计划接口时，本地 D1 会自动创建开发用数据表；正式环境使用 `drizzle/` 中的数据库迁移。

## 测试与构建

```bash
npm run test:unit
npm run lint
npm test
npm run build
```

- 核心单元测试覆盖 v1→v2 迁移、WCL 分页、目标分组、冲突、压力与减伤、预设、MRT 和时间轴换算
- 接口集成测试覆盖创建、鉴权、保存、版本冲突、只读脱敏、WCL 未配置、v1 兼容和 v2 往返
- 生产构建生成 Cloudflare Worker 兼容输出

## 数据与安全

- 计划正文保存在 Cloudflare D1；浏览器只保存设备查看偏好、个人预设、最近入口和编辑密钥
- 编辑密钥位于恢复链接的 URL fragment 中，服务端仅保存 SHA-256 哈希
- 乐观锁通过计划版本避免静默覆盖；冲突时可加载服务器版本或另存为新计划
- WCL Client Secret 只可配置为服务端环境变量，切勿提交到 GitHub
- 当前仅支持公开 WCL 战报

## 需求记录

后续需求统一记录在 [`docs/requirements/`](docs/requirements/)：

1. 在 [`INDEX.md`](docs/requirements/INDEX.md) 中登记优先级和状态。
2. 复制 [`TEMPLATE.md`](docs/requirements/TEMPLATE.md)，按 `YYYY-MM-功能名称.md` 命名需求文档。
3. 截图、草图与其他附件放入 `docs/requirements/assets/`。
4. 每次实现后由 Codex 更新验收结果和变更记录。

## 部署

项目使用 React、Vinext、Drizzle、Cloudflare Worker 与 D1，可通过 OpenAI Sites 私有发布，也可以迁移到兼容的 Cloudflare Workers 环境。正式部署前需要应用 `drizzle/` 中的数据库迁移，并在托管环境中配置可选的 WCL 环境变量。

## 免责声明

Raidline 是社区工具，与 Blizzard Entertainment 或 Warcraft Logs 没有官方关联。
