#!/usr/bin/env bash
set -euo pipefail
for i in $(seq 1 60); do
  if curl -sf http://localhost:4566/_localstack/health >/dev/null 2>&1; then
    echo "localstack ready"
    exit 0
  fi
  sleep 1
done
echo "localstack not ready after 60s" >&2
exit 1
