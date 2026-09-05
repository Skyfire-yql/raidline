# 全局玩家技能提取 v1：实施与验收记录

日期：2026-09-05。范围为当前路线第 4 步，不包含第 5 步实际计时插件格式。

## 当前交付状态

本记录对应 `codex/wcl-player-skill-import` 的阶段性实现，汇总匿名玩家技能导入、反魔法领域 v2 修订以及目标／分组简化三轮工作。前 3 步已完成；第 4 步仍有 17 条提取规则及技能数值待核验，尚未关闭完整验收门槛。当前代码保留严格 schema v1，仅新增可选字段，不迁移存量计划，不做 WCL 服务器持久化或生产部署。

下方真实 WCL 和浏览器记录来自专项任务的实际验收，不表示本次汇总重新调用了 WCL。后续先完成本文“已知缺口与发布门槛”，再讨论第 5 步实际计时插件格式；提交与同步状态以 Git 记录为准。

## 本轮修订：简化技能面板与反魔法领域

- 用户确认反魔法领域以成功施法为准。发布全局 profile 修订 v2，保留 v1 原文与读取能力；不是将所有技能改为只看施法。
- v2 的反魔法领域使用 `confirmation: { kind: "cast-success" }`。仍检查玩家职业、主动成功施法、死亡／复活与去重；没有光环归属也能生成候选。使用所选定义的基础持续时间与全团计划目标，不推断真实覆盖名单。
- 新导入背景文字固定为“嗜血”；技能安排的自动备注为空。来源 ID、规则版本和事件引用保持独立，不再复制为玩家备注。
- 技能面板删除两段变体／时长操作说明，不展示审核限制列表，底部只展示技能效果。改变效果的变体使用其效果说明，冷却类变体沿用基础效果；用户备注入口默认折叠。
- 现有计划只做显示与阅读导出的精简：精确识别旧版生成的嗜血标题，以及带提取规则来源的完整自动备注。用户手写／追加／改过的文字保留，未自动改写快照或清空旧计划。
- `RaidPlanDocument` 与目录结构均不变，无存储迁移；反魔法领域新增使用记录只出现在新导入中，不回填既有计划。
- 同一真实样本的新预览为 70 个机制、20 人、150 次技能，其中反魔法领域 4 次，开始时间分别为 00:53.150、03:05.608、04:35.306、05:57.247；计划约 200,839 字节，自动技能备注 0 条，反魔法领域生效未确认警告 0 条。
- 浏览器重新打开原验收轴并选择 04:24 复仇之怒，已验证两段操作说明与来源备注消失、效果文字保留、旧嗜血标题显示为“嗜血”。没有替用户重新建轴或修改原计划内容。
- 该轮单元测试 69 / 69 通过，包含 v1 历史规则、v2 单技能例外、死亡与重复施法、文本非破坏性处理和效果变体测试；沿用下方记录的命令再次执行类型检查、lint、生产构建和页面/API 集成测试（1 / 1），全部通过。`git diff --check` 通过，旧 v1 profile 的内容比较确认没有变化。该轮未部署。

## 已确认范围

- v1 同时覆盖 13 个职业，按可排轴的团队减伤、大治疗、个人防御和少量团队功能筛选。普通输出循环和伤害爆发延期。
- 人工审批共 173 项，77 项 Y、96 项 N。互斥替代技能合并为同一技能族后，目录提供 72 个可选定义。
- 非自身单体减伤、治疗、护盾、保命外部技能不纳入。神圣壁垒、法师三系常规屏障、渐隐、佯攻、猩红之瓶、挫志怒吼、援护及其他已否决项不重新启用。
- 激活和空间悖论属于保留的资源／施法支援。嗜血类保持 N：不建立成员技能卡，仅以实际光环窗口形成全轴背景。
- 新建本地计划优先，不实现合并现有计划、对比或同步。任何服务器数据库、队列、战斗快照持久化、大陆部署均不在本轮范围内。

## 对象与版本

权威结构仍是 `lib/domain/schema.ts`。不引入另一套领域 DTO 或旧格式迁移。

| 对象 | 调整 |
| --- | --- |
| 全局技能数据 | `data/player-skills-retail-12.1.json`，72 个技能族，完整中文说明、基础数值、限制、可选变体 |
| 全局提取规则 | `data/player-skill-extraction-profile-retail-12.1-v2.json` 为当前修订，gameVersion=`retail-12.1`；v1 文件原文保留，均独立于 encounter profile |
| PlayerSkillExtractionRule | 引用全局 definitionId，可选 variantId；主动 cast-success allowlist。confirmation 明确区分成功施法例外和包含事件、法术 ID、时间窗口、目标与人数的生效佐证 |
| verification | pending / fixture-verified / live-verified 分开；记录证据及报告代码。通过合成测试不等于完成真实日志或全部数值核准 |
| SkillVariant | 可选 spellId 表示实际替代法术；天赋 ID 不当作主动施放 ID |
| SkillAssignment | 可选 variantId 和整秒 timing，仅覆盖本次施放；缺省时保持原有成员默认变体逻辑 |
| PlanImportDraft | 可选 playerSkillProfile、noteCandidates；技能候选保存毫秒 observed 时点，与计划整秒锚点分开 |
| TacticalNote | 可选 timelinePresentation=`team-buff-window`，以精确时间锚点和正持续时长绘制团队增益背景 |
| CombatLogSnapshot | 增加 resurrection、absorb 语义事件；不把 WCL DTO 放入领域层 |
| PlanSourceRecord | 可选 conversionProfiles 记录 Boss 与全局玩家规则版本，仅追溯，不参与编辑或时间解析 |
| 内置目录 | builtin-seed-v6，72 个启用技能，另保留 1 个禁用的历史痛苦压制条目；旧计划中的完整快照不被覆盖 |

严格 v1 只增加可选计划字段，不改写旧计划、不补默认字段。旧版本程序不能保证读取含新字段的新计划；回滚前须保留新计划原文，用支持这些字段的版本打开，不能静默剥离字段。

## 数据流与隐私

1. 浏览器提交公开报告链接和 fightId。
2. 服务端探针确认史诗难度，精确选择 encounter 3455 / retail-12.1 / v3，以及独立全局玩家 profile v2。
3. 读取无姓名的 masterData actors，仅用于瞬时数字身份映射与宠物归属。查询不包含 actors.name 或 playerDetails；事件使用 useActorIDs=true、includeResources=false。
4. CombatantInfo 仅取 sourceID / specID；不保留天赋树、装备、角色名等附带字段。未知或冲突专精不从技能倒推。
5. 采集规则合并并将 ability allowlist 下推；两个 provider hostility 视图在匿名规范化后按规则过滤。All 仅用于带精确 death/resurrect 过滤的生命周期核验。
6. 在每个事件页比较 report revision。元数据或分页版本改变时整个预览失败，不拼接不同版本。
7. 纯函数生成匿名槽位、按核准条件确认的技能候选和独立背景注释。反魔法领域仅需成功施法，其他技能仍需生效证据；Boss 转换与玩家转换互不生成或推断对方的对象。
8. 返回匿名候选摘要和严格 plan 预览。原始事件、actors、报告演员 ID、凭据、敏感头、快照、导入草稿均不返回。
9. 用户逐项选择后，只在浏览器保存新计划。完整技能／机制快照、成员与锚点已复制，之后不再请求 WCL。来源缺失仅为追溯警告，不改变内容。

同职业槽位按报告内部数字 ID 稳定分配 A/B/C，随后按坦克、治疗、DPS 排序；数字 ID 不进入 RosterSlot。不同报告间不做身份关联。角色名始终未请求、未读取，匿名名字可在编辑器修改。

## 事件处理规则

- cast-start 只帮助恢复已确认施放的开始时间，不独立建轴。除用户批准的反魔法领域例外，cast-success 必须同时匹配本规则的生效佐证。
- 生效包括正确施法者或有明确 owner 的宠物所施加的光环、治疗（含过量治疗）、实际正数吸收、成功驱散。零吸收不算成功；预备动作、被动光环、未知归属不补成主动安排。
- 同一施法者、技能族按原始毫秒去重；跨视图／分页相同事件先规范化去重，再按规则的短去重窗口聚合。不会以整秒取整进行去重。
- 多目标光环及治疗 tick 只证明同一次使用。每个初始光环与它的首次完整移除配对；后续被动重新触发不延长本次区间，移除一层不等于整个光环结束。
- 没有完整结束证据时，保留已证明的施放，使用已配置基础时长；该规则在导入预览详情说明，不写入技能备注。不能由此宣称完整团队覆盖或完整引导。
- 结束时点不超过战斗结束；计划的开始、命中、结束向前取整到秒。读条施法与引导区间使用不同语义。
- 死亡后、未出现复活证据的主动施放不导入。宠物仅凭明确归属与主人关联，不能凭名称、职业数量或时点猜主人。
- 小于基础 CD 的真实已生效施放保留，产生提示。不会根据间隔猜双充能、天赋、动态 CD 或重置。互斥替代技能共享同一技能族；仅单次可证明的替代法术覆盖本次变体。
- 玩家安排在后续官方阶段内使用 phase anchor；P1 使用 pull anchor。不按附近 Boss 机制自动吸附，不把内部循环猜成阶段。
- 嗜血背景只使用至少 2 名不同友方同时生效的实测重叠区间，不猜施放者、不证明全员覆盖；单人的被动触发、延长以及同一人多条光环不扩大背景。阈值由全局规则 minimumTargets 明示；缺少结束记录时不猜固定 40 秒。背景不参与成员技能或减伤计算。

## 前端行为

- 首页同时展示机制、匿名人员和玩家技能。可按职责、职业、技能类别筛选；分别全选、取消筛选结果或逐项选择。
- 新导入计划的团队技能目标为全团，个人技能目标为自己；WCL 受益人仅用于施放生效核验，不再作为新计划的指定成员目标。取消成员会同时取消由其施放的候选，重新选择成员不会自动恢复技能勾选；已有预览中的指定成员依赖仍严格检查。
- 预览的来源说明列出规则版本、待核准条目和最多 100 条诊断；总数单列。无证据不等于未施放，界面不宣称恢复原团队完整战术。
- “新建本地计划”防重复点击。链接或战斗变化使旧请求结果失效，旧预览不能覆盖新选择。
- 成员排序为坦克、治疗、DPS；职责底色按 18% 与白色混合。基础色为 #1980E0 / #4DCF29 / #C41E3A，混合结果 #D6E8F9 / #DFF6D8 / #F4D7DC。职业标识使用 Blizzard 职业颜色。横轴、竖轴一致。
- 团队增益背景独立于职责底色，使用淡金色覆盖时间窗口。其注释可选中、调整锚点和时长、关闭背景显示或删除。
- 本次技能变体和区间可独立编辑。改选另一个技能会清除不再适用的本次变体／时长；恢复基础值是显式操作，不自动覆盖原计划。
- 技能目标只提供“全团 / 自己”，不再提供具体成员、职责、策略组、小队或继承机制目标。新建手动安排按技能范围默认选择；时间锚定到机制不等于继承其目标。显式更换技能重设默认目标，更换施法成员时“自己”跟随新成员。
- 暂时移除成员编辑／只读面板的策略组和小队入口；职责排序、职责底色、职业色不变。Boss 目标仅提供全团，任务执行者保留全团／具体成员，不提供分组。任务执行者不是技能受益目标。
- 不改 plan schema v1 或已发布提取 profile。自己使用既有成员选择器保存单个施法成员 ID。已有分组、职责、小队、指定其他成员和继承目标不自动转换或删除；选择器以不可选占位“保留原目标”显示，只有用户明确选择新目标才覆盖。新导入的目标简化发生在创建独立计划的边界，草稿和生效证据不改写。

## 已知缺口与发布门槛

目前 78 条技能提取规则中 61 条启用、17 条待核验。72 个目录技能族均可按说明手动安排；自动提取覆盖不能等同于完整目录范围。

待自动提取核准：万灵之召、静滞释放、扭转天平＋梦境吐息、操控时间、青龙／朱鹤、天神御身、天神灌注、玄牛、圣洁鸣钟、福音、终极苦修、清毒图腾、战栗图腾、恶魔治疗石、灵魂燃烧治疗石变体、光晕。这些条目不能因为存在存储／准备／召唤事件就自动建轴。

反魔法领域的环境光环仍不能可靠归属，但不再阻止导入：v2 按用户批准只采用玩家成功施法记录，不按邻近时间匹配光环或猜测受益人。

目录 dataStatus 仍标为 needs-live-check。施放识别通过，不代表所有基础数值、专精变体、充能与动态 CD 都已实测。路线第 4 步完整发布门槛尚未全部关闭，不进入第 5 步游戏内插件导出。

## 失败语义与回滚

- INVALID_WCL_IMPORT / INVALID_WCL_LINK：422，请求格式或链接无效，不回显原始输入内容。
- UNSUPPORTED_DIFFICULTY / profile 未配置：422，在事件抓取前停止。
- WCL_REPORT_CHANGED：409，可重新读取；不接受混合 revision。
- WCL_RESPONSE_INVALID：502，严格结构或分页异常，不返回上游详细 payload。
- WCL_PLAN_TOO_LARGE：413，超过 1 MB 整体拒绝，不截断成员或技能来凑大小。
- WCL_AUTH_FAILED、WCL_NETWORK_FAILED、WCL_RATE_LIMITED：维持既有安全错误，恢复后用户手动重试。
- PLAYER_SPECIALIZATION_UNKNOWN / PLAYER_SKILL_AMBIGUOUS / PLAYER_SKILL_EFFECT_UNCONFIRMED / PLAYER_SKILL_AFTER_DEATH：可定位的预览警告，相关候选不生成。
- PLAYER_SKILL_COOLDOWN_UNCERTAIN：提示基础 CD 无法解释，但保留实际生效候选。
- TEAM_BUFF_END_UNCONFIRMED：背景没有可靠结束证据，不生成猜测时长。
- 无效／过期选择在浏览器明确失败，不能保存半个计划。导入失败不影响已有计划或手工建轴。
- 回滚规则应发布后继修订或停用问题规则，不改写已保存快照。退回旧程序前先备份新字段计划；不得清空本地存储、迁移降级或自动删除安排。

## 首次 v1 实测与测试（历史记录）

真实样本为公开报告 fhBFw4RybzqLC19H / fight 32，encounter 3455，史诗击杀 7:08.025，revision 287。真实解析得到 70 个机制、20 人（2 坦克、5 治疗、13 DPS）和 146 次技能，涉及全部 13 个职业。

其中神圣赞美诗 5 次、回溯 2 次、灵魂链接 2 次、光环掌握 2 次、黑暗 2 次；技能定义共 35 个实际名称。没有可靠归属的反魔法领域保持警告。该单份日志不能证明所有职业的所有批准技能均被覆盖。

API 最终汇总复核：HTTP 200；严格计划 216,235 字节，完整预览 268,045 字节，含 1 个开场 00:00—00:40 的嗜血背景。未发现 actors/events/sourceActorKey/targetActorKey/reportActorId、装备天赋树或凭据字段。只检查统计与匿名预览；真实事件未写磁盘、未纳入 fixture。

合成测试覆盖每条启用规则的 cast+effect 正例、cast-only 反例，以及姓名隔离、同职业多人、专精缺失、宠物归属、过量治疗、实际吸收、被动再触发、去重边界、死亡复活、短场截断、动态 CD 提示、替代变体、官方阶段锚点、来源独立、逐项选择依赖、1 MB、嗜血背景。WCL 客户端测试覆盖姓名不查询、事件 allowlist、生命周期过滤、分页 revision 与史诗前置门槛。

实际执行的检查使用已安装依赖：

- `node node_modules/tsx/dist/cli.mjs --test tests/core.test.ts tests/wcl.test.ts tests/wcl-event-review.test.ts tests/wcl-conversion.test.ts tests/wcl-import.test.ts tests/player-skill-import.test.ts`：65 / 65 通过。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/eslint/bin/eslint.js app lib scripts tests '*.ts' '*.mjs' --ignore-pattern dist --ignore-pattern .next`：通过。
- `node node_modules/vinext/dist/cli.js build`：通过。
- `node --test tests/rendered-html.test.mjs`：生产构建的页面／API 集成测试 1 / 1 通过。
- `git diff --check`：通过；仅有仓库现有换行转换提示。

包管理器联网校验失败，因此没有将 pnpm 安装报告为成功，也没有更改依赖版本或绕过安全检查。

### 浏览器端到端验收

本地服务使用项目已有配置正常加载凭据；代理没有读取、输出或复制凭据文件内容。

1. 从首页提交报告链接，选择 fight 32，实际调用只读 WCL 探针与事件解析，预览为 70 个机制、20 人、146 次技能、1 个背景。
2. 按治疗职责筛选并取消筛选结果，已选技能降为 101；重新选中筛选结果恢复为 146，其他职责没有被影响。
3. 明确取消开场“毒性蒸汽 ×1”和死亡骑士C开场“符文刃舞”，创建全新本地计划；最终 69 个机制、20 人、145 次技能、1 个背景。
4. 修改计划名称为“M4 Vashnik · 实际日志导入验收（筛选示例）”，将猎人A改为“猎人A（可改名示例）”，界面显示“本地已保存”。
5. 完整刷新页面后，DOM 再次核对 69 个不同机制、20 条成员轨道和 145 次技能；取消项没有复活，名称和开场 40 秒背景完整保留。
6. 横向／纵向切换及亮色／深色均人工查看截图；职责轨道颜色实际为 #D6E8F9 / #DFF6D8 / #F4D7DC，标签深色文字可读，职业色条独立保留。最后恢复“跟随系统”和横向时间轴。

验收计划 ID：`6a83eaac-ceba-4dd6-a335-71fb358aeda8`。仅保存在本次使用的内置浏览器中，页面为 `http://localhost:3001/plans/6a83eaac-ceba-4dd6-a335-71fb358aeda8`。在另一个浏览器打开同一地址不会自动获得该本地计划。没有点击发布、没有创建分享链接。

该次验收未部署；实现分支为 `codex/wcl-player-skill-import`。现有分享功能的集成测试仅使用独立临时测试目录，不写真实发布服务。

## 2026-09-05 目标与分组简化验收

- 修改模块：技能目标编辑组件、成员编辑／只读面板、技能默认目标辅助函数、WCL 草稿建计划边界和预览提示。plan schema v1、目录和已发布提取 profile 未改变；无存量迁移或自动写回。
- 自动测试新增：仅两种可选目标、原目标只读占位且渲染不改数据、新导入按技能范围选全团／自己、不把受益人变成目标依赖且保留草稿证据。既有分组、指定成员和继承机制目标的解析回归继续保留。
- 单元测试命令 `node node_modules/tsx/dist/cli.mjs --test tests/core.test.ts tests/wcl.test.ts tests/wcl-event-review.test.ts tests/wcl-conversion.test.ts tests/wcl-import.test.ts tests/player-skill-import.test.ts`：71 项通过。
- 类型检查 `node node_modules/typescript/bin/tsc --noEmit`、构建 `node node_modules/vinext/dist/cli.js build` 通过；`node --test tests/rendered-html.test.mjs`：1 项通过。
- `node node_modules/eslint/bin/eslint.js app lib scripts tests '*.ts' '*.mjs' --ignore-pattern dist --ignore-pattern .next` 无错误、无警告；`git diff --check` 通过（Git 仅提示仓库已有换行符设置）。
- 浏览器通过 computer-use 技能检查已有验收计划：成员面板无策略组和小队；吸血鬼之血显示自己、复仇之怒显示全团；仅两种可选项，无目标成员复选框。另一个原先指定其他成员的安排保持不可选“保留原目标”。整个检查未编辑计划，页面保持本地已保存、撤销不可用、尚未发布。
- 该轮未进行真实 WCL 请求，未读取凭据或部署。

## 主分支汇总检查（2026-09-05）

按本文记录的同一组命令重新执行单元测试（71 / 71）、TypeScript、ESLint、生产构建和页面／API 集成测试（1 / 1），全部通过；`git diff --check` 通过。本次只同步已确认实现与进度文档，没有新增功能、重新调用真实 WCL 或重跑浏览器人工验收。

## 一手技术依据

- WCL Report schema：https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html
- WCL EventDataType：https://www.warcraftlogs.com/v2-api-docs/warcraft/eventdatatype.doc.html
- WCL CombatantInfo：https://www.warcraftlogs.com/scripting-api-docs/warcraft/interfaces/RpgLogs.CombatantInfoEvent.html
- 字段差异以本次官方 v2 API 只读响应验证：CombatantInfo 的 JSON specID；Healing 中 absorbed 的 abilityGameID 是吸收技能，extraAbilityGameID 不作为技能施放 ID。
- 真实样本确认 Spirit Link 的 325174 宠物光环、Time Spiral 的 13 种受益职业光环及 Darkness 的 209426 吸收事件。网络社区清单仅用于定位待核 ID，不作为 WCL 身份推断依据。
