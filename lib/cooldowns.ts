import seedCatalog from "../data/catalog-seed.json" with { type: "json" };
import { normalizeCooldownDefinition, skillAvailableToMember } from "./skills.ts";
import type { CooldownDefinition, RaidRole, RosterMember } from "./types.ts";

export const WOW_CLASS_COLORS: Record<string, string> = {
  DeathKnight: "#c41e3a", DemonHunter: "#a330c9", Druid: "#ff7c0a", Evoker: "#33937f",
  Hunter: "#aad372", Mage: "#3fc7eb", Monk: "#00ff98", Paladin: "#f48cba",
  Priest: "#e7e7e7", Rogue: "#fff468", Shaman: "#0070dd", Warlock: "#8788ee", Warrior: "#c69b6d",
};

export const WOW_CLASS_LABELS: Record<string, string> = {
  DeathKnight: "死亡骑士", DemonHunter: "恶魔猎手", Druid: "德鲁伊", Evoker: "唤魔师",
  Hunter: "猎人", Mage: "法师", Monk: "武僧", Paladin: "圣骑士", Priest: "牧师",
  Rogue: "潜行者", Shaman: "萨满祭司", Warlock: "术士", Warrior: "战士",
};

export interface WowSpecialization {
  slug: string;
  label: string;
  role: RaidRole;
}

export const WOW_CLASS_SPECS: Record<string, WowSpecialization[]> = {
  DeathKnight: [
    { slug: "blood", label: "鲜血", role: "tank" },
    { slug: "frost", label: "冰霜", role: "damage" },
    { slug: "unholy", label: "邪恶", role: "damage" },
  ],
  DemonHunter: [
    { slug: "havoc", label: "浩劫", role: "damage" },
    { slug: "vengeance", label: "复仇", role: "tank" },
  ],
  Druid: [
    { slug: "balance", label: "平衡", role: "damage" },
    { slug: "feral", label: "野性", role: "damage" },
    { slug: "guardian", label: "守护", role: "tank" },
    { slug: "restoration", label: "恢复", role: "healer" },
  ],
  Evoker: [
    { slug: "devastation", label: "湮灭", role: "damage" },
    { slug: "preservation", label: "恩护", role: "healer" },
    { slug: "augmentation", label: "增辉", role: "damage" },
  ],
  Hunter: [
    { slug: "beast-mastery", label: "野兽控制", role: "damage" },
    { slug: "marksmanship", label: "射击", role: "damage" },
    { slug: "survival", label: "生存", role: "damage" },
  ],
  Mage: [
    { slug: "arcane", label: "奥术", role: "damage" },
    { slug: "fire", label: "火焰", role: "damage" },
    { slug: "frost", label: "冰霜", role: "damage" },
  ],
  Monk: [
    { slug: "brewmaster", label: "酒仙", role: "tank" },
    { slug: "mistweaver", label: "织雾", role: "healer" },
    { slug: "windwalker", label: "踏风", role: "damage" },
  ],
  Paladin: [
    { slug: "holy", label: "神圣", role: "healer" },
    { slug: "protection", label: "防护", role: "tank" },
    { slug: "retribution", label: "惩戒", role: "damage" },
  ],
  Priest: [
    { slug: "discipline", label: "戒律", role: "healer" },
    { slug: "holy", label: "神圣", role: "healer" },
    { slug: "shadow", label: "暗影", role: "damage" },
  ],
  Rogue: [
    { slug: "assassination", label: "奇袭", role: "damage" },
    { slug: "outlaw", label: "狂徒", role: "damage" },
    { slug: "subtlety", label: "敏锐", role: "damage" },
  ],
  Shaman: [
    { slug: "elemental", label: "元素", role: "damage" },
    { slug: "enhancement", label: "增强", role: "damage" },
    { slug: "restoration", label: "恢复", role: "healer" },
  ],
  Warlock: [
    { slug: "affliction", label: "痛苦", role: "damage" },
    { slug: "demonology", label: "恶魔学识", role: "damage" },
    { slug: "destruction", label: "毁灭", role: "damage" },
  ],
  Warrior: [
    { slug: "arms", label: "武器", role: "damage" },
    { slug: "fury", label: "狂怒", role: "damage" },
    { slug: "protection", label: "防护", role: "tank" },
  ],
};

export function specializationsForClass(classSlug: string) {
  return WOW_CLASS_SPECS[classSlug] ?? [];
}

export function specializationFor(classSlug: string, specSlug: string) {
  return specializationsForClass(classSlug).find((item) => item.slug === specSlug);
}

export function specializationLabel(classSlug: string, specSlug: string) {
  if (!specSlug) return "待选择专精";
  return specializationFor(classSlug, specSlug)?.label ?? specSlug;
}

export const DEFAULT_COOLDOWNS: CooldownDefinition[] = seedCatalog.playerSkills.map((item) => {
  const { enabled: _enabled, gameVersion: _gameVersion, ...cooldown } = item;
  void _enabled; void _gameVersion;
  const normalized = normalizeCooldownDefinition(cooldown, { defaultStatus: "unconfigured", defaultCatalogVersion: seedCatalog.manifest.version });
  normalized.catalogVersion = seedCatalog.manifest.version;
  return normalized;
});

export const COOLDOWN_BY_SPELL_ID = new Map(
  DEFAULT_COOLDOWNS.filter((item) => item.spellId).map((item) => [item.spellId!, item]),
);

export function cooldownsForClass(cooldowns: CooldownDefinition[], classSlug: string) {
  if (!classSlug) return [];
  return cooldowns.filter((item) => item.classSlug === classSlug);
}

export function cooldownsForMember(cooldowns: CooldownDefinition[], member: Pick<RosterMember, "classSlug" | "specSlug"> | undefined) {
  if (!member) return [];
  return cooldowns.filter((item) => skillAvailableToMember(item, member));
}
