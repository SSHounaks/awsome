import { Cypher } from "../cypher.ts";
import { buildContext, ChatContext } from "./retrieval.ts";
import { askHeuristic } from "./heuristic.ts";
import { askBedrock, bedrockModelName } from "./bedrock.ts";
import { askOpenRouter, openRouterModelName } from "./openai.ts";
import { askOpencode } from "./opencode.ts";
import { askAnthropic, anthropicModelName } from "./anthropic.ts";

export type ChatProvider = "heuristic" | "anthropic" | "bedrock" | "openrouter" | "opencode";

export interface ChatResult {
  provider: ChatProvider;
  answer: string;
  model: string;
  citations: { key: string; name: string; label: string }[];
  latency_ms: number;
  context: { resources: number; findings: number; focused: boolean; skills: string[] };
  note?: string;
}

const SYSTEM = `You are AWSome, a security posture assistant for an AWS account mapped into a Neo4j knowledge graph.
Answer ONLY from the RETRIEVED CONTEXT about the latest snapshot. The context is grouped into labeled blocks, one per ACTIVE skill:
- [Findings]: security findings with severity, rule id, message, and remediation.
- [Infra view]: live topology graph statistics (nodes/edges/types/accounts/regions) and, when named, a focused resource with its attributes and affecting findings.
- [Drift]: a diff of the two most recent snapshots (added/removed/changed resources, findings, and CloudTrail attribution).
Rules:
- Ground answers in the blocks whose skill matches the question. Name the skill you used.
- If a relevant skill is absent from the context, say that data is unavailable and point to the right tab.
- If the user asks about changes/drift, ground the answer in [Drift] and name the actor/event behind each change.
Answer style:
- Open with a one-line verdict containing concrete numbers (e.g. "Posture B with 38 findings, dominated by 32 low-severity hygiene issues.").
- Be specific: name the actual resource IDs/names, quote real finding messages, and give the exact remediations from context when available.
- Use short markdown bullets. Stay under ~180 words unless the question asks for more.
- Cite where numbers come from (resources, findings rules) so answers read concrete, not templated.
- If the context cannot answer, say so plainly and point to Scan / Findings / Drift tabs. Never invent resources, ARNs, or findings.
- End with one short follow-up question offering a concrete next step (run a scan, open a finding, export drift).`;

const PROVIDER_LABEL: Record<ChatProvider, string> = {
  heuristic: "heuristic",
  anthropic: "Anthropic",
  bedrock: "Bedrock",
  openrouter: "OpenRouter",
  opencode: "opencode",
};

const KNOWN = new Set<string>(["heuristic", "anthropic", "bedrock", "openrouter", "opencode"]);

async function runProvider(
  p: string,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<{ name: ChatProvider; model: string; text: string }> {
  switch (p) {
    case "anthropic": {
      const model = anthropicModelName();
      return { name: "anthropic", model, text: await askAnthropic(system, user, timeoutMs) };
    }
    case "bedrock": {
      const model = bedrockModelName();
      return { name: "bedrock", model, text: await askBedrock(system, user, timeoutMs) };
    }
    case "openrouter": {
      const model = openRouterModelName();
      return { name: "openrouter", model, text: await askOpenRouter(system, user, timeoutMs) };
    }
    case "opencode":
      return { name: "opencode", model: "opencode agent", text: await askOpencode(system, user, timeoutMs) };
    default:
      return { name: "heuristic", model: "offline rules", text: "" };
  }
}

export async function ask(cypher: Cypher, question: string, providerOverride?: string): Promise<ChatResult> {
  const t0 = Date.now();
  const ctx = await buildContext(cypher, question);
  const citations = Array.from(new Map(
    ctx.findings.map((f) => [f.resource_key, {
      key: f.resource_key, name: f.resource_name || f.resource_label, label: f.resource_label,
    }]),
  ).values()).slice(0, 20);

  const blocks = ctx.skills.map((sk) =>
    `[${sk.label}] (skill: ${sk.id})\n${sk.payload !== null ? JSON.stringify(sk.payload) : "collection unavailable"}\nheuristic answer for this block: ${sk.answer ?? "none"}`,
  );
  const user = `RETRIEVED CONTEXT:
- summary: ${JSON.stringify(ctx.summary)}
- focused resource: ${JSON.stringify(ctx.focused)}
- active skills: ${ctx.skills.length ? ctx.skills.map((sk) => sk.id).join(", ") : "none"}
${blocks.join("\n")}
QUESTION: ${question}`;

  const timeoutMs = Number(Deno.env.get("AWSOME_CHAT_TIMEOUT_MS") ?? "0");
  const want = (providerOverride ?? Deno.env.get("AWSOME_CHAT_PROVIDER") ?? "heuristic").toLowerCase();

  let provider: ChatProvider = "heuristic";
  let model = "offline rules";
  let answer: string;
  let note: string | undefined;

  if (!KNOWN.has(want) || want === "heuristic") {
    answer = askHeuristic(question, ctx);
  } else {
    const label = PROVIDER_LABEL[want as ChatProvider] ?? want;
    try {
      const r = await runProvider(want, SYSTEM, user, timeoutMs);
      provider = r.name;
      model = r.model;
      answer = r.text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      answer = askHeuristic(question, ctx) + `\n\n_(${label} unavailable (${msg}); answered by offline rules)_`;
      note = `${label} unavailable`;
    }
  }

  return {
    provider,
    model,
    answer,
    citations,
    latency_ms: Date.now() - t0,
    context: { resources: ctx.resources.length, findings: ctx.findings.length, focused: !!ctx.focused, skills: ctx.skills.map((sk) => sk.id) },
    note,
  };
}

export type { ChatContext };
