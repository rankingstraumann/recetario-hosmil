// logic.ts -- Emisor de la gestion interna de pagos (Fase C). Logica con dependencias INYECTADAS (BD, firmado, Resend, log):
// se prueba sin red. index.ts solo cablea Deno + supabase-js + Resend. NADA se envia mientras la BD tenga envio_activo<>'true'
// (pago_gestion_reclamar no devuelve filas) y, mientras modo<>'real', el UNICO destinatario posible es el de prueba (pago_gestion_destinatarios_de).
//
// Garantias que implementa (todas probadas en test/):
//  - Idempotencia: UNIQUE(cotizacion_id) en BD + reclamar con FOR UPDATE SKIP LOCKED + Idempotency-Key por intento.
//  - Nunca reenvia ante duda: timeout / 5xx / respuesta ilegible / fallo al registrar => la gestion queda 'enviando' y la BD la pasa a 'incierto'.
//  - Guardia previa a Resend (pago_gestion_validar_envio) con EXACTAMENTE lo que se enviara; sin BCC.
//  - Elegibilidad re-verificada justo antes de Resend (anulada / eliminada / ya movida / pago no cubre el total => se suelta, no se envia).
//  - Logs sin datos personales: lista blanca de campos; nunca tokens, URL firmadas, correos, nombres ni RUT.
import { construirGestion, etiquetasComprobantes, institucionInfo, type Cotizacion, type Pago } from './gestion.ts';

export interface Cfg { secret: string; from: string; replyDomain: string; maxLote: number; resendTimeoutMs: number }
export interface Res<T> { data: T | null; error: { code?: string; message?: string } | null }
export interface ResendResp { status: number; json: any }
export interface Deps {
  cfg: Cfg;
  rpc(name: string, args?: Record<string, unknown>): Promise<Res<any>>;
  getCotizacion(id: string): Promise<Res<(Cotizacion & { institucion_codigo?: string | null }) | null>>;
  getPagos(id: string): Promise<Res<Pago[]>>;
  /** URL firmada de 7 dias (como el Admin) o null si no se pudo. */
  sign(path: string): Promise<string | null>;
  resend(payload: Record<string, unknown>, idempotencyKey: string, signal: AbortSignal): Promise<ResendResp>;
  log(o: Record<string, unknown>): void;
}

// ---- Logs: lista blanca estricta -------------------------------------------------------------------------------
const LOG_OK = new Set(['ev', 'gid', 'estado', 'inst', 'n', 'status', 'motivo', 'intento', 'code', 'reclamadas', 'enviadas', 'dudosas', 'errores', 'soltadas', 'modo_prueba']);
export function safeLog(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!LOG_OK.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_:\-]{1,60}$/.test(v) && !v.includes('@')) out[k] = v;
  }
  return out;
}
const shortId = (id: string) => String(id).slice(0, 8);

export function readConfig(get: (k: string) => string | undefined): { cfg?: Cfg; error?: string } {
  const secret = get('GESTION_PAGOS_SECRET') ?? '';
  const from = (get('GESTION_PAGOS_FROM') ?? '').trim();
  const replyDomain = (get('GESTION_PAGOS_REPLY_DOMAIN') ?? 'pagos.recetariostra.cl').trim().toLowerCase();   // PROVISIONAL: sujeto a DNS/Resend
  if (secret.length < 24) return { error: 'config_secret' };
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(from)) return { error: 'config_from' };
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(replyDomain)) return { error: 'config_reply_domain' };
  const maxLote = Math.min(Math.max(parseInt(get('GESTION_PAGOS_LOTE') ?? '5', 10) || 5, 1), 20);
  const resendTimeoutMs = Math.min(Math.max(parseInt(get('GESTION_PAGOS_TIMEOUT_MS') ?? '15000', 10) || 15000, 1000), 25000);
  return { cfg: { secret, from, replyDomain, maxLote, resendTimeoutMs } };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

const firstRow = (d: any) => (Array.isArray(d) ? d[0] : d);
const errCode = (e: { code?: string } | null) => (e && typeof e.code === 'string' && /^[0-9A-Za-z]{1,10}$/.test(e.code) ? e.code : 'rpc');

/** Clasifica la respuesta de Resend. 'ok' = aceptado con id; 'rechazado' = DEFINITIVAMENTE no enviado; 'dudoso' = pudo haberse enviado. */
export function clasificarResend(r: ResendResp): { tipo: 'ok'; id: string } | { tipo: 'rechazado'; razon: string } | { tipo: 'dudoso' } {
  const s = r.status;
  if (s >= 200 && s < 300) {
    const id = r.json && typeof r.json.id === 'string' ? r.json.id : '';
    return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? { tipo: 'ok', id } : { tipo: 'dudoso' };   // 2xx sin id legible: no sabemos => no reenviar
  }
  const nombre = r.json && typeof r.json.name === 'string' && /^[a-z_]{1,40}$/.test(r.json.name) ? r.json.name : 'sin_nombre';
  if (s === 429 || s === 400 || s === 401 || s === 403 || s === 404 || s === 422) return { tipo: 'rechazado', razon: `resend_${s}:${nombre}` };
  return { tipo: 'dudoso' };   // 408, 409 (idempotencia en curso), 5xx, cualquier otro
}

export interface Resultado { ok: boolean; status: number; body: Record<string, unknown> }

export async function handle(secretHeader: string | null, deps: Deps): Promise<Resultado> {
  const { cfg } = deps; const log = (o: Record<string, unknown>) => deps.log(safeLog(o));
  if (!secretHeader || !timingSafeEqual(secretHeader, cfg.secret)) { log({ ev: 'no_autorizado' }); return { ok: false, status: 401, body: { ok: false, error: 'no_autorizado' } }; }

  // 1) Higiene previa: lo reclamado y vencido pasa a 'incierto' (NUNCA se reenvia solo); lo que dejo de ser elegible se marca.
  const inc = await deps.rpc('pago_gestion_marcar_inciertas');
  if (inc.error) log({ ev: 'marcar_inciertas_error', code: errCode(inc.error) });
  const rev = await deps.rpc('pago_gestion_revisar_elegibilidad');
  if (rev.error) log({ ev: 'revisar_elegibilidad_error', code: errCode(rev.error) });

  // 2) Reclamar (la BD devuelve vacio si envio_activo<>'true')
  const cl = await deps.rpc('pago_gestion_reclamar', { p_limite: cfg.maxLote });
  if (cl.error) { log({ ev: 'reclamar_error', code: errCode(cl.error) }); return { ok: false, status: 500, body: { ok: false, error: 'reclamar' } }; }
  const filas: { gestion_id: string; cotizacion_id: string; reply_token: string; intentos: number }[] = Array.isArray(cl.data) ? cl.data : [];
  const tot = { reclamadas: filas.length, enviadas: 0, dudosas: 0, errores: 0, soltadas: 0 };
  log({ ev: 'lote', reclamadas: filas.length });

  for (const f of filas) {
    const ctx = { resendLlamado: false };
    try {
      const r = await procesar(f, deps, ctx);
      if (r === 'enviada') tot.enviadas++; else if (r === 'dudosa') tot.dudosas++; else if (r === 'soltada') tot.soltadas++; else tot.errores++;
    } catch (e) {
      if (ctx.resendLlamado) {
        // Excepcion DESPUES de llamar a Resend: pudo haberse enviado => NO se marca error (seria reenviable). Queda 'enviando' => 'incierto'.
        tot.dudosas++; log({ ev: 'excepcion_post_envio', gid: shortId(f.gestion_id), code: (e as Error).name }); continue;
      }
      // Excepcion inesperada ANTES de llamar a Resend: no hay envio => error reintentable.
      tot.errores++; log({ ev: 'excepcion', gid: shortId(f.gestion_id), code: (e as Error).name });
      try { await deps.rpc('pago_gestion_finalizar_envio', { p_id: f.gestion_id, p_ok: false, p_resend_id: null, p_asunto: null, p_to: null, p_cc: null, p_error: 'excepcion_previa_a_envio' }); } catch { /* queda enviando => incierto */ }
    }
  }
  log({ ev: 'fin', ...tot });
  return { ok: true, status: 200, body: { ok: true, ...tot } };
}

type Salida = 'enviada' | 'dudosa' | 'soltada' | 'error';

async function fallar(f: { gestion_id: string }, deps: Deps, motivo: string): Promise<Salida> {
  deps.log(safeLog({ ev: 'gestion_error', gid: shortId(f.gestion_id), motivo }));
  await deps.rpc('pago_gestion_finalizar_envio', { p_id: f.gestion_id, p_ok: false, p_resend_id: null, p_asunto: null, p_to: null, p_cc: null, p_error: motivo });
  return 'error';
}
async function soltar(f: { gestion_id: string }, deps: Deps, motivo: string): Promise<Salida> {
  deps.log(safeLog({ ev: 'gestion_soltada', gid: shortId(f.gestion_id), motivo: motivo.replace(/[^A-Za-z0-9_:\-]/g, '_').slice(0, 50) }));
  await deps.rpc('pago_gestion_soltar', { p_id: f.gestion_id, p_motivo: motivo });
  return 'soltada';
}

async function procesar(f: { gestion_id: string; cotizacion_id: string; reply_token: string; intentos: number }, deps: Deps, ctx: { resendLlamado: boolean }): Promise<Salida> {
  const { cfg } = deps; const log = (o: Record<string, unknown>) => deps.log(safeLog(o));

  // a) Elegibilidad (1a verificacion)
  const el = await deps.rpc('pago_gestion_motivo_no_elegible', { p_cotizacion_id: f.cotizacion_id });
  if (el.error) return fallar(f, deps, 'no_se_pudo_verificar_elegibilidad');
  if (el.data) return soltar(f, deps, String(el.data));

  // b) Datos
  const cot = await deps.getCotizacion(f.cotizacion_id);
  const pg = await deps.getPagos(f.cotizacion_id);
  if (cot.error || !cot.data || pg.error || !pg.data) return fallar(f, deps, 'datos_cotizacion_no_disponibles');
  const c = cot.data; const pagos = pg.data;
  const codigo = c.institucion_codigo || '';
  if (!codigo) return fallar(f, deps, 'sin_codigo_institucion');

  // c) Destinatarios: UNICA fuente = la BD (fail-closed en modo prueba)
  const de = await deps.rpc('pago_gestion_destinatarios_de', { p_institucion_codigo: codigo });
  const d = firstRow(de.data);
  if (de.error || !d) return fallar(f, deps, 'destinatarios_no_disponibles');
  const to: string[] = Array.isArray(d.to_emails) ? d.to_emails : [];
  const cc: string[] = Array.isArray(d.cc_emails) ? d.cc_emails : [];
  const esPrueba = d.es_prueba !== false;   // cualquier valor distinto de false se trata como prueba
  if (to.length === 0) return fallar(f, deps, 'sin_destinatarios');

  // d) Enlaces firmados AL MOMENTO DEL ENVIO (7 dias, como el Admin); si uno falla, queda "No se pudo generar link"
  const etiquetas = etiquetasComprobantes(c, pagos);
  const lista = [];
  for (const e of etiquetas) { let link: string | null = null; try { link = await deps.sign(e.path); } catch { link = null; } lista.push({ texto: e.texto, link }); }
  // Una gestion INCOMPLETA no se envia: si algun comprobante requerido no se pudo firmar, se bloquea y queda registrado para revision
  // (error reintentable: ultimo_error='enlace_firmado_fallo', hasta 3 intentos cada 15 min). Nunca sale "No se pudo generar link" por correo.
  if (lista.some((x) => !x.link || !/^https:\/\//i.test(x.link))) return fallar(f, deps, 'enlace_firmado_fallo');
  const g = construirGestion(c, lista);

  // e) Asunto y cuerpo. En prueba: prefijo [PRUEBA] y aviso con los destinatarios reales que NO recibieron nada.
  let asunto = g.asunto, html = g.html, texto = g.texto;
  if (esPrueba) {
    const realTo = '(en produccion iria a Customer Service y Cobranza, con copia a los ejecutivos de la institucion)';
    asunto = '[PRUEBA] ' + asunto;
    html = '<div style="background:#fff3cd;border:1px solid #fde68a;padding:8px;margin-bottom:12px;font-family:Arial,sans-serif;font-size:12px;">MODO PRUEBA: este correo NO fue enviado a los destinatarios reales ' + realTo + '.</div>' + html;
    texto = 'MODO PRUEBA: este correo NO fue enviado a los destinatarios reales ' + realTo + '.\n\n' + texto;
  }

  // f) Guardia: exactamente lo que se enviara, sin BCC
  const gd = await deps.rpc('pago_gestion_validar_envio', { p_institucion_codigo: codigo, p_to: to, p_cc: cc, p_bcc: [] });
  if (gd.error || gd.data !== true) return fallar(f, deps, 'guardia_rechazo');

  // g) Elegibilidad (2a verificacion, inmediatamente antes de Resend)
  const el2 = await deps.rpc('pago_gestion_motivo_no_elegible', { p_cotizacion_id: f.cotizacion_id });
  if (el2.error) return fallar(f, deps, 'no_se_pudo_verificar_elegibilidad');
  if (el2.data) return soltar(f, deps, String(el2.data));

  // h) Resend. Desde aqui, ante duda NO se finaliza como error (podria haberse enviado): queda 'enviando' => 'incierto'.
  const payload: Record<string, unknown> = {
    from: cfg.from, to, subject: asunto, html, text: texto,
    reply_to: `reply+${f.reply_token}@${cfg.replyDomain}`,
    ...(cc.length ? { cc } : {}),
  };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), cfg.resendTimeoutMs);
  let resp: ResendResp | null = null;
  ctx.resendLlamado = true;
  try { resp = await deps.resend(payload, `gestion-pago:${f.gestion_id}:${f.intentos}`, ctrl.signal); }
  catch { resp = null; }
  finally { clearTimeout(timer); }
  if (!resp) { log({ ev: 'envio_dudoso', gid: shortId(f.gestion_id), motivo: 'sin_respuesta' }); return 'dudosa'; }

  const k = clasificarResend(resp);
  if (k.tipo === 'dudoso') { log({ ev: 'envio_dudoso', gid: shortId(f.gestion_id), status: resp.status }); return 'dudosa'; }
  if (k.tipo === 'rechazado') return fallar(f, deps, k.razon);

  // i) Aceptado por Resend (NO equivale a entregado). Registrar; si el registro falla se reintenta; si sigue fallando => incierto (no se reenvia).
  for (let i = 0; i < 3; i++) {
    const fin = await deps.rpc('pago_gestion_finalizar_envio', { p_id: f.gestion_id, p_ok: true, p_resend_id: k.id, p_asunto: asunto, p_to: to, p_cc: cc, p_error: null });
    if (!fin.error && fin.data === true) { log({ ev: 'aceptado', gid: shortId(f.gestion_id), inst: codigo, modo_prueba: esPrueba }); return 'enviada'; }
  }
  log({ ev: 'registro_fallido_post_envio', gid: shortId(f.gestion_id) });
  return 'dudosa';
}

export { institucionInfo };
