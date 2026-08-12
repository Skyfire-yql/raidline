这份文件作为给ai阅读的机制说明，不是结构化文件，需要二次加工。

详细数据可以参考：https://www.wowhead.com/ptr/guide/midnight/raids/venomous-abyss-vashnik-the-malignant-boss-strategy-abilities#vashnik-the-malignant-2882-details-abilities

场地机制：场地上有三个喷泉，分别是Fountain of Blood（红），Fountain of Shadow（紫），Fountain of Flame（橙）

Malignant Burst - 灭团技，有 Living Venom 进入中央的 Malignant Cavity 时触发

Malignance - 由 Malignant Tumor 施放的全团毒波，并附加长时间、可叠加的持续伤害；与 Malignant Burst 是两个不同机制

Toxic Vapor - 贯穿全场的持续伤害

Plague Froth - 召唤带有伤害的分散圈，一段时间后射出十字海浪（Plague Wave）；需要让海浪命中地上的 Malignant Tumor，以移除其 Hardened Tumor 减伤效果

Dripping Fangs - 打T技能

Imbibe - 会同时激活两个喷泉。当前五场 WCL 样本中的顺序固定为：第一次橙色（Burning Venom）+紫色（Shrouded Venom），第二次红色（Clotting Venom）+橙色，第三次红色+紫色，第四次回到橙色+紫色，之后继续循环

Malignant Catalyst - Aoe并召唤分散圈，接分散圈的人会受到Catalytic Bile伤害，如果没人接会灭团

Siphoning Infection - 通常点名两名玩家，施加持续伤害、治疗吸收，并使其受到的普通治疗量降低 100%。被点玩家会周期性产生 Siphon Blood 圈；其他玩家需要进入圈内承受伤害，Siphon Blood 会根据命中的附近玩家治疗被点者，从而清掉治疗吸收。若没有队友进入，治疗者无法用普通治疗清掉吸收，被点者会被持续伤害击杀

## WCL 首版时间轴转换决定

- 当前优先把 WCL 战斗记录转换为网页机制时间轴；复盘可以后置，但失败结果、伤害证据和关系事件的审查标记继续保留。
- 五场样本按单阶段处理。Imbibe 不决定阶段；首版只显示 `1284663 begincast → cast` 的约 4 秒读条区间，并用 `1284669/1284670/1284671` 标注喷泉组合。更长区间的终点之后再定。
- Malignant Catalyst 显示为一个复合机制实例：`1282516 begincast` 为开始，`1282516 cast` / 聚类后的 `1282525 damage` 为 AOE 判定，聚类后的 `1282602 damage` 为同一实例内的 Catalytic Bile 接圈判定。`1282616` 只保留为漏接证据。
- Plague Froth 使用同一套“一个机制实例、多个阶段”的通用逻辑：聚类后的 `1281913 applydebuff → removedebuff` 是 Froth 持续阶段，结束时点同时是同一实例内的即时 Plague Wave 判定；不通过 Wave damage 判断是否生成。
- Dripping Fangs 使用 `1280935 begincast → cast/damage`；同机制的减益、层数和持续伤害不单独建轴。
- Siphoning Infection 从 `1295224 applydebuff` 开始，同轮多目标合并；Siphon Blood 暂不稳定追踪。
- Toxic Vapor 只显示 `1284563` 初始光环和层数变化，不显示 `1284561` Tick。
- Malignance 独立保留但不进入首版时间轴；其事件可能与 Tumor 死亡或动态状态相关，后续再审。
- WCL 与导入草稿保留毫秒；写入整秒 plan v1 时向更早方向吸附：`floor(atMs / 1000) * 1000`。
- 其他敌方事件只有在跨样本时间稳定、机制语义明确且要求玩家处理时才进入时间轴；小怪死亡、随机机制、玩家失误或证据不足的事件保持待审。
