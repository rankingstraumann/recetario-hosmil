#!/usr/bin/env bash
# Consulta SEGURA de un correo recibido en Resend: muestra solo el objeto `authentication`, nombres de cabeceras y si hay cuerpo. NO imprime el cuerpo
# ni la clave. La API key se pide por teclado (sin eco), vive solo en esta ejecucion y solo se envia a https://api.resend.com (o RESEND_BASE para pruebas locales).
# Uso: bash consultar_recepcion.sh <email_id>
set -u
ID="${1:-}"; BASE="${RESEND_BASE:-https://api.resend.com}"
[[ "$ID" =~ ^[A-Za-z0-9_-]{6,80}$ ]] || { echo "email_id invalido" >&2; exit 2; }
read -rs -p "Resend API key (no se muestra): " KEY; echo
[ -n "$KEY" ] || { echo "sin clave" >&2; exit 2; }
TMP="$(mktemp)"; trap 'rm -f "$TMP"; KEY=' EXIT
# La clave va por stdin de curl (-K -), no en la linea de comandos ni en el historial.
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -sS -K - -o "$TMP" -w '%{http_code}' "$BASE/emails/receiving/$ID")
echo "HTTP $CODE"
case "$CODE" in 200) ;; 401|403) echo "La API key no tiene permiso de lectura de correos recibidos (o es invalida)."; exit 1;; 404) echo "email_id no encontrado."; exit 1;; *) echo "Respuesta inesperada."; exit 1;; esac
python3 -I - "$TMP" <<'PY'
import json, re, sys
j = json.load(open(sys.argv[1]))
a = j.get('authentication')
print('authentication =', json.dumps(a, ensure_ascii=False))
dm = (a or {}).get('dmarc') if isinstance(a, dict) else None
print('dmarc =', dm, '=> regla actual:', 'VERIFICADO' if isinstance(dm, str) and dm.lower() == 'pass' else ('REINTENTAR' if dm == 'processing_failed' else 'NO VERIFICADO'))
h = j.get('headers') or {}
print('cabeceras =', ','.join(sorted(k.lower() for k in h if re.fullmatch(r'[A-Za-z0-9\-]{1,40}', k))))
print('tiene_texto =', bool(j.get('text')), '| tiene_html =', bool(j.get('html')), '| adjuntos =', len(j.get('attachments') or []))
print('from_dominio =', re.sub(r'.*@|>.*', '', str(j.get('from', ''))).lower())
PY
