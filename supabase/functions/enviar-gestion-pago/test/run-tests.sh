#!/usr/bin/env bash
# Pruebas del emisor de gestion de pagos. Requiere Node >= 22.
#  - gestion.test.mjs : sin red ni BD (fidelidad vs el boton original de admin.html)
#  - envio.integracion.test.mjs : Postgres LOCAL (B1+B2+B3) + mock de Resend en 127.0.0.1. Requiere PAGOS_FASE_B_DIR y la BD en /var/tmp/pgproof.
cd "$(dirname "$0")" || exit 1
node --experimental-strip-types --no-warnings --test gestion.test.mjs || exit 1
if [ -n "$PAGOS_FASE_B_DIR" ]; then node --experimental-strip-types --no-warnings --test --test-concurrency=1 envio.integracion.test.mjs; else echo "(integracion omitida: define PAGOS_FASE_B_DIR)"; fi
