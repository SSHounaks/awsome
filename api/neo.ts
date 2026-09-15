import { Cypher } from "./cypher.ts";

export interface GraphNode {
  id: string;
  label: string;
  name: string;
  type: string;
  tags: Record<string, unknown>;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

export const safeLabel = (s: string): string =>
  s.replace(/[^A-Za-z0-9_]/g, "_");

const labelOf = (labels: unknown): string => {
  if (typeof labels === "string") return labels;
  if (Array.isArray(labels)) return labels.find((l) => l !== "Resource") as string ?? "";
  return "";
};

export function querySummary(c: Cypher) {
  return c.run(
    `MATCH (n:Resource)
     WITH [l IN labels(n) WHERE l <> 'Resource'][0] AS label
     RETURN label, count(*) AS c ORDER BY c DESC`,
  );
}

export function queryEdgesCount(c: Cypher) {
  return c.run(`MATCH ()-[r]->() RETURN count(r) AS c`);
}

export function queryAccountsRegions(c: Cypher) {
  return c.run(
    `MATCH (n:Resource) RETURN n.account_id AS account_id, n.region AS region, count(*) AS c ORDER BY c DESC`,
  );
}

export async function queryResources(
  c: Cypher,
  opts: { q?: string; type?: string; region?: string; account?: string; limit: number },
): Promise<RowLike[]> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  let match = "MATCH (n:Resource)";
  if (opts.type) match = `MATCH (n:Resource:${safeLabel(opts.type)})`;
  if (opts.q) {
    where.push("(n.name CONTAINS $q OR n.key CONTAINS $q)");
    params.q = opts.q;
  }
  if (opts.region) { where.push("n.region = $region"); params.region = opts.region; }
  if (opts.account) { where.push("n.account_id = $account"); params.account = opts.account; }
  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await c.run(
    `${match} ${whereClause}
     RETURN n.key AS key, [l IN labels(n) WHERE l <> 'Resource'][0] AS label,
            n.name AS name, n.type AS type
     ORDER BY label LIMIT ${Math.max(1, opts.limit)}`,
    params,
  );
  const out: RowLike[] = [];
  for (const r of rows) {
    out.push({
      key: r.key as string,
      label: labelOf(r.label),
      name: (r.name as string) ?? "",
      type: (r.type as string) ?? "",
    });
  }
  return out;
}

export function parseNode(row: Record<string, unknown>): GraphNode {
  const tagsRaw = (row.tags as string) ?? "{}";
  let tags: Record<string, unknown> = {};
  try { tags = JSON.parse(tagsRaw); } catch { tags = { _raw: tagsRaw }; }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (["key", "aid", "name", "type", "tags", "partition", "region", "account_id", "snapshot_id", "scanned_at"].includes(k)) continue;
    props[k] = v;
  }
  return {
    id: String(row.key),
    label: props.label as string ?? "",
    name: (row.name as string) ?? "",
    type: (row.type as string) ?? "",
    tags,
    properties: props,
  };
}

export async function queryNodes(c: Cypher): Promise<GraphNode[]> {
  const rows = await c.run(
    `MATCH (n:Resource)
     RETURN n, [l IN labels(n) WHERE l <> 'Resource'][0] AS label`,
  );
  return rows.map((r) => {
    const node = parseNode(r.n as Record<string, unknown>);
    node.label = labelOf(r.label);
    return node;
  });
}

export async function queryEdges(c: Cypher): Promise<GraphEdge[]> {
  const rows = await c.run(
    `MATCH (a:Resource)-[r]->(b:Resource) RETURN a.key AS from, type(r) AS t, b.key AS to`,
  );
  return rows.map((r) => ({
    from: r.from as string,
    to: r.to as string,
    type: r.t as string,
  }));
}

export async function queryDetail(c: Cypher, key: string): Promise<GraphNode | null> {
  const rows = await c.run(
    `MATCH (n {key: $key}) RETURN n, [l IN labels(n) WHERE l <> 'Resource'][0] AS label`,
    { key },
  );
  if (!rows.length) return null;
  const node = parseNode(rows[0].n as Record<string, unknown>);
  node.label = labelOf(rows[0].label);
  return node;
}

export interface Neighbor {
  dir: "out" | "in";
  type: string;
  key: string;
  name: string;
  label: string;
}

export async function queryNeighbors(c: Cypher, key: string): Promise<Neighbor[]> {
  const rows = await c.run(
    `MATCH (n {key: $key})-[r]->(m)
     RETURN 'out' AS dir, type(r) AS t, m.key AS key, m.name AS name,
            [l IN labels(m) WHERE l <> 'Resource'][0] AS label
     UNION
     MATCH (n {key: $key})<-[r]-(m)
     RETURN 'in' AS dir, type(r) AS t, m.key AS key, m.name AS name,
            [l IN labels(m) WHERE l <> 'Resource'][0] AS label`,
    { key },
  );
  return rows.map((r) => ({
    dir: r.dir as "out" | "in",
    type: r.t as string,
    key: r.key as string,
    name: (r.name as string) ?? "",
    label: labelOf(r.label),
  }));
}

interface RowLike {
  key: string;
  label: string;
  name: string;
  type: string;
}

export async function queryFindingNodes(c: Cypher): Promise<GraphNode[]> {
  const rows = await c.run(
    `MATCH (f:Finding)
     RETURN f.key AS key, f.severity AS severity, f.rule AS rule,
            f.message AS message, f.remediation AS remediation,
            f.resource_label AS resource_label, f.resource_name AS resource_name,
            f.resource_key AS resource_key,
            f.region AS region, f.account_id AS account_id`,
  );
  return rows.map((r) => ({
    id: String(r.key ?? ""),
    label: "Finding",
    name: `[${r.severity ?? ""}] ${r.rule ?? ""}`.trim(),
    type: "Finding",
    tags: { severity: r.severity, rule: r.rule },
    properties: {
      severity: r.severity,
      rule: r.rule,
      message: r.message,
      remediation: r.remediation,
      resource_label: r.resource_label,
      resource_name: r.resource_name,
      resource_key: r.resource_key,
      region: r.region,
      account_id: r.account_id,
    },
  }));
}

export async function queryAffectsEdges(c: Cypher): Promise<GraphEdge[]> {
  const rows = await c.run(
    `MATCH (f:Finding)-[:AFFECTS]->(r:Resource) RETURN f.key AS from, r.key AS to`,
  );
  return rows.map((r) => ({
    from: String(r.from ?? ""),
    to: String(r.to ?? ""),
    type: "AFFECTS",
  }));
}
