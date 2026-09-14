# AWS ↔ LocalStack Differences

Stance: LocalStack Community is a **dev/emulation target, not a modeling-of-truth target**. It exists to
exercise the scanner's *code paths*; real AWS validates *data shapes*. This file captures what differs
and what that means for the scanner, so nobody trusts emulator behavior they never verified.

| # | Area | LocalStack Community | Real AWS | Scanner implication |
|---|------|----------------------|----------|----------------------|
| 1 | **Supply of regions** | `DescribeRegions` returns ALL commercial + gov + cn regions (35 here) | Returns only regions enabled for the calling account; gov/cn absent unless the account is in them | Don't hard-assert region count; "prune empty" logic should be unit-tested, not eyeballed |
| 2 | **Region scoping** | Single backend ignores region — **same resources appear in every region** (we observed: one instance listed in 5 regions, default VPCs everywhere) | Perfectly region-scoped (resource belongs to exactly one region, except global services) | A resource appearing in multiple regions is an emulator artifact — never filter on it locally |
| 3 | **Account / partition** | Account id is always `000000000000`; partition always `aws` | Real 12-digit id; `aws`/`aws-us-gov`/`aws-cn` per session | Partition parser must be exercised against a *real* GovCloud session eventually (D06) |
| 4 | **ARN shapes** | `arn:aws:ec2:…:000000000000:…` | Real account + partition + service-specific formats | Node `key` = ARN; validate uniqueness on real ARNs during golden check |
| 5 | **Throttling / rate limits** | None by default — unbounded throughput | Real quota-based throttling (`ThrottlingException`, 5xx, `SlowDown`) | **Retry/backoff + jitter path is untestable locally** → must be verified against real AWS or injected mocks |
| 6 | **Denied permissions** | Permissive unless `ENFORCE_IAM=true` | `AccessDenied` is real and common on least-privilege roles | **Degrade-on-deny path is untestable locally by default** → test with ENFORCE_IAM, then confirm on real role |
| 7 | **Pagination** | Honors `MaxResults`/`NextToken` on many services | Real; page sizes vary per service | Works locally for page-walking logic; real page-size boundaries should be seen once |
| 8 | **Instance lifecycle** | Instances created then idle-stuck at `running`; no SSH; arbitrary types/AMIs accepted | Real lifecycle, real platforms, image validation | Never assert instance internals (OS login, metadata) in e2e tests |
| 9 | **EBS / AMI** | Basic describe; stub data | Real volumes/snapshots/images | Field population differs — capture `properties` as raw JSON, don't parse-semantics locally |
| 10 | **VPC/SG/NACL/RT/IGW** | Basic CRUD + describe well-supported (defaults auto-created) | Full semantics | Good local coverage; NACL/RT field values may still differ — diff against real data |
| 11 | **NAT Gateways** | **Not supported in Community** | Real | Walker must handle "empty list" locally, real NGs only verifiable on real AWS (or Pro) |
| 12 | **VPC Endpoints / Peering** | Peering basic; endpoints limited/absent | Full | Degrade gracefully when endpoint list is empty |
| 13 | **ALB / NLB (ELBv2)** | Partial (create/describe/listeners/TGs limited) | Full | Local = shape smoke; real = authoritative TG/listener wiring |
| 14 | **RDS** | Community: a few engines (MySQL/Postgres), subnet groups, no Aurora/clusters | Full engine matrix | Local walker test ok; real = authoritative for engine/SG/subnet-group shape |
| 15 | **ElastiCache / Redshift / OpenSearch** | Stub-ish / partial | Full | **Treat as not-verifiable locally** — schedule for real-AWS walker validation |
| 16 | **Lambda (VPC config)** | Supported; VPC attrs settable/describable | Full | Good local coverage of the VPC-binding attributes |
| 17 | **ECS / EKS** | Partial (Fargate acts via Docker; EKS minimal) | Full clusters | Node/role wiring validated on real only |
| 18 | **DynamoDB** | Very well supported | Full | High-confidence local coverage |
| 19 | **S3** | Very well supported (buckets, ACL, policy, tagging) | Full | Good local coverage; **public-block & policy-deny nuances differ** — rule engine (Phase 2) must be authored against real examples |
| 20 | **IAM** | CRUD + basic trust parsing; no policy sim | Full | Attachments/trust parse similar; rule semantics must be validated on real |
| 21 | **Ids & naming** | Synthetic ids (`vpc-7b5f688f`, 17-hex sg); no global name constraints beyond basics | Real, globally constrained (S3 bucket names, etc.) | Never assume id formats inside the scanner |
| 22 | **Time** | No event-time drift | Real | `scanned_at` uses client clock; fine for both |
| 23 | **Cost** | Nothing meaningful | Real (Cost Explorer) | Already parked (D10) — cost work is real-AWS-only by definition |

## Rules of engagement

- **Build against LocalStack, verify against Free Tier.** LocalStack exercises paginators, walkers, edge
  emission, snapshot finalize, and the future job/SSE runner. Real AWS exercises truth.
- **Items unusable on Community (rows 11, 14, 15, 17, 19-rules, 20-rules):** treat LocalStack as a
  smoke fixture only; add explicit "REAL-VALIDATE" markers in tests/stories for these.
- **Never write a test that asserts LocalStack-only behaviors** (multi-region duplicates, all-regions
  DescribeRegions, `000000000000`) as if they were AWS truth.
- **Upgrade path:** switching to LocalStack Pro closes rows 11/13/14/15/17 for dev purposes but *still*
  doesn't model AWS quotas/throttling/denial (rows 5/6) — the Free-Tier smoke stays mandatory.
- Revisit this file whenever a Phase adds a service (λ engines, Redshift/OpenSearch walkers, rule engine).

## Verified coverage on this box (LocalStack 3.8.1 Community, via Docker)

Empirically confirmed single-region scan (`make scan`, us-east-1). A walker "degraded" (silently skipped)
when the emulator returned a 501 "not yet implemented or pro feature"; the snapshot still completes.

| Walkers VERIFIED against LocalStack (nodes present in snapshot) | Walkers DEGRADED here (Community gap / pro-feature) |
|---|---|
| EC2, VPC, SG, Subnet, RouteTable, NACL, IGW, EIP, Peering, ENI, Volume, AMI, ASG* | ELBv2 (LB/TG/listeners → `FORWARDS`) |
| IAM (role/policy/profile + attach chain) | AutoScalingGroup (`CONTAINS`) |
| Lambda (+ VPC edges) | RDS (+ DBSG, `USES_SUBGRP`) |
| DynamoDB | ElastiCache |
| Redshift (node + SG edges) | ECS, EKS |
| S3 (buckets, ACL, policy, tags, versioning) | ECR |

*AutoScalingGroup: seed creates the ASG fixture (CreateAutoScalingGroup), but instances the ASG would own
are emulator-dependent; treat `CONTAINS` edges as REAL-VALIDATE.

Gotchas confirmed by running it:
- S3 with the Go SDK requires **path-style addressing** against a non-AWS endpoint
  (`s3.NewFromConfig(sdk, func(o *s3.Options){ o.UsePathStyle = true })`). Virtual-host style → 500
  "Unable to find operation for request to service s3: PUT /".
- IAM `ListPolicies Scope:"All"` returns ~1200 AWS-managed policies in LocalStack → the walker uses
  `Scope:"Local"` (customer-managed only) to keep snapshots meaningful (applies to real AWS too).
- The collector **degrades instead of failing** on: EC2-built-in `not yet implemented`/`NotImplemented`,
  `InvalidAction`, `OptInRequired`, `AccessDenied`, `UnauthorizedOperation`. This is what lets a scan
  complete even when some services are Community gaps (row 5/6 philosophy).
- Instance IAM-profile + AMI wiring is a real edge chain: `instance -USES_PROFILE-> profile -HAS_ROLE->
  role -USES_POLICY-> policy` and `instance -RUNS_AMI-> ami`.
