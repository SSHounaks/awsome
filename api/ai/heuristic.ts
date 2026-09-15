import { ChatContext } from "./retrieval.ts";

function postureFallback(ctx: ChatContext): string {
  const s = ctx.summary as { nodes?: number; edges?: number; labels?: Record<string, number>; regions?: string[] } | null;
  const c = ctx.counts;
  const lines: string[] = [];
  lines.push(`**AWSome posture summary**: ${c.total} finding(s): ` +
    `critical ${c.bySeverity.critical ?? 0}, high ${c.bySeverity.high ?? 0}, medium ${c.bySeverity.medium ?? 0}, low ${c.bySeverity.low ?? 0}.`);
  const crit = ctx.findings.filter((f) => f.severity === "critical" || f.severity === "high");
  if (crit.length) {
    lines.push("**Fix first**:");
    for (const f of crit.slice(0, 3)) lines.push(`- [${f.severity}] ${f.rule} on ${f.resource_name || f.resource_label}: ${f.remediation || f.message}`);
  }
  if (s) lines.push(`Graph: ${s.nodes} nodes, ${s.edges} edges across ${s.labels ? Object.keys(s.labels).length : 0} resource type(s) in ${s.regions?.length ?? 0} region(s).`);
  if (ctx.top.length) {
    lines.push("Top findings:");
    for (const f of ctx.top.slice(0, 4)) lines.push(`- [${f.severity}] ${f.rule} ${f.resource_name || f.resource_label}`);
  }
  return lines.join("\n");
}

export function askHeuristic(question: string, ctx: ChatContext): string {
  const answers = ctx.skills.map((sk) => sk.answer).filter((a): a is string => !!a);
  if (answers.length) return answers.join("\n\n");
  return postureFallback(ctx);
}
