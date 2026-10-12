#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RAG_URL="https://veti-rag-api.livelystone-4391080e.chilecentral.azurecontainerapps.io"
IMAGE="${1:-ghcr.io/allyhere/veti-rag-api:auth-$(date -u +%Y%m%d-%H%M%S)}"

for command in node docker perl curl az; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Comando obrigatório não encontrado: $command" >&2
    exit 1
  fi
done

if [[ ! -f .env ]]; then
  echo "Arquivo .env não encontrado." >&2
  exit 1
fi

if ! node --env-file=.env -e '
  const required = [
    "GHCR_TOKEN",
    "GEMINI_API_KEY",
    "NEO4J_PASSWORD",
    "NEO4J_URI",
    "NEO4J_USER",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "CORS_ORIGINS",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.error(`Variáveis ausentes no .env: ${missing.join(", ")}`);
    process.exit(1);
  }
'; then
  exit 1
fi

echo "Autenticando no GHCR..."
node --env-file=.env -e 'process.stdout.write(process.env.GHCR_TOKEN)' |
  docker login ghcr.io -u allyhere --password-stdin

echo "Construindo $IMAGE..."
docker build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "$IMAGE" .

echo "Publicando $IMAGE..."
docker push "$IMAGE"

echo "Atualizando infra/main.bicepparam..."
export IMAGE
perl -0pi -e \
  's|param containerImage = '\''[^'\'']+'\''|param containerImage = '\''$ENV{IMAGE}'\''|' \
  infra/main.bicepparam

if [[ "$(< infra/main.bicepparam)" != *"param containerImage = '$IMAGE'"* ]]; then
  echo "Não foi possível atualizar containerImage em infra/main.bicepparam." >&2
  exit 1
fi

echo "Implantando no Azure..."
scripts/play-pause.sh play

echo "Verificando saúde..."
curl -sf --max-time 60 "$RAG_URL/health"
echo

echo "Verificando proteção Firebase..."
response="$(
  curl -sS --max-time 60 \
    -w $'\n%{http_code}' \
    "$RAG_URL/v1/conversations"
)"
status="${response##*$'\n'}"
if [[ "$status" != "401" ]]; then
  echo "Esperado HTTP 401 sem token Firebase; recebido HTTP $status." >&2
  exit 1
fi

echo "Deploy concluído: $IMAGE"
