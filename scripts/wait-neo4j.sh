#!/usr/bin/env bash
set -euo pipefail
URL="http://127.0.0.1:7474"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "${URL}" 2>/dev/null; then
    echo "neo4j ready at ${URL}"
    exit 0
  fi
  sleep 2
done
echo "neo4j did not become ready at ${URL}" >&2
exit 1
