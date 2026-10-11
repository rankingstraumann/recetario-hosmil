# Vendor: SheetJS (xlsx) 0.20.3 — build MINI

Usado por la Edge Function `prospect-import-preview` solo para leer **XLSX**. Se empaqueta con la función:
sin descarga en runtime ni CDN dinámico. El build mini NO soporta CSV; el CSV lo procesa `parseCsv`/`decodeCsv` (`parse.ts`), sin SheetJS.

## Origen (oficial)
| Campo | Valor |
|---|---|
| Versión | 0.20.3 (`XLSX.version`) |
| Paquete | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz |
| SHA-256 `xlsx-0.20.3.tgz` | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| Archivo original | `package/dist/xlsx.mini.min.js` (279.523 bytes) |
| SHA-256 original | `0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939` |
| Licencia | Apache-2.0 (`vendor/LICENSE`) |
| Incorporación | 2026-10-11 |

## Transformación aplicada (única)
El original es un script standalone (`var XLSX={}; ... make_xlsx_lib(XLSX)`). Para usarlo como módulo ESM se hizo:

    cp package/dist/xlsx.mini.min.js vendor/xlsx.mini.mjs
    printf '\nexport { XLSX };\n' >> vendor/xlsx.mini.mjs

Es decir: los primeros 279.523 bytes son idénticos al original y solo se agregan 18 bytes al final (`\nexport { XLSX };\n`).
En un módulo ESM no existen `exports`/`module`/`define`, así que el script cae en su rama `make_xlsx_lib(XLSX)` y puebla el objeto exportado.

| Archivo derivado | `vendor/xlsx.mini.mjs` |
|---|---|
| Tamaño | 279.541 bytes |
| SHA-256 | `d84716827eb56e78ed75bd3d837694b2bc05adaa74199b371eab434621c9f97e` |

## Verificar
    sha256sum vendor/xlsx.mini.mjs                      # d8471682...f97e
    head -c 279523 vendor/xlsx.mini.mjs | sha256sum     # 0cb353f8...0939 (= original oficial)

Cubre CVE-2023-30533 (corregido en 0.19.3) y CVE-2024-22363 (corregido en 0.20.2). El paquete `xlsx` de npm se detuvo en 0.18.5 (vulnerable): **no usar `npm:xlsx`**.

## Actualizar
Descargar el .tgz oficial, calcular SHA-256, repetir la transformación, actualizar esta tabla y correr `test/run-tests.sh`.
