import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { Cypher, Row } from "./cypher.ts";
import {
  GraphNode, GraphEdge,
  querySummary, queryEdgesCount, queryAccountsRegions,
  queryResources, queryNodes, queryEdges, queryDetail, queryNeighbors,
  queryFindingNodes, queryAffectsEdges,
} from "./neo.ts";
import * as findings from "./findings.ts";
import * as jobs from "./jobs.ts";
import * as chat from "./ai/chat.ts";
import * as drift from "./diff.ts";
import * as opencodeProc from "./opencode_proc.ts";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "web");

const NEO4J_URL = Deno.env.get("NEO4J_URL") ?? "http://127.0.0.1:7474";
const NEO4J_USER = Deno.env.get("NEO4J_USER") ?? "neo4j";
const NEO4J_PASSWORD = Deno.env.get("NEO4J_PASSWORD") ?? "awsome-dev-pass";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

const cypher = new Cypher({ base: NEO4J_URL, user: NEO4J_USER, password: NEO4J_PASSWORD });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withError(fn: () => Promise<unknown>): Promise<Response> {
  return fn().then((d) => json(d)).catch((err) =>
    json({ error: String(err instanceof Error ? err.message : err) }, 500)
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function handleStatic(reqPath: string, url: URL): Response {
  let rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  let full = path.resolve(webRoot, "." + path.sep + rel);
  if (!full.startsWith(webRoot + path.sep) && full !== webRoot) {
    return new Response("forbidden", { status: 403 });
  }
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    full = path.join(full, "index.html");
  }
  if (!fs.existsSync(full)) {
    return json({ error: "not found", path: reqPath }, 404);
  }
  const ext = path.extname(full).toLowerCase();
  const body = fs.readFileSync(full);
  return new Response(body, {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
  });
}

async function graphSubgraph(nodes: GraphNode[], edges: GraphEdge[], vpc: string | null) {
  let scopeNodes = nodes;
  if (vpc) {
    const rows = await cypher.run(
      `MATCH (v {key: $vk}), (n:Resource)
       WHERE n = v OR (n)-[:PART_OF|IN_VPC|IN_SUBNET|CONTAINS*1..4]-(v)
       RETURN n.key AS key`,
      { vk: vpc },
    );
    const keys = new Set(rows.map((r) => r.key as string));
    scopeNodes = nodes.filter((n) => keys.has(n.id));
    edges = edges.filter((e) => keys.has(e.from) && keys.has(e.to));
  }
  return { nodes: scopeNodes, edges };
}

async function handler(req: Request): Promise<Response> {
  const reqPath = new URL(req.url).pathname;
  const url = new URL(req.url);

  const ws = jobs.ws(req);
  if (ws) return ws;

  if (reqPath === "/api/health") {
    return withError(async () => {
      await cypher.run("RETURN 1 AS ok");
      return { ok: true, neo4j: true, latest: findings.latestSnapshot() };
    });
  }

  if (reqPath === "/api/summary") {
    return withError(async () => {
      const [byType, edgeCount, accountRegions, snaps] = await Promise.all([
        querySummary(cypher),
        queryEdgesCount(cypher),
        queryAccountsRegions(cypher),
        Promise.resolve(findings.listSnapshots()),
      ]);
      const labels: Record<string, number> = {};
      for (const r of byType) labels[String(r.label ?? "")] = Number(r.c);
      const edges = Number(edgeCount[0]?.c ?? 0);
      const accounts = [...new Set(accountRegions.map((r) => r.account_id as string))];
      const regions = [...new Set(accountRegions.map((r) => r.region as string))];
      const latest = snaps[0] ?? null;
      const fs = latest
        ? findings.loadFindings(latest.id)
        : [];
      return {
        nodes: Object.values(labels).reduce((a, b) => a + b, 0),
        labels,
        edges,
        accounts,
        regions,
        latest_snapshot: latest,
        findings: findings.findingsCounts(fs),
        neo4j: { url: NEO4J_URL },
      };
    });
  }

  if (reqPath === "/api/snapshots") {
    return json(findings.listSnapshots());
  }

  if (reqPath === "/api/diff") {
    return withError(async () => {
      const snaps = findings.listSnapshots();
      let from = url.searchParams.get("from") ?? null;
      let to = url.searchParams.get("to") ?? null;
      if (!from || !to) {
        const t = drift.driftTargets();
        from = from ?? t.from;
        to = to ?? t.to;
      }
      if (!from || !to || from === to) return json({ error: "need two different snapshots (use ?from=&to=)" }, 400);
      const snapById = (id: string) => snaps.find((s) => s.id === id) ?? null;
      return { ...drift.diffSnapshots(from, to), from_meta: snapById(from), to_meta: snapById(to), target: { from, to } };
    });
  }

  if (reqPath === "/api/graph") {
    return withError(async () => {
      const [nodes, edges] = await Promise.all([queryNodes(cypher), queryEdges(cypher)]);
      const scope = url.searchParams.get("vpc") ?? url.searchParams.get("scope");
      const vpc = scope && scope !== "account" ? scope : null;
      const sub = await graphSubgraph(nodes, edges, vpc);
      return { count: { nodes: sub.nodes.length, edges: sub.edges.length }, ...sub };
    });
  }

  if (reqPath === "/api/findings") {
    const sid = url.searchParams.get("snapshot") ?? undefined;
    const list = findings.loadFindings(sid);
    return json({ snapshot: findings.latestSnapshot(), counts: findings.findingsCounts(list), findings: list });
  }

  if (reqPath === "/api/graph/findings") {
    return withError(async () => {
      const [nodes, edges] = await Promise.all([queryFindingNodes(cypher), queryAffectsEdges(cypher)]);
      return { count: { nodes: nodes.length, edges: edges.length }, nodes, edges };
    });
  }

  if (reqPath.startsWith("/api/resources/")) {
    const segments = reqPath.split("/").filter(Boolean); // ["api","resources",<key>,(neighbors)?]
    const key = decodeURIComponent(segments[2] ?? "");
    if (!key) return json({ error: "missing key" }, 400);
    return withError(async () => {
      const detail = await queryDetail(cypher, key);
      if (!detail) return json({ error: "not found" }, 404);
      if (segments[3] === "neighbors") {
        const neighbors = await queryNeighbors(cypher, key);
        return { node: detail, neighbors };
      }
      return detail;
    });
  }

  if (reqPath === "/api/jobs") {
    if (req.method === "POST") {
      let regions: string[] = [];
      try {
        const b = await req.json();
        regions = Array.isArray(b?.regions) ? b.regions as string[] : [];
      } catch {
        // no body -> default regions
      }
      return withError(async () => jobs.createJob(regions));
    }
    return withError(async () => jobs.listJobs());
  }

  if (reqPath === "/api/opencode") {
    return withError(async () => ({
      managed: await opencodeProc.status(),
      env: { url: opencodeProc.explicitTarget().url, password_set: !!opencodeProc.explicitTarget().password, managed_port: opencodeProc.managedPort() },
    }));
  }
  if (reqPath === "/api/opencode/start" && req.method === "POST") {
    return withError(async () => opencodeProc.start());
  }
  if (reqPath === "/api/opencode/stop" && req.method === "POST") {
    return withError(async () => opencodeProc.stop());
  }

  if (reqPath === "/api/chat" && req.method === "POST") {
    let question = "";
    let provider: string | undefined;
    try {
      const b = await req.json();
      question = String(b?.question ?? "").trim();
      provider = typeof b?.provider === "string" && b.provider ? b.provider : undefined;
    } catch { /* fallthrough */ }
    if (!question) return json({ error: "missing question" }, 400);
    if (question.length > 2000) return json({ error: "question too long (max 2000)" }, 400);
    return withError(async () => chat.ask(cypher, question, provider));
  }

  if (reqPath.startsWith("/api/jobs/")) {
    const segments = reqPath.split("/").filter(Boolean); // ["api","jobs",<id>,(action)?]
    const id = decodeURIComponent(segments[2] ?? "");
    if (!id) return json({ error: "missing job id" }, 400);
    const action = segments[3];
    try {
      const job = await jobs.getJob(id);
      if (!job) return json({ error: "job not found" }, 404);
    } catch {
      // control plane down; fall through to explicit error
    }
    if (req.method === "POST") {
      if (action === "cancel") return withError(async () => jobs.cancelJob(id));
      if (action === "resume") return withError(async () => jobs.resumeJob(id));
    }
    return withError(async () => {
      const job = await jobs.getJob(id);
      if (!job) throw new Error("job not found");
      return job;
    });
  }

  if (reqPath === "/api/diff/export") {
    try {
      const snaps = findings.listSnapshots();
      let from = url.searchParams.get("from") ?? null;
      let to = url.searchParams.get("to") ?? null;
      if (!from || !to) { const t = drift.driftTargets(); from = from ?? t.from; to = to ?? t.to; }
      if (!from || !to || from === to) return json({ error: "need two different snapshots" }, 400);
      const fmt = (url.searchParams.get("format") ?? "json").toLowerCase() as "json" | "md";
      const snapById = (id: string) => snaps.find((s) => s.id === id) ?? null;
      const data = { ...drift.diffSnapshots(from, to), from_meta: snapById(from), to_meta: snapById(to), target: { from, to } };
      const body = drift.exportDiff(data, fmt === "md" ? "md" : "json");
      const mime = fmt === "md" ? "text/markdown; charset=utf-8" : "application/json";
      const ext = fmt === "md" ? ".md" : ".json";
      const filename = `awsome-drift-${from}-to-${to}${ext}`;
      return new Response(body, {
        headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${filename}"` },
      });
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  }

  if (reqPath === "/api/resources") {
    return withError(async () => {
      const q = url.searchParams.get("q") ?? "";
      const type = url.searchParams.get("type") ?? "";
      const region = url.searchParams.get("region") ?? "";
      const account = url.searchParams.get("account") ?? "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
      const list = await queryResources(cypher, { q, type, region, account, limit });
      return { count: list.length, resources: list };
    });
  }

  return handleStatic(reqPath, url);
}

const server = Deno.serve({ port: PORT, handler, onListen({ port }) {
  console.log(`awesome-web  http://127.0.0.1:${port}`);
  console.log(`neo4j        ${NEO4J_URL}`);
} });
void server;
