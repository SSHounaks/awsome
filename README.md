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
cp .env.example .env
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

make localstack-up              # start LocalStack (Docker)
make seed                       # demo VPC/subnet/SG x2 (sg-app references sg-web)/instance
make scan                       # enumerate + write snapshots/<snapshot-id>/records.jsonl
```

Then inspect:

```sh
go run ./cmd/awsome-scanner --endpoint-url http://localhost:4566   # same as make scan
ls snapshots/snap-*/             # records.jsonl + summary.json
```

## Real AWS (Free Tier account)

```sh
# after `aws configure sso` / setting AWS_PROFILE
make scan-real                  # or: go run ./cmd/awsome-scanner
go run ./cmd/awsome-scanner --regions us-east-1,us-west-2
```

Rules of thumb: no `--endpoint-url` = real AWS; credential chain = SSO/default profile.

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

Community edition emulates the `Describe*` API shape and pagination well, but not full EC2 parity
(NAT gateways, endpoints, some rule behaviors). It is the day-to-day dev target; use the real Free-Tier
account for the "golden" correctness check (diff the JSONL vs the console).

## Layout

```
cmd/awsome-scanner       CLI entrypoint (flags: --endpoint-url --regions --out --snapshot-id --concurrency)
cmd/awsome-seed          seeds a demo topology into LocalStack
internal/awscfg          SDK config loader (endpoint override aware)
internal/config          CLI/env config
internal/collect         target resolution + walkers (EC2/VPC/SG) + orchestration + record model helpers
internal/inspect         JSONL writer + summary writer
compose.yml              LocalStack service
```
