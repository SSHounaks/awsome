import { Creds, credsFromEnv, sign } from "./sigv4.ts";

const DEFAULT_MODEL = "anthropic.claude-3-5-sonnet-20240620-v1:0";

export function bedrockModelName(): string {
  return Deno.env.get("AWSOME_BEDROCK_MODEL") ?? DEFAULT_MODEL;
}

export async function askBedrock(system: string, user: string, serviceTimeoutMs = 0): Promise<string> {
  const region = Deno.env.get("AWSOME_BEDROCK_REGION") ?? Deno.env.get("AWS_REGION") ?? "us-east-1";
  const model = bedrockModelName();
  const creds = credsFromEnv();
  if (!creds) throw new Error("no AWS credentials in environment for Bedrock");

  const payload = {
    anthropic_version: "2023-06-01",
    max_tokens: 600,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: user }],
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(model)}/invoke`;
  const headers = await sign(creds, { method: "POST", host, region, service: "bedrock", path, body });

  const res = await fetch(`https://${host}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
    signal: serviceTimeoutMs ? AbortSignal.timeout(serviceTimeoutMs) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Bedrock ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? []).find((c) => c.type === "text")?.text ?? "";
  if (!text) throw new Error("Bedrock returned no text");
  return text;
}
