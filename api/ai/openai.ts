export interface OpenAICompatOpts {
  baseURL: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  label?: string;
}

export async function askOpenAICompat(
  system: string,
  user: string,
  opts: OpenAICompatOpts,
): Promise<string> {
  const base = opts.baseURL.replace(/\/+$/, "");
  const label = opts.label ?? "OpenAI-compatible";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      ...opts.extraHeaders,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`${label} ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error(`${label} returned no content`);
  return text.trim();
}

export function openRouterModelName(): string {
  return Deno.env.get("OPENROUTER_MODEL") ?? "openrouter/auto";
}

export async function askOpenRouter(system: string, user: string, timeoutMs = 0): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("no OPENROUTER_API_KEY in environment");
  const model = openRouterModelName();
  return await askOpenAICompat(system, user, {
    baseURL: Deno.env.get("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
    apiKey: key,
    model,
    extraHeaders: { "X-Title": "AWSome", "HTTP-Referer": "http://127.0.0.1:8000" },
    timeoutMs,
    label: "OpenRouter",
  });
}
