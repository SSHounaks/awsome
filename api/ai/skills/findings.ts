import { Skill } from "../skill.ts";

function findingHits(f: { resource_name?: string; resource_key?: string }, name: string): boolean {
  return !!f.resource_name?.toLowerCase().includes(name.toLowerCase()) ||
    !!f.resource_key?.toLowerCase().includes(name.toLowerCase());
}

export const findingsSkill: Skill = {
  id: "findings",
  label: "Findings",
  description: "Answer questions about security findings: flow logs, encryption, public exposure, critical/high risks, and posture.",
  matcher: (q: string) => /(flow.?log|encrypt|public|expos|open|ingress|0\.0\.0\.0|critical|high|finding|issue|risk|vulnerab|misconfig|remediat|fix|posture|security)/i.test(q),
  collect: async () => null,
  answer: (_q: string, _payload: unknown, base: { findings: any[] }): string | null => {
    const q = _q.toLowerCase();
    const findings = base.findings;
    const lines: string[] = [];

    if (/fl(ow)? ?log|flowlog/.test(q)) {
      const fl = findings.filter((f) => f.rule === "vpc-flow-logs-disabled");
      lines.push(fl.length
        ? `**VPC Flow Logs**: ${fl.length} VPC(s) have flow logs disabled.`
        : "**VPC Flow Logs**: enabled everywhere (no findings).");
      if (fl.length) lines.push(`- ${fl[0].message} → ${fl[0].remediation}`);
      return lines.join("\n");
    }

    if (/encrypt/.test(q)) {
      const un = findings.filter((f) => f.rule === "unencrypted-storage");
      lines.push(un.length
        ? `**Encryption**: ${un.length} unencrypted storage resource(s):`
        : "**Encryption**: no unencrypted-storage findings.");
      for (const f of un) lines.push(`- [${f.severity}] ${f.resource_name || f.resource_label}: ${f.message}`);
      return lines.join("\n");
    }

    if (/public|expos|open|ingress|0\.0\.0\.0/.test(q)) {
      const open = findings.filter((f) => f.rule === "sg-open-ingress" || f.rule === "s3-public-bucket");
      lines.push(open.length ? "**Public exposure**: " : "**Public exposure**: none detected (no open-ingress / public-bucket findings).");
      for (const f of open) lines.push(`- [${f.severity}] ${f.rule} ${f.resource_name}: ${f.message}`);
      return lines.join("\n");
    }

    if (/critical|high/.test(q)) {
      const bad = findings.filter((f) => f.severity === "critical" || f.severity === "high");
      lines.push(`**${bad.length} critical/high finding(s):`);
      for (const f of bad) lines.push(`- [${f.severity}] ${f.rule} ${f.resource_name || f.resource_label}: ${f.message}`);
      if (!bad.length) lines.push("none — posture is clean at the top level.");
      return lines.join("\n");
    }

    const c = base.findings.length;
    lines.push(`**Posture**: ${c} finding(s) total; fix-first from critical/high:`);
    const crit = findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (crit.length) for (const f of crit.slice(0, 4)) lines.push(`- [${f.severity}] ${f.rule} on ${f.resource_name || f.resource_label}: ${f.remediation || f.message}`);
    else lines.push("no critical/high findings.");
    return lines.join("\n");
  },
};
