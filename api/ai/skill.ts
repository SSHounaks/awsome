import { Cypher } from "../cypher.ts";
import { Finding } from "../findings.ts";

export interface ResourceRef { key: string; name: string; label: string; }

export interface FocusedContext {
  detail: Record<string, unknown> | null;
  neighbors: unknown[];
  affectedBy: Finding[];
}

export interface SkillBase {
  cypher: Cypher;
  summary: Record<string, unknown> | null;
  counts: { total: number; bySeverity: Record<string, number> };
  findings: Finding[];
  top: Finding[];
  resources: ResourceRef[];
  focused: FocusedContext | null;
}

export interface SkillResult {
  id: string;
  label: string;
  active: boolean;
  payload: unknown | null;
  answer: string | null;
}

export interface Skill {
  id: string;
  label: string;
  description: string;
  matcher: (question: string) => boolean;
  collect: (question: string, base: SkillBase) => Promise<unknown | null>;
  answer: (question: string, payload: unknown | null, base: SkillBase) => string | null;
}
