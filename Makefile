GO ?= go

.PHONY: help tidy build localstack-up localstack-down wait seed scan scan-real clean

help:
	@echo "make localstack-up   start LocalStack (docker compose up -d)"
	@echo "make localstack-down stop LocalStack"
	@echo "make seed            create demo VPC/subnet/SGs/instance in LocalStack"
	@echo "make scan            run the phase-0 scanner against LocalStack"
	@echo "make scan-real       run against real AWS (uses default credential chain)"
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

seed: wait
	$(GO) run ./cmd/awsome-seed

scan: wait
	$(GO) run ./cmd/awsome-scanner

scan-real:
	$(GO) run ./cmd/awsome-scanner

clean:
	rm -rf snapshots .localstack
