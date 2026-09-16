import Anthropic from "npm:@anthropic-ai/sdk@^0.125.0";

// Direct Anthropic API provider. Distinct from bedrock.ts, which reaches Claude
// through Amazon Bedrock with SigV4 — that needs Bedrock model access in the
// account's region, which GovCloud regions do not generally have. This talks to
// api.anthropic.com with an API key instead.

const DEFAULT_MODEL = "claude-opus-5";

export function anthropicModelName(): string {
  return Deno.env.get("AWSOME_ANTHROPIC_MODEL") ?? DEFAULT_MODEL;
}

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  // The SDK resolves ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN, or an
  // `ant auth login` profile) itself — don't read or pass the key by hand.
  cached = new Anthropic();
  return cached;
}

// Chat answers are short and grounded in retrieved context, and this route is
// latency-sensitive: it renders in a panel while the user waits. Effort is the
// per-route tuning knob for exactly that, so it defaults below the platform
// default of "high" and stays configurable.
function effort(): "low" | "medium" | "high" | "xhigh" | "max" {
  const raw = (Deno.env.get("AWSOME_ANTHROPIC_EFFORT") ?? "medium").toLowerCase();
  const allowed = ["low", "medium", "high", "xhigh", "max"] as const;
  return (allowed as readonly string[]).includes(raw)
    ? raw as "low" | "medium" | "high" | "xhigh" | "max"
    : "medium";
}

// Security questions ("is anything publicly exposed?", "how would an attacker
// reach this bucket?") are the kind of prompt a safety classifier can decline.
// Server-side fallbacks re-serve a declined request on another model inside the
// same call, so a posture question does not dead-end. Opt out with
// AWSOME_ANTHROPIC_FALLBACKS=off.
function fallbacksEnabled(): boolean {
  return (Deno.env.get("AWSOME_ANTHROPIC_FALLBACKS") ?? "on").toLowerCase() !== "off";
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Fail fast when no key is present. Without this the SDK falls back to looking
// for an `ant auth login` profile under ~/.config/anthropic, which the server's
// --allow-read=. sandbox denies — surfacing a Deno permission error instead of
// the real problem, which is simply that no credential is configured.
function missingCredential(): string | null {
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("ANTHROPIC_AUTH_TOKEN") ?? "").trim();
  if (key) return null;
  return "no ANTHROPIC_API_KEY in the server environment — export it and restart the web server " +
    "(the process reads its environment at startup, so exporting it in another shell has no effect)";
}

export async function askAnthropic(system: string, user: string, timeoutMs: number): Promise<string> {
  const missing = missingCredential();
  if (missing) throw new Error(missing);

  const model = anthropicModelName();
  const opts = timeoutMs > 0 ? { timeout: timeoutMs } : undefined;

  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: effort() },
  };
  if (fallbacksEnabled()) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client().beta.messages.create(params, opts);
  } catch (e) {
    // A rejected beta or fallbacks parameter should not cost the user the whole
    // provider — retry once without them before giving up.
    if (fallbacksEnabled() && e instanceof Anthropic.BadRequestError) {
      const { betas: _b, fallbacks: _f, ...plain } = params;
      response = await client().beta.messages.create(plain, opts);
    } else {
      throw describe(e);
    }
  }

  // Always check stop_reason before reading content: a refusal returns HTTP 200
  // with no usable text.
  if (response.stop_reason === "refusal") {
    const cat = response.stop_details?.category ?? "unspecified";
    throw new Error(`request declined by safety classifier (${cat})`);
  }

  const text = textOf(response.content);
  if (!text) throw new Error(`empty response from ${model} (stop_reason: ${response.stop_reason})`);
  return text;
}

// Most-specific-first, so the caller's note says what actually went wrong rather
// than a generic failure.
function describe(e: unknown): Error {
  // Deno denied a read the SDK attempted while resolving credentials. Safety net
  // behind missingCredential(); reachable if a key is set but the SDK still
  // probes the profile directory.
  if (e instanceof Deno.errors.NotCapable) {
    return new Error(
      "credential lookup blocked by the server sandbox — set ANTHROPIC_API_KEY, " +
        "or grant the server read access to ~/.config/anthropic to use an `ant auth login` profile",
    );
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new Error("ANTHROPIC_API_KEY missing or invalid");
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new Error("API key lacks access to this model");
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new Error(`model ${anthropicModelName()} not found for this account`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new Error("rate limited by the Anthropic API");
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new Error("Anthropic API timed out");
  }
  if (e instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${e.status}: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
