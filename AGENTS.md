# AGENTS.md — working context for AI agents

AWSome maps an AWS account into a Neo4j knowledge graph and surfaces security
posture, drift, and an AI Copilot. Pipeline: Go scanner -> versioned JSONL
snapshots (`snapshots/`) -> findings engine / Neo4j graph -> Deno API (:8000) +
React Flow SPA.

## Toolchain & environment

- **Go** is pinned to **1.27.1** via mise (`.mise.toml`). `go`/`make` are NOT on the
  default shell PATH. Run toolchain-dependent commands as
  `mise x -- bash -lc '...'` (or `eval "$(mise activate bash)"`). Fresh clone:
  `mise install && mise trust`.
- **Deno 2.9.6** lives at `/home/shalnark/.deno/bin/deno` (not on PATH). Use the full
  path or run under mise.
- **Docker compose** (`compose.yml`): LocalStack (`awsome-localstack-1`, `:4566`) and
  Neo4j 5.26 (`awsome-neo4j-1`, `127.0.0.1:7474`, user `neo4j`, password `awsome-dev-pass`).
- **LocalStack dummy creds**: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
  region `us-east-1`. No `aws` CLI / boto3 installed.
- **Web runtime deps** are loaded from esm.sh via the importmap (`web/index.html` +
  `web/importmap.json`): React 18.3.1, `@xyflow/react` 12.3.5, dagre, marked 12, dompurify.
  Network is required at runtime. `web/styles.css` is compiled from `web/styles.src.css`
  by the Tailwind v4 standalone binary at `.tools/tailwindcss` and is **gitignored** —
  run `make tw` after editing `styles.src.css` or styles will go stale/empty.
- `bin/` holds compiled Go binaries (build artifacts, gitignored).

## Repo layout

- `cmd/awsome-scanner` — Go scanner (one-shot + `--control` daemon on :8080)
- `cmd/awsome-seed` — LocalStack demo fixtures
- `cmd/awsome-neo4j` — MERGE latest snapshot into Neo4j
- `cmd/awsome-report` — findings engine CLI against latest snapshot
- `internal/collect/` — per-service walkers; `internal/findings/` — rule engine;
  `internal/jobs/`, `internal/store/`, `internal/control/`, `internal/model/`
- `api/` — Deno backend: `main.ts` (HTTP :8000), `mcp_server.ts` (MCP stdio),
  `diff.ts` (drift), `neo.ts` (Cypher), `findings.ts`, `jobs.ts`
- `api/ai/` — Copilot: `chat.ts` (orchestrator), `heuristic.ts` (offline), `retrieval.ts`
  (context), `bedrock.ts`, `openai.ts`, `opencode.ts`, `sigv4.ts`, and `skills/`
  (drift, findings, infra-view skills + registry)
- `web/` — SPA (`app.js`, `index.html`, `importmap.json`, `styles.src.css`)
- `snapshots/` — scan bundles on disk; drift compares the two most recent

## Run

```sh
eval "$(mise activate bash)"        # or: use `mise x -- bash -lc '...'` per command
make localstack-up                  # start LocalStack
make seed                           # demo fixtures
make scan                           # enumerate LocalStack, write snapshots/<id>/records.jsonl
make neo4j-up && make neo4j-load    # load into graph DB
make web                            # Tailwind build + API + SPA at http://127.0.0.1:8000
make serve                          # scan daemon + control plane http://127.0.0.1:8080
make report                         # findings vs latest snapshot
make mcp                            # MCP stdio server
```

Background web server (used in headless verification):

```sh
setsid --fork env PORT=8000 /home/shalnark/.deno/bin/deno run \
  --allow-net --allow-read=. --allow-run=bash,kill,setsid,opencode,pgrep \
  --allow-write=/tmp/awsome --allow-env api/main.ts \
  > /tmp/awsome/web.log 2>&1 < /dev/null
# kill the listener with:
ss -ltnp 'sport = :8000'    # find pid, then kill <pid>
```

## Test / verify

- UI + API type-checks: `mise x -- bash -lc 'make check-web'`
  (equivalent: `deno check api/main.ts api/mcp_server.ts api/ai/chat.ts` and
  `deno check --import-map=web/importmap.json web/app.js`)
- Go: `mise x -- bash -lc 'go vet ./... && go test ./...'`
- Copilot API: `curl -s -X POST http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"..."}'`
- Headless UI smoke: Playwright via `deno run npm:playwright-core`; Chromium headless
  shell at `/home/shalnark/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell`,
  flags `--no-sandbox --disable-dev-shm-usage --disable-crash-reporter --headless`.
  Run scripts from `/tmp/awsome` with `deno run --allow-all --unsafe-proto script.mjs`.
  **Quirk**: `getBoundingClientRect()` returns `.width`/`.height`, NOT `.w`/`.h`.
  All panes stay mounted with `hidden` for inactive tabs (SPA is click-routed, no router).

## Copilot

- `POST /api/chat` returns `provider`, `model`, `answer`, `citations`, `latency_ms`,
  `context` (incl. `skills[]`), `note`. Provider select: `auto | heuristic | bedrock |
  openrouter | opencode`; `auto` resolves via `AWSOME_CHAT_PROVIDER` then falls back to
  heuristic (offline rules, no keys needed).
- **Skills** are modular (`api/ai/skills/`): each has a matcher, `collect()`, and a
  grounded offline `answer()`. Current: `drift` (snapshot diff + CloudTrail attribution),
  `findings` (flow logs / encryption / exposure / posture), `infra` (topology counts +
  focused resource).
- Env vars: `AWSOME_CHAT_PROVIDER`, `AWSOME_CHAT_TIMEOUT_MS`, `AWSOME_BEDROCK_MODEL`,
  `AWSOME_BEDROCK_REGION`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`.

## Known constraints

- CloudTrail `LookupEvents` returns **501 on LocalStack** (real-AWS only).
- No real AWS creds in the dev env — scans run against LocalStack; no real LLM keys —
  live Copilot answers are heuristic.
- Assistants render markdown (marked + dompurify) inside `.bubble-ai .md-body`.
