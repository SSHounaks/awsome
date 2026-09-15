import { driftTargets, diffSnapshots } from "../../diff.ts";
import { Skill, SkillBase } from "../skill.ts";

export interface DriftBrief {
  from: string;
  to: string;
  counts: {
    nodes_added: number; nodes_removed: number; nodes_changed: number;
    edges_added: number; edges_removed: number;
    findings_added: number; findings_removed: number; findings_changed: number;
  };
  nodes_added: { name: string; label: string; by?: string }[];
  nodes_removed: { name: string; label: string; by?: string }[];
  nodes_changed: { name: string; label: string; by?: string }[];
  findings_added: { rule: string; resource_name?: string; by?: string }[];
  findings_removed: { rule: string; resource_name?: string; by?: string }[];
  findings_changed: { rule: string; resource_name?: string; by?: string }[];
  trail: { attributed: number; events_from: number; events_to: number };
}

const DRIFT_RE = /(drift|diff(erence|s)?|what(''?s| is| are)? (new|changed)|changed?|change log|added|removed|since .{0,24}(scan|snapshot|last)|between .{0,24}(scan|snapshot)|last scan|previous snapshot|new findings)/i;

function attBy(it: { attributed_by?: { event_name: string; username?: string; user_arn?: string; event_time?: string } } | undefined): string | undefined {
  if (!it?.attributed_by) return undefined;
  const a = it.attributed_by;
  const who = a.username || a.user_arn?.split("/").pop();
  return `${a.event_name}${who ? " by " + who : ""}`;
}

function buildDriftBrief(): DriftBrief | null {
  try {
    const t = driftTargets();
    if (!t.from || !t.to || t.from === t.to) return null;
    const d = diffSnapshots(t.from, t.to);
    return {
      from: d.from,
      to: d.to,
      counts: d.counts,
      nodes_added: d.nodes_added.items.map((it) => ({ name: it.name, label: it.label, by: attBy(it as never) })),
      nodes_removed: d.nodes_removed.items.map((it) => ({ name: it.name, label: it.label, by: attBy(it as never) })),
      nodes_changed: d.nodes_changed.items.map((it) => ({ name: it.name, label: it.label, by: attBy(it as never) })),
      findings_added: d.findings_added.items.map((it) => ({ rule: (it as never as { rule: string }).rule, resource_name: (it as never as { resource_name?: string }).resource_name, by: attBy(it as never) })),
      findings_removed: d.findings_removed.items.map((it) => ({ rule: (it as never as { rule: string }).rule, resource_name: (it as never as { resource_name?: string }).resource_name, by: attBy(it as never) })),
      findings_changed: d.findings_changed.items.map((it) => ({ rule: (it as never as { rule: string }).rule, resource_name: (it as never as { resource_name?: string }).resource_name, by: attBy(it as never) })),
      trail: d.trail,
    };
  } catch {
    return null;
  }
}

export const driftSkill: Skill = {
  id: "drift",
  label: "Drift",
  description: "Answer questions about changes between the two most recent snapshots, with CloudTrail attribution.",
  matcher: (q: string) => DRIFT_RE.test(q) && !/flow ?log|encrypt|public|expos/.test(q),
  collect: async () => buildDriftBrief(),
  answer: (q: string, payload: unknown, base: SkillBase): string | null => {
    const d = payload as DriftBrief | null;
    if (!d) return null;
    const c = d.counts;
    const out: string[] = [];
    out.push(`**Drift** ${d.from} -> ${d.to}: +${c.nodes_added}/-${c.nodes_removed}/~${c.nodes_changed} resources, +${c.edges_added}/-${c.edges_removed} edges, findings +${c.findings_added}/-${c.findings_removed}/~${c.findings_changed}.`);
    const list = (title: string, xs: { name: string; label: string; by?: string }[]) => {
      if (!xs.length) return;
      out.push(`**${title}**:`);
      for (const it of xs.slice(0, 8)) out.push(`- [${it.label}] ${it.name}${it.by ? ` — via ${it.by}` : ""}`);
    };
    list("Added", d.nodes_added);
    list("Removed", d.nodes_removed);
    list("Changed", d.nodes_changed);
    const flist = (title: string, xs: { rule: string; resource_name?: string; by?: string }[]) => {
      if (!xs.length) return;
      out.push(`**${title}**:`);
      for (const f of xs.slice(0, 6)) out.push(`- ${f.rule}${f.resource_name ? " on " + f.resource_name : ""}${f.by ? ` — via ${f.by}` : ""}`);
    };
    flist("New findings", d.findings_added);
    flist("Resolved findings", d.findings_removed);
    flist("Changed findings", d.findings_changed);
    if (d.trail.attributed) out.push(`Attribution: ${d.trail.attributed} change(s) attributed via CloudTrail.`);
    return out.join("\n");
  },
};
