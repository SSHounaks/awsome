# AWSome — AWS Infrastructure Mapping, Visualization & Insight

> Lean-startup tooling to **recover and keep** visibility over AWS infrastructure that grew organically.
> Phase 1 delivers an accurate, connected, queryable map (interactive diagram + Neo4j knowledge graph).
> Phase 2 adds misconfiguration insight and AI-assisted querying on top of the same graph.

---


## 1. Goals

1. **MAP** — automatically discover resources across **one or more AWS accounts**, capture their
   properties and the *relationships* between them (what is inside which VPC/subnet, which security
   groups reference which, which buckets are public, which roles are attached to which instances).
2. **INSIGHT (Phase 2)** — flag misconfigurations (public S3, `0.0.0.0/0` ingress, missing tags,
   cross-environment wiring, unencrypted volumes, idle resources) with a curated Top-10 plus a full list.
3. **AI-ASSIST (Phase 2)** — a knowledge graph + retrieval layer so an LLM answers questions like
   "which instances can reach the database?" and "what does this security group protect?" in plain
   English, with **cited graph paths**.

Phase 1 scope in this spec: **goal 1 (mapping)** plus all architectural groundwork for goals 2 and 3.
Everything is designed for **seamless scale** (accounts, regions, resources) from day one even though
today's footprint is a single small account.

**Driving problem, restated:** information must be **produced automatically** — scheduled/on-demand scan —
never hand-typed from the console. Outputs must directly serve audits, up-to-date architecture reviews,
and security review, *without* anyone manually assembling them.

---

## 2. Decision log (locked)

| # | Topic | Decision |
|---|-------|----------|
| D01 | Stack | Go scanner (fast/reliable) · **Deno for ALL frontend/web work** · Python AI service · Neo4j graph |
| D02 | Accounts | **Multi-account from day one** in the data model (dev/stage/prod); today scan 1 account; Organizations discovery later |
| D03 | Regions | **Auto-detect** via `ec2:DescribeRegions` (1 cheap call) → scan enabled regions → prune empty from map |
| D04 | AWS Config | Agencies can run **with or without** Config recording; both must work. When present, ingest Config findings later |
| D05 | External network | Future scope — but graph schema supports **EXTERNAL nodes**; any path to external is a first-class **security risk to flag** |
| D06 | Partitions | Must support **commercial + GovCloud** (and tolerate China) → partition-aware config, Bedrock for AI |
| D07 | Services (P1) | EC2, ENI, EBS, SG, NACL, VPC, Subnet, RouteTable, IGW/NAT/EIP, Peering, **ALB/NLB**, RDS(+subnet groups), **Lambda (VPC binding)**, **ECS/EKS (clusters+nodes only)**, **ElastiCache/Redshift/OpenSearch**, **DynamoDB**, S3, **AMIs**, **ECR**, IAM (roles, policies, profiles, **full policy bodies**) |
| D08 | Containers | **Clusters + nodes only**; no in-cluster Kubernetes topology in Phase 1 |
| D09 | Defaults | Default VPC / default SGs / managed resources = **collapsed groups** by default, expandable |
| D10 | Cost | **Future scope** (join Cost Explorer per-resource later) |
| D11 | Control-plane/observability | **Future scope** (VPC endpoints/CloudTrail/CloudWatch) |
| D12 | Scan execution | **Long-running scanner daemon w/ jobs**: live progress, graceful **cancel + resume** (D32) |
| D32 | Long-running tasks | Scanner is a persistent daemon + control plane; **Deno triggers jobs, streams progress (SSE→WS), cancels/resumes** |
| D13 | Drift | Diff snapshots; **show drift in the frontend**; email/Slack alerts later |
| D14 | History | **Keep last N** snapshots (default 30), pruned after |
| D15 | Tags | Capture always. **Missing tags / cross-environment edges = findings**, not hard requirements |
| D16 | IaC | Terraform exists → **declared-vs-actual reconciliation** is future scope |
| D17 | Misconfig engine | **Own Cypher rules** + **ingest AWS Config findings when present** (accounts without Config work too) |
| D18 | Findings format | **Top-10 curated + expandable full list** |
| D19 | Compliance frame | Both **pragmatic security/cost** and **CIS-style governance** checks |
| D20 | Env weighting | **Uniform checks** (no prod/dev weighting) |
| D21 | Auto-remediation | Phase 3: **dry-run + guarded apply**; Phase 1 report-only |
| D22 | Blast radius | Phase 3 ("what breaks if I delete this") |
| D23 | AI models | **Amazon Bedrock** default (commercial + GovCloud safe); provider-adapter allows OpenAI-compatible later |
| D24 | AI killer feature | **Chat with citations** (graph paths as sources) |
| D25 | AI agency | **Advisory + draft plans only**; never executes |
| D26 | Access model | **Single-user localhost**, no auth flows in Phase 1 |
| D27 | Export | **PNG/SVG export** of the map; **masked** for export/share contexts |
| D28 | Theme | **Dark only** |
| D29 | Scan credentials | **SSO (IAM Identity Center) profile**; multi-account via role assumption under the SSO chain |
| D30 | Neo4j exposure | **Expose Neo4j Browser/Bloom** (localhost-bound) for power Cypher users, plus our API/UI |
| D31 | Sensitive data | **Mask on export/share** only; unmasked within the private localhost tool |

---

## 3. Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌───────────────────────┐
│  AWS APIs   │◄───►│  awsome-     │─MERGE─►│   Neo4j     │◄────|  web (Deno)           │
│ accounts ×  │     │  scanner(Go) │     │  (graph)    │      │  API + React Flow UI   │
│ regions     │     └──────────────┘     └─────────────┘      └────────────┬──────────┘
│             │        │ JSON-lines audit artifact                        │ /api/*
└─────────────┘        ▼                                    ┌─────────────▼─────────┐
              snapshot bundle (nodes+edges, versioned)      │ AI svc (Python)       │
                                                            │ neo4j-graphrag → Bedrock │
                                                            └───────────────────────┘
```

- **Go** → scanner only: AWS data → normalized `(node, edge)` records → JSON-lines artifact → Neo4j `MERGE`.
- **Deno** → ALL web: the HTTP API + the React dashboard (single web stack; no Go API).
- **Python** → AI service: `neo4j-graphrag` RAG + text→Cypher, talking to Bedrock.
- **Neo4j** → single graph store for the connected diagram *and* the AI knowledge graph.

### Components

| Component | Tech | Notes |
|-----------|------|-------|
| Collector  | Go + `aws-sdk-go-v2` | Concurrent, paginated, retried; single static binary |
| Graph store | Neo4j Community (Docker) | Verified; Browser/Bloom exposed on localhost |
| Web (API + UI) | **Deno** (React + `@xyflow/react`) | Serves `/api/*` + SPA; talks Neo4j via Bolt |
| AI | Python `neo4j-graphrag` | Phase 2; Bedrock chat + embeddings; adapter pattern |
| Deploy | Docker Compose | Neo4j + scanner + web on laptop/VM |

### Why Go for scanning, where Rust could step in
Go's `aws-sdk-go-v2` is the most complete AWS SDK, goroutines map directly to parallel service scans,
and the official Neo4j Go driver is production-grade. Rust is a viable pivot if the collector later
becomes a long-running continuous watcher (hot path).

### Why Deno owns the web layer
One web stack end-to-end: `Deno.serve` API + React SPA tooled by Deno. TypeScript-only, no Node build
pipeline, modern stdlib, single-binary runtime. React Flow (`@xyflow/react`) runs natively under React/Deno.

---

## 4. Account, partition & credential model

- **Every node/edge carries `account_id`, `partition` (`aws` / `aws-us-gov` / `aws-cn`), `region`.**
  Multi-account is thus cheap at scan time (a config list) and free at query time (Cypher on `account_id`).
- **Credentials:** IAM Identity Center (SSO) profile via the SDK default chain. Multi-account = a list of
  `{sso_profile, role_arn}` targets; the scanner assumes each role per target and scans with its creds.
- **Regions:** autodetect enabled regions with `ec2:DescribeRegions` (one cheap global call), scan all of
  them, and drop empty ones from the map. Config allows an explicit region allow-list override.
- **Partition support:** `partition` and region set derive from the SSO/STS session. GovCloud runs the same
  scanner + Neo4j + web locally; the **AI service must use Bedrock**, which is available in both partitions
  (public OpenAI/Anthropic APIs are not reachable from GovCloud).

---

## 5. Resource inventory — Phase 1 scan scope

Per (account, region). All walkers paginated.

| Service | API | Key captured |
|---------|-----|--------------|
| EC2 instances | `DescribeInstances` | type, state, vpc/subnet/ENI/SG ids, instance profile, key pair, AMI id |
| ENI | `DescribeNetworkInterfaces` | attachment, subnet, security groups |
| EBS | `DescribeVolumes` | size/type/encrypted, attachments |
| AMIs | `DescribeImages` (owner=self) | image id, name, backing snapshots, tags |
| Security Groups | `DescribeSecurityGroups` | vpc id, ingress/egress incl. peer-SG refs |
| VPCs | `DescribeVpcs` | cidr, isDefault, tags |
| Subnets | `DescribeSubnets` | cidr, az, vpc, default RT/ACL |
| IGW / NAT / EIP | `DescribeInternetGateways` / `DescribeNatGateways` / `DescribeAddresses` | attachments, associations |
| Route Tables | `DescribeRouteTables` | routes+targets, subnet associations |
| Network ACLs | `DescribeNetworkAcls` | subnet associations, rules |
| Peering | `DescribeVpcPeeringConnections` | local/remote vpc+cidr |
| ALB / NLB | `DescribeLoadBalancers` (+listeners/target groups) | vpc, subnets, SG ids, listeners, TGs |
| Target groups | `DescribeTargetGroups` (+target health) | targets = instances/IPs |
| RDS | `DescribeDBInstances` | engine, vpc, subnet group, SGs, encryption |
| RDS subnet groups | `DescribeDBSubnetGroups` | members |
| ElastiCache | `DescribeCacheClusters` | engine, subnet group, SGs, vpc |
| Redshift | `DescribeClusters` | vpc, subnet group, SG, encryption |
| OpenSearch | `ListDomainNames`+`DescribeDomain` | vpc options, subnets, SGs |
| Lambda | Lambda `List`+`GetFunction` | VPC config (subnets/SGs) when attached |
| ECS | `ListClusters`+`DescribeClusters` | cluster, capacity providers, container instances |
| EKS | `ListClusters`+`DescribeCluster` | cluster ↔ node role, VPC/subnet, nodes (EC2) |
| DynamoDB | `ListTables`+`DescribeTable` | global table config, tags (no VPC wiring; cost-relevant later) |
| S3 | `ListBuckets` + per-bucket `GetBucketAcl/Policy/Location/Tagging` | region, tags, ACL summary, policy ref. `AccessDenied` → node flagged `access_denied` |
| ECR | `DescribeRepositories` | repo ARNs + tags |
| IAM | `ListRoles`/`ListPolicies`/`ListInstanceProfiles` + attachments | **full policy documents**, trust policies, instance-profile ↔ role ↔ instance |

**Hygiene:** untagged resources are still captured fully (tags never block discovery); missing tags simply
become a finding in Phase 2.

---

## 6. Relationship / graph model

Direction convention: edges point **from** a resource **to** its container/parent or dependency.

### Node template
```
Label: Resource plus concrete label (EC2, VPC, Subnet, SG, NACL, RouteTable, IGW, NATGW, EIP, ENI, EBS,
       AMI, Peering, RDS, DBSubnetGroup, Elasticache, Redshift, OpenSearch, Lambda, ECSCluster, EKSCluster,
       LB, TargetGroup, DynamoDBTable, S3Bucket, BucketPolicy, ECRRepo, IAMRole, IAMPolicy, ASG, EXTERNAL)
Props: key   = arn (or logical id for S3/IAM)
       account_id, partition, region, name, type, tags{}, properties(json), scanned_at, snapshot_id
```

### Core edges (extended from grilling)

| From | Edge | To | Why |
|------|------|----|-----|
| EC2 | `IN_VPC` / `IN_SUBNET` / `ATTACHES`→ENI / `USES`→EBS | VPC, Subnet, ENI, EBS | placement & storage |
| EC2 | `ASSOC_WITH`→SG · `USES_ROLE`→IAMRole · `RUNS`→AMI | SG, IAMRole, AMI | hardening & image audit |
| ENI | `IN_SUBNET` · `ASSOC_WITH`→SG | Subnet, SG | effective network |
| Subnet | `PART_OF`→VPC · `USES_ROUTETABLE`→RT · `ASSOC_WITH`→NACL · `ASSOC_WITH`→SG-group (subnet-level SG mapping, Phase 2) | — | routing/firewall |
| SG | `PART_OF`→VPC · `REFERENCES`→SG (peer refs) | VPC, SG | the "who talks to whom" graph |
| NACL | `PART_OF`→VPC · `PROTECTS`→Subnet | VPC, Subnet | |
| RT | `ROUTES_TO`→IGW/NATGW/Peering/VPCE | targets | connectivity edges |
| IGW | `ATTACHED_TO`→VPC | VPC | internet ingress |
| NATGW | `IN_SUBNET`·`USES`→EIP → Subnet · EIP | | egress |
| EIP | `ASSOC_WITH`→EC2/ENI/NATGW | | public assoc |
| **LB** | `PART_OF`→VPC · `ASSOC_WITH`→SG · `FORWARDS`→TargetGroup | VPC, SG, TG | load path |
| **TargetGroup** | `TARGETS`→EC2/IP | EC2 | where traffic lands |
| **RDS/ElastiCache/Redshift/OpenSearch** | `IN_VPC`→VPC · `IN_SUBNET_GROUP`→SubGroup · `ASSOC_WITH`→SG | — | data plane |
| **DBSubnetGroup** | `CONTAINS`→Subnet | Subnet | |
| **Lambda** | `IN_VPC`→VPC · `IN_SUBNET`→Subnet · `ASSOC_WITH`→SG (when attached) | — | serverless wiring |
| **ECSCluster** | `CONTAINS`→EC2 (container instances) | EC2 | |
| **EKSCluster** | `CONTAINS`→EC2 (nodes) · `USES_ROLE`→IAMRole | EC2, IAMRole | |
| **DynamoDBTable** | `TAGGED_IN` (region) — informational node for now | — | |
| S3Bucket | `HAS_ACL`(inline) · `HAS_POLICY`→BucketPolicy | — | public exposure |
| BucketPolicy | `GRANTS_TO`→IAMRole | IAMRole | |
| IAMRole | `ATTACHES`→IAMPolicy | IAMPolicy | |
| ASG | `CONTAINS`→EC2 | EC2 | |
| **(future)** EXTERNAL | `CONNECTS_TO`→VPN/DX/Peering peers | any | **flagged** as risk edges |

**Rule representation:** SG ingress/egress live as inline properties on the SG node; only *peer-SG
references* become `REFERENCES` edges. A future SG-explorer expands rules to their own nodes.

### Neo4j storage
- `MERGE` on `key` for nodes; `MERGE` relationships on `(from, type, to)` — idempotent, no dupes.
- Uniqueness constraint on `key`; indexes on `type`, `account_id`, `partition`, `region`, `snapshot_id`.
- Fine-grained **access_denied** on nodes retains partial results without blocking a scan.


## 7. Collector — long-running job runner (Go)

The scanner is a **persistent daemon** (not a one-shot CLI). It owns a job queue, executes scan jobs
made of many steps, streams live progress, and honors graceful cancellation + resume. The Deno web
layer is a thin localhost client of its control plane.

```
cmd/awsome-scanner/main.go     — daemon: control plane + job runner
internal/
  collect/…                    — per-service walkers (ec2, vpc, sg, … as before)
  jobs/{job,manager,store}.go  — job lifecycle, scheduler, persisted checkpoint store (bbolt)
  control/{api,ws}.go          — localhost control API (REST + SSE)
  store/neo4j.go, inspect/jsonl.go
```

### Job model
A scan is a **Job**:

```
id · snapshot_id
status ∈ {queued, running, cancelling, cancelled, completed, failed, interrupted}
plan  → steps: (account_id, partition, region, service)
step  ∈ {pending, running, done, cancelled}  + counts (found, skipped, denied, failed)
totals: nodes, edges, api_calls, retries, throttles · timestamps · resume_mark (persisted)
```

### Control plane (localhost only)
```
POST /jobs                 — enqueue a scan (single-flight: one active job per target; others queued)
POST /jobs/:id/cancel      — status → cancelling → graceful stop → cancelled
POST /jobs/:id/resume      — re-enqueue, skipping already-`done` steps (no re-scan of completed work)
GET  /jobs · GET /jobs/:id — list / detail incl. live per-step progress table
GET  /jobs/:id/events (SSE) — throttled progress events (batched ~250 ms)
```

### Cancellation semantics (Go)
- One `context.WithCancel` per job; every walker *and every AWS request* carries the derived ctx.
- On cancel: the in-flight step aborts via request-context cancel; all queued steps → `cancelled`.
- Neo4j: partial writes carry the job's `snapshot_id`; a snapshot is only **finalized** on completion.
  Cancelled snapshots never finalize, are filtered out of the UI, and a GC step prunes their orphaned
  nodes later. The partial JSON-lines bundle is kept (audit + resume source).

### Recovery
- Job + step state is checkpointed to disk (**bbolt**) on every step transition.
- Daemon restart → `running` jobs become `interrupted`, resumable from the last completed step.
- Configurable job timeout (default 60 min) → auto-fail with partial state left resumable.

### Progress events (SSE → bridged by Deno to browser WebSocket)
`job.started · step.started(account,region,service) · step.progress(counts) ·
step.done(summary) · batch.written(nodes,edges) · job.finalized(snapshot_id) ·
job.cancelled · job.failed(reason)` — the UI renders these as a live scan panel.

Other collector behavior unchanged from before: bounded worker pool (default 8), full pagination,
retry + exponential backoff, region autodetect, degrade-on-deny (`access_denied`, never halt).

---

---

## 8. Web layer (Deno)

### API (Deno, same process as the SPA)
```
GET  /api/health
GET  /api/accounts / /api/regions                          — scope dimension (multi-account ready)
GET  /api/summary                                           — counts by type, snapshot freshness
GET  /api/snapshots                                         — history, drift deltas between siblings
GET  /api/resources?type=&account_id=&region=&vpc_id=&q=    — search (type/name/tag/ARN)
GET  /api/resources/:key                                    — full detail + properties + tags + raw JSON
GET  /api/resources/:key/neighbors                          — edges + 1-hop
GET  /api/graph?scope=vpc_<id>|subnet_<id>|account&snapshot=— typed subgraph for React Flow
GET  /api/graph/sg/:id                                      — focused SG reference view
GET  /api/jobs · GET /api/jobs/:id                          — scan history + live progress table
POST /api/jobs                                             — trigger an on-demand scan
POST /api/jobs/:id/cancel                                   — cancel a running scan (graceful)
POST /api/jobs/:id/resume                                   — resume an interrupted/cancelled scan
WS   /ws/events                                             — bridges scanner SSE → browser
GET  /api/findings (Phase 2)                                — Top-10 + full list
POST /api/chat (Phase 2)                                    — AI chat with citations (proxies AI svc)
```
Graph payloads are typed and minimal (id/type/name/status/tags) so large maps render fast; full
properties only on detail fetch.

### SPA (React + `@xyflow/react`, themed dark-only)
- **Overview** — accounts/regions, type counts, snapshot freshness, collapsed default-vpc groups.
- **Connected diagram** — one VPC per view; subnets as nested `@xyflow/react` group nodes; resources laid
  out inside; SGs as a cluster; `<100 nodes` per VPC → `dagre` layout is sufficient.
- **SG explorer** — directed `REFERENCES` graph, rules on click.
- **Live scan panel** — progress per (account, region, service) with counts, cancel/resume buttons,
  driven by `/ws/events`. Adjacent "Scan now" button on the Overview.
- **Snapshot timeline** — drift view: added/removed/changed badges between snapshots (future alerts reuse
  the same diff engine).
- **Findings panel (Phase 2)** — Top-10 cards + expandable full rule list.
- **Export** — PNG/SVG of the current view, **masked** (IPs/ARNs/userdata replaced) for share contexts.
- No auth flows in Phase 1 (localhost, single user).

---

## 9. Misconfiguration engine (Phase 2 — rules designed now)

- **Source of truth = the graph.** Cypher checks over nodes+edges. Uniform across envs (D20).
- **Also ingests AWS Config findings when recording is present** (rule → finding node linked to resource);
  accounts **without** Config use pure Cypher checks — both paths supported (D04/D17).

### Initial rule library (seed)
1. S3 bucket public (`GetBucketAcl` allows `AllUsers/AuthenticatedUsers`; policy effect-not-`deny`).
2. `0.0.0.0/0` ingress on a SG attached to a non-`intra` resource.
3. SG `REFERENCES`/`ASSOC_WITH` but nothing attached anywhere → orphan SG.
4. EC2/RDS/ElastiCache volume/cluster **unencrypted**.
5. EIP allocated but not associated (public IP leak).
6. **Missing mandatory tags** (any resource without `env`/`name`).
7. **Cross-environment edge** (dev SG/instance reaching stage/prod SG or resource) — the risk your
   startup sees in practice (D15).
8. Stopped/idle EC2 & unassociated EIPs → cost signal (D10 partial, no $ figures yet).
9. Logging/flow-log disabled on VPC (D11 borrow, cheap to compute).

### Presentation
- **Top-10**: highest-severity affected resources with "why it matters" + concrete remediation.
- **Full list**: every fired rule, grouped by category, expandable.
- Findings written as `:Finding` nodes linked to affected resources (`AFFECTS` edge), so AI can cite them.

---

## 10. AI layer (Phase 2 — Python `neo4j-graphrag`)

- **Models:** **Amazon Bedrock** default — works in commercial *and* GovCloud (D23). Provider adapter maps
  chat + embeddings (e.g., Claude for chat, Titan Embeddings for vectors); OpenAI-compatible adapter
  optional for non-GovCloud use.
- **Retrieval:** hybrid — graph traversal + Neo4j **vector index** over embedded resource/relationship
  text + full-text Lucene index; citations are the actual graph paths returned.
- **Skills:**
  1. **Chat w/ citations** — "which instances can reach the DB?" → answered with the traversed path as
     sources (D24).
  2. **Text→Cypher** — validated read-only Cypher generated from the live graph schema.
  3. **Findings explainer** — translate Top-10 findings into plain-English remediation drafts (D25:
     **draft plans only**, never executes; auto-remediation is Phase 3 D21).
- Consumed by the Deno web layer through `POST /api/chat` (keep Deno as the only client-facing surface).

---

## 11. Security & ops

- Scanner runs with SSO credentials; assume a **least-privilege read-only role** per account. Required
  actions are the `Describe*`/`List*` from §5 + `resourcegroupstaggingapi:GetResources` (optional).
- No secrets in repo — creds come from the AWS default chain; Neo4j auth via env vars, **bound to
  127.0.0.1**; Browser/Bloom exposed only locally (D30).
- The scanner performs **zero write operations** on AWS, ever (Phase 1-2).
- JSON-lines bundle is the auditable source of truth; Neo4j is a re-buildable derived view.
- **Masking:** applies on export/share paths only (D31).

---

## 12. Deployment

```
docker-compose.yml
  neo4j    (community, 127.0.0.1:7474 + 7687 bolt, auth via env)
  scanner  (awsome-scanner daemon; starts with compose, waits idle for jobs, control plane on
            127.0.0.1:<ctl-port>; Deno triggers via POST /jobs)
  web      (Deno: serves SPA + /api/*; talks Bolt to Neo4j + control plane to scanner)
  [ai      (Phase 2, python service; talks Bolt + Bedrock)]
```
Single-user localhost (D26): `docker compose up`, open http://localhost:PORT, click "Scan now".

---

## 13. Roadmap

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| 0 | Auth/SSO bootstrap; scan EC2+VPC+SG in one region; JSON-lines dump | verified JSON, no missing fields |
| 1 | Full Phase-1 inventory (§5) → Neo4j → Deno API + VPC diagram + detail; **job runner with live progress, cancel, resume** | engineer reads whole account legibly; scans are observable & interruptible |
| 1.5 | Multi-account targets, region autodetect, snapshots + drift UI, SG explorer, collapsed defaults, PNG/SVG export | map is trustworthy; diff visible in UI |
| 2 | Misconfig engine + Config ingest + findings UI; AI service (Bedrock, chat w/ citations, text→Cypher) | actionable Top-10; chat answers with paths |
| 2.5 | Drift alerts (email/Slack), IaC (Terraform) declared-vs-actual diff | change notifications + drift from IaC |
| 3 | Cost join, external-network nodes + risk flags, blast radius, guarded auto-remediation, Organizations auto-discovery, share links | backburner backlog items landing |

## 14. Future scope (explicitly parked)

- Cost/expense join; control-plane & observability nodes (VPCE/CloudTrail/CloudWatch); drift alerts by
  channel; IaC reconciliation (Terraform); blast-radius analysis; dry-run+apply remediation; multi-account
  auto-discovery via Organizations; KMS encryption edges; in-cluster Kubernetes topology; shareable links.

---

## 15. Remaining open questions

1. Exact SSO multi-account target format for Phase 1.5 (role-per-account list vs single SSO permission-set).
2. Snapshot retention N — default 30; make it a config knob.
3. Neo4j credentials management for the local compose env (env file), rotation policy.
4. Cancel/resume UX depth: cancel-only in Phase 1, resume in 1.5? (spec assumes both from Phase 1).
4. Whether Phase 0 should already include EKS/ECS clusters (usage skews the collector's priority order).
