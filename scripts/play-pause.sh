#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  play) replicas=1 ;;
  pause) replicas=0 ;;
  *)
    echo "Uso: scripts/play-pause.sh play|pause" >&2
    exit 1
    ;;
esac

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${GEMINI_API_KEY:-}" || -z "${NEO4J_PASSWORD:-}" || -z "${NEO4J_URI:-}" || -z "${NEO4J_USER:-}" || -z "${GHCR_TOKEN:-}" ]]; then
  echo "Faltam GEMINI_API_KEY, NEO4J_PASSWORD, NEO4J_URI, NEO4J_USER ou GHCR_TOKEN no .env." >&2
  exit 1
fi

az deployment group create \
  --resource-group rg-veti \
  --name veti-rag \
  --template-file infra/main.bicep \
  --parameters infra/main.bicepparam \
  --parameters \
    geminiApiKey="$GEMINI_API_KEY" \
    neo4jPassword="$NEO4J_PASSWORD" \
    neo4jUri="$NEO4J_URI" \
    neo4jUser="$NEO4J_USER" \
    registryPassword="$GHCR_TOKEN" \
    minReplicas="$replicas" \
  --query properties.outputs.url.value \
  -o tsv
