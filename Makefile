GO ?= go

.PHONY: help tidy build localstack-up localstack-down wait seed scan scan-real report neo4j-up neo4j-load web clean

help:
	@echo "make localstack-up   start LocalStack (docker compose up -d)"
	@echo "make localstack-down stop LocalStack"
	@echo "make seed            create demo VPC/subnet/SGs/instance in LocalStack"
	@echo "make scan            scan LocalStack (single region us-east-1), one-shot"
	@echo "make scan-real       run against real AWS (profile $(AWS_PROFILE), regions $(REGIONS))"
	@echo "make serve           run scan daemon + control plane http://127.0.0.1:8080"
	@echo "make report          run findings engine against latest snapshot"
	@echo "make neo4j-up        start Neo4j (docker)"
	@echo "make neo4j-load      MERGE latest snapshot into Neo4j"
	@echo "make web             start API + React Flow SPA (http://127.0.0.1:8000)"
	@echo "make mcp             MCP stdio server (graph/findings/scan tools for AI agents)"
	@echo "make check-web       deno type-check api/ + web/app.js"
	@echo "make tidy            go mod tidy"
	@echo "make build           compile everything"

tidy:
	$(GO) mod tidy

build: tidy
	$(GO) build ./...

localstack-up:
	docker compose up -d localstack

localstack-down:
	docker compose down

wait:
	./scripts/wait-localstack.sh

neo4j-up:
	docker compose up -d neo4j
	./scripts/wait-neo4j.sh

neo4j-load:
	$(eval SNAP := $(shell ls -td snapshots/*/ 2>/dev/null | head -1))
	$(if $(SNAP),$(GO) run ./cmd/awsome-neo4j --dir $(SNAP),@echo "no snapshot yet — run make scan first")

# Tailwind v4 CLI: prefer the standalone binary if it was downloaded, otherwise
# fall back to the npm package (`npm install --no-save tailwindcss@4 @tailwindcss/cli@4`).
# v4 auto-detects sources from the input stylesheet's directory, so --content
# (a v3 flag) is not needed.
TW := $(firstword $(wildcard .tools/tailwindcss node_modules/.bin/tailwindcss))

tw:
	@if [ -z "$(TW)" ]; then \
		echo "no tailwind CLI found — run: npm install --no-save tailwindcss@4 @tailwindcss/cli@4" >&2; \
		exit 1; \
	fi
	$(TW) -i web/styles.src.css -o web/styles.css --minify

# ANTHROPIC_CONFIG_DIR is readable/writable so the `anthropic` chat provider can
# use an `ant auth login` OAuth profile instead of a static API key. Write access
# is needed because the SDK saves refreshed tokens back to the profile. Narrow it
# to that one directory rather than opening up $HOME.
ANTHROPIC_CONFIG_DIR ?= $(HOME)/.config/anthropic

web: tw
	@mise x -- bash -lc 'deno run --allow-net --allow-read=.,$(ANTHROPIC_CONFIG_DIR) --allow-run=bash,kill,setsid,opencode,pgrep --allow-write=/tmp/awsome,$(ANTHROPIC_CONFIG_DIR) --allow-env api/main.ts'

check-web: tw
	@mise x -- bash -lc 'deno check api/main.ts api/mcp_server.ts api/ai/chat.ts && deno check --import-map=web/importmap.json web/app.js'

mcp:
	@mise x -- bash -lc 'deno run --allow-net --allow-read=. --allow-env api/mcp_server.ts'

check-web:
	@mise x -- bash -lc 'deno check api/main.ts api/mcp_server.ts api/ai/chat.ts && deno check --import-map=web/importmap.json web/app.js'

AWS_PROFILE ?= awsome
REGIONS   ?= us-east-1

LS_ENV := AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY AWS_DEFAULT_REGION=us-east-1

seed: wait
	$(LS_ENV) $(GO) run ./cmd/awsome-seed --endpoint-url http://localhost:4566

scan: wait
	$(LS_ENV) $(GO) run ./cmd/awsome-scanner --endpoint-url http://localhost:4566 --regions us-east-1

scan-real:
	$(GO) run ./cmd/awsome-scanner --profile $(AWS_PROFILE) --regions $(REGIONS)

serve: wait
	$(LS_ENV) $(GO) run ./cmd/awsome-scanner --endpoint-url http://localhost:4566 --control 127.0.0.1:8080

report:
	$(eval SNAP := $(shell ls -td snapshots/*/ 2>/dev/null | head -1))
	$(if $(SNAP),$(GO) run ./cmd/awsome-report --dir $(SNAP),@echo "no snapshot yet — run make scan first")

clean:
	rm -rf snapshots .localstack
