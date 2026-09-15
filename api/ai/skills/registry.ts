import { Skill, SkillBase, SkillResult } from "../skill.ts";
import { driftSkill } from "./drift.ts";
import { findingsSkill } from "./findings.ts";
import { infraSkill } from "./infra.ts";

export const SKILLS: Skill[] = [driftSkill, findingsSkill, infraSkill];

export async function runSkills(question: string, base: SkillBase): Promise<SkillResult[]> {
  const matching = SKILLS.filter((sk) => sk.matcher(question));
  const collected = await Promise.all(
    matching.map(async (sk) => ({ sk, payload: await sk.collect(question, base).catch(() => null) })),
  );
  return collected.map(({ sk, payload }) => ({
    id: sk.id,
    label: sk.label,
    active: true,
    payload,
    answer: sk.answer(question, payload, base),
  }));
}
