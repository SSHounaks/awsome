GO ?= go

.PHONY: help tidy build localstack-up localstack-down wait seed scan scan-real clean

help:
	@echo "make localstack-up   start LocalStack (docker compose up -d)"
	@echo "make localstack-down stop LocalStack"
	@echo "make seed            create demo VPC/subnet/SGs/instance in LocalStack"
	@echo "make scan            scan LocalStack (single region us-east-1)"
	@echo "make scan-real       run against real AWS (profile $(AWS_PROFILE), regions $(REGIONS))"
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

AWS_PROFILE ?= awsome
REGIONS   ?= us-east-1

LS_ENV := AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY AWS_DEFAULT_REGION=us-east-1

seed: wait
	$(LS_ENV) $(GO) run ./cmd/awsome-seed --endpoint-url http://localhost:4566

scan: wait
	$(LS_ENV) $(GO) run ./cmd/awsome-scanner --endpoint-url http://localhost:4566 --regions us-east-1

scan-real:
	$(GO) run ./cmd/awsome-scanner --profile $(AWS_PROFILE) --regions $(REGIONS)

clean:
	rm -rf snapshots .localstack
