-- AUDITORIA DE AISLAMIENTO (SOLO LECTURA). Ejecutar DESPUES de cualquier ensayo con confirmaciones_activo=true. Sin cambios en la BD.
-- Uso:  psql "$CONEXION" -X -A -t -F'|' -f auditoria_aislamiento.sql   (la conexion la maneja Daniel; no se pega en el chat)
-- Esperado: las unicas filas MODIFICADA| son las cotizaciones de PRUEBA (en_lista_prueba=true) y NO hay filas ALERTA|. Cualquier otra => DETENER y usar ROLLBACK operativo.
BEGIN TRANSACTION READ ONLY;
-- 1) Cotizaciones cuyo estado/SAP/Finanzas fue tocado por la gestion automatica
SELECT 'MODIFICADA', c.numero, c.estado, coalesce(g.sap_numero,'-'), coalesce(g.fin_confirmado_en::text,'-'), coalesce(g.pedido_aplicado_en::text,'-'),
       (EXISTS (SELECT 1 FROM public.pago_gestion_cotizaciones_prueba p WHERE p.cotizacion_id = c.id))::text AS en_lista_prueba
FROM public.pago_gestiones g JOIN public.cotizaciones c ON c.id = g.cotizacion_id
WHERE g.sap_numero IS NOT NULL OR g.fin_confirmado_en IS NOT NULL OR g.pedido_aplicado_en IS NOT NULL
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.historial) h WHERE h->>'origen' LIKE 'gestion_interna%')
ORDER BY c.numero;
-- 2) Eventos entrantes por tipo (rechazos y revisiones: no modifican nada, solo informan)
SELECT 'EVENTO', e.tipo, count(*), min(e.created_at)::text, max(e.created_at)::text
FROM public.pago_gestion_eventos e WHERE e.tipo IN ('respuesta_cs','respuesta_finanzas','respuesta_no_autorizada','respuesta_ambigua','discrepancia_sap') GROUP BY e.tipo ORDER BY e.tipo;
-- 3) Gestiones enviadas a destinatarios (deberia ser solo el destinatario de prueba mientras modo<>real)
SELECT 'MODO', coalesce((SELECT valor FROM public.pago_gestion_config WHERE clave='modo'),'(ausente)'),
       (SELECT valor FROM public.pago_gestion_config WHERE clave='envio_activo'), (SELECT valor FROM public.pago_gestion_config WHERE clave='confirmaciones_activo');
-- 4) ALERTA: cotizaciones tocadas que NO estan en la lista de prueba mientras modo<>real. Con la proteccion instalada NO debe aparecer ninguna fila.
SELECT 'ALERTA', c.numero, c.estado
FROM public.pago_gestiones g JOIN public.cotizaciones c ON c.id = g.cotizacion_id
WHERE NOT public.pago_gestion_modo_real()
  AND NOT EXISTS (SELECT 1 FROM public.pago_gestion_cotizaciones_prueba p WHERE p.cotizacion_id = c.id)
  AND (g.sap_numero IS NOT NULL OR g.fin_confirmado_en IS NOT NULL OR g.pedido_aplicado_en IS NOT NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.historial) h WHERE h->>'origen' LIKE 'gestion_interna%'))
ORDER BY c.numero;
-- 5) Lista de cotizaciones de PRUEBA vigente
SELECT 'LISTA_PRUEBA', c.numero, p.created_at::text FROM public.pago_gestion_cotizaciones_prueba p JOIN public.cotizaciones c ON c.id = p.cotizacion_id ORDER BY c.numero;
ROLLBACK;
