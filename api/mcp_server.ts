import { Cypher } from "./cypher.ts";
import {
  querySummary, queryEdgesCount, queryAccountsRegions,
  queryDetail, queryNeighbors, queryFindingNodes,
} from "./neo.ts";
import * as findings from "./findings.ts";
import * as jobs from "./jobs.ts";

const VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

const NEO4J_URL = Deno.env.get("NEO4J_URL") ?? "http://127.0.0.1:7474";
const NEO4J_USER = Deno.env.get("NEO4J_USER") ?? "neo4j";
const NEO4J_PASSWORD = Deno.env.get("NEO4J_PASSWORD") ?? "awsome-dev-pass";
const cypher = new Cypher({ base: NEO4J_URL, user: NEO4J_USER, password: NEO4J_PASSWORD });

const tools = [
  {
    name: "graph_summary",
    description: "Counts and labels for the current infrastructure graph (Neo4j), plus latest snapshot id.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_findings",
    description: "List misconfiguration findings from the latest snapshot. Optionally filter by severity, rule or a resource name.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
        rule: { type: "string" },
        limit: { type: "number", default: 25 },
      },
    },
  },
  {
    name: "get_resource",
    description: "Fetch a single resource (ARN key) with its properties, neighbors, and findings that AFFECT it.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "resource ARN / key" } },
      required: ["key"],
    },
  },
  {
    name: "list_finding_nodes",
    description: "Return findings as graph nodes with AFFECTS edges (overlay for diagram/AI citation).",
    inputSchema: {
      type: "object",
      properties: { severity: { type: "string" }, limit: { type: "number", default: 100 } },
    },
  },
  {
    name: "list_snapshots",
    description: "List recorded snapshots with their summary status.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "start_scan",
    description: "Start a background scan job against AWS (control plane). Optional regions; simulates a full account snapshot.",
    inputSchema: {
      type: "object",
      properties: { regions: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "list_jobs",
    description: "List scan jobs with their status and step progress.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
] as const;

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "graph_summary": {
      const [byType, edge, acct] = await Promise.all([
        querySummary(cypher).catch(() => [] as { label: string; c: number }[]),
        queryEdgesCount(cypher).catch(() => [] as { c: number }[]),
        queryAccountsRegions(cypher).catch(() => [] as { account_id: string; region: string }[]),
      ]);
      const labels: Record<string, number> = {};
      for (const r of byType) labels[String(r.label ?? "")] = Number(r.c);
      return JSON.stringify({
        snapshot: findings.latestSnapshot(),
        nodes: Object.values(labels).reduce((a, b) => a + b, 0),
        labels,
        edges: Number(edge[0]?.c ?? 0),
        accounts: [...new Set(acct.map((r) => r.account_id as string))],
        regions: [...new Set(acct.map((r) => r.region as string))],
        findings: findings.findingsCounts(findings.loadFindings()),
      }, null, 2);
    }
    case "list_findings": {
      const sev = String(args.severity ?? "");
      const rule = String(args.rule ?? "");
      const limit = Math.min(Number(args.limit ?? 25), 200);
      let list = findings.loadFindings();
      if (sev) list = list.filter((f) => f.severity === sev);
      if (rule) list = list.filter((f) => f.rule === rule);
      return JSON.stringify(list.slice(0, limit), null, 2);
    }
    case "get_resource": {
      const key = String(args.key ?? "");
      if (!key) throw new Error("missing key");
      const [detail, neighbors, findingNodes] = await Promise.all([
        queryDetail(cypher, key).catch(() => null),
        queryNeighbors(cypher, key).catch(() => []),
        queryFindingNodes(cypher).catch(() => []),
      ]);
      if (!detail) throw new Error(`resource not found: ${key}`);
      const affected = findingNodes.filter((f) =>
        String(f.properties?.resource_key ?? f.id) === key ||
        (f.properties?.resource_key && key.includes(String(f.properties.resource_key))),
      );
      return JSON.stringify({ node: detail, neighbors, affected }, null, 2);
    }
    case "list_finding_nodes": {
      const nodes = await queryFindingNodes(cypher);
      const sev = String(args.severity ?? "");
      const limit = Math.min(Number(args.limit ?? 100), 500);
      const filtered = nodes.filter((n) => !sev || n.tags?.severity === sev).slice(0, limit);
      return JSON.stringify(filtered.map((n) => ({ id: n.id, name: n.name, ...n.properties })), null, 2);
    }
    case "list_snapshots":
      return JSON.stringify(findings.listSnapshots(), null, 2);
    case "start_scan": {
      const regions = Array.isArray(args.regions) ? args.regions.map(String) : undefined;
      const job = await jobs.createJob(regions);
      return JSON.stringify({ ok: true, job }, null, 2);
    }
    case "list_jobs":
      return JSON.stringify(await jobs.listJobs(), null, 2);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function frame(json: unknown): string {
  const body = JSON.stringify(json);
  return `Content-Length: ${body.length}\r\n\r\n${body}`;
}

function writeAll(data: Uint8Array) {
  let off = 0;
  while (off < data.length) {
    const n = Deno.stdout.writeSync(data.subarray(off));
    if (n <= 0) throw new Error("stdout write failed");
    off += n;
  }
}

function isNotEmpty(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === "object" && msg !== null;
}

async function handleMessage(msg: Record<string, unknown>): Promise<unknown> {
  const method = String(msg.method ?? "");
  const id = msg.id;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "awsome", version: VERSION },
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null; // notifications get no response
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools } };
  }
  if (method === "tools/call") {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const tool = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await callTool(tool, args);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (e) {
      return {
        jsonrpc: "2.0", id,
        result: { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

async function main() {
  const stdin = Deno.stdin.readable.getReader();
  const stdout = new TextEncoder();
  let buf = new Uint8Array(0);
  const needs = { len: 0 };

  const tryConsume = (): unknown[] => {
    const out: unknown[] = [];
    for (;;) {
      const head = /Content-Length: (\d+)\r\n\r\n/.exec(new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 4096))));
      if (!head) break;
      const headerLen = new TextEncoder().encode(`Content-Length: ${head[1]}\r\n\r\n`).length;
      const bodyLen = Number(head[1]);
      if (buf.length < headerLen + bodyLen) break;
      const body = buf.subarray(headerLen, headerLen + bodyLen);
      buf = buf.subarray(headerLen + bodyLen);
      try { out.push(JSON.parse(new TextDecoder().decode(body))); } catch { /* skip malformed */ }
    }
    return out;
  };

  for (;;) {
    const { done, value } = await stdin.read();
    if (done) break;
    if (value) {
      const tmp = new Uint8Array(buf.length + value.length);
      tmp.set(buf); tmp.set(value, buf.length);
      buf = tmp;
    }
    for (const msg of tryConsume()) {
      if (!isNotEmpty(msg)) continue;
      const reply = await handleMessage(msg);
      if (reply !== null) writeAll(stdout.encode(frame(reply)));
    }
    void needs;
  }
}

if (import.meta.main) {
  console.error(`awsome-mcp   tools=${tools.length}  neo4j=${NEO4J_URL}`);
  main().catch((e) => { console.error("mcp:", e); Deno.exit(1); });
}
