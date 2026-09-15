const CONTROL: string = Deno.env.get("CONTROL_URL") ?? "http://127.0.0.1:8080";

export interface StepState {
  service: string;
  region: string;
  status: string;
  nodes?: number;
  edges?: number;
  skipped?: number;
  failed?: number;
}

export interface Job {
  id: string;
  snapshot_id: string;
  status: string;
  account_id?: string;
  partition?: string;
  regions: string[];
  steps: StepState[];
  nodes?: number;
  edges?: number;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cfg?: { endpoint_url?: string; snapshot_dir?: string; concurrency?: number; profile?: string };
}

async function control(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(CONTROL + pathname, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export async function listJobs(): Promise<Job[]> {
  const r = await control("/jobs");
  return Array.isArray(r.body) ? (r.body as Job[]) : [];
}

export async function createJob(regions?: string[]): Promise<Job> {
  const r = await control("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ regions: regions ?? [] }),
  });
  if (r.status >= 400) {
    const e = (r.body as { error?: string }) ?? {};
    throw new Error(e.error ?? `create job failed (${r.status})`);
  }
  return r.body as Job;
}

export async function getJob(id: string): Promise<Job | null> {
  const r = await control(`/jobs/${id}`);
  const b = r.body as Job | { error?: string } | null;
  if (!b || (b as { error?: string }).error) return null;
  return b as Job;
}

export async function cancelJob(id: string): Promise<Job> {
  const r = await control(`/jobs/${id}/cancel`, { method: "POST" });
  return r.body as Job;
}

export async function resumeJob(id: string): Promise<Job> {
  const r = await control(`/jobs/${id}/resume`, { method: "POST" });
  return r.body as Job;
}

function send(socket: WebSocket, msg: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function streamJobEvents(socket: WebSocket, id: string, signal: AbortSignal) {
  try {
    const res = await fetch(`${CONTROL}/jobs/${id}/events`, { signal });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              send(socket, { type: "evt", id, event: JSON.parse(line.slice(6)) });
            } catch {
              // ignore malformed event
            }
          }
        }
      }
    }
  } catch {
    // aborted or stream ended
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(socket: WebSocket) {
  let digest = "";
  let curId = "";
  let ctrl: AbortController | null = null;
  for (;;) {
    if (socket.readyState !== WebSocket.OPEN) return;
    let jobs: Job[] | null = null;
    try {
      jobs = await listJobs();
    } catch {
      jobs = null;
    }
    if (jobs) {
      const d = JSON.stringify(jobs.map((j) => [j.id, j.status, j.nodes, j.edges]));
      if (d !== digest) {
        digest = d;
        send(socket, { type: "jobs", jobs });
      }
      const live = jobs.find((j) => j.status === "queued" || j.status === "running" || j.status === "cancelling");
      if (live && live.id !== curId) {
        curId = live.id;
        if (ctrl) ctrl.abort();
        ctrl = new AbortController();
        void streamJobEvents(socket, live.id, ctrl.signal);
      }
      if (!live && curId !== "") {
        curId = "";
        if (ctrl) ctrl.abort();
        ctrl = null;
      }
    }
    await sleep(1000);
  }
}

export function ws(req: Request): Response | null {
  if (new URL(req.url).pathname !== "/ws/events") return null;
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onopen = () => void pump(socket);
  socket.onclose = () => {
    // nothing to clean; sockets are per-connection
  };
  return response;
}
