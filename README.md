# AWSome — Phase 0: enumeration bootstrap

Go-based scanner

## Go version policy

Toolchain is managed by [mise](https://mise.jdx.dev/) (`.mise.toml` pins `go 1.27.1`).

- `go.mod` `go` directive = **1.24** — the minimum required by our deps:
  `aws-sdk-go-v2` and `neo4j-go-driver/v6` (both declare Go 1.24 minimums).
- `toolchain` directive = **go1.27.1** — the build version: a Go-release-policy
  *maintained* version (AWS SDK v2 only supports maintained toolchains; Go 1.24 is
  EOL as of late 2026 and must not be used to build).

After `git pull` / fresh clone: `mise install && mise trust` then `eval "$(mise activate bash)"`
(or add that line to your shell rc) so `go`, `go build`, etc. resolve to the pinned toolchain.
Then `go mod tidy && go build ./...`. that enumerates AWS resources and emits a versioned **JSON-lines** snapshot
(`(node, edge)` records). Current scope: **EC2 + VPC + Security Groups** in one or more regions,
single account. This proves enumeration correctness before we build Neo4j + dashboard on top.

## Quickstart (LocalStack — free, no AWS bill)

```sh
eval "$(mise activate bash)"    # put go on PATH (add to ~/.bashrc)
cp .env.example .env                       # LocalStack dummy creds
set -a; source .env; set +a

make localstack-up              # start LocalStack (Docker)
make seed                       # demo VPC/subnet/SG x2 (sg-app references sg-web)/instance
make scan                       # enumerate + write snapshots/<snapshot-id>/records.jsonl
```

Then inspect:

```sh
go run ./cmd/awsome-scanner --endpoint-url http://localhost:4566   # same as make scan
ls snapshots/snap-*/             # records.jsonl + summary.json
```

## Graph store (Neo4j)

The JSON-lines bundle is the source of truth; Neo4j is a re-buildable derived view. Load the latest snapshot, then query with `cypher-shell` or the Neo4j Browser (`http://127.0.0.1:7474`, dev creds in `.env`):

```sh
make neo4j-up        # start Neo4j (Docker, bound to 127.0.0.1)
make neo4j-load      # MERGE latest snapshot into the graph (idempotent, keyed on ARN)
docker exec awsome-neo4j-1 cypher-shell -u neo4j -p "$(sed 's|.*/||' .env)" --format plain   'MATCH (n:VPC) RETURN n.name, n.cidr_block;'
```

Nodes are `(:Resource:<Label>)` with `key = ARN` and flattened scalar properties plus `tags` (JSON); relationships are typed edges like `ASSOC_WITH`, `IN_VPC`, `REFERENCES`. Re-loading never duplicates (`MERGE` on `key` / `(from, to, type)`).

Findings land in the graph too: `(f:Finding {key, severity, rule, category, message, remediation})` linked via `[:AFFECTS]` to the resource they flag (`MERGE`, re-loadable). `make neo4j-load` now runs `make report` first, so scan → `neo4j-load` gives you both nodes *and* findings in one shot. Query them alongside the graph, e.g.:

```cypher
MATCH (f:Finding {severity:'critical'})-[:AFFECTS]->(r) RETURN f.rule, r.name;
MATCH (f:Finding {rule:'missing-tags'})-[e:AFFECTS]->(r) RETURN count(e);  -- 29
```

## Web layer (Deno — API + React Flow SPA)

One process serves both the HTTP API (Neo4j via its transactional HTTP endpoint, no driver shims) and the dark React Flow SPA:

```sh
make neo4j-up        # if not already running
make neo4j-load      # has the JSONL been merged into the graph?
make web             # http://127.0.0.1:8000  (Diagram / Findings / Summary)
```

Endpoints: `/api/health`, `/api/summary`, `/api/resources[?q=&type=&region=]`, `/api/resources/:key` (+`/neighbors`), `/api/graph`, `/api/graph/findings` (`:Finding` + `AFFECTS` as overlay graph), `/api/snapshots`, `/api/findings`. The SPA is dependency-fetched at runtime (`esm.sh` import map) — no build step; source lives in `web/` (`index.html`, `app.js`, `style.css`). Type-check the browser code with `deno check --import-map=web/importmap.json web/app.js`.

## Scans (daemon + jobs)

The scanner also runs as a background daemon with a control plane and per-job live progress:

```sh
make serve           # daemon on http://127.0.0.1:8080 + control API
# POST /jobs {"regions":["us-east-1"]}   start a scan (queued/running/cancelling/completed)
# GET   /jobs        history (persisted in snapshots/.jobs.db via bbolt, survives restart)
# GET   /jobs/:id    step-by-step detail (nodes/edges per service)
# POST  /jobs/:id/cancel, /resume    interrupt and resume mid-scan (keeps snapshot id)
# GET   /jobs/:id/events             server-sent events (SSE)
```

Jobs are single-flight per target (a second scan of the same target returns 409 while one is active) and run FIFO; interrupted/queued jobs on daemon restart become `interrupted` (resumable). The web SPA surfaces all this on the **Scans** tab and streams live step progress over `/ws/events` (SSE bridged to WebSocket by `api/jobs.ts`). The **Diagram** tab has a "toggle findings overlay" button that draws confirmed `:Finding`/`:AFFECTS` data directly on the graph (colored by severity).

```sh
# refresh defaults after a new scan
make report && make neo4j-load
```

## AI-assist (chat + MCP)

Two ways to interrogate the graph in natural language:

**Chat API** — `POST /api/chat {question}` returns an answer grounded in the graph + findings with citations. Provider chosen by `AWSOME_CHAT_PROVIDER` (`heuristic` default):

| provider | backend | env |
| --- | --- | --- |
| `heuristic` | offline deterministic QA (always available) | — |
| `anthropic` | **Claude via the Anthropic API** (official SDK) | `ANTHROPIC_API_KEY`, `AWSOME_ANTHROPIC_MODEL` (default `claude-opus-5`), `AWSOME_ANTHROPIC_EFFORT` (default `medium`), `AWSOME_ANTHROPIC_FALLBACKS` |
| `bedrock` | Amazon Bedrock Claude (SigV4-signed, needs creds) | `AWSOME_BEDROCK_REGION`, `AWSOME_BEDROCK_MODEL`, `AWS_*` creds |
| `openrouter` | OpenAI-compatible router | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `openrouter/auto`), `OPENROUTER_BASE_URL` |
| `opencode` | your **local opencode agent** (headless `opencode serve`) | `OPENCODE_URL` (default `http://127.0.0.1:4096`), `OPENCODE_SERVER_PASSWORD`, `OPENCODE_MODEL` |

Any non-heuristic provider degrades gracefully to heuristic with a visible notice (verified for missing keys / unreachable servers).

```sh
curl -s http://127.0.0.1:8000/api/chat -d '{"question":"is anything publicly exposed?"}'
curl -s http://127.0.0.1:8000/api/chat -d '{"question":"tell me about awsome-demo-web"}'
```

- Default provider is `heuristic` — deterministic, retrieval-grounded, zero-cost (answer comes from graph stats + `:Finding` data). The web SPA exposes the provider on the **Ask** tab.
- `opencode` delegates the question to a real opencode agent session on your machine (read-only: no tools). Two ways to point at it:
  - **Managed (from the Ask tab):** press **start opencode** — the web API spawns a detached `opencode serve` on `127.0.0.1:4100` (`OPENCODE_MANAGED_PORT` to change), tracks the pid, and **stop** kills it. Auth uses `OPENCODE_SERVER_PASSWORD` if you set it.
  - **External:** run `opencode serve --port 4096` yourself and set `OPENCODE_URL=http://127.0.0.1:4096` (+ `OPENCODE_SERVER_PASSWORD`) on the web server; per-question override comes from the Ask tab's provider dropdown (`auto`, `heuristic`, `bedrock`, `openrouter`, `opencode`) sent as `provider` in `POST /api/chat`.

AWSome POSTs the retrieved context to a fresh session, waits for the agent turn, and renders its answer (verified live end-to-end).

### Claude via the Anthropic API

`anthropic` talks to `api.anthropic.com` with the official SDK. This is different
from `bedrock`, which reaches Claude through Amazon Bedrock with SigV4 and needs
Bedrock model access in the account's region — GovCloud regions generally do not
have it.

```sh
export ANTHROPIC_API_KEY=sk-ant-...
AWSOME_CHAT_PROVIDER=anthropic make web
# or pick "anthropic" from the Ask tab's provider dropdown
```

Effort defaults to `medium` rather than the platform default of `high`: answers
are short, grounded in retrieved context, and rendered in a panel while the user
waits. Raise it with `AWSOME_ANTHROPIC_EFFORT=high` for harder questions.

Server-side refusal fallbacks are on by default. Posture questions ("is anything
publicly exposed?", "how would an attacker reach this bucket?") are exactly the
shape a safety classifier can decline, and a fallback re-serves the request on
another model inside the same call. Disable with `AWSOME_ANTHROPIC_FALLBACKS=off`.
Like every non-heuristic provider it degrades to the offline rules with a visible
note if the key is missing or the API is unreachable.

**MCP server** — a Model Context Protocol stdio server exposing the graph & findings to any MCP client (7 tools: `graph_summary`, `list_findings`, `get_resource`, `list_finding_nodes`, `list_snapshots`, `start_scan`, `list_jobs`):

```sh
make mcp                 # requires a MCP client to drive stdio
mise x -- bash -lc 'deno run --allow-net --allow-read=. --allow-env --allow-run scripts/test-mcp.ts'   # self-test handshake + tool calls
```

**Connecting Claude Code to this project.** The MCP server is how you point Claude
at the graph. Add it as a project-scoped server (`.mcp.json` in the repo root):

```json
{
  "mcpServers": {
    "awsome": {
      "command": "deno",
      "args": ["run", "--allow-net", "--allow-read=.", "--allow-env", "api/mcp_server.ts"]
    }
  }
}
```

Claude can then call `graph_summary`, `list_findings`, `get_resource` and
`start_scan` directly. Neo4j must be running (`make neo4j-up && make neo4j-load`);
verify the handshake first with the self-test below.

Implementation lives in `api/mcp_server.ts` (JSON-RPC 2.0 over stdio, `Content-Length` framing) and `api/ai/` (`retrieval.ts` builds context, `heuristic.ts` offline QA, `bedrock.ts` += `sigv4.ts` SigV4-signs the Anthropic invoke call). `make check-web` type-checks everything.

## Real AWS (Free Tier account)

```sh
# after `aws configure sso` / setting AWS_PROFILE
make scan-real                  # or: go run ./cmd/awsome-scanner
go run ./cmd/awsome-scanner --regions us-east-1,us-west-2
```

Rules of thumb: no `--endpoint-url` = real AWS; credential chain = SSO/default profile.

### Non-commercial partitions (GovCloud, China)

Partition is derived from the STS caller ARN, so `arn:aws-us-gov:...` keys are emitted
automatically. The one thing that needs care is the **bootstrap region** used for
`GetCallerIdentity` / `DescribeRegions` before region enumeration: `us-east-1` does not
exist in `aws-us-gov` or `aws-cn`, so the scanner takes the first `--regions` value, then
the profile/environment region, and only then falls back to the commercial default. Pass
`--regions` explicitly and it always does the right thing:

```sh
AWS_PROFILE=<gov-profile> go run ./cmd/awsome-scanner --regions us-gov-west-1
```

### CloudTrail window

`LookupEvents` is throttled to a few TPS and pages 50 at a time, so walking the full 90-day
retention can take hours on a busy account. The trail step is bounded by default and only
captures mutations (drift attribution does not need read-only events):

| flag | default | meaning |
| --- | --- | --- |
| `--trail-lookback` | `168h` | how far back to look; `0` skips the trail step entirely |
| `--trail-max-events` | `20000` | stop paginating after this many events; `0` = uncapped |
| `--trail-include-readonly` | `false` | also capture read-only events |

### Scan coverage

Every `(service, region)` walker emits a `{"kind":"coverage"}` record with status
`ok` / `degraded` / `failed`. A service that is denied by your role, unavailable in the
partition, or unimplemented is recorded with the reason rather than silently skipped — so a
restricted scan is distinguishable from an empty account:

```sh
grep '"kind":"coverage"' snapshots/<snap>/records.jsonl | grep -v '"status":"ok"'
```

## Record format (JSON-lines)

```jsonl
{"kind":"node","label":"EC2","key":"arn:aws:ec2:us-east-1:000000000000:instance/i-...", ...}
{"kind":"edge","from":"...","to":"...","type":"ASSOC_WITH", ...}
{"kind":"snapshot","snapshot_id":"snap-...","statistics":{...}, ...}
```

Snapshot dir = `snapshots/<snapshot_id>/` with `records.jsonl` and `summary.json`.

## Relationship semantics (Phase-0 subset)

| Type        | Meaning                                             |
|-------------|-----------------------------------------------------|
| `IN_VPC`    | resource is contained by the VPC                    |
| `IN_SUBNET` | resource placed in the subnet                       |
| `ASSOC_WITH`| instance is protected by the security group         |
| `PART_OF`   | SG belongs to the VPC                               |
| `REFERENCES`| the SG's ingress/egress rules reference another SG (rule owner → peer) |
| `ATTACHES`  | instance attaches the network interface             |

## LocalStack caveats

Community edition emulates the `Describe*` API shape and pagination well, but several services are
**Pro-only** in 3.8.1 Community and simply 501 at the API (ELBv2, AutoScaling, RDS, ElastiCache, ECS, EKS,
ECR). The scanner degrades (skips) a service that returns `not yet implemented`/`AccessDenied`/etc. so a
snapshot still completes. Full walker coverage vs. LocalStack gaps is tracked in `AWS-LOCALSTACK-DIFF.md`.

The real Free-Tier account is the "golden" correctness check (diff the JSONL vs the console) and the only
place ELBv2/ASG/RDS/ECS/EKS data shapes can be validated.
Create the read-only scanner login + run the golden scan: see `docs/aws-free-tier-setup.md`.

## Layout

```
cmd/awsome-scanner       CLI entrypoint (flags: --endpoint-url --regions --out --snapshot-id --concurrency)
cmd/awsome-seed          seeds a demo topology into LocalStack
internal/awscfg          SDK config loader (endpoint override aware)
internal/config          CLI/env config
internal/collect         target resolution + walkers (EC2-family, ELBv2, ASG, RDS, ElastiCache,
                          Redshift, OpenSearch, DynamoDB, Lambda, ECS, EKS, S3, ECR, IAM) + orchestration + degrade-on-denied
                          handling + record model helpers
internal/inspect         JSONL writer + summary writer
compose.yml              LocalStack service
```
## Snapshot drift (Diff tab)

Compare any two snapshots with `GET /api/diff?from=<snap>&to=<snap>` (defaults to latest vs previous). Returns per-node added/removed/changed (property-level field deltas), edge diffs, and finding-level drift (new/resolved findings, severity or message changes). Exposed in the SPA as the **Diff** tab.

The Diff tab is a Bitbucket-style viewer: resources are grouped **added (green) / removed (red) / changed (amber)**, each as a collapsible block with a line-level diff (red `−` deleted rows, green `+` added rows, dim unchanged context), drill-down per field, plus flattened edges and finding rows. The **Diagram** tab has a *drift overlay* (green = added, amber = changed nodes) with its own from/to pickers. Export the whole report as Markdown or JSON with the buttons in the toolbar or:

```sh
curl -s 'http://127.0.0.1:8000/api/diff/export?format=md'
curl   -s 'http://127.0.0.1:8000/api/diff/export?format=json'
```

### Who made the change (attribution)

Every snapshot records who ran the scan (`user`, `hostname`, `trigger`, `job_id` in `summary.json`). Drift attribution goes further: the scanner's `trail` step reads **CloudTrail** (`LookupEvents` → `trail.jsonl` per snapshot) and the diff layer correlates changed resources against mutation events in the from→to window, showing the **AWS principal** (IAM user/role, access key, source IP) that created/modified/deleted the resource or parameter — e.g. `CreateFlowLogs by drift-agent from 203.0.113.42`. Attribution chips appear next to every affected resource/finding in the Diff tab and in exported reports.

- CloudTrail `LookupEvents` is **not implemented by LocalStack** (API returns 501), so the step degrades gracefully (no `trail.jsonl`, scan still succeeds). The two demo snapshots under `snapshots/` ship with demo `trail.jsonl` files so attribution renders without real CloudTrail. On real AWS the step captures events automatically.
- `LookupEvents` covers the last ~90 days; ensure a trail is created in the account for full coverage.

Backfill findings for an older snapshot (e.g. ones captured before the findings engine shipped) with:

```sh
mise x -- bash -lc 'go build -o bin/awsome-report ./cmd/awsome-report && bin/awsome-report -dir snapshots/<older-snapshot>'
```
