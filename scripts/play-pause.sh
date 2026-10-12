#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

AZURE_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-22d97a05-d599-4949-a977-04132c4080e3}"
AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-rg-veti}"

case "${1:-}" in
  play) replicas=1 ;;
  pause) replicas=0 ;;
  *)
    echo "Uso: scripts/play-pause.sh play|pause" >&2
    exit 1
    ;;
esac

env_value() {
  node --env-file=.env -e \
    'const value = process.env[process.argv[1]]; if (value) process.stdout.write(value)' \
    "$1"
}

GEMINI_API_KEY="$(env_value GEMINI_API_KEY)"
NEO4J_PASSWORD="$(env_value NEO4J_PASSWORD)"
NEO4J_URI="$(env_value NEO4J_URI)"
NEO4J_USER="$(env_value NEO4J_USER)"
GHCR_TOKEN="$(env_value GHCR_TOKEN)"
FIREBASE_PROJECT_ID="$(env_value FIREBASE_PROJECT_ID)"
FIREBASE_CLIENT_EMAIL="$(env_value FIREBASE_CLIENT_EMAIL)"
FIREBASE_PRIVATE_KEY="$(env_value FIREBASE_PRIVATE_KEY)"
CORS_ORIGINS="$(env_value CORS_ORIGINS)"

if [[ -z "$GEMINI_API_KEY" || -z "$NEO4J_PASSWORD" || -z "$NEO4J_URI" || -z "$NEO4J_USER" || -z "$GHCR_TOKEN" || -z "$FIREBASE_PROJECT_ID" || -z "$FIREBASE_CLIENT_EMAIL" || -z "$FIREBASE_PRIVATE_KEY" || -z "$CORS_ORIGINS" ]]; then
  echo "Faltam variáveis obrigatórias de Gemini, Neo4j, GHCR, Firebase ou CORS no .env." >&2
  exit 1
fi

az deployment group create \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name veti-rag \
  --template-file infra/main.bicep \
  --parameters infra/main.bicepparam \
  --parameters \
    geminiApiKey="$GEMINI_API_KEY" \
    neo4jPassword="$NEO4J_PASSWORD" \
    neo4jUri="$NEO4J_URI" \
    neo4jUser="$NEO4J_USER" \
    firebaseProjectId="$FIREBASE_PROJECT_ID" \
    firebaseClientEmail="$FIREBASE_CLIENT_EMAIL" \
    firebasePrivateKey="$FIREBASE_PRIVATE_KEY" \
    corsOrigins="$CORS_ORIGINS" \
    registryPassword="$GHCR_TOKEN" \
    minReplicas="$replicas" \
  --query properties.outputs.url.value \
  -o tsv
