#!/usr/bin/env bash
# Requiere Node >= 22. Sin red ni dependencias.
cd "$(dirname "$0")" && node --experimental-strip-types --no-warnings --test send.test.mjs
