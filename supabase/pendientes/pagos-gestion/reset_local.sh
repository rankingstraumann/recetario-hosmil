#!/bin/bash
SP="$(cd "$(dirname "$0")" && pwd)"
BIN=/usr/lib/postgresql/16/bin
Q(){ su postgres -c "/var/tmp/pgproof/q.sh t"; }
su postgres -c "$BIN/dropdb -h /var/tmp/pgproof -p 54329 --if-exists t; $BIN/createdb -h /var/tmp/pgproof -p 54329 t"
Q < $SP/00_stub_local.sql >/dev/null 2>&1; Q < $SP/seed.sql
for f in B1_estructuras B2_trigger B3_confirmaciones; do Q < $SP/$f.sql >/dev/null || echo "ERROR en $f"; done
