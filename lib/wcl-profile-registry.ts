import { PLAYER_SKILLS } from "./player-skill-library";
import vashnikProfileValue from "../data/fixtures/vashnik-encounter-conversion-profile.json";
import playerSkillProfileV2Value from "../data/player-skill-extraction-profile-retail-12.1-v2.json";
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
];

export const playerSkillDefinitions = PLAYER_SKILLS;
for (const profile of playerSkillExtractionProfiles) validatePlayerSkillProfileReferences(profile, playerSkillDefinitions);
