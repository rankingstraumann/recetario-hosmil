#!/usr/bin/env bash
# Requiere Node >= 22 y xlsx@0.18.5 instalado (solo dev): XLSX_FROM=<carpeta con node_modules/xlsx> ./run-tests.sh
cd "$(dirname "$0")" && node --experimental-strip-types --no-warnings --test import-preview.test.mjs
