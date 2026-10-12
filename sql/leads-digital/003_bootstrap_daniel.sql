-- BOOTSTRAP SEPARADO: alta de Daniel como lead admin.
-- UUID validado contra auth.users (daniel.jordan@straumann.com) y admin_perfiles (Daniel Jordan, es_super_admin).
INSERT INTO public.lead_admin_users (user_id)
SELECT u.id FROM auth.users u
WHERE u.id = 'd4e43b8f-09fe-4dc6-ba3a-7d88df27a0d1'
ON CONFLICT DO NOTHING;
