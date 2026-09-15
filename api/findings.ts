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
