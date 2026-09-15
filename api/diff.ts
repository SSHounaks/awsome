import * as fs from "node:fs";
import * as path from "node:path";
import { snapshotsRoot, listSnapshots, Finding } from "./findings.ts";

interface RawNode {
  key: string;
  name: string;
  label: string;
  type: string;
  region: string;
  account_id: string;
  tags: string;
  properties: Record<string, unknown>;
}

interface RawEdge { from: string; to: string; type: string; }

export interface TrailEvent {
  event_id?: string;
  event_time?: string;
  event_name?: string;
  read_only: boolean;
  region?: string;
  username?: string;
  user_arn?: string;
  access_key_id?: string;
  user_type?: string;
  source_ip?: string;
  resources?: { type?: string; name?: string }[];
}

export interface SnapshotMeta {
  id: string;
  user?: string;
  hostname?: string;
  trigger?: string;
  job_id?: string;
  started_at?: string;
  finished_at?: string;
  status?: string;
}

interface SnapshotGraph {
  nodes: Map<string, RawNode>;
  edges: RawEdge[];
  findings: Map<string, Finding>;
  trail: TrailEvent[];
  meta: SnapshotMeta;
}

export interface DiffLine { status: "same" | "add" | "del" | "mod"; path: string; from?: unknown; to?: unknown; }

export interface Attribution {
  event_name: string;
  username?: string;
  user_arn?: string;
  access_key_id?: string;
  user_type?: string;
  source_ip?: string;
  event_time: string;
}

export interface DriftEntry { key: string; name: string; label: string; lines: DiffLine[]; attributed_by?: Attribution; }
export interface DriftChange extends DriftEntry { fields: Record<string, { from: unknown; to: unknown }>; }

const VALUE_KEYS = ["state", "status", "instance_type", "cidr_block", "engine", "cluster_status",
  "api_version", "runtime", "versioning_enabled", "public", "availability_zone", "az"];

function readJSONIf(dir: string, name: string, fallback: unknown): unknown {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function loadSnapshot(id: string): SnapshotGraph {
  const dir = path.join(snapshotsRoot, id);
  const g: SnapshotGraph = {
    nodes: new Map(), edges: [], findings: new Map(), trail: [],
    meta: { id },
  };
  const rec = path.join(dir, "records.jsonl");
  if (fs.existsSync(rec)) {
    for (const line of fs.readFileSync(rec, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.kind === "node") {
        const props = (o.properties as Record<string, unknown>) ?? {};
        g.nodes.set(String(o.key), {
          key: String(o.key),
          name: String(o.name ?? o.key ?? ""),
          label: String(o.label ?? ""),
          type: String(o.type ?? ""),
          region: String(o.region ?? ""),
          account_id: String(o.account_id ?? ""),
          tags: JSON.stringify(o.tags ?? {}),
          properties: props,
        });
      } else if (o.kind === "edge") {
        g.edges.push({ from: String(o.from), to: String(o.to), type: String(o.type ?? "") });
      }
    }
  }
  const fp = path.join(dir, "findings.json");
  if (fs.existsSync(fp)) {
    try {
      const list = JSON.parse(fs.readFileSync(fp, "utf8")) as Finding[];
      for (const f of list) g.findings.set(f.id, f);
    } catch { /* ignore */ }
  }
  const tp = path.join(dir, "trail.jsonl");
  if (fs.existsSync(tp)) {
    for (const line of fs.readFileSync(tp, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { g.trail.push(JSON.parse(line) as TrailEvent); } catch { /* ignore */ }
    }
  }
  const meta = readJSONIf(dir, "summary.json", null) as Record<string, unknown> | null;
  if (meta) {
    g.meta = {
      id,
      user: str(meta.user),
      hostname: str(meta.hostname),
      trigger: str(meta.trigger) ?? "manual",
      job_id: str(meta.job_id),
      started_at: str(meta.started_at),
      finished_at: str(meta.finished_at),
      status: str(meta.status),
    };
  }
  return g;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function flatten(n: RawNode): { path: string; value: unknown }[] {
  const rows: { path: string; value: unknown }[] = [];
  const push = (p: string, v: unknown) => {
    if (v === undefined || v === null) return;
    rows.push({ path: p, value: v });
  };
  push("label", n.label);
  push("name", n.name);
  push("type", n.type);
  push("region", n.region);
  push("account_id", n.account_id);
  for (const k of Object.keys(n.properties).sort()) {
    let v: unknown = n.properties[k];
    if (typeof v === "object") v = JSON.stringify(v);
    push(`properties.${k}`, v);
  }
  push("tags", JSON.parse(n.tags || "{}"));
  return rows;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function pstr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function buildLines(x: RawNode | null, y: RawNode | null): DiffLine[] {
  const xr = x ? flatten(x) : [];
  const yr = y ? flatten(y) : [];
  const paths = [...new Set([...xr.map((r) => r.path), ...yr.map((r) => r.path)])].sort();
  const out: DiffLine[] = [];
  for (const p of paths) {
    const xv = xr.find((r) => r.path === p)?.value;
    const yv = yr.find((r) => r.path === p)?.value;
    if (!x) out.push({ status: "add", path: p, to: yv });
    else if (!y) out.push({ status: "del", path: p, from: xv });
    else if (same(xv, yv)) out.push({ status: "same", path: p, to: yv });
    else out.push({ status: "mod", path: p, from: xv, to: yv });
  }
  return out;
}

const MUTATION_RE = /^(Create|Delete|Put|Modify|Update|Tag|Untag|Stop|Start|Terminate|Run|Associate|Disassociate|Attach|Detach|Authorize|Revoke|Enable|Disable|Remove|Add|Set|Change)/;

function attribute(pair: { a: SnapshotGraph; b: SnapshotGraph }, items: { key: string; name: string }[]): Attribution | undefined {
  const a = pair.a, b = pair.b;
  const trail = b.trail.length ? b.trail : a.trail;
  if (!trail || !trail.length) return undefined;
  const win = { from: a.meta.finished_at ?? "", to: b.meta.finished_at ?? "" };
  const tsFrom = win.from ? Date.parse(win.from) : NaN;
  const tsTo = win.to ? Date.parse(win.to) : Infinity;
  const keys = new Set(items.map((i) => i.key));
  const names = new Set(items.map((i) => i.name).filter(Boolean));
  const keyArr = [...keys], nameArr = [...names];
  const hit = (rn: string) =>
    keys.has(rn) || names.has(rn) ||
    keyArr.some((k) => k.endsWith("/" + rn) || k.endsWith(":" + rn)) ||
    nameArr.some((n) => n.endsWith("/" + rn) || n.endsWith(":" + rn));
  let best: TrailEvent | undefined;
  for (const e of trail) {
    if (!e.read_only && MUTATION_RE.test(e.event_name ?? "")) {
      const t = e.event_time ? Date.parse(e.event_time) : NaN;
      if (!isNaN(t) && t >= tsFrom && t <= tsTo) {
        const res = (e.resources ?? []).some((r) => hit(r.name ?? ""));
        if (res) {
          if (!best || t > Date.parse(best.event_time ?? "")) best = e;
        }
      }
    }
  }
  if (!best) return undefined;
  return {
    event_name: best.event_name ?? "",
    username: best.username,
    user_arn: best.user_arn,
    access_key_id: best.access_key_id,
    user_type: best.user_type,
    source_ip: best.source_ip,
    event_time: best.event_time ?? "",
  };
}

export function diffSnapshots(fromId: string, toId: string) {
  const a = loadSnapshot(fromId);
  const b = loadSnapshot(toId);

  const aKeys = new Set(a.nodes.keys());
  const bKeys = new Set(b.nodes.keys());
  const addedKeys = [...bKeys].filter((k) => !aKeys.has(k));
  const removedKeys = [...aKeys].filter((k) => !bKeys.has(k));
  const commonKeys = [...aKeys].filter((k) => bKeys.has(k));

  const added: DriftEntry[] = [];
  const removed: DriftEntry[] = [];
  const changed: DriftChange[] = [];

  for (const k of addedKeys) {
    const n = b.nodes.get(k)!;
    added.push({ key: k, name: n.name, label: n.label, lines: buildLines(null, n) });
  }
  for (const k of removedKeys) {
    const n = a.nodes.get(k)!;
    removed.push({ key: k, name: n.name, label: n.label, lines: buildLines(n, null) });
  }
  for (const k of commonKeys) {
    const x = a.nodes.get(k)!;
    const y = b.nodes.get(k)!;
    const fields: DriftChange["fields"] = {};
    for (const p of ["label", "name", "type", "region"]) {
      const xv = (x as unknown as Record<string, unknown>)[p];
      const yv = (y as unknown as Record<string, unknown>)[p];
      if (xv !== yv) fields[p] = { from: xv, to: yv };
    }
    if (x.tags !== y.tags) fields.tags = { from: JSON.parse(x.tags), to: JSON.parse(y.tags) };
    for (const fk of VALUE_KEYS) {
      const xv = x.properties[fk];
      const yv = y.properties[fk];
      if (JSON.stringify(xv) !== JSON.stringify(yv) && (xv !== undefined || yv !== undefined)) {
        fields[fk] = { from: xv ?? null, to: yv ?? null };
      }
    }
    if (Object.keys(fields).length) {
      changed.push({ key: k, name: y.name, label: y.label, fields, lines: buildLines(x, y) });
    }
  }

  const aEdges = new Set(a.edges.map((e) => `${e.from}>${e.to}>${e.type}`));
  const bEdges = new Set(b.edges.map((e) => `${e.from}>${e.to}>${e.type}`));
  const edgesAdded: RawEdge[] = [...bEdges].filter((s) => !aEdges.has(s)).map(decodeSig);
  const edgesRemoved: RawEdge[] = [...aEdges].filter((s) => !bEdges.has(s)).map(decodeSig);

  const aF = new Set(a.findings.keys());
  const bF = new Set(b.findings.keys());
  const fAdded: Finding[] = [];
  const fRemoved: Finding[] = [];
  const fChanged: Finding[] = [];
  for (const id of [...bF].filter((k) => !aF.has(k))) fAdded.push(b.findings.get(id)!);
  for (const id of [...aF].filter((k) => !bF.has(k))) fRemoved.push(a.findings.get(id)!);
  for (const id of [...aF].filter((k) => bF.has(k))) {
    const x = a.findings.get(id)!;
    const y = b.findings.get(id)!;
    if (x.severity !== y.severity || x.message !== y.message || x.resource_key !== y.resource_key) fChanged.push(y);
  }

  const ctx = { a, b };
  for (const it of added) it.attributed_by = attribute(ctx, [it]);
  for (const it of removed) it.attributed_by = attribute(ctx, [it]);
  for (const it of changed) it.attributed_by = attribute(ctx, [{ key: it.key, name: it.name }]);
  for (const it of fAdded) (it as unknown as { attributed_by?: Attribution }).attributed_by = attribute(ctx, [{ key: it.resource_key, name: it.resource_key }]);
  for (const it of fRemoved) (it as unknown as { attributed_by?: Attribution }).attributed_by = attribute(ctx, [{ key: it.resource_key, name: it.resource_key }]);
  for (const it of fChanged) (it as unknown as { attributed_by?: Attribution }).attributed_by = attribute(ctx, [{ key: it.resource_key, name: it.resource_key }]);

  const attrCount = [...added, ...removed, ...changed, ...fAdded, ...fRemoved, ...fChanged]
    .filter((x) => (x as unknown as { attributed_by?: Attribution }).attributed_by).length;

  const summarize = <T,>(xs: T[]) => ({ count: xs.length, items: xs.slice(0, 50) });
  const listSnaps = listSnapshots();
  return {
    from: fromId,
    to: toId,
    meta: {
      from: a.meta,
      to: b.meta,
    },
    counts: {
      nodes_added: added.length, nodes_removed: removed.length, nodes_changed: changed.length,
      edges_added: edgesAdded.length, edges_removed: edgesRemoved.length,
      findings_added: fAdded.length, findings_removed: fRemoved.length, findings_changed: fChanged.length,
    },
    trail: {
      available_from: !!a.trail.length,
      available_to: !!b.trail.length,
      events_from: a.trail.length,
      events_to: b.trail.length,
      attributed: attrCount,
    },
    nodes_added: summarize(added),
    nodes_removed: summarize(removed),
    nodes_changed: summarize(changed),
    edges_added: summarize(edgesAdded),
    edges_removed: summarize(edgesRemoved),
    findings_added: summarize(fAdded),
    findings_removed: summarize(fRemoved),
    findings_changed: summarize(fChanged),
    overlay: {
      nodes: [...added.slice(0, 200), ...changed.slice(0, 200)].map((n) => ({ key: n.key, kind: added.includes(n) ? "add" : "mod" })),
      snapshots_length: listSnaps.length,
    },
  };
}

export function exportDiff(d: ReturnType<typeof diffSnapshots>, format: "md" | "json"): string {
  if (format === "json") return JSON.stringify(d, null, 2);

  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const linesOut: string[] = [];
  const push = (s = "") => linesOut.push(s);

  push(`# AWSome drift report`);
  push();
  push(`- **From:** \`${d.from}\` → **To:** \`${d.to}\``);
  const fm = d.meta.from, tm = d.meta.to;
  push(`- From by \`${fm.user ?? "?"}@${fm.hostname ?? "?"}\` (${fm.trigger ?? "manual"}) \u2022 To by \`${tm.user ?? "?"}@${tm.hostname ?? "?"}\` (${tm.trigger ?? "manual"})`);
  const c = d.counts;
  push(`- Changes: **+${c.nodes_added}** / **\u2212${c.nodes_removed}** / **\u2248${c.nodes_changed}** resources \u2022 edges **+${c.edges_added}** /\u2212${c.edges_removed} \u2022 findings **+${c.findings_added}** /\u2212${c.findings_removed} /\u2248${c.findings_changed}`);
  push();
  push(`## Resources`);
  if (d.nodes_added.count) {
    push(`### Added (+${d.nodes_added.count})`);
    for (const r of d.nodes_added.items) {
      push(`#### \`${r.label}\` ${r.name || r.key}`);
      if (r.attributed_by) push(`> 🔑 ${attrText(r.attributed_by)}`);
      push("```diff");
      for (const l of r.lines) {
        if (l.status === "add") push(`+ ${l.path} = ${pstr(l.to)}`);
      }
      push("```");
    }
  }
  if (d.nodes_removed.count) {
    push(`### Removed (\u2212${d.nodes_removed.count})`);
    for (const r of d.nodes_removed.items) {
      push(`#### \`${r.label}\` ${r.name || r.key}`);
      if (r.attributed_by) push(`> 🔑 ${attrText(r.attributed_by)}`);
      push("```diff");
      for (const l of r.lines) {
        if (l.status === "del") push(`- ${l.path} = ${pstr(l.from)}`);
      }
      push("```");
    }
  }
  if (d.nodes_changed.count) {
    push(`### Changed (\u2248${d.nodes_changed.count})`);
    for (const r of d.nodes_changed.items) {
      push(`#### \`${r.label}\` ${r.name || r.key}`);
      if (r.attributed_by) push(`> 🔑 ${attrText(r.attributed_by)}`);
      push("```diff");
      for (const l of r.lines) {
        if (l.status === "mod") push(`- ${l.path} = ${pstr(l.from)}\n+ ${l.path} = ${pstr(l.to)}`);
        else if (l.status !== "same") push(`${l.status === "add" ? "+" : "-"} ${l.path} = ${pstr(l.to ?? l.from)}`);
      }
      push("```");
    }
  }
  if (d.edges_added.count || d.edges_removed.count) {
    push(`## Edges`);
    push("| change | from | to | type |");
    push("| --- | --- | --- | --- |");
    for (const e of d.edges_added.items) push(`| + | ${esc(e.from)} | ${esc(e.to)} | ${esc(e.type)} |`);
    for (const e of d.edges_removed.items) push(`| \u2212 | ${esc(e.from)} | ${esc(e.to)} | ${esc(e.type)} |`);
  }
  if (d.findings_added.count || d.findings_removed.count || d.findings_changed.count) {
    push(`## Findings`);
    const sevBadge = (s: string) => s.toUpperCase();
    const fAttr = (f: { attributed_by?: Attribution }) => f.attributed_by ? ` — 🔑 ${attrText(f.attributed_by)}` : "";
    for (const f of d.findings_added.items) {
      push(`- **+ ${sevBadge(f.severity)}** ${esc(f.rule)} — ${esc(f.message)} (\`${esc(f.resource_key)}\`)${fAttr(f as never)}`);
    }
    for (const f of d.findings_removed.items) {
      push(`- **\u2212 ${sevBadge(f.severity)}** ${esc(f.rule)} — ${esc(f.message)} (\`${esc(f.resource_key)}\`)${fAttr(f as never)}`);
    }
    for (const f of d.findings_changed.items) {
      push(`- **\u2248 ${sevBadge(f.severity)}** ${esc(f.rule)} — ${esc(f.message)} (\`${esc(f.resource_key)}\`)${fAttr(f as never)}`);
    }
  }
  return linesOut.join("\n") + "\n";
}

function attrText(a: Attribution): string {
  return `${a.event_name} by ${a.username ?? a.user_arn ?? a.access_key_id ?? "unknown"}${a.source_ip ? ` from ${a.source_ip}` : ""} @ ${a.event_time}`;
}

export { listSnapshots };

export function driftTargets(): { from: string | null; to: string | null } {
  const snaps = listSnapshots();
  if (snaps.length < 2) return { from: null, to: snaps[0]?.id ?? null };
  return { from: snaps[1].id, to: snaps[0].id };
}

function decodeSig(sig: string): RawEdge {
  const i = sig.indexOf(">");
  const j = sig.lastIndexOf(">");
  return { from: sig.slice(0, i), to: sig.slice(i + 1, j), type: sig.slice(j + 1) };
}
