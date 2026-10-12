#!/usr/bin/env bash
# Pruebas locales de lógica (sin red, sin Supabase): motor + orquestación contra una BD en memoria y un LLM simulado.
# Uso: bash supabase/functions/whatsapp-webhook/test/run-local.sh   (requiere Node >= 22.6)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$HERE/.."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$SRC"/{index,engine,extract,summary,whatsapp,reply,outbound-sirios}.ts "$TMP"/
cp "$HERE/fake-db.ts" "$TMP/db.ts"; cp "$HERE/harness.mjs" "$TMP/"; cp "$HERE/local-flow.test.mjs" "$TMP/t1.mjs"; cp "$HERE/outbound-sirios.test.mjs" "$TMP/t2.mjs"
cd "$TMP"
F="ExperimentalWarning|trace-warnings|^\{\"ev\""
node --experimental-strip-types t1.mjs 2>&1 | grep -v -E "$F"
echo "=== OUTBOUND 9A (journey outbound_sirios) ==="
node --experimental-strip-types t2.mjs 2>&1 | grep -v -E "$F"
