import vashnikProfileValue from "../data/fixtures/vashnik-encounter-conversion-profile.json";
import playerSkillProfileValue from "../data/player-skill-extraction-profile-retail-12.1-v1.json";
import playerSkillProfileV2Value from "../data/player-skill-extraction-profile-retail-12.1-v2.json";
import playerSkillValues from "../data/player-skills-retail-12.1.json";
import { CatalogSkillDefinitionSchema } from "./types";
import { validatePlayerSkillProfileReferences } from "./player-skill-extraction";
import {
  parseConversionProfile,
  parsePlayerSkillExtractionProfile,
  type PlayerSkillExtractionProfile,
} from "./types";

export const liveVashnikProfile = parseConversionProfile(vashnikProfileValue);

export const encounterConversionProfiles = [
  liveVashnikProfile,
];

export const playerSkillExtractionProfiles: PlayerSkillExtractionProfile[] = [
  parsePlayerSkillExtractionProfile(playerSkillProfileV2Value),
  parsePlayerSkillExtractionProfile(playerSkillProfileValue),
];

export const playerSkillDefinitions = playerSkillValues.map(value => CatalogSkillDefinitionSchema.parse(value));
for (const profile of playerSkillExtractionProfiles) validatePlayerSkillProfileReferences(profile, playerSkillDefinitions);
