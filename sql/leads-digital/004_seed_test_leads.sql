-- 10 leads FICTICIOS (is_test=true). Telefonos ficticios +5690000000x. Score lo calcula el trigger.
INSERT INTO public.digital_leads
 (created_at, source_channel, campaign_name, phone_e164, contact_name, clinic_name, commune,
  uses_intraoral_scanner, current_scanner, need, purchase_timeline, wants_demo, wants_quote,
  high_intent_override, high_intent_reason, ai_summary, is_test)
VALUES
 (now() - interval '1 hour',  'test','SIRIOS RM','+56900000001','Prueba 01 Ana Rojas','Clinica Test Alfa','Providencia', true,'Medit i700','trade_up','now',true,true,false,null,'[PRUEBA] Usa Medit i700, busca Trade Up de inmediato y pide demo y cotizacion.',true),
 (now() - interval '3 hours', 'test','SIRIOS RM','+56900000002','Prueba 02 Luis Soto','Dental Test Beta','Las Condes', false,null,'first_scanner','now',false,true,false,null,'[PRUEBA] Sin scanner, busca su primer equipo ahora y pide cotizacion.',true),
 (now() - interval '5 hours', 'test','SIRIOS RM','+56900000003','Prueba 03 Marta Vera','Clinica Test Gamma','Santiago', true,'iTero','renew','1_3_months',true,false,false,null,'[PRUEBA] Usa iTero, quiere renovar en 1-3 meses y pide demo.',true),
 (now() - interval '8 hours', 'test','SIRIOS RM','+56900000004','Prueba 04 Jorge Paz','Odonto Test Delta','Nunoa', false,null,'know_sirios','later',null,null,true,'Escribio: quiero cotizar','[PRUEBA] Intencion fuerte declarada (override). Sin otros datos.',true),
 (now() - interval '1 day',   'test','SIRIOS RM','+56900000005','Prueba 05 Eva Mora','Clinica Test Epsilon','Vitacura', true,'Trios','digital_flow','3_6_months',true,false,false,null,'[PRUEBA] Usa Trios, quiere mejorar flujo digital en 3-6 meses.',true),
 (now() - interval '2 days',  'test','SIRIOS RM','+56900000006','Prueba 06 Raul Diaz','Dental Test Zeta','La Florida', false,null,'know_sirios','1_3_months',null,true,false,null,'[PRUEBA] Sin scanner, quiere conocer SIRIOS y pide cotizacion.',true),
 (now() - interval '3 days',  'test','SIRIOS RM','+56900000007','Prueba 07 Sofia Lira','Clinica Test Eta','Maipu', true,'Medit i600','renew','evaluating',true,false,false,null,'[PRUEBA] Usa Medit i600, evalua renovar y pide demo.',true),
 (now() - interval '4 days',  'test','SIRIOS RM','+56900000008','Prueba 08 Tomas Gil','Odonto Test Theta','Recoleta', false,null,'information_only','later',false,false,false,null,'[PRUEBA] Solo busca informacion, sin plazo.',true),
 (now() - interval '5 days',  'test','SIRIOS RM','+56900000009','Prueba 09 Ines Cruz','Clinica Test Iota','Penalolen', null,null,'know_sirios','evaluating',null,null,false,null,'[PRUEBA] Respondio parcialmente; curiosidad por SIRIOS.',true),
 (now() - interval '6 days',  'test','SIRIOS RM','+56900000010','Prueba 10 Hugo Neira','Dental Test Kappa','San Miguel', true,'iTero','digital_flow','later',false,false,false,null,'[PRUEBA] Usa iTero, interes de flujo digital sin plazo.',true);

-- Un lead de prueba ya derivado (para ver "Asignados" y el historial)
UPDATE public.digital_leads SET assigned_to_name='Gloria Trejos', assigned_at=now()-interval '1 day', status='assigned'
 WHERE phone_e164='+56900000007' AND is_test;
INSERT INTO public.digital_lead_activities(lead_id, event_type, detail)
SELECT id,'assigned', jsonb_build_object('assigned_to_name','Gloria Trejos','test',true)
 FROM public.digital_leads WHERE phone_e164='+56900000007' AND is_test;
