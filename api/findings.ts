import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
export const snapshotsRoot = path.join(repoRoot, "snapshots");

export interface Finding {
  kind: string;
  id: string;
  rule: string;
  severity: string;
  category: string;
  resource_label: string;
  resource_key: string;
  resource_name: string;
  account_id: string;
  region: string;
  snapshot_id: string;
  message: string;
  remediation: string;
  evidence?: Record<string, unknown>;
}

export function listSnapshots(): { id: string; summary: Record<string, unknown> }[] {
  if (!fs.existsSync(snapshotsRoot)) return [];
  const ids = fs.readdirSync(snapshotsRoot)
    .filter((d) => fs.statSync(path.join(snapshotsRoot, d)).isDirectory())
    .sort()
    .reverse();
  return ids.map((id) => {
    const summaryPath = path.join(snapshotsRoot, id, "summary.json");
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch { /* missing */ }
    return { id, summary };
  });
}

export function latestSnapshot(): string | null {
  const snaps = listSnapshots();
  return snaps[0]?.id ?? null;
}

export function loadFindings(snapshotId?: string): Finding[] {
  const sid = snapshotId ?? latestSnapshot();
  if (!sid) return [];
  const p = path.join(snapshotsRoot, sid, "findings.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const SEVERITY_ORDER: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export function sortFindings(items: Finding[]): Finding[] {
  return [...items].sort((a, b) => {
    const d = (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
    if (d !== 0) return d;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.resource_key < b.resource_key ? -1 : 1;
  });
}

// Excel and Sheets treat a leading =, +, - or @ as a formula, so a crafted tag or
// bucket name in an exported cell could execute on open. Prefix those with a
// quote, then apply normal CSV quoting.
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS: (keyof Finding)[] = [
  "severity",
  "rule",
  "category",
  "resource_label",
  "resource_name",
  "resource_key",
  "region",
  "account_id",
  "message",
  "remediation",
  "snapshot_id",
];

export function exportFindings(items: Finding[], fmt: "json" | "csv" | "md"): string {
  const sorted = sortFindings(items);

  if (fmt === "json") return JSON.stringify(sorted, null, 2);

  if (fmt === "csv") {
    const rows = [CSV_COLUMNS.join(",")];
    for (const f of sorted) rows.push(CSV_COLUMNS.map((c) => csvCell(f[c])).join(","));
    return rows.join("\n") + "\n";
  }

  const counts = findingsCounts(sorted);
  const snap = sorted[0]?.snapshot_id ?? latestSnapshot() ?? "unknown";
  const out: string[] = [
    `# AWSome findings — ${snap}`,
    "",
    `**${counts.total}** findings` +
      (Object.keys(counts.bySeverity).length
        ? " — " +
          Object.entries(counts.bySeverity)
            .sort((a, b) => (SEVERITY_ORDER[b[0]] ?? 0) - (SEVERITY_ORDER[a[0]] ?? 0))
            .map(([s, n]) => `${n} ${s}`)
            .join(", ")
        : ""),
    "",
  ];

  let severity = "";
  for (const f of sorted) {
    if (f.severity !== severity) {
      if (severity) out.push("");
      severity = f.severity;
      out.push(`## ${severity}`, "");
    }
    const name = f.resource_name || f.resource_key;
    out.push(`- **${f.rule}** — ${name} \`${f.region}\``);
    out.push(`  - ${f.message}`);
    if (f.remediation) out.push(`  - _remediation:_ ${f.remediation}`);
    out.push(`  - \`${f.resource_key}\``);
  }
  out.push("");
  return out.join("\n");
}

export function findingsCounts(findings: Finding[]) {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  return { bySeverity, byCategory, byRule, total: findings.length };
}
