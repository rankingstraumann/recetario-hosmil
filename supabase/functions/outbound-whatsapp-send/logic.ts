// logic.ts -- OUTBOUND 7: logica pura (sin Deno) del envio inicial por plantilla WhatsApp. SOLO MODO PRUEBA.
// Todas las dependencias (rpc, fetch, env) se inyectan => se prueba sin red ni Supabase.
export type EnvGet = (k: string) => string | undefined;
export interface Config {
  enabled: boolean;          // kill switch: OUTBOUND_WHATSAPP_ENABLED === 'true' (defecto: apagado)
  testOnly: boolean;         // OUTBOUND_WHATSAPP_TEST_ONLY (defecto: true; solo 'false' lo desactiva)
  templateName: string | null;
  templateLanguage: string | null;
  mode: 'real' | 'dry_run';  // real solo si plantilla marcada como aprobada + token + phone id; si no => simulacion
  token?: string; phoneNumberId?: string; version: string;
}
export const NAME_RE = /^[a-z0-9_]{1,200}$/;
export const LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readConfig(env: EnvGet): Config {
  const name = (env('OUTBOUND_TEMPLATE_NAME') || '').trim();
  const lang = (env('OUTBOUND_TEMPLATE_LANGUAGE') || '').trim();
  const token = env('WHATSAPP_ACCESS_TOKEN') || undefined;
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID') || undefined;
  const approved = env('OUTBOUND_TEMPLATE_APPROVED') === 'true';
  return {
    enabled: env('OUTBOUND_WHATSAPP_ENABLED') === 'true',
    testOnly: env('OUTBOUND_WHATSAPP_TEST_ONLY') !== 'false',
    templateName: NAME_RE.test(name) ? name : null,
    templateLanguage: LANG_RE.test(lang) ? lang : null,
    mode: approved && token && phoneNumberId ? 'real' : 'dry_run',
    token, phoneNumberId, version: env('WHATSAPP_GRAPH_VERSION') || 'v21.0',
  };
}

/** Mensaje de error apto para guardar/mostrar: sin telefonos, tokens ni secuencias largas; max 200 car. */
export function sanitizeError(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[num]').replace(/\b(EAA|Bearer)[A-Za-z0-9_\-.=]{6,}/g, '[token]')
    .replace(/[A-Za-z0-9_\-]{30,}/g, '[id]').trim().slice(0, 200);
}

export function buildTemplatePayload(toE164: string, name: string, lang: string) {
  // Plantilla SIN variables ni componentes: el texto vive en la plantilla aprobada en Meta (no se inventa aqui).
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: toE164.replace(/^\+/, ''),
    type: 'template', template: { name, language: { code: lang } } };
}

export interface SendOutcome { ok: boolean; id?: string; code?: string; message?: string }
export async function sendTemplate(cfg: Config, to: string, doFetch: typeof fetch): Promise<SendOutcome> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await doFetch(`https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(buildTemplatePayload(to, cfg.templateName!, cfg.templateLanguage!)),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, code: `http_${r.status}${j?.error?.code ? `_code_${j.error.code}` : ''}`.slice(0, 60), message: sanitizeError(j?.error?.message) };
    const id = j?.messages?.[0]?.id;
    if (typeof id !== 'string' || !id) return { ok: false, code: 'no_provider_id', message: 'Meta no devolvio id de mensaje' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, code: `fetch_${(e as Error).name}`.slice(0, 60), message: 'No se pudo contactar a Meta' };
  } finally { clearTimeout(timer); }
}

const RPC_ERRORS: Array<[string, number, string, string]> = [
  ['NO_AUTORIZADO', 403, 'no_autorizado', 'No tienes permiso para enviar.'],
  ['PROSPECTO_REAL_NO_PERMITIDO', 403, 'prospecto_real_no_permitido', 'Solo se puede enviar a prospectos de PRUEBA. Los prospectos reales están bloqueados.'],
  ['SIN_CONSENTIMIENTO', 422, 'sin_consentimiento', 'El prospecto no tiene consentimiento WhatsApp autorizado.'],
  ['SIN_MOVIL_VALIDO', 422, 'sin_movil_valido', 'El prospecto no tiene un móvil +569 válido.'],
  ['ESTADO_NO_PENDIENTE', 409, 'estado_no_pendiente', 'El prospecto ya no está en estado Pendiente (ya contactado u otro estado).'],
  ['ENVIO_EN_CURSO', 409, 'envio_en_curso', 'Ya hay un envío en curso para este prospecto.'],
  ['YA_ENVIADO', 409, 'ya_enviado', 'Este prospecto ya recibió la plantilla.'],
  ['PROSPECTO_NO_ENCONTRADO', 404, 'prospecto_no_encontrado', 'Prospecto no encontrado.'],
  ['PARAMETROS_INVALIDOS', 400, 'parametros_invalidos', 'Parámetros inválidos.'],
];
export function mapRpcError(e: any): { status: number; code: string; message: string } {
  const m = String(e?.message || '');
  for (const [k, status, code, message] of RPC_ERRORS) if (m.includes(k)) return { status, code, message };
  return { status: 500, code: 'error_base', message: 'No se pudo completar la operación.' };
}

export interface Deps {
  cfg: Config;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  doFetch: typeof fetch;
  log?: (o: Record<string, unknown>) => void;
}
export interface Res { status: number; body: Record<string, unknown> }
const err = (status: number, error: string, message: string): Res => ({ status, body: { ok: false, error, message } });

/** body ya parseado. El llamador (index.ts) ya verifico JWT + is_lead_admin. */
export async function handle(body: any, d: Deps): Promise<Res> {
  const { cfg } = d;
  const action = body?.action === 'check' ? 'check' : body?.action === 'send' ? 'send' : null;
  if (!action) return err(400, 'accion_invalida', 'Acción no válida.');
  const configured = cfg.templateName !== null && cfg.templateLanguage !== null;

  if (action === 'check') {
    return { status: 200, body: { ok: true, enabled: cfg.enabled, test_only: cfg.testOnly, template_configured: configured,
      template_name: cfg.templateName, template_language: cfg.templateLanguage, mode: cfg.mode } };
  }
  // ---- send: barreras en orden. NINGUNA escribe ni envia nada.
  if (!cfg.enabled) return err(403, 'envio_deshabilitado', 'El envío de WhatsApp está deshabilitado (kill switch OUTBOUND_WHATSAPP_ENABLED).');
  if (!cfg.testOnly) return err(403, 'modo_real_no_soportado', 'Esta versión solo permite modo PRUEBA (OUTBOUND_WHATSAPP_TEST_ONLY debe ser true).');
  if (!configured) return err(422, 'plantilla_no_configurada', 'La plantilla no está configurada (OUTBOUND_TEMPLATE_NAME / OUTBOUND_TEMPLATE_LANGUAGE). No se envió nada.');
  const pid = typeof body?.prospect_id === 'string' ? body.prospect_id : '';
  if (!UUID_RE.test(pid)) return err(400, 'parametros_invalidos', 'Prospecto inválido.');

  // Reserva atomica: valida is_test / consentimiento / movil / pending y evita doble envio.
  const c = await d.rpc('claim_outbound_send', { p_prospect_id: pid, p_template_name: cfg.templateName, p_template_language: cfg.templateLanguage });
  if (c.error) { const m = mapRpcError(c.error); return err(m.status, m.code, m.message); }
  const sendId = c.data?.send_id as string, to = c.data?.to as string;
  if (!sendId || !to) return err(500, 'error_base', 'Respuesta inesperada de la base.');

  let status: 'sent' | 'failed' | 'dry_run', pmid: string | null = null, code: string | null = null, msg: string | null = null;
  if (cfg.mode === 'dry_run') { status = 'dry_run'; }
  else {
    const o = await sendTemplate(cfg, to, d.doFetch);   // UN intento; sin reintentos automaticos
    if (o.ok) { status = 'sent'; pmid = o.id!; } else { status = 'failed'; code = o.code || 'send_failed'; msg = o.message || null; }
  }
  const f = await d.rpc('finalize_outbound_send', { p_send_id: sendId, p_status: status, p_provider_message_id: pmid, p_error_code: code, p_error_message: msg });
  d.log?.({ ev: 'outbound_send', status, mode: cfg.mode, finalize_ok: !f.error });
  if (f.error) {
    // El envio pudo haber salido pero no se pudo registrar: NO se reintenta. La fila queda 'sending' y bloquea otro envio.
    return { status: 500, body: { ok: false, error: 'registro_fallido', message: 'El envío se procesó pero no se pudo registrar el resultado. No reintentes: revisa con soporte.', provider_message_id: pmid, send_id: sendId } };
  }
  if (status === 'failed') return { status: 200, body: { ok: false, status, mode: cfg.mode, error: 'envio_fallido', error_code: code, message: msg || 'Meta rechazó el envío.', send_id: sendId } };
  return { status: 200, body: { ok: true, status, mode: cfg.mode, provider_message_id: pmid, send_id: sendId } };
}
