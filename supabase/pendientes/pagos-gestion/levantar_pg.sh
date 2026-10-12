#!/bin/bash
# Levanta (o recrea) la Postgres LOCAL de pruebas en /var/tmp/pgproof y carga stub + B1 + B2 + B3 (+ B4 si existe). Nada toca produccion.
B=/usr/lib/postgresql/16/bin; SP="$(cd "$(dirname "$0")" && pwd)"
if [ ! -d /var/tmp/pgproof/d ]; then
  mkdir -p /var/tmp/pgproof && chown postgres /var/tmp/pgproof
  cat > /var/tmp/pgproof/q.sh <<'EOQ'
#!/bin/bash
exec /usr/lib/postgresql/16/bin/psql -h /var/tmp/pgproof -p 54329 -U postgres -X -q -At -v ON_ERROR_STOP=0 "${1:-postgres}"
EOQ
  chmod +x /var/tmp/pgproof/q.sh
  su postgres -c "$B/initdb -D /var/tmp/pgproof/d -A trust >/dev/null && $B/pg_ctl -D /var/tmp/pgproof/d -o '-p 54329 -c unix_socket_directories=/var/tmp/pgproof -c listen_addresses=' -l /var/tmp/pgproof/log -w start >/dev/null"
fi
bash "$SP/reset_local.sh" >/dev/null 2>&1
[ -f "$SP/B4_recepcion.sql" ] && su postgres -c "/var/tmp/pgproof/q.sh t" < "$SP/B4_recepcion.sql" >/dev/null
echo "pg listo: $(echo 'select count(*) from pago_gestiones' | su postgres -c '/var/tmp/pgproof/q.sh t') gestiones historicas"
