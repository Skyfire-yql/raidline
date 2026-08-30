export type WclActorAffiliation =
  | "enemy"
  | "environment"
  | "friendly-pet"
  | "friendly-player"
  | "other";

export type WclReviewCategory = "enemy" | "player" | "system" | "unknown" | "excluded";

export interface WclCompatActor {
  id: number;
  name: string;
  guid?: number;
  type?: string;
  subType?: string;
  petOwner?: number | null;
}

export interface WclCompatFight {
  id: number;
  start_time: number;
  end_time: number;
  encounterID?: number;
  boss?: number;
  name: string;
  difficulty?: number;
  kill?: boolean;
  bossPercentage?: number;
  friendlyPlayers?: number[];
  friendlyPets?: Array<{ id: number }>;
  enemyNPCs?: Array<{ id: number }>;
  phases?: Array<{ id: number; startTime: number }> | null;
}

export interface WclCompatReport {
  title?: string;
  start?: number;
  end?: number;
  zone?: number;
  lang?: string;
  logVersion?: number;
  gameVersion?: number;
  masterData?: { actors?: WclCompatActor[] };
  fights: WclCompatFight[];
  friendlies?: WclCompatActor[];
  enemies?: WclCompatActor[];
  friendlyPets?: WclCompatActor[];
  enemyPets?: WclCompatActor[];
}

export interface WclRawAbility {
  name?: string;
  guid?: number;
  type?: number;
  abilityIcon?: string;
}

export interface WclRawEvent {
  timestamp: number;
  type: string;
  fight?: number;
  sourceID?: number;
  sourceInstance?: number;
  targetID?: number;
  targetInstance?: number;
  attackerID?: number;
  attackerInstance?: number;
  ability?: WclRawAbility;
  extraAbility?: WclRawAbility;
  amount?: number;
  stack?: number;
  resourceChange?: number;
  resourceChangeType?: number;
  hitPoints?: number;
  maxHitPoints?: number;
  name?: string;
  encounterID?: number;
  [key: string]: unknown;
}

export interface WclReviewActor {
  actorId: number | null;
  gameId: number | null;
  name: string;
  type: string;
  subType: string;
  affiliation: WclActorAffiliation;
}

export interface WclReviewWave {
  atMs: number;
  eventCount: number;
  uniqueTargetCount: number;
  amountTotal: number | null;
}

export interface WclReviewEpisode {
  startMs: number;
  endMs: number;
  waveCount: number;
  eventCount: number;
  medianIntervalMs: number | null;
}

export interface WclReviewFightObservation {
  fightId: number;
  rawEventCount: number;
  firstAtMs: number;
  lastAtMs: number;
  waves: WclReviewWave[];
  episodes: WclReviewEpisode[];
}

export interface WclReviewEventType {
  type: string;
  rawEventCount: number;
  fights: WclReviewFightObservation[];
}

export interface WclCrossFightTiming {
  comparableFightCount: number;
  commonOccurrenceCount: number;
  medianDriftMs: number | null;
  maxDriftMs: number | null;
  stableWithinThreeSeconds: boolean;
}

export interface WclReviewFamily {
  key: string;
  abilityId: number | null;
  abilityName: string;
  abilityIcon: string | null;
  source: WclReviewActor;
  sourceActorCount: number;
  category: WclReviewCategory;
  excludedReason: string | null;
  description: string;
  suggestedAnchorEvent: string | null;
  eventTypes: WclReviewEventType[];
  rawEventCount: number;
  fightsSeen: number[];
  crossFightTiming: WclCrossFightTiming;
  relatedAbilityIds: number[];
  observedActorIds: number[];
  observedTargets: WclReviewActor[];
}

export interface WclExtractedHealthSample {
  fightId: number;
  atMs: number;
  actorId: number;
  current: number;
  maximum: number;
  percent: number;
}

export interface WclReviewCatalog {
  schemaVersion: 1;
  reportCode: string;
  reportTitle: string;
  generatedAt: number;
  fights: Array<{
    id: number;
    name: string;
    durationMs: number;
    kill: boolean;
    bossPercentage: number | null;
    rawEventCount: number;
  }>;
  summary: {
    rawEventCount: number;
    familyCount: number;
    candidateFamilyCount: number;
    excludedFamilyCount: number;
    categories: Record<WclReviewCategory, number>;
  };
  families: WclReviewFamily[];
  extractedBossHealth: WclExtractedHealthSample[];
}

interface MutableOccurrence {
  fightId: number;
  atMs: number;
  targetId: number | null;
  amount: number | null;
}

interface MutableFamily {
  key: string;
  abilityId: number | null;
  abilityName: string;
  abilityIcon: string | null;
  source: WclReviewActor;
  sourceActorIds: Set<number>;
  targetActorIds: Set<number>;
  category: WclReviewCategory;
  excludedReason: string | null;
  description: string;
  relatedAbilityIds: Set<number>;
  occurrences: Map<string, MutableOccurrence[]>;
}

const KNOWN_VASHNIK_DESCRIPTIONS: Record<string, string> = {
  "anti-magic zone": "死亡骑士的团队减伤区域；若由 Environment 记录，应作为玩家技能辅助事件处理，而不是 Boss 机制。",
  "blood infusion": "鲜血灌注强化下一次 Imbibe，并提高 Hemo Expulsion 与 Clotting Venom 的强度；可叠加。",
  "burning venom": "被 Imbibe 激活的火焰喷泉毒液；与另一种毒液按固定轮次组合。",
  "burning presence": "Burning Venom 存活期间周期性对全团造成火焰伤害。",
  "catalytic bile": "催化胆汁（Catalytic Bile）：恶性催化剂分散圈被玩家承接时产生的伤害。",
  "caustic explosion": "Exploding Infection 被移除后触发的全团火焰爆炸。",
  "caustic surge": "Burning Venom 死亡时造成全团火焰伤害，并留下可叠加的短持续伤害。",
  "clotting venom": "被 Imbibe 激活的鲜血喷泉毒液。",
  "conflagrating expulsion": "从火焰喷泉抽取毒液时造成的全团火焰伤害。",
  "dripping fangs": "滴毒之牙（Dripping Fangs）：主要针对坦克的机制。",
  "exploding infection": "火焰毒液点名；周期伤害并叠层，移除时触发 Caustic Explosion。",
  "flame infusion": "火焰灌注强化下一次 Imbibe，并提高 Conflagrating Expulsion 与 Burning Venom 的强度；可叠加。",
  "gloom expulsion": "从暗影喷泉抽取毒液时造成的全团暗影伤害。",
  "hardened tumor": "Malignant Tumor 获得极高减伤；被 Plague Wave 命中后移除。",
  "hemo expulsion": "从鲜血喷泉抽取毒液时造成的全团暗影伤害。",
  imbibe: "痛饮（Imbibe）：同时激活两个毒液喷泉；组合顺序在样本中预期固定。",
  malignance: "恶念（Malignance）：Malignant Tumor 释放的全团毒波，并施加长时间、可叠加的周期伤害；与小怪进入中场触发的恶性爆发不同。",
  "malignant burst": "恶性爆发（Malignant Burst）：Living Venom 抵达中央腔体时触发的高额全团伤害，并施加可叠加的长持续伤害。",
  "malignant catalyst": "恶性催化剂（Malignant Catalyst）：全团伤害后发射催化胆汁分散圈；每个落点至少需要一名玩家承接。",
  "miasmic coating": "Shrouded Venom 出现时获得相当于其最大生命值的吸收盾。",
  "plague froth": "瘟疫泡沫（Plague Froth）：生成带伤害的分散圈，随后产生十字方向的瘟疫浪潮；海浪命中 Malignant Tumor 会移除 Hardened Tumor。",
  "plague wave": "瘟疫浪潮（Plague Wave）：由瘟疫泡沫后续产生的十字海浪；命中 Malignant Tumor 会移除 Hardened Tumor。",
  "sanguineous fortitude": "Clotting Venom 出现时获得控制免疫。",
  "shrouded venom": "被 Imbibe 激活的暗影喷泉毒液。",
  "shadow infusion": "暗影灌注强化下一次 Imbibe，并提高 Gloom Expulsion 与 Shrouded Venom 的强度；可叠加。",
  "shadow word: death": "牧师技能的反噬伤害可能由 Environment 记录；不属于 Boss 机制。",
  "siphon blood": "鲜血虹吸（Siphon Blood）：虹吸感染目标周期性产生的范围效果，伤害附近队友，并按命中人数治疗被点者，用于清除其治疗吸收。",
  "siphoning infection": "虹吸感染（Siphoning Infection）：通常点名两名玩家，造成周期伤害、治疗吸收和受到治疗量降低 100%；需要队友进入其鲜血虹吸范围，使该机制产生的治疗清除吸收。",
  "splitting clot": "Clotting Venom 死亡时分裂为更小的 Clotting Venom。",
  "splitting venom": "Vashnik 战斗中的毒液单位；具体与喷泉/分裂机制的关系待人工确认。",
  "stygian burst": "Stygian Infection 目标周期性产生的暗影落点爆发，对附近玩家造成伤害。",
  "stygian infection": "暗影毒液点名：周期伤害、吸收治疗，并周期性触发 Stygian Burst。",
  "toxic vapor": "毒性蒸汽（Toxic Vapor）：贯穿全场的周期自然伤害；每次痛饮增加层数。",
  "umbral ejection": "Shrouded Venom 死亡时向落点喷射暗影毒液，命中附近玩家。",
};

const ANCHOR_PRIORITY = [
  "begincast",
  "cast",
  "empowerstart",
  "applydebuff",
  "applybuff",
  "summon",
  "damage",
  "removebuff",
  "removedebuff",
  "death",
];

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function actorFromRaw(actor: WclCompatActor | undefined, actorId: number | null, affiliation: WclActorAffiliation): WclReviewActor {
  if (!actor) {
    if (actorId === -1) return { actorId, gameId: 0, name: "Environment", type: "NPC", subType: "Environment", affiliation: "environment" };
    return { actorId, gameId: null, name: actorId === null ? "Unknown source" : `Unknown actor ${actorId}`, type: "Unknown", subType: "", affiliation };
  }
  return {
    actorId,
    gameId: finiteInteger(actor.guid),
    name: actor.name,
    type: actor.type ?? "Unknown",
    subType: actor.subType ?? "",
    affiliation,
  };
}

export function buildWclActorIndex(report: WclCompatReport) {
  const master = new Map((report.masterData?.actors ?? []).map((actor) => [actor.id, actor]));
  const actors = new Map<number, WclReviewActor>();
  const add = (values: WclCompatActor[] | undefined, affiliation: WclActorAffiliation) => {
    for (const value of values ?? []) actors.set(value.id, actorFromRaw(master.get(value.id) ?? value, value.id, affiliation));
  };
  const addIds = (values: Array<number | { id: number }> | undefined, affiliation: WclActorAffiliation) => {
    for (const value of values ?? []) {
      const actorId = typeof value === "number" ? value : value.id;
      actors.set(actorId, actorFromRaw(master.get(actorId), actorId, affiliation));
    }
  };
  add(report.friendlies, "friendly-player");
  add(report.friendlyPets, "friendly-pet");
  add(report.enemies, "enemy");
  add(report.enemyPets, "enemy");
  // The compatibility payload's top-level lists can omit actors that occur in
  // only some pulls. Per-fight ownership is the more reliable fallback.
  for (const fight of report.fights) {
    addIds(fight.friendlyPlayers, "friendly-player");
    addIds(fight.friendlyPets, "friendly-pet");
    addIds(fight.enemyNPCs, "enemy");
  }
  const enemyGameIds = new Set(
    [...actors.values()]
      .filter((actor) => actor.affiliation === "enemy" && actor.gameId !== null)
      .map((actor) => actor.gameId),
  );
  for (const actor of master.values()) {
    if (enemyGameIds.has(finiteInteger(actor.guid))) {
      actors.set(actor.id, actorFromRaw(actor, actor.id, "enemy"));
    }
  }
  for (const actor of master.values()) {
    if (actors.has(actor.id)) continue;
    const affiliation: WclActorAffiliation = actor.id === -1 ? "environment" : actor.type === "Player" ? "friendly-player" : "other";
    actors.set(actor.id, actorFromRaw(actor, actor.id, affiliation));
  }
  actors.set(-1, actorFromRaw(master.get(-1), -1, "environment"));
  return actors;
}

function normalizedAbility(event: WclRawEvent, actors: Map<number, WclReviewActor>) {
  const sourceId = finiteInteger(event.sourceID);
  return {
    ability: event.ability,
    sourceId,
    source: actors.get(sourceId ?? Number.NaN),
    relatedAbility: event.extraAbility,
  };
}

function classifyEvent(
  event: WclRawEvent,
  source: WclReviewActor,
  target: WclReviewActor | undefined,
): { category: WclReviewCategory; excludedReason: string | null } {
  if (event.type === "encounterstart" || event.type === "encounterend" || event.type === "phase") {
    return { category: "system", excludedReason: null };
  }
  if (event.type === "combatantinfo") return { category: "excluded", excludedReason: "战斗人员详情由名单提取器单独处理" };
  if (event.type === "aurabroken") return { category: "excluded", excludedReason: "光环破除事件只保留为技能关系证据，不能可靠归属为 Boss 施法" };

  if (source.affiliation === "enemy") return { category: "enemy", excludedReason: null };
  if (source.affiliation === "environment") {
    if (target?.affiliation === "friendly-player") return { category: "unknown", excludedReason: null };
    return { category: "unknown", excludedReason: null };
  }
  if (source.affiliation === "friendly-pet") return { category: "excluded", excludedReason: "玩家宠物事件不属于当前排轴范围" };
  if (source.affiliation === "friendly-player") {
    if (event.type === "damage") return { category: "excluded", excludedReason: "玩家伤害事件不属于当前排轴范围" };
    if (event.type === "heal") return { category: "excluded", excludedReason: "逐次治疗量不用于识别关键治疗技能" };
    if (event.type === "resourcechange" || event.type === "extraattacks") {
      return { category: "excluded", excludedReason: "玩家资源或额外攻击事件不属于当前排轴范围" };
    }
    if (target?.affiliation === "enemy" && ["applydebuff", "refreshdebuff", "removedebuff", "applydebuffstack", "removedebuffstack"].includes(event.type)) {
      return { category: "excluded", excludedReason: "玩家施加给敌人的输出型减益默认不进入排轴候选" };
    }
    if (target?.affiliation === "enemy" && event.type === "cast") {
      return { category: "excluded", excludedReason: "以敌人为目标的玩家普通施法默认不进入关键技能候选" };
    }
    return { category: "player", excludedReason: null };
  }
  if (target?.affiliation === "friendly-player" && ["damage", "applydebuff", "removedebuff", "death"].includes(event.type)) {
    return { category: "unknown", excludedReason: null };
  }
  return { category: "excluded", excludedReason: "未关联到当前 Boss 或团队成员的事件" };
}

function stableFamilyKey(abilityId: number | null, abilityName: string, source: WclReviewActor) {
  const sourceIdentity = source.affiliation === "friendly-player"
    ? "players"
    : source.gameId ?? source.actorId ?? "unknown";
  const normalizedName = abilityName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "");
  const abilityIdentity = abilityId ?? (normalizedName || "none");
  return `${source.affiliation}:${sourceIdentity}:${abilityIdentity}`;
}

function representativeSource(source: WclReviewActor): WclReviewActor {
  if (source.affiliation !== "friendly-player") return source;
  return { actorId: null, gameId: null, name: "Players", type: "Player", subType: "", affiliation: "friendly-player" };
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function wavesForOccurrences(values: MutableOccurrence[]): WclReviewWave[] {
  const sorted = [...values].sort((left, right) => left.atMs - right.atMs);
  const waves: Array<{ values: MutableOccurrence[] }> = [];
  for (const value of sorted) {
    const current = waves.at(-1);
    if (!current || value.atMs - current.values[0].atMs > 250) waves.push({ values: [value] });
    else current.values.push(value);
  }
  return waves.map(({ values: waveValues }) => {
    const amounts = waveValues.map((item) => item.amount).filter((value): value is number => value !== null);
    return {
      atMs: Math.min(...waveValues.map((item) => item.atMs)),
      eventCount: waveValues.length,
      uniqueTargetCount: new Set(waveValues.map((item) => item.targetId).filter((value) => value !== null)).size,
      amountTotal: amounts.length ? amounts.reduce((sum, value) => sum + value, 0) : null,
    };
  });
}

function episodesForWaves(waves: WclReviewWave[]): WclReviewEpisode[] {
  if (waves.length === 0) return [];
  const intervals = waves.slice(1).map((wave, index) => wave.atMs - waves[index].atMs).filter((value) => value > 0);
  const typicalInterval = median(intervals);
  const splitGap = typicalInterval === null ? 5_000 : Math.max(3_000, Math.min(15_000, typicalInterval * 3));
  const groups: WclReviewWave[][] = [];
  for (const wave of waves) {
    const group = groups.at(-1);
    if (!group || wave.atMs - group.at(-1)!.atMs > splitGap) groups.push([wave]);
    else group.push(wave);
  }
  return groups.map((group) => {
    const groupIntervals = group.slice(1).map((wave, index) => wave.atMs - group[index].atMs).filter((value) => value > 0);
    return {
      startMs: group[0].atMs,
      endMs: group.at(-1)!.atMs,
      waveCount: group.length,
      eventCount: group.reduce((sum, wave) => sum + wave.eventCount, 0),
      medianIntervalMs: median(groupIntervals),
    };
  });
}

function crossFightTiming(eventTypes: WclReviewEventType[]): WclCrossFightTiming {
  const anchor = ANCHOR_PRIORITY.map((type) => eventTypes.find((item) => item.type === type)).find(Boolean) ?? eventTypes[0];
  const fights = anchor?.fights.filter((fight) => fight.waves.length > 0) ?? [];
  if (fights.length < 2) {
    return { comparableFightCount: fights.length, commonOccurrenceCount: 0, medianDriftMs: null, maxDriftMs: null, stableWithinThreeSeconds: false };
  }
  const commonOccurrenceCount = Math.min(...fights.map((fight) => fight.waves.length));
  const drifts: number[] = [];
  for (let index = 0; index < commonOccurrenceCount; index += 1) {
    const values = fights.map((fight) => fight.waves[index].atMs);
    drifts.push(Math.max(...values) - Math.min(...values));
  }
  const maxDriftMs = drifts.length ? Math.max(...drifts) : null;
  return {
    comparableFightCount: fights.length,
    commonOccurrenceCount,
    medianDriftMs: median(drifts),
    maxDriftMs,
    stableWithinThreeSeconds: fights.length >= 3 && drifts.length > 0 && drifts.every((value) => value <= 3_000),
  };
}

function suggestedAnchor(eventTypes: WclReviewEventType[]) {
  return ANCHOR_PRIORITY.find((type) => eventTypes.some((item) => item.type === type)) ?? eventTypes[0]?.type ?? null;
}

function familySort(left: WclReviewFamily, right: WclReviewFamily) {
  const categoryOrder: Record<WclReviewCategory, number> = { enemy: 0, unknown: 1, system: 2, player: 3, excluded: 4 };
  return categoryOrder[left.category] - categoryOrder[right.category]
    || left.source.name.localeCompare(right.source.name, "en")
    || left.abilityName.localeCompare(right.abilityName, "en")
    || (left.abilityId ?? 0) - (right.abilityId ?? 0);
}

export function buildWclEventReviewCatalog(input: {
  reportCode: string;
  report: WclCompatReport;
  fightIds: number[];
  events: Iterable<WclRawEvent>;
  generatedAt?: number;
}): WclReviewCatalog {
  const fights = input.report.fights.filter((fight) => input.fightIds.includes(fight.id));
  const fightIndex = new Map(fights.map((fight) => [fight.id, fight]));
  const actors = buildWclActorIndex(input.report);
  const families = new Map<string, MutableFamily>();
  const extractedBossHealth: WclExtractedHealthSample[] = [];
  const bossIds = new Set(fights.flatMap((fight) => fight.enemyNPCs ?? []).map((item) => item.id));
  const rawEventCountByFight = new Map<number, number>();
  let rawEventCount = 0;

  for (const event of input.events) {
    const fightId = finiteInteger(event.fight);
    const fight = fightId === null ? undefined : fightIndex.get(fightId);
    if (!fight) continue;
    rawEventCount += 1;
    rawEventCountByFight.set(fight.id, (rawEventCountByFight.get(fight.id) ?? 0) + 1);
    const atMs = Math.round(event.timestamp - fight.start_time);
    if (atMs < 0 || atMs > fight.end_time - fight.start_time + 1_000) continue;

    const normalized = normalizedAbility(event, actors);
    const source = normalized.source ?? actorFromRaw(undefined, normalized.sourceId, normalized.sourceId === -1 ? "environment" : "other");
    const targetId = finiteInteger(event.targetID);
    const target = targetId === null ? undefined : actors.get(targetId);
    const abilityId = finiteInteger(normalized.ability?.guid);
    const abilityName = normalized.ability?.name?.trim() || event.name?.trim() || (event.type === "combatantinfo" ? "Combatant Info" : event.type);
    const key = stableFamilyKey(abilityId, abilityName, source);
    const classification = classifyEvent(event, source, target);
    let family = families.get(key);
    if (!family) {
      family = {
        key,
        abilityId,
        abilityName,
        abilityIcon: normalized.ability?.abilityIcon ?? null,
        source: representativeSource(source),
        sourceActorIds: new Set(source.actorId === null ? [] : [source.actorId]),
        targetActorIds: new Set<number>(),
        category: classification.category,
        excludedReason: classification.excludedReason,
        description: KNOWN_VASHNIK_DESCRIPTIONS[abilityName.toLowerCase()] ?? "",
        relatedAbilityIds: new Set<number>(),
        occurrences: new Map<string, MutableOccurrence[]>(),
      };
      families.set(key, family);
    } else if (family.category === "excluded" && classification.category !== "excluded") {
      family.category = classification.category;
      family.excludedReason = null;
    }
    if (source.actorId !== null) family.sourceActorIds.add(source.actorId);
    if (targetId !== null) family.targetActorIds.add(targetId);
    const relatedAbilityId = finiteInteger(normalized.relatedAbility?.guid);
    if (relatedAbilityId !== null) family.relatedAbilityIds.add(relatedAbilityId);
    const occurrenceKey = `${event.type}\u0000${fight.id}`;
    const occurrences = family.occurrences.get(occurrenceKey) ?? [];
    occurrences.push({ fightId: fight.id, atMs, targetId, amount: finiteInteger(event.amount) });
    family.occurrences.set(occurrenceKey, occurrences);

    const healthActorId = targetId ?? finiteInteger(event.sourceID);
    const currentHealth = finiteInteger(event.hitPoints);
    const maximumHealth = finiteInteger(event.maxHitPoints);
    if (healthActorId !== null && bossIds.has(healthActorId) && currentHealth !== null && maximumHealth !== null && maximumHealth > 0) {
      extractedBossHealth.push({
        fightId: fight.id,
        atMs,
        actorId: healthActorId,
        current: currentHealth,
        maximum: maximumHealth,
        percent: Math.max(0, Math.min(100, currentHealth / maximumHealth * 100)),
      });
    }
  }

  const normalizedFamilies = [...families.values()].map((family): WclReviewFamily => {
    const byType = new Map<string, Map<number, MutableOccurrence[]>>();
    for (const [occurrenceKey, values] of family.occurrences) {
      const [type, fightValue] = occurrenceKey.split("\u0000");
      const fightId = Number(fightValue);
      const fightMap = byType.get(type) ?? new Map<number, MutableOccurrence[]>();
      fightMap.set(fightId, values);
      byType.set(type, fightMap);
    }
    const eventTypes = [...byType.entries()].map(([type, fightMap]): WclReviewEventType => {
      const observations = [...fightMap.entries()].map(([fightId, values]): WclReviewFightObservation => {
        const waves = wavesForOccurrences(values);
        return {
          fightId,
          rawEventCount: values.length,
          firstAtMs: Math.min(...values.map((item) => item.atMs)),
          lastAtMs: Math.max(...values.map((item) => item.atMs)),
          waves,
          episodes: episodesForWaves(waves),
        };
      }).sort((left, right) => left.fightId - right.fightId);
      return { type, rawEventCount: observations.reduce((sum, item) => sum + item.rawEventCount, 0), fights: observations };
    }).sort((left, right) => left.type.localeCompare(right.type, "en"));
    const fightsSeen = [...new Set(eventTypes.flatMap((item) => item.fights.map((fight) => fight.fightId)))].sort((left, right) => left - right);
    return {
      key: family.key,
      abilityId: family.abilityId,
      abilityName: family.abilityName,
      abilityIcon: family.abilityIcon,
      source: family.source,
      sourceActorCount: family.sourceActorIds.size,
      category: family.category,
      excludedReason: family.excludedReason,
      description: family.description,
      suggestedAnchorEvent: suggestedAnchor(eventTypes),
      eventTypes,
      rawEventCount: eventTypes.reduce((sum, item) => sum + item.rawEventCount, 0),
      fightsSeen,
      crossFightTiming: crossFightTiming(eventTypes),
      relatedAbilityIds: [...family.relatedAbilityIds].sort((left, right) => left - right),
      observedActorIds: [...family.sourceActorIds].sort((left, right) => left - right),
      observedTargets: [...family.targetActorIds]
        .sort((left, right) => left - right)
        .map((actorId) => actors.get(actorId) ?? actorFromRaw(undefined, actorId, actorId === -1 ? "environment" : "other")),
    };
  }).sort(familySort);

  const categories: Record<WclReviewCategory, number> = { enemy: 0, player: 0, system: 0, unknown: 0, excluded: 0 };
  for (const family of normalizedFamilies) categories[family.category] += 1;
  return {
    schemaVersion: 1,
    reportCode: input.reportCode,
    reportTitle: input.report.title ?? input.reportCode,
    generatedAt: input.generatedAt ?? Date.now(),
    fights: fights.map((fight) => ({
      id: fight.id,
      name: fight.name,
      durationMs: Math.round(fight.end_time - fight.start_time),
      kill: fight.kill === true,
      bossPercentage: typeof fight.bossPercentage === "number" && Number.isFinite(fight.bossPercentage)
        ? Math.round((fight.bossPercentage > 100 ? fight.bossPercentage / 100 : fight.bossPercentage) * 100) / 100
        : null,
      rawEventCount: rawEventCountByFight.get(fight.id) ?? 0,
    })),
    summary: {
      rawEventCount,
      familyCount: normalizedFamilies.length,
      candidateFamilyCount: normalizedFamilies.filter((family) => family.category !== "excluded").length,
      excludedFamilyCount: normalizedFamilies.filter((family) => family.category === "excluded").length,
      categories,
    },
    families: normalizedFamilies,
    extractedBossHealth: extractedBossHealth.sort((left, right) => left.fightId - right.fightId || left.atMs - right.atMs),
  };
}

export function formatReviewTime(milliseconds: number) {
  const value = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value % 60_000 / 1_000);
  const remainder = value % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}
