import { Skill, SkillBase } from "../skill.ts";

export const infraSkill: Skill = {
  id: "infra",
  label: "Infra view",
  description: "Answer questions about the live topology graph: counts of resources/instances/VPCs/regions/accounts and focused-resource detail.",
  matcher: (q: string) => {
    const wordish = /(how many|count|number of|topolog|graph|regions?|accounts?|instances?|vpcs?|subnets?|buckets?|nodes?|security groups?|sgs?|overview|resource)/i.test(q);
    if (wordish) return true;
    return /[a-z0-9]/.test(q) && /resource|instance|vpc|sg|bucket/.test(q.toLowerCase());
  },
  collect: async () => null,
  answer: (q: string, _p: unknown, base: SkillBase): string | null => {
    const s = base.summary as { nodes?: number; edges?: number; accounts?: string[]; regions?: string[]; labels?: Record<string, number> } | null;
    const lines: string[] = [];

    if (/(how many|count|number of|overview|topolog|graph)/.test(q)) {
      lines.push(s
        ? `Graph: ${s.nodes} nodes across ${s.labels ? Object.keys(s.labels).length : 0} resource types, ${s.edges} edges, ${s.accounts?.length ?? 0} account(s), ${s.regions?.length ?? 0} region(s).`
        : "Graph unavailable.");
      if (s?.labels) {
        const topL = Object.entries(s.labels as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 6);
        for (const [l, n] of topL) lines.push(`- ${l}: ${n}`);
      }
      lines.push(`Findings: ${base.counts.total} (critical ${base.counts.bySeverity.critical ?? 0}, high ${base.counts.bySeverity.high ?? 0}, medium ${base.counts.bySeverity.medium ?? 0}, low ${base.counts.bySeverity.low ?? 0}).`);
      return lines.join("\n");
    }

    if (base.focused) {
      const { detail, affectedBy } = base.focused;
      const d = detail as Record<string, unknown> | null;
      lines.push(`**Resource** ${(d?.name as string) || "(unnamed)"} [${d?.label ?? ""}] — ${(d?.type as string) || ""}`);
      if (d) {
        const keep = Object.fromEntries(Object.entries(d).filter(([k, v]) => ["region", "account_id", "cidr_block", "instance_type", "state", "status", "engine", "cluster_status"].includes(k)));
        if (Object.keys(keep).length) for (const [k, v] of Object.entries(keep)) lines.push(`- ${k}: ${String(v)}`);
      }
      if (affectedBy.length) {
        lines.push("Findings affecting it:");
        for (const f of affectedBy) lines.push(`- [${f.severity}] ${f.rule}: ${f.message}`);
      } else {
        lines.push("No findings affect this resource.");
      }
      return lines.join("\n");
    }

    return null;
  },
};
