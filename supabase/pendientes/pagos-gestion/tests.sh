#!/bin/bash
# Pruebas locales Fase B. Uso: bash tests.sh   (corre como root; ejecuta psql como postgres)
Q(){ su postgres -c "/var/tmp/pgproof/q.sh t"; }
PASS=0; FAIL=0
chk(){ # nombre esperado real
  if [ "$2" == "$3" ]; then PASS=$((PASS+1)); printf "PASS | %-62s | %s\n" "$1" "$3"; else FAIL=$((FAIL+1)); printf "FAIL | %-62s | esperado=%s real=%s\n" "$1" "$2" "$3"; fi; }
S(){ echo "$1" | Q 2>&1 | tail -1; }
ADM="11111111-1111-1111-1111-111111111111"
SP_DIR="$(cd "$(dirname "$0")" && pwd)"
cat <<'SQL' | Q >/dev/null
CREATE OR REPLACE FUNCTION public.actualizar_estado_cotizacion(p_id uuid, p_estado text, p_historial jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth'; END IF; UPDATE public.cotizaciones SET estado=p_estado, historial=p_historial WHERE id=p_id; END $f$;
INSERT INTO cotizaciones(id,numero,institucion_codigo,estado,total,token) VALUES
 ('00000000-0000-0000-0000-000000000009','P6','UNAB','Enviada al paciente',100000,'tokP6'),
 ('00000000-0000-0000-0000-00000000000a','P7','UMAYOR','Enviada al paciente',100000,'tokP7'),
 ('00000000-0000-0000-0000-00000000000b','P8','UDP','Enviada al paciente',100000,'tokP8');
SQL
pay(){ echo "SET ROLE anon; SELECT registrar_pago_publico('$1','r/$1-$2.pdf',$3,'h$2');" | Q 2>&1 | tail -1; }
G(){ S "SELECT $2 FROM pago_gestiones g JOIN cotizaciones c ON c.id=g.cotizacion_id WHERE c.numero='$1'"; }

echo "--- T1 flujo normal (anon paga el total)"
R=$(pay tokP1 a 100000); chk "T1 RPC paciente responde estado" "Pago informado" "$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["estado"])')"
chk "T1 pago registrado" "1" "$(S "select count(*) from cotizacion_pagos where comprobante_path='r/tokP1-a.pdf'")"
chk "T1 gestión creada pendiente/paciente" "pendiente|paciente" "$(G P1 "estado_envio||'|'||origen")"
echo "--- T2 UC sin regla"
pay tokP2 a 100000 >/dev/null
chk "T2 UC bloqueada" "bloqueado_sin_regla" "$(G P2 estado_envio)"
chk "T2 evento sin_regla registrado" "1" "$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero='P2' and e.tipo='sin_regla'")"
chk "T2 el pago del paciente se registró igual" "Pago informado" "$(S "select estado from cotizaciones where numero='P2'")"
echo "--- T3 parcial → completo"
pay tokP3 a 30000 >/dev/null
chk "T3a parcial: sin gestión" "0" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='P3'")"
chk "T3a estado Pagado parcialmente" "Pagado parcialmente" "$(S "select estado from cotizaciones where numero='P3'")"
pay tokP3 b 70000 >/dev/null
chk "T3b al cubrir total: 1 gestión, cubre=true" "1|true" "$(S "select count(*)||'|'||min(g.cobertura->>'cubre') from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='P3'")"
echo "--- T4 comprobante adicional NO genera otro correo"
pay tokP1 b 5000 >/dev/null
chk "T4 sigue 1 sola gestión para P1" "1" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='P1'")"
chk "T4 evento actividad_posterior para revisión" "1" "$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero='P1' and e.tipo='actividad_posterior'")"
chk "T4 pago adicional sí quedó registrado" "2" "$(S "select count(*) from cotizacion_pagos p join cotizaciones c on c.id=p.cotizacion_id where c.numero='P1'")"
echo "--- T5 Admin manual"
echo "SET request.jwt.claim.sub='$ADM'; SET ROLE authenticated; SELECT actualizar_estado_cotizacion('00000000-0000-0000-0000-000000000007','Pago informado','[]'::jsonb);" | Q >/dev/null 2>&1
chk "T5 admin dispara gestión (origen admin)" "pendiente|admin" "$(G P4 "estado_envio||'|'||origen")"
echo "SET request.jwt.claim.sub='$ADM'; SET ROLE authenticated; SELECT actualizar_estado_cotizacion('00000000-0000-0000-0000-000000000007','Pagado parcialmente','[1]'::jsonb); SELECT actualizar_estado_cotizacion('00000000-0000-0000-0000-000000000007','Pago informado','[1,2]'::jsonb);" | Q >/dev/null 2>&1
chk "T5 reingreso a Pago informado: sigue 1 gestión" "1" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='P4'")"
chk "T5 reingreso queda como evento de revisión" "1" "$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero='P4' and e.tipo='actividad_posterior'")"
echo "--- T6 histórico no envía"
echo "SET request.jwt.claim.sub='$ADM'; SET ROLE authenticated; SELECT actualizar_estado_cotizacion('00000000-0000-0000-0000-000000000001','Pago informado','[]'::jsonb);" | Q >/dev/null 2>&1
chk "T6 histórico sigue omitido (sin pendiente nuevo)" "omitido_historico" "$(G H1 estado_envio)"
chk "T6 histórico no genera eventos" "0" "$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero='H1'")"

echo "--- T7 AISLAMIENTO: la automatización falla y el pago del paciente NO"
BEFORE_P=$(S "select count(*) from cotizacion_pagos")
OUT=$(cat <<SQL | Q 2>&1 | tail -3 | tr '\n' ' '
BEGIN;
ALTER TABLE pago_gestiones RENAME TO x_gest; ALTER TABLE pago_gestion_eventos RENAME TO x_ev;   -- las DOS tablas desaparecen
SET ROLE anon; SELECT registrar_pago_publico('tokP6','r/p6.pdf',100000,'h6');
RESET ROLE;
SELECT (select count(*) from cotizacion_pagos where comprobante_path='r/p6.pdf') || '|' || (select estado from cotizaciones where numero='P6');
ROLLBACK;
SQL
)
chk "T7a tablas inexistentes: pago registrado + estado correcto" "1|Pago informado" "$(echo "$OUT" | grep -o '1|Pago informado')"
OUT=$(cat <<SQL | Q 2>&1 | tail -3 | tr '\n' ' '
BEGIN;
ALTER TABLE pago_gestiones ADD CONSTRAINT boom CHECK (false) NOT VALID;                           -- todo INSERT en la cola falla
SET ROLE anon; SELECT registrar_pago_publico('tokP7','r/p7.pdf',100000,'h7');
RESET ROLE;
SELECT (select count(*) from cotizacion_pagos where comprobante_path='r/p7.pdf') || '|' || (select estado from cotizaciones where numero='P7') || '|err=' || (select count(*) from pago_gestion_eventos where tipo='error_tecnico');
ROLLBACK;
SQL
)
chk "T7b INSERT en cola falla: pago OK y error registrado" "1|Pago informado|err=1" "$(echo "$OUT" | grep -o '1|Pago informado|err=[0-9]')"
OUT=$(cat <<SQL | Q 2>&1 | tail -3 | tr '\n' ' '
BEGIN;
CREATE OR REPLACE FUNCTION public.pago_gestion_crear(p_cotizacion_id uuid, p_origen text DEFAULT 'sistema') RETURNS uuid LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM 1/0; RETURN NULL; END \$f\$;   -- lógica interna explota
SET ROLE anon; SELECT registrar_pago_publico('tokP8','r/p8.pdf',100000,'h8');
RESET ROLE;
SELECT (select count(*) from cotizacion_pagos where comprobante_path='r/p8.pdf') || '|' || (select estado from cotizaciones where numero='P8');
ROLLBACK;
SQL
)
chk "T7c división por cero en la lógica: pago OK" "1|Pago informado" "$(echo "$OUT" | grep -o '1|Pago informado')"
# T7d: bloqueo de tabla (lock_timeout) — sesión A retiene ACCESS EXCLUSIVE 3 s; el paciente no debe esperar ni fallar
( echo "BEGIN; LOCK TABLE pago_gestiones IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); ROLLBACK;" | Q >/dev/null 2>&1 & )
sleep 0.6
T0=$(date +%s%N)
R=$(echo "SET ROLE anon; SELECT registrar_pago_publico('tokP6','r/p6-lock.pdf',100000,'h6l');" | Q 2>&1 | tail -1)
T1=$(date +%s%N); MS=$(( (T1-T0)/1000000 ))
chk "T7d tabla bloqueada: RPC responde (sin error)" "Pago informado" "$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["estado"])' 2>/dev/null)"
chk "T7d demora añadida < 1500 ms (lock_timeout 250 ms)" "ok" "$([ $MS -lt 1500 ] && echo ok || echo "lento:${MS}ms")"
echo "      (demora medida: ${MS} ms)"; sleep 3
echo "update pago_gestion_config set valor='false' where clave='encolado_activo'" | Q >/dev/null
echo "SET ROLE anon; SELECT registrar_pago_publico('tokP7','r/p7-off.pdf',100000,'h7o');" | Q >/dev/null 2>&1
chk "T7e interruptor encolado_activo=false: sin gestión" "0" "$(G P7 "count(*)")"
chk "T7e interruptor: pago del paciente intacto" "Pago informado" "$(S "select estado from cotizaciones where numero='P7'")"
echo "update pago_gestion_config set valor='true' where clave='encolado_activo'" | Q >/dev/null
chk "T7f P6 (falla por bloqueo): SIN gestión y con error_tecnico" "0|1" "$(G P6 "count(*)")|$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero='P6' and e.tipo='error_tecnico'")"
chk "T7f reconciliar() recupera las 2 omitidas (P6 falla, P7 interruptor)" "2" "$(S "select pago_gestion_reconciliar()")"
chk "T7f reconciliar() es idempotente (2a corrida = 0)" "0" "$(S "select pago_gestion_reconciliar()")"

echo "--- T8 reclamo / envío / reintentos"
echo "update pago_gestion_config set valor='true' where clave='envio_activo'" | Q >/dev/null
echo "update pago_gestiones set estado_envio='enviando' where estado_envio='pendiente'; update pago_gestiones set estado_envio='pendiente' where id=(select g.id from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='P1')" | Q >/dev/null
( echo "BEGIN; SELECT count(*) FROM pago_gestion_reclamar(5); SELECT pg_sleep(2); COMMIT;" | Q >/tmp/claude-0/a.out 2>&1 & )
sleep 0.7
chk "T8a reclamo concurrente: la 2ª sesión no obtiene la misma" "0" "$(S "SELECT count(*) FROM pago_gestion_reclamar(5)")"
sleep 2.2
chk "T8a la 1ª sesión sí la reclamó" "1" "$(tail -3 /tmp/claude-0/a.out | head -1)"
GID=$(G P1 "g.id")
chk "T8b finalizar OK → aceptado" "aceptado" "$(S "select pago_gestion_finalizar_envio('$GID',true,'re_123','asunto',array['a@x.cl'],array['b@x.cl'],null)" >/dev/null; G P1 estado_envio)"
chk "T8b aceptado ≠ entregado (entrega_estado nulo)" "" "$(G P1 "coalesce(entrega_estado,'')")"
echo "update pago_gestiones set estado_envio='enviando', reclamado_hasta=now()-interval '1 minute' where id='$GID'" | Q >/dev/null
chk "T8c envío sin cierre → incierto" "1" "$(S "select pago_gestion_marcar_inciertas()")"
chk "T8c incierto NO se reclama de nuevo" "0" "$(S "SELECT count(*) FROM pago_gestion_reclamar(5) where gestion_id='$GID'")"
echo "update pago_gestiones set estado_envio='aceptado' where id='$GID'" | Q >/dev/null
echo "update pago_gestion_config set valor='false' where clave='envio_activo'" | Q >/dev/null
echo "update pago_gestiones set estado_envio='pendiente' where id='$GID'" | Q >/dev/null
chk "T8d envio_activo=false: nada se reclama" "0" "$(S "SELECT count(*) FROM pago_gestion_reclamar(5)")"
echo "update pago_gestiones set estado_envio='aceptado' where id='$GID'" | Q >/dev/null

echo "--- T9 destinatarios — MODO PRUEBA (por defecto)"
chk "T9 modo por defecto = prueba" "prueba" "$(S "select valor from pago_gestion_config where clave='modo'")"
chk "T9 prueba UDP: TO solo Daniel, CC vacío, es_prueba" "{daniel.jordan@straumann.com}|0|true|true" "$(S "select to_emails::text||'|'||cardinality(cc_emails)||'|'||tiene_regla||'|'||es_prueba from pago_gestion_destinatarios_de('UDP')")"
chk "T9 prueba HOSMIL/PDI/ARMADA: igual, sin ejecutivos" "3" "$(S "select count(*) from (values ('HOSMIL'),('PDI'),('ARMADA')) v(c), pago_gestion_destinatarios_de(v.c) d where d.to_emails='{daniel.jordan@straumann.com}' and cardinality(d.cc_emails)=0")"
chk "T9 prueba UC: sigue bloqueada (sin regla)" "f" "$(S "select tiene_regla from pago_gestion_destinatarios_de('UC')")"
echo "--- T9b GUARDIA de envío (lo que el emisor debe validar antes de Resend)"
G_(){ S "select pago_gestion_validar_envio('UDP', $1, $2, $3)"; }
chk "G1 prueba: solo Daniel => permitido" "t" "$(G_ "array['daniel.jordan@straumann.com']" "'{}'::text[]" "'{}'::text[]")"
chk "G2 prueba: + Customer Service => BLOQUEADO" "f" "$(G_ "array['daniel.jordan@straumann.com','m.cl.customerservicechile@straumann.com']" "'{}'::text[]" "'{}'::text[]")"
chk "G3 prueba: Daniel + CC ejecutiva => BLOQUEADO" "f" "$(G_ "array['daniel.jordan@straumann.com']" "array['isleinny.rojas@straumann.com']" "'{}'::text[]")"
chk "G4 prueba: BCC de cualquier tipo => BLOQUEADO" "f" "$(G_ "array['daniel.jordan@straumann.com']" "'{}'::text[]" "array['daniel.jordan@straumann.com']")"
chk "G5 prueba: destinatarios reales (Finanzas) => BLOQUEADO" "f" "$(G_ "array['cobranza.cl@straumann.com','m.cl.customerservicechile@straumann.com']" "array['daniel.jordan@straumann.com','isleinny.rojas@straumann.com']" "'{}'::text[]")"
chk "G6 mayúsculas en Daniel => permitido (normaliza)" "t" "$(G_ "array['Daniel.Jordan@Straumann.com']" "'{}'::text[]" "'{}'::text[]")"
echo "--- T9c FAIL-CLOSED del modo"
for V in "Real" "REAL" "real " "" "prod" "test"; do
  echo "update pago_gestion_config set valor='$V' where clave='modo'" | Q >/dev/null
  chk "F modo='$V' => sigue siendo PRUEBA (solo Daniel)" "{daniel.jordan@straumann.com}|0" "$(S "select to_emails::text||'|'||cardinality(cc_emails) from pago_gestion_destinatarios_de('UDP')")"
done
echo "delete from pago_gestion_config where clave='modo'" | Q >/dev/null
chk "F fila 'modo' AUSENTE => PRUEBA" "{daniel.jordan@straumann.com}|0" "$(S "select to_emails::text||'|'||cardinality(cc_emails) from pago_gestion_destinatarios_de('UDP')")"
echo "insert into pago_gestion_config(clave,valor) values ('modo','prueba')" | Q >/dev/null
echo "update pago_gestion_config set valor='cobranza.cl@straumann.com' where clave='destinatario_prueba'" | Q >/dev/null
chk "F destinatario_prueba = Finanzas (no es CC fijo interno) => NADIE" "0|0" "$(S "select cardinality(to_emails)||'|'||cardinality(cc_emails) from pago_gestion_destinatarios_de('UDP')")"
echo "update pago_gestion_config set valor='otro@gmail.com' where clave='destinatario_prueba'" | Q >/dev/null
chk "F destinatario_prueba externo => NADIE" "0" "$(S "select cardinality(to_emails) from pago_gestion_destinatarios_de('UDP')")"
echo "delete from pago_gestion_config where clave='destinatario_prueba'" | Q >/dev/null
chk "F destinatario_prueba ausente => NADIE" "0" "$(S "select cardinality(to_emails) from pago_gestion_destinatarios_de('UDP')")"
echo "insert into pago_gestion_config(clave,valor) values ('destinatario_prueba','daniel.jordan@straumann.com')" | Q >/dev/null
echo "--- T9d MODO REAL (solo en esta prueba local)"
echo "update pago_gestion_config set valor='real' where clave='modo'" | Q >/dev/null
chk "R UDP: TO 2 / CC daniel+isleinny" "2|{daniel.jordan@straumann.com,isleinny.rojas@straumann.com}|true|false" "$(S "select cardinality(to_emails)||'|'||cc_emails::text||'|'||tiene_regla||'|'||es_prueba from pago_gestion_destinatarios_de('UDP')")"
chk "R UC: sin regla => sin destinatarios" "0|0|false" "$(S "select cardinality(to_emails)||'|'||cardinality(cc_emails)||'|'||tiene_regla from pago_gestion_destinatarios_de('UC')")"
chk "R PDI: CC neodent" "{daniel.jordan@straumann.com,gerardo.salgado@neodent.com}" "$(S "select cc_emails::text from pago_gestion_destinatarios_de('PDI')")"
chk "R guardia: lista real exacta => permitido" "t" "$(G_ "array['cobranza.cl@straumann.com','m.cl.customerservicechile@straumann.com']" "array['daniel.jordan@straumann.com','isleinny.rojas@straumann.com']" "'{}'::text[]")"
chk "R guardia: CC de OTRA institución => BLOQUEADO" "f" "$(G_ "array['cobranza.cl@straumann.com','m.cl.customerservicechile@straumann.com']" "array['daniel.jordan@straumann.com','gloria.trejos@straumann.com']" "'{}'::text[]")"
chk "R guardia: falta Finanzas => BLOQUEADO" "f" "$(G_ "array['m.cl.customerservicechile@straumann.com']" "array['daniel.jordan@straumann.com','isleinny.rojas@straumann.com']" "'{}'::text[]")"
chk "R guardia: UC (sin regla) => BLOQUEADO" "f" "$(S "select pago_gestion_validar_envio('UC', array['cobranza.cl@straumann.com','m.cl.customerservicechile@straumann.com'], array['daniel.jordan@straumann.com'], '{}'::text[])")"
chk "R liberar bloqueadas (UC sigue sin regla)" "0" "$(S "select pago_gestion_liberar_bloqueadas()")"
echo "insert into pago_gestion_destinatarios(tipo,institucion_codigo,email) values ('cc_institucion','UC','ejecutivo.uc@straumann.com')" | Q >/dev/null
chk "R al asignar ejecutivo a UC se libera 1" "1" "$(S "select pago_gestion_liberar_bloqueadas()")"
echo "delete from pago_gestion_destinatarios where institucion_codigo='UC'; update pago_gestiones set estado_envio='bloqueado_sin_regla' where institucion_codigo='UC'; update pago_gestion_config set valor='prueba' where clave='modo'" | Q >/dev/null
chk "modo vuelve a prueba" "prueba" "$(S "select valor from pago_gestion_config where clave='modo'")"

echo "update pago_gestion_config set valor='true' where clave='confirmaciones_activo'" | Q >/dev/null
echo "--- T10 confirmaciones (B3)"
# Ensayo "etapa 2": modo=prueba, y las cotizaciones usadas estan en la lista EXPLICITA de prueba (si no, la proteccion las bloquearia: ver T17)
echo "insert into pago_gestion_cotizaciones_prueba(cotizacion_id, nota) select id, 'tests.sh' from cotizaciones where numero in ('P1','P2','P3','P4')" | Q >/dev/null
G1=$(G P1 "g.id"); C1=$(S "select id from cotizaciones where numero='P1'")
chk "T10a Finanzas primero → Pago validado" "pago_validado" "$(S "select pago_gestion_registrar_confirmacion('$G1','finanzas','in:f1','', 'cobranza.cl@straumann.com',true)")"
chk "T10a estado = Pago validado" "Pago validado" "$(S "select estado from cotizaciones where id='$C1'")"
chk "T10b SAP mal formado → a revisión, sin registrar" "sap_a_revision" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','in:s0','123','m.cl.customerservicechile@straumann.com',true)")"
chk "T10b estado NO cambia con SAP ambiguo" "Pago validado" "$(S "select estado from cotizaciones where id='$C1'")"
chk "T10c SAP válido + finanzas ya presente → Pedido ingresado" "pedido_ingresado" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','in:s1','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "T10c estado final" "Pedido ingresado al sistema" "$(S "select estado from cotizaciones where id='$C1'")"
chk "T10d mismo mensaje reprocesado → duplicado" "duplicado" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','in:s1','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "T10e SAP distinto después → discrepancia" "discrepancia_sap" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','in:s2','9999999999','m.cl.customerservicechile@straumann.com',true)")"
chk "T10e el SAP original NO se reemplaza" "1234567890" "$(S "select sap_numero from pago_gestiones where id='$G1'")"
G4=$(G P4 "g.id"); C4=$(S "select id from cotizaciones where numero='P4'")
chk "T10f SAP primero → registrado, estado intacto" "registrado|Pago informado|5555555555" "$(S "select pago_gestion_registrar_confirmacion('$G4','sap','in:s4','5555555555','m.cl.customerservicechile@straumann.com',true)")|$(S "select estado from cotizaciones where id='$C4'")|$(S "select sap_numero from pago_gestiones where id='$G4'")"
chk "T10f luego Finanzas → Pedido ingresado" "pedido_ingresado" "$(S "select pago_gestion_registrar_confirmacion('$G4','finanzas','in:f4','', 'cobranza.cl@straumann.com',true)")"
chk "T10g historial conserva ambas entradas" "t" "$(S "select (jsonb_array_length(historial) >= 2) from cotizaciones where id='$C4'")"
G2=$(G P2 "g.id"); C2=$(S "select id from cotizaciones where numero='P2'")
echo "update cotizaciones set estado='Anulado' where id='$C2'" | Q >/dev/null
S "select pago_gestion_registrar_confirmacion('$G2','sap','in:s5','7777777777','m.cl.customerservicechile@straumann.com',true)" >/dev/null
chk "T10h cotización Anulada: no avanza, queda evento" "estado_no_aplicable|Anulado" "$(S "select pago_gestion_registrar_confirmacion('$G2','finanzas','in:f5','', 'cobranza.cl@straumann.com',true)")|$(S "select estado from cotizaciones where id='$C2'")"
chk "T10i histórico: confirmación ignorada" "ignorado_historico" "$(S "select pago_gestion_registrar_confirmacion('$(G H1 "g.id")','sap','in:h','1234567890','x',true)")"
chk "T10j entrega Resend → entregado (distinto de aceptado)" "t|entregado" "$(S "select pago_gestion_registrar_entrega('re_123','entregado','evt:1','{}'::jsonb)")|$(G P1 entrega_estado)"
chk "T10j evento de entrega duplicado → false" "f" "$(S "select pago_gestion_registrar_entrega('re_123','entregado','evt:1','{}'::jsonb)")"

echo "--- T14 IDENTIDAD Y AUTORIZACIÓN DEL REMITENTE (B3)"
GA=$(G P3 "g.id"); CA=$(S "select id from cotizaciones where numero='P3'")
R14(){ S "select pago_gestion_registrar_confirmacion('$GA','$1','$2','$3','$4',$5)"; }
chk "A1 remitente desconocido (SAP) => no_autorizado" "no_autorizado" "$(R14 sap a1 1234567890 'intruso@gmail.com' true)"
chk "A2 remitente desconocido (Finanzas) => no_autorizado" "no_autorizado" "$(R14 finanzas a2 '' 'intruso@gmail.com' true)"
chk "A3 CS intentando validar pago financiero => no_autorizado" "no_autorizado" "$(R14 finanzas a3 '' 'm.cl.customerservicechile@straumann.com' true)"
chk "A4 Finanzas intentando informar SAP => no_autorizado" "no_autorizado" "$(R14 sap a4 1234567890 'cobranza.cl@straumann.com' true)"
chk "A5 autenticación fallida (SPF/DKIM) => no_autorizado" "no_autorizado" "$(R14 sap a5 1234567890 'm.cl.customerservicechile@straumann.com' false)"
chk "A6 auth desconocida (NULL) => no_autorizado" "no_autorizado" "$(R14 sap a6 1234567890 'm.cl.customerservicechile@straumann.com' null)"
chk "A7 nombre visible falso 'Cobranza <evil@x.cl>' => no_autorizado" "no_autorizado" "$(R14 finanzas a7 '' 'Cobranza <cobranza.cl@straumann.com>' true)"
chk "A8 dominio parecido (straumann.com.evil.cl) => no_autorizado" "no_autorizado" "$(R14 finanzas a8 '' 'cobranza.cl@straumann.com.evil.cl' true)"
chk "A9 remitente inactivo => no_autorizado" "no_autorizado" "$(S "update pago_remitentes_autorizados set activo=false where email='cobranza.cl@straumann.com'" >/dev/null; R14 finanzas a9 '' 'cobranza.cl@straumann.com' true)"
echo "update pago_remitentes_autorizados set activo=true where email='cobranza.cl@straumann.com'" | Q >/dev/null
chk "A10 NADA se registró: sin SAP, sin validación, estado intacto" "||Pago informado" "$(S "select coalesce(sap_numero,'')||'|'||coalesce(fin_confirmado_en::text,'')||'|'||(select estado from cotizaciones where id='$CA') from pago_gestiones where id='$GA'")"
chk "A11 los 9 intentos quedaron en revisión manual" "9" "$(S "select count(*) from pago_gestion_eventos where gestion_id='$GA' and tipo='respuesta_no_autorizada'")"
chk "A12 remitente autorizado en MAYÚSCULAS (normaliza) => registra" "registrado" "$(R14 sap a12 1234567890 'M.CL.CustomerServiceChile@Straumann.com' true)"
echo "update pago_remitentes_autorizados set activo=false where email='cobranza.cl@straumann.com'" | Q >/dev/null
echo "insert into pago_remitentes_autorizados(email,rol,tipo) values ('persona.finanzas@straumann.com','finanzas','individual')" | Q >/dev/null
chk "A13 individual autorizado EXPLÍCITAMENTE (Finanzas) => válido y completa" "pedido_ingresado" "$(R14 finanzas a13 '' 'persona.finanzas@straumann.com' true)"
echo "update pago_remitentes_autorizados set activo=true where email='cobranza.cl@straumann.com'; delete from pago_remitentes_autorizados where email='persona.finanzas@straumann.com'" | Q >/dev/null
echo "update pago_gestion_config set valor='false' where clave='confirmaciones_activo'" | Q >/dev/null
chk "A14 confirmaciones_activo=false => desactivado (no escribe)" "desactivado" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','zz','1234567890','m.cl.customerservicechile@straumann.com',true)")"
echo "update pago_gestion_config set valor='true' where clave='confirmaciones_activo'" | Q >/dev/null

echo "--- T11 privilegios"
deny(){ echo "$2" | Q 2>&1 | grep -c "permission denied" ; }
chk "T11 anon NO lee pago_gestiones" "1" "$(deny x "SET ROLE anon; SELECT * FROM pago_gestiones;")"
chk "T11 anon NO lee eventos" "1" "$(deny x "SET ROLE anon; SELECT * FROM pago_gestion_eventos;")"
chk "T11 anon NO lee destinatarios/config/remitentes" "3" "$(( $(deny x "SET ROLE anon; SELECT * FROM pago_gestion_destinatarios;") + $(deny x "SET ROLE anon; SELECT * FROM pago_gestion_config;") + $(deny x "SET ROLE anon; SELECT * FROM pago_remitentes_autorizados;") ))"
chk "T11 anon NO ejecuta funciones internas" "3" "$(( $(deny x "SET ROLE anon; SELECT pago_gestion_crear(gen_random_uuid());") + $(deny x "SET ROLE anon; SELECT * FROM pago_gestion_reclamar(1);") + $(deny x "SET ROLE anon; SELECT pago_gestion_registrar_confirmacion(gen_random_uuid(),'sap','z','1234567890','x',true);") ))"
chk "T11 authenticated NO ejecuta funciones internas" "2" "$(( $(deny x "SET ROLE authenticated; SELECT * FROM pago_gestion_reclamar(1);") + $(deny x "SET ROLE authenticated; SELECT pago_gestion_registrar_confirmacion(gen_random_uuid(),'sap','z','1234567890','x',true);") ))"
chk "T11 authenticated NO puede escribir" "1" "$(deny x "SET ROLE authenticated; UPDATE pago_gestiones SET sap_numero='1';")"
chk "T11 authenticated NO ve reply_token ni resend_id" "1" "$(deny x "SET ROLE authenticated; SELECT reply_token FROM pago_gestiones;")"
chk "T11 authenticated NO lee la tabla (ni siquiera sap_numero)" "2" "$(( $(deny x "SET ROLE authenticated; SELECT sap_numero FROM pago_gestiones;") + $(deny x "SET ROLE authenticated; SELECT count(*) FROM pago_gestiones;") ))"
echo "--- T11b lectura SAP segura (pago_sap_visibles)"
OBS="22222222-2222-2222-2222-222222222222"; UDPU="33333333-3333-3333-3333-333333333333"; NADA="44444444-4444-4444-4444-444444444444"
echo "INSERT INTO admin_perfiles(user_id,es_super_admin) VALUES ('$ADM',true); INSERT INTO admin_perfiles(user_id,es_observador) VALUES ('$OBS',true); INSERT INTO admin_perfiles(user_id) VALUES ('$UDPU'),('$NADA'); INSERT INTO admin_instituciones_permitidas VALUES ('$UDPU','UDP');
UPDATE pago_gestiones SET sap_numero='7000000001' WHERE id=(SELECT g.id FROM pago_gestiones g JOIN cotizaciones c ON c.id=g.cotizacion_id WHERE c.institucion_codigo='UDP' AND g.sap_numero IS NULL LIMIT 1);
UPDATE pago_gestiones SET sap_numero='7000000002' WHERE id=(SELECT g.id FROM pago_gestiones g JOIN cotizaciones c ON c.id=g.cotizacion_id WHERE c.institucion_codigo='HOSMIL' AND g.sap_numero IS NULL LIMIT 1);" | Q >/dev/null
TOT=$(S "select count(*) from pago_gestiones where sap_numero is not null"); UDPN=$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where g.sap_numero is not null and c.institucion_codigo='UDP'")
V(){ S "SET request.jwt.claim.sub='$1'; SET ROLE authenticated; SELECT count(*) FROM pago_sap_visibles()"; }
chk "T11b datos de prueba: hay SAP de varias instituciones" "t" "$(S "select $TOT > $UDPN and $UDPN >= 1")"
chk "T11b super admin ve todos los SAP" "$TOT" "$(V $ADM)"
chk "T11b observador ve todos los SAP" "$TOT" "$(V $OBS)"
chk "T11b usuario con permiso solo UDP ve solo los de UDP" "$UDPN" "$(V $UDPU)"
chk "T11b autenticado sin perfil ni instituciones ve 0" "0" "$(V $NADA)"
chk "T11b authenticated SIN sesion (sin uid) ve 0" "0" "$(S "SET ROLE authenticated; SELECT count(*) FROM pago_sap_visibles()")"
chk "T11b anon NO ejecuta la funcion" "1" "$(deny x "SET ROLE anon; SELECT * FROM pago_sap_visibles();")"
chk "T11b solo devuelve cotizacion_id y sap_numero" "cotizacion_id,sap_numero" "$(S "select string_agg(a.attname, ',' order by a.attnum) from pg_proc p, unnest(p.proargnames) with ordinality n(attname, i), pg_attribute a where false union all select string_agg(x,',' order by o) from (select unnest(proargnames) x, generate_subscripts(proargnames,1) o from pg_proc where proname='pago_sap_visibles') z" | tail -1)"
chk "T11b los SAP devueltos son exactamente los de las cotizaciones visibles" "$(S "select string_agg(g.sap_numero,',' order by g.sap_numero) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where g.sap_numero is not null and c.institucion_codigo='UDP'")" "$(S "SET request.jwt.claim.sub='$UDPU'; SET ROLE authenticated; SELECT string_agg(sap_numero,',' ORDER BY sap_numero) FROM pago_sap_visibles()")"
chk "T11 authenticated SIN sesión no ve filas de la tabla" "1" "$(deny x "SET ROLE authenticated; SELECT count(*) FROM pago_gestiones")"
chk "T11 service_role sí ejecuta" "t" "$(S "SET ROLE service_role; SELECT count(*)>=0 FROM pago_gestion_reclamar(1)")"
echo "--- T12 cotizaciones no cambió de forma"
chk "T12 sin columnas nuevas en cotizaciones (SAP no se filtra por row_to_json)" "0" "$(S "select count(*) from information_schema.columns where table_name='cotizaciones' and column_name ~ 'sap|gestion'")"
echo "--- T15 ROLLBACK OPERATIVO (apaga sin borrar)"
echo "update pago_gestion_config set valor='true' where clave in ('encolado_activo','envio_activo','confirmaciones_activo')" | Q >/dev/null
N_G=$(S "select count(*) from pago_gestiones"); N_E=$(S "select count(*) from pago_gestion_eventos"); SAPS=$(S "select md5(string_agg(coalesce(sap_numero,'-')||coalesce(fin_confirmado_en::text,'-'),',' order by id)) from pago_gestiones")
su postgres -c "/var/tmp/pgproof/q.sh t" < ${SP_DIR}/OPERATIVO_OFF.sql >/dev/null 2>&1
chk "O1 interruptores apagados y modo=prueba" "false|false|false|prueba" "$(S "select (select valor from pago_gestion_config where clave='encolado_activo')||'|'||(select valor from pago_gestion_config where clave='envio_activo')||'|'||(select valor from pago_gestion_config where clave='confirmaciones_activo')||'|'||(select valor from pago_gestion_config where clave='modo')")"
echo "insert into cotizaciones(id,numero,institucion_codigo,estado,total,token) values ('00000000-0000-0000-0000-0000000000f1','F1','HOSMIL','Enviada al paciente',100000,'tokF1')" | Q >/dev/null
echo "SET ROLE anon; SELECT registrar_pago_publico('tokF1','r/f1.pdf',100000,'hf1');" | Q >/dev/null 2>&1
chk "O2 pago nuevo con automatización OFF: pago OK, SIN gestión" "Pago informado|0" "$(S "select estado from cotizaciones where numero='F1'")|$(G F1 'count(*)')"
echo "update pago_gestiones set estado_envio='pendiente' where cotizacion_id=(select id from cotizaciones where numero='P4')" | Q >/dev/null
chk "O3 OFF: nada se reclama" "0" "$(S "select count(*) from pago_gestion_reclamar(5)")"
chk "O4 OFF: respuestas no se aplican" "desactivado" "$(S "select pago_gestion_registrar_confirmacion('$G1','sap','oo','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "O5 DATOS CONSERVADOS: gestiones/eventos/SAP/validaciones intactos" "$N_G|$N_E|$SAPS" "$(S "select count(*) from pago_gestiones")|$(S "select count(*) from pago_gestion_eventos")|$(S "select md5(string_agg(coalesce(sap_numero,'-')||coalesce(fin_confirmado_en::text,'-'),',' order by id)) from pago_gestiones")"
echo "update pago_gestion_config set valor='true' where clave='encolado_activo'" | Q >/dev/null
chk "O6 reactivar es reversible (con un UPDATE)" "t" "$(S "select (select valor from pago_gestion_config where clave='encolado_activo')='true'")"
echo "update pago_gestion_config set valor='false' where clave='encolado_activo'" | Q >/dev/null

echo "--- T16 ELEGIBILIDAD: el proceso de envío NO puede reclamar anuladas / eliminadas / ya movidas / sin cobertura"
echo "update pago_gestion_config set valor='true' where clave in ('encolado_activo','envio_activo')" | Q >/dev/null
for i in 1 2 3 4 5 6 7 8 9; do echo "insert into cotizaciones(id,numero,institucion_codigo,estado,total,token) values ('00000000-0000-0000-0000-0000000001e$i','E$i','UDP','Enviada al paciente',100000,'tokE$i')" | Q >/dev/null; done
SE(){ S "select g.estado_envio||'|'||coalesce(g.ultimo_error,'') from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='$1'"; }
echo "SET ROLE anon; SELECT marcar_pago_informado_publico('tokE7');" | Q >/dev/null 2>&1       # "avisar" ANTES de subir comprobante => PI sin pagos
for i in 1 2 3 4 5 6 8 9; do pay tokE$i a 100000 >/dev/null; done
chk "E0 todas las gestiones se crearon (9) — el trigger no distingue elegibilidad" "9" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero like 'E%'")"
echo "update cotizaciones set deleted_at=now() where numero='E2'; update cotizaciones set estado='Anulado' where numero='E3'; update cotizaciones set estado='Pago validado' where numero='E4'; delete from cotizacion_pagos where cotizacion_id=(select id from cotizaciones where numero='E5'); update cotizaciones set estado='Pagado parcialmente' where numero='E6'" | Q >/dev/null
chk "E1m motivo: eliminada lógicamente" "eliminada_logicamente" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E2'")"
chk "E1m motivo: anulada" "anulada" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E3'")"
chk "E1m motivo: ya movida a mano (Pago validado)" "estado_actual:Pago validado" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E4'")"
chk "E1m motivo: pago acumulado ya no cubre el total" "pago_acumulado_no_cubre_total" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E5'")"
chk "E1m motivo: Pagado parcialmente" "estado_actual:Pagado parcialmente" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E6'")"
chk "E1m motivo: 'avisar' sin pagos registrados" "pago_acumulado_no_cubre_total" "$(S "select pago_gestion_motivo_no_elegible(id) from cotizaciones where numero='E7'")"
chk "E1m elegible: cotización sana" "" "$(S "select coalesce(pago_gestion_motivo_no_elegible(id),'') from cotizaciones where numero='E1'")"
CL=$(S "select string_agg(c.numero, ',' order by c.numero) from pago_gestion_reclamar(100) r join cotizaciones c on c.id=r.cotizacion_id where c.numero like 'E%'")
chk "E2 reclamar() SOLO toma las elegibles (E1,E8,E9)" "E1,E8,E9" "$CL"
chk "E2 las no elegibles siguen sin reclamar (E2..E7 no 'enviando')" "0" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero in ('E2','E3','E4','E5','E6','E7') and g.estado_envio='enviando'")"
S "select marcadas from pago_gestion_revisar_elegibilidad()" >/dev/null   # incluye P4 sobrante de pruebas previas (cotización ya avanzada): correcto
chk "E3 barrido marca no_elegible con motivo (E2..E7 = 6)" "6" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero in ('E2','E3','E4','E5','E6','E7') and g.estado_envio='no_elegible' and g.ultimo_error is not null")"
chk "E3 gestión sobrante cuya cotización ya avanzó (P4) también queda marcada" "no_elegible" "$(G P4 estado_envio)"
chk "E3 E4 queda visible para revisión: no_elegible|estado_actual:Pago validado" "no_elegible|estado_actual:Pago validado" "$(SE E4)"
chk "E3 evento de revisión creado por cada una" "6" "$(S "select count(*) from pago_gestion_eventos e join cotizaciones c on c.id=e.cotizacion_id where c.numero in ('E2','E3','E4','E5','E6','E7') and e.tipo='no_elegible'")"
chk "E3 barrido idempotente (2a corrida marca 0)" "0" "$(S "select marcadas from pago_gestion_revisar_elegibilidad()")"
chk "E3 no_elegible NO se reclama aunque envio_activo=true" "0" "$(S "select count(*) from pago_gestion_reclamar(100) r join cotizaciones c on c.id=r.cotizacion_id where c.numero in ('E2','E3','E4','E5','E6','E7')")"
# E7: el paciente completa el pago después => se reactiva
pay tokE7 a 100000 >/dev/null
chk "E4 E7 completa el pago: sigue 1 gestión" "1" "$(S "select count(*) from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='E7'")"
chk "E4 barrido REACTIVA lo que volvió a ser elegible (E7)" "1" "$(S "select reactivadas from pago_gestion_revisar_elegibilidad()")"
chk "E4 E7 vuelve a pendiente" "pendiente|" "$(SE E7)"
chk "E4 y ahora sí se reclama" "E7" "$(S "select string_agg(c.numero,',') from pago_gestion_reclamar(100) r join cotizaciones c on c.id=r.cotizacion_id where c.numero like 'E%'")"
# E9: reclamada y luego anulada justo antes de enviar => el emisor la suelta
echo "update cotizaciones set estado='Anulado' where numero='E9'" | Q >/dev/null
E9=$(S "select g.id from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='E9'")
chk "E5 pre-envío: el emisor detecta anulación tras reclamar" "anulada" "$(S "select pago_gestion_motivo_no_elegible(cotizacion_id) from pago_gestiones where id='$E9'")"
chk "E5 soltar() => no_elegible, nada se envía" "t|no_elegible|anulada" "$(S "select pago_gestion_soltar('$E9','anulada')")|$(SE E9 | sed 's/|$//')"
chk "E5 soltar() de nuevo => false (idempotente)" "f" "$(S "select pago_gestion_soltar('$E9','anulada')")"
chk "E5 no se reclama más" "0" "$(S "select count(*) from pago_gestion_reclamar(100) r where r.gestion_id='$E9'")"
# E8: ya ENVIADA (aceptada) y luego anulada => el barrido NO la toca (registro histórico intacto)
E8=$(S "select g.id from pago_gestiones g join cotizaciones c on c.id=g.cotizacion_id where c.numero='E8'")
S "select pago_gestion_finalizar_envio('$E8',true,'re_e8','a',array['d@x.cl'],'{}'::text[],null)" >/dev/null
echo "update cotizaciones set estado='Anulado' where numero='E8'" | Q >/dev/null
S "select marcadas from pago_gestion_revisar_elegibilidad()" >/dev/null
chk "E6 gestión ya aceptada no cambia aunque la cotización se anule" "aceptado|" "$(SE E8)"
echo "update pago_gestion_config set valor='false' where clave in ('encolado_activo','envio_activo')" | Q >/dev/null

echo "--- T17 FK ON DELETE RESTRICT (trazabilidad) y borrado lógico"
chk "F1 FK es RESTRICT (confdeltype='r')" "r" "$(S "select confdeltype from pg_constraint where conrelid='pago_gestiones'::regclass and contype='f'")"
chk "F2 DELETE físico de cotización CON gestión => bloqueado" "1" "$(echo "delete from cotizaciones where numero='E1';" | Q 2>&1 | grep -c 'violates foreign key')"
chk "F2 la gestión y la cotización siguen existiendo" "1|1" "$(S "select count(*) from cotizaciones where numero='E1'")|$(G E1 'count(*)')"
echo "insert into cotizaciones(id,numero,institucion_codigo,estado,total,token) values ('00000000-0000-0000-0000-0000000001f0','SINGEST','UDP','Borrador',1,'tokSG')" | Q >/dev/null
chk "F3 DELETE físico de cotización SIN gestión => permitido" "0" "$(echo "delete from cotizaciones where numero='SINGEST'; select count(*) from cotizaciones where numero='SINGEST';" | Q 2>&1 | tail -1)"
chk "F4 borrado LÓGICO (deleted_at) con gestión => permitido y conserva SAP" "1234567890" "$(S "update cotizaciones set deleted_at=now() where numero='P1'; select sap_numero from pago_gestiones where cotizacion_id=(select id from cotizaciones where numero='P1')" | tail -1)"
chk "F5 eventos sobreviven (sin FK): trazabilidad de SAP/Finanzas" "t" "$(S "select count(*)>0 from pago_gestion_eventos where tipo in ('respuesta_cs','respuesta_finanzas')")"

echo "--- T18 PROTECCION DEL MODO PRUEBA (cotizaciones reales intactas mientras modo<>real)"
echo "insert into cotizaciones(id,numero,institucion_codigo,estado,total,token) values ('00000000-0000-0000-0000-0000000001b1','PR1','UDP','Pago informado',100000,'tokPR1'),('00000000-0000-0000-0000-0000000001b2','PT1','UDP','Pago informado',100000,'tokPT1')" | Q >/dev/null
echo "insert into pago_gestiones(cotizacion_id,estado_envio) select id,'aceptado' from cotizaciones where numero in ('PR1','PT1'); insert into pago_gestion_cotizaciones_prueba(cotizacion_id,nota) select id,'tests.sh T18' from cotizaciones where numero='PT1'" | Q >/dev/null
echo "update pago_gestion_config set valor='prueba' where clave='modo'; update pago_gestion_config set valor='true' where clave='confirmaciones_activo'" | Q >/dev/null
GR=$(G PR1 "g.id"); GT=$(G PT1 "g.id"); CR=$(S "select id from cotizaciones where numero='PR1'")
HUE(){ S "select md5(coalesce((select to_jsonb(c)::text from cotizaciones c where id='$CR'),'')||coalesce((select to_jsonb(g)::text from pago_gestiones g where id='$GR'),'')||(select count(*)::text from pago_gestion_eventos where gestion_id='$GR'))"; }
H0=$(HUE)
chk "P1 real+modo prueba: SAP válido de CS autorizado => bloqueado" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_confirmacion('$GR','sap','p1','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "P2 real+modo prueba: Finanzas autorizada => bloqueado" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_confirmacion('$GR','finanzas','p2','','cobranza.cl@straumann.com',true)")"
chk "P3 real+modo prueba: remitente NO autorizado => bloqueado (ni siquiera evento)" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_confirmacion('$GR','sap','p3','1234567890','intruso@gmail.com',false)")"
chk "P4 real+modo prueba: respuesta ambigua => bloqueado" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_ambigua('$GR','p4','m.cl.customerservicechile@straumann.com','m','t')")"
chk "P5 trigger: UPDATE directo de SAP sobre gestión real => rechazado" "1" "$(echo "update pago_gestiones set sap_numero='1234567890' where id='$GR'" | Q 2>&1 | grep -c 'modo_prueba')"
chk "P6 trigger: UPDATE directo de validación financiera => rechazado" "1" "$(echo "update pago_gestiones set fin_confirmado_en=now() where id='$GR'" | Q 2>&1 | grep -c 'modo_prueba')"
chk "P7 cotización real, gestión y eventos: huella IDÉNTICA" "$H0" "$(HUE)"
chk "P8 estado de la cotización real intacto" "Pago informado" "$(S "select estado from cotizaciones where id='$CR'")"
chk "P9 cotización de PRUEBA sí procesa (modo prueba)" "registrado" "$(S "select pago_gestion_registrar_confirmacion('$GT','sap','p9','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "P10 y completa el flujo hasta Pedido ingresado" "pedido_ingresado" "$(S "select pago_gestion_registrar_confirmacion('$GT','finanzas','p10','','cobranza.cl@straumann.com',true)")"
for V in "" "Real" "REAL" " real" "real " "true" "produccion"; do
  echo "update pago_gestion_config set valor='$V' where clave='modo'" | Q >/dev/null
  chk "P11 fail-closed modo='$V' => bloqueado" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_confirmacion('$GR','sap','p11','1234567890','m.cl.customerservicechile@straumann.com',true)")"
done
echo "delete from pago_gestion_config where clave='modo'" | Q >/dev/null
chk "P11 fila 'modo' AUSENTE => bloqueado" "bloqueado_modo_prueba" "$(S "select pago_gestion_registrar_confirmacion('$GR','sap','p11b','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "P11 huella real sigue idéntica tras todos los modos no reales" "$H0" "$(HUE)"
echo "insert into pago_gestion_config(clave,valor) values ('modo','real')" | Q >/dev/null
chk "P12 comportamiento productivo (modo EXACTAMENTE real): la cotización real procesa" "registrado" "$(S "select pago_gestion_registrar_confirmacion('$GR','sap','p12','1234567890','m.cl.customerservicechile@straumann.com',true)")"
chk "P12 y completa el flujo" "pedido_ingresado" "$(S "select pago_gestion_registrar_confirmacion('$GR','finanzas','p12b','','cobranza.cl@straumann.com',true)")"
echo "update pago_gestion_config set valor='prueba' where clave='modo'" | Q >/dev/null
chk "P13 lista de prueba y funciones nuevas: anon/authenticated sin acceso" "6" "$(( $(deny x "SET ROLE anon; SELECT * FROM pago_gestion_cotizaciones_prueba;") + $(deny x "SET ROLE authenticated; SELECT * FROM pago_gestion_cotizaciones_prueba;") + $(deny x "SET ROLE anon; SELECT pago_gestion_puede_modificar('$CR');") + $(deny x "SET ROLE authenticated; SELECT pago_gestion_modo_real();") + $(deny x "SET ROLE anon; SELECT pago_gestion_exigir_modificable('$CR');") + $(deny x "SET ROLE authenticated; INSERT INTO pago_gestion_cotizaciones_prueba(cotizacion_id) VALUES ('$CR');") ))"
echo "update pago_gestion_config set valor='false' where clave='confirmaciones_activo'" | Q >/dev/null

echo; echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
