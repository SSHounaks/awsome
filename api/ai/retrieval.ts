import { Cypher } from "../cypher.ts";
import { querySummary, queryEdgesCount, queryAccountsRegions, queryResources, queryDetail, queryNeighbors } from "../neo.ts";
import * as findings from "../findings.ts";
import { ResourceRef, FocusedContext, SkillResult } from "./skill.ts";
import { runSkills } from "./skills/registry.ts";

export interface ChatContext {
  summary: Record<string, unknown> | null;
  counts: ReturnType<typeof findings.findingsCounts>;
  findings: findings.Finding[];
  top: findings.Finding[];
  resources: ResourceRef[];
  focused: FocusedContext | null;
  skills: SkillResult[];
}

export type { ResourceRef };

function matchTokens(q: string): string[] {
  const toks = q.toLowerCase().split(/[^a-z0-9\-.]/).filter((t) => t.length >= 4);
  const seen = new Set<string>();
  return [...toks.filter((t) => !seen.has(t) && seen.add(t)).slice(0, 6)];
}

export async function buildContext(c: Cypher, question: string): Promise<ChatContext> {
  const [byLabel, edge, acct, fns] = await Promise.all([
    querySummary(c).catch(() => [] as { label: string; c: number }[]),
    queryEdgesCount(c).catch(() => [] as { c: number }[]),
    queryAccountsRegions(c).catch(() => [] as { account_id: string; region: string }[]),
    Promise.resolve(findings.loadFindings()),
  ]);
  const labels: Record<string, number> = {};
  for (const r of byLabel) labels[String(r.label ?? "")] = Number(r.c);
  const summary = {
    nodes: Object.values(labels).reduce((a, b) => a + b, 0),
    labels,
    edges: Number(edge[0]?.c ?? 0),
    accounts: [...new Set(acct.map((r) => r.account_id as string))],
    regions: [...new Set(acct.map((r) => r.region as string))],
    findings: findings.findingsCounts(fns),
  };

  const top = [...fns].sort(sevCmp).slice(0, 10);

  const resources: ResourceRef[] = [];
  const matched: { key: string; name: string; label: string }[] = [];
  for (const f of fns) {
    const nm = f.resource_name;
    if (nm && nm.length >= 4 && question.toLowerCase().includes(nm.toLowerCase())) {
      matched.push({ key: f.resource_key, name: nm, label: f.resource_label });
    }
  }
  for (const t of matchTokens(question)) {
    try {
      const rows = await queryResources(c, { q: t, limit: 5 });
      for (const r of rows) {
        const name = String(r.name ?? "");
        resources.push({ key: String(r.key), name, label: r.label });
        if (name && name.length >= 4 && question.toLowerCase().includes(name.toLowerCase())) {
          matched.push({ key: String(r.key), name, label: r.label });
        }
      }
    } catch { /* graph query failure is non-fatal */ }
  }

  let focused: FocusedContext | null = null;
  if (matched.length) {
    const fav = matched[0];
    const [detail, neighbors] = await Promise.all([
      queryDetail(c, fav.key).catch(() => null),
      queryNeighbors(c, fav.key).catch(() => []),
    ]);
    focused = {
      detail: detail ? (detail as unknown as Record<string, unknown>) : null,
      neighbors,
      affectedBy: fns.filter((f) => f.resource_key === fav.key),
    };
  }

  const base = { cypher: c, summary, counts: findings.findingsCounts(fns), findings: fns, top, resources, focused };
  const skills = await runSkills(question, base);

  return { summary, counts: base.counts, findings: fns, top, resources, focused, skills };
}

export function sevCmp(a: findings.Finding, b: findings.Finding): number {
  const rank: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
}
