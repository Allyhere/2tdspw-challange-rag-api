#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://localhost:3000}"
CSV="$ROOT/api/data/clinica-catalogo.csv"

echo "== GET /health =="
curl -sf "$BASE/health"
echo
echo

run_case() {
  local name="$1"
  local payload="$2"
  echo "== POST /v1/care-plan ($name) =="
  local body
  body="$(curl -sf -X POST "$BASE/v1/care-plan" \
    -H "Content-Type: application/json" \
    -d "$payload")"
  echo "$body" | python3 -m json.tool
  echo "$body" | node "$ROOT/scripts/assert-catalog.mjs" "$CSV"
  echo
}

run_case "Labrador" '{"name":"Thor","breed":"Labrador","species":"cachorro","sex":"macho","weight":28.5,"age":3,"isCastrated":false}'
run_case "Persa" '{"name":"Luna","breed":"Persa","species":"gato","sex":"femea","weight":4,"age":2,"isCastrated":true}'

echo "OK: respostas válidas e nomes apenas do catálogo."
