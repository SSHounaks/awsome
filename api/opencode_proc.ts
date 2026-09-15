import * as path from "node:path";
import * as os from "node:os";

const STATE_DIR = Deno.env.get("AWSOME_STATE_DIR") ?? path.join(os.tmpdir(), "awsome");
const STATE_FILE = path.join(STATE_DIR, "opencode-server.json");
const LOG_FILE = path.join(STATE_DIR, "opencode.log");

export function managedPort(): number {
  return Number(Deno.env.get("OPENCODE_MANAGED_PORT") ?? "4100");
}

export interface ManagedState {
  pid: number | null;
  port: number;
  started: string | null;
  password: string | null;
}

export interface OpencodeStatus {
  running: boolean;
  port: number;
  url: string;
  pid: number | null;
  password: boolean;
}

function readState(): ManagedState | null {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(STATE_FILE)) as Partial<ManagedState>;
    return {
      pid: typeof raw.pid === "number" ? raw.pid : null,
      port: typeof raw.port === "number" ? raw.port : managedPort(),
      started: typeof raw.started === "string" ? raw.started : null,
      password: typeof raw.password === "string" ? raw.password : null,
    };
  } catch {
    return null;
  }
}

function writeState(st: ManagedState) {
  Deno.mkdirSync(STATE_DIR, { recursive: true });
  Deno.writeTextFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  try { Deno.chmodSync(STATE_FILE, 0o600); } catch { /* unsupported */ }
}

function clearState() {
  try { Deno.removeSync(STATE_FILE); } catch { /* already gone */ }
}

export async function pidForPort(port: number): Promise<number | null> {
  try {
    const out = await new Deno.Command("pgrep", {
      args: ["-f", `opencode serve --hostname 127.0.0.1 --port ${port}`],
    }).output();
    const txt = new TextDecoder().decode(out.stdout).trim();
    if (!txt) return null;
    const pid = Number(txt.split("\n")[0].trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

export async function status(): Promise<OpencodeStatus> {
  const port = managedPort();
  const st = readState();
  const up = await isUp(port);
  const pid = up ? (await pidForPort(port)) ?? st?.pid ?? null : null;
  if (up && pid === null && st?.pid) {
    // stale record: still reachable, keep last-known pid
    return { running: true, port, url: `http://127.0.0.1:${port}`, pid: st.pid, password: !!st.password };
  }
  return { running: up, port, url: `http://127.0.0.1:${port}`, pid, password: !!st?.password };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function start(opts: { port?: number; password?: string } = {}): Promise<{ ok: boolean; running: boolean; port: number; url: string; pid: number | null; error?: string }> {
  const port = opts.port ?? managedPort();
  if (await isUp(port)) {
    const pid = await pidForPort(port);
    writeState({ pid, port, started: new Date().toISOString(), password: opts.password ?? null });
    return { ok: true, running: true, port, url: `http://127.0.0.1:${port}`, pid };
  }

  const password = opts.password ?? Deno.env.get("OPENCODE_SERVER_PASSWORD") ?? null;
  Deno.mkdirSync(STATE_DIR, { recursive: true });
  const args = ["setsid", "--fork", "opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)];
  const env: Record<string, string> = { ...Deno.env.toObject() };
  if (password) env.OPENCODE_SERVER_PASSWORD = password;
  const script = args.join(" ") + ` > ${JSON.stringify(LOG_FILE)} 2>&1 < /dev/null`;

  const proc = new Deno.Command("bash", { args: ["-c", script], env }).spawn();
  await proc.status; // setsid --fork returns as soon as the daemon forks

  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await isUp(port)) {
      const pid = await pidForPort(port);
      writeState({ pid, port, started: new Date().toISOString(), password });
      return { ok: true, running: true, port, url: `http://127.0.0.1:${port}`, pid };
    }
  }
  return { ok: false, running: false, port, url: `http://127.0.0.1:${port}`, pid: null, error: `opencode serve did not come up within 12s on port ${port} (log: ${LOG_FILE})` };
}

export async function stop(): Promise<{ ok: boolean; running: boolean; port: number; pid: number | null }> {
  const port = managedPort();
  const st = readState();
  let pid = await pidForPort(port) ?? st?.pid ?? null;
  if (pid) {
    try {
      await new Deno.Command("kill", { args: ["-TERM", String(pid)] }).output();
    } catch { /* already gone */ }
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      if (!(await isUp(port))) break;
    }
  }
  pid = await pidForPort(port); // final survival check
  clearState();
  return { ok: true, running: !!pid, port, pid };
}

export function managedTarget(): { url: string; password: string | null } | null {
  const st = readState();
  if (!st) return null;
  return { url: `http://127.0.0.1:${st.port}`, password: st.password };
}

export function explicitTarget(): { url: string | null; password: string | null } {
  return {
    url: Deno.env.get("OPENCODE_URL") ?? null,
    password: Deno.env.get("OPENCODE_SERVER_PASSWORD") ?? null,
  };
}
