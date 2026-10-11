#!/usr/bin/env bash
# Requiere Node >= 22. Usa SheetJS 0.20.3 vendorizada (../vendor/xlsx.mini.mjs); no requiere npm install.
cd "$(dirname "$0")" && node --experimental-strip-types --no-warnings --test import-preview.test.mjs confirm.test.mjs
