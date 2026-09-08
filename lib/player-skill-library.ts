import playerSkillsJson from "../data/player-skills-retail-12.1.json" with { type: "json" };
import { CatalogSkillDefinitionSchema } from "./domain/schema";

/** The built-in global library. Published catalogs supply updates at application boundaries. */
export const PLAYER_SKILLS = playerSkillsJson.map(value => CatalogSkillDefinitionSchema.parse(value));
