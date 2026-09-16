import * as path from "node:path";
import * as url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const rpc = (id: number, method: string, params?: unknown): string => {
  const msg = { jsonrpc: "2.0", id, method, params };
  return `Content-Length: ${JSON.stringify(msg).length}\r\n\r\n${JSON.stringify(msg)}`;
};

// Deno.execPath() is the interpreter already running this script, so the test
// works on any machine. This was hardcoded to one developer's home directory.
const proc = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read=.", "--allow-env", "api/mcp_server.ts"],
  cwd: repoRoot,
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();

const writer = proc.stdin.getWriter();
const reader = proc.stdout.getReader();
const errReader = proc.stderr.getReader();
void (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await errReader.read();
    if (done) break;
    if (value) console.error("MCP>", dec.decode(value).trim());
  }
})();

const input = [
  rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  }),
  rpc(2, "tools/list"),
  rpc(3, "tools/call", { name: "graph_summary", arguments: {} }),
  rpc(4, "tools/call", { name: "list_findings", arguments: { severity: "critical" } }),
  rpc(5, "tools/call", { name: "get_resource", arguments: { key: "arn:aws:s3:::awsome-demo-public" } }),
];
await writer.write(new TextEncoder().encode(input.join("")));
await writer.close();

let allOut = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value) allOut += new TextDecoder().decode(value);
}
await proc.status;

const frames: string[] = [];
let raw = allOut;
const dec = new TextDecoder();
for (;;) {
  const head = /Content-Length: (\d+)\r\n\r\n/.exec(dec.decode(new TextEncoder().encode(raw).subarray(0, 4096)));
  if (!head) break;
  const header = new TextEncoder().encode(`Content-Length: ${head[1]}\r\n\r\n`);
  const n = Number(head[1]);
  if (new TextEncoder().encode(raw).length < header.length + n) break;
  frames.push(new TextDecoder().decode(new TextEncoder().encode(raw).subarray(header.length, header.length + n)));
  raw = new TextDecoder().decode(new TextEncoder().encode(raw).subarray(header.length + n));
}

for (const f of frames) {
  const m = JSON.parse(f);
  if (m.id === 1) console.log("initialize ->", JSON.stringify(m.result.serverInfo), m.result.protocolVersion);
  if (m.id === 2) console.log("tools/list ->", m.result && Array.isArray(m.result.tools) ? `${m.result.tools.length} tools: ${m.result.tools.map((t: any) => t.name).join(", ")}` : "ERR");
  if (m.id === 3) {
    const txt = m.result?.content?.[0]?.text ?? "";
    const s = JSON.parse(txt);
    console.log("graph_summary ->", `${s.nodes} nodes ${s.edges} edges findings=${s.findings.total}`);
  }
  if (m.id === 4) {
    const txt = m.result?.content?.[0]?.text ?? "";
    const list = JSON.parse(txt);
    console.log("list_findings(critical) ->", list.length, list[0]?.rule, "|", list[0]?.message?.slice(0, 60));
  }
  if (m.id === 5) {
    const txt = m.result?.content?.[0]?.text ?? "";
    // get_resource answers with a plain-text message when the key is absent, so
    // the probe key not existing in this account is a valid result, not a crash.
    try {
      const d = JSON.parse(txt);
      console.log("get_resource ->", d.node?.name ?? "ERR", "findings:", (d.affected ?? []).length);
    } catch {
      console.log("get_resource ->", txt.slice(0, 80));
    }
  }
}
Deno.exit(0);
