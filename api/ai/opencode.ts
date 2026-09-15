import { managedTarget, explicitTarget } from "../opencode_proc.ts";

interface OCPart { type?: string; text?: string; }

function credentials(): string | null {
  const pw = explicitTarget().password ?? managedTarget()?.password ?? Deno.env.get("OPENCODE_SERVER_PASSWORD");
  if (!pw) return null;
  const user = Deno.env.get("OPENCODE_SERVER_USERNAME") ?? "opencode";
  const bin = new TextEncoder().encode(`${user}:${pw}`);
  let chars = "";
  for (const b of bin) chars += String.fromCharCode(b);
  return `Basic ${btoa(chars)}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const creds = credentials();
  if (creds) h.authorization = creds;
  return h;
}

function resolveBase(): string {
  const exp = explicitTarget().url;
  if (exp) return exp.replace(/\/+$/, "");
  const mg = managedTarget();
  if (mg) return mg.url;
  return "http://127.0.0.1:4100";
}

async function ocFetch(
  base: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs: number },
): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method: init.method,
    headers: headers(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.timeoutMs > 0 ? AbortSignal.timeout(init.timeoutMs) : undefined,
  });
  return res;
}

export async function askOpencode(system: string, user: string, timeoutMs = 180000): Promise<string> {
  const base = resolveBase();

  const health = await ocFetch(base, "/global/health", { method: "GET", timeoutMs: 5000 });
  if (!health.ok) throw new Error(`opencode server unreachable at ${base} (${health.status})`);

  const sessRes = await ocFetch(base, "/session", { method: "POST", body: { title: "awsome-ask" }, timeoutMs: 15000 });
  if (!sessRes.ok) throw new Error(`opencode: create session ${sessRes.status}`);
  const sess = await sessRes.json() as { id: string };
  const sid = sess.id;

  const body: Record<string, unknown> = {
    system,
    tools: null,
    parts: [{ type: "text", text: user }],
  };
  const model = Deno.env.get("OPENCODE_MODEL");
  if (model) body.model = model;

  try {
    const res = await ocFetch(base, `/session/${sid}/message`, { method: "POST", body, timeoutMs });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`opencode ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = await res.json() as { info?: { id: string; role?: string }; parts?: OCPart[] };
    const texts = (data.parts ?? [])
      .filter((p) => p.type === "text" && p.text && p.text.trim().length > 0)
      .map((p) => p.text!.trim());
    const answer = texts.join("\n\n");
    if (!answer) throw new Error("opencode agent returned no text (got " + (data.parts?.length ?? 0) + " parts)");
    return answer;
  } finally {
    try {
      await ocFetch(base, `/session/${sid}`, { method: "DELETE", timeoutMs: 5000 });
    } catch { /* best-effort cleanup */ }
  }
}
