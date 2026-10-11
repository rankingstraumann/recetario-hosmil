# Vendor: SheetJS (xlsx) 0.20.3

Copia **sin modificar** del build ESM oficial, usada por la Edge Function `prospect-import-preview`.
Se empaqueta junto con la función: no hay descarga en runtime ni CDN dinámico.

| Campo | Valor |
|---|---|
| Versión | 0.20.3 (`XLSX.version`) |
| Origen oficial | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz |
| Archivo vendorizado | `package/xlsx.mjs` del tarball (1.008.308 bytes) |
| SHA-256 `xlsx-0.20.3.tgz` | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| SHA-256 `package/xlsx.mjs` | `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db` |
| Licencia | Apache-2.0 (`vendor/LICENSE`, copia de `package/LICENSE`) |
| Fecha de incorporación | 2026-10-11 |

Ambos hashes fueron calculados de forma independiente sobre el archivo recibido y coinciden con los
hashes de control entregados por el responsable del proyecto.

Cubre: CVE-2023-30533 (prototype pollution, corregido en 0.19.3) y CVE-2024-22363 (ReDoS, corregido en 0.20.2).
El paquete `xlsx` de npm se detuvo en 0.18.5 (vulnerable): **no usar `npm:xlsx`** en ningún punto.

## Verificar
    sha256sum vendor/xlsx.mjs   # debe dar 1a0fb062...b77db

## Actualizar
1. Descargar el .tgz oficial desde cdn.sheetjs.com, 2. calcular ambos SHA-256, 3. reemplazar `xlsx.mjs`, 4. actualizar esta tabla,
5. correr `test/run-tests.sh`.
