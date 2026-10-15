// logic.ts -- Funcion de PRUEBA AISLADA de recepcion (NO DESPLEGADA). Sirve para comprobar con Resend real, y solo con datos ficticios:
//   (1) que el webhook `email.received` llega y la firma Svix valida (y con que desfase de reloj);
//   (2) que la API de lectura responde con la API key (permisos) y que valores trae `authentication` para cada remitente;
//   (3) que el Reply-To con token llega en to/received_for.
// NO usa base de datos, NO cambia estados, NO guarda el cuerpo del correo ni direcciones completas: solo devuelve/loguea un resumen de metadatos.
// Ambito: ignora todo correo que no vaya dirigido a prueba-<texto>@<dominio de pedidos> (no toca trafico real).
import { autenticacionResend, remitenteSimple, tokenDeDestinatarios, verificarSvix } from './reglas_copia.ts';

export interface LecturaResend { status: number; json: Record<string, unknown> | null }
export interface Deps {
  dominio: string;
  webhookSecret: string;
  /** null = sin API key configurada (se omite la lectura). */
  leer: ((emailId: string) => Promise<LecturaResend>) | null;
  now?: () => number;
  log(o: Record<string, unknown>): void;
}
export interface Entrada { rawBody: string; svixId: string | null; svixTimestamp: string | null; svixSignature: string | null }
export interface Resultado { status: number; body: Record<string, unknown> }

const ENUM_AUTH = new Set(['pass', 'fail', 'gray', 'processing_failed', 'unknown']);
const enumAuth = (v: unknown) => (typeof v === 'string' && ENUM_AUTH.has(v.toLowerCase()) ? v.toLowerCase() : v == null ? 'ausente' : 'otro');
const dominioDe = (dir: string) => (dir.split('@')[1] ?? '').toLowerCase().replace(/[^a-z0-9.\-]/g, '').slice(0, 80);

export async function handlePrueba(e: Entrada, deps: Deps): Promise<Resultado> {
  const ahora = (deps.now ?? Date.now)();
  const skew = e.svixTimestamp && Number.isFinite(Number(e.svixTimestamp)) ? Math.round(ahora / 1000 - Number(e.svixTimestamp)) : null;
  const prefijoWhsec = deps.webhookSecret.startsWith('whsec_');
  const firmaOk = await verificarSvix({ id: e.svixId, timestamp: e.svixTimestamp, signature: e.svixSignature }, e.rawBody, deps.webhookSecret, ahora);
  if (!firmaOk) {
    const r = { ev: 'firma_invalida', skew_s: skew, secreto_con_prefijo_whsec: prefijoWhsec, cabeceras_svix: !!(e.svixId && e.svixTimestamp && e.svixSignature) };
    deps.log(r); return { status: 401, body: { ok: false, ...r } };
  }
  let ev: any; try { ev = JSON.parse(e.rawBody); } catch { return { status: 200, body: { ok: true, resultado: 'json_invalido' } }; }
  const tipo = typeof ev?.type === 'string' && /^[a-z._]{1,40}$/.test(ev.type) ? ev.type : 'otro';
  if (tipo !== 'email.received' || !ev.data || typeof ev.data !== 'object') { deps.log({ ev: 'evento_ignorado', tipo, skew_s: skew }); return { status: 200, body: { ok: true, resultado: 'evento_ignorado', tipo } }; }
  const d = ev.data;
  const destinos: string[] = [...(Array.isArray(d.to) ? d.to : []), ...(Array.isArray(d.cc) ? d.cc : []), ...(Array.isArray(d.received_for) ? d.received_for : [])].map(String);
  const dom = deps.dominio.toLowerCase();
  const enAlcance = destinos.some((x) => { const a = remitenteSimple(x); const m = a.match(/^prueba-[a-z0-9-]{3,40}@(.+)$/); return !!m && m[1] === dom; })
    || tokenDeDestinatarios(destinos, dom) !== null;
  if (!enAlcance) { deps.log({ ev: 'fuera_de_alcance', skew_s: skew }); return { status: 200, body: { ok: true, resultado: 'fuera_de_alcance' } }; }

  const from = remitenteSimple(String(d.from ?? ''));
  const resumen: Record<string, unknown> = {
    ev: 'recepcion_prueba', firma_valida: true, skew_s: skew, secreto_con_prefijo_whsec: prefijoWhsec,
    from_dominio: dominioDe(from), from_con_nombre_visible: /</.test(String(d.from ?? '')),
    to_n: Array.isArray(d.to) ? d.to.length : 0, cc_n: Array.isArray(d.cc) ? d.cc.length : 0, received_for_n: Array.isArray(d.received_for) ? d.received_for.length : 0,
    hilo_token_en_destino: tokenDeDestinatarios(destinos, dom) !== null,
    message_id_presente: typeof d.message_id === 'string' && d.message_id.length > 0,
    asunto_largo: typeof d.subject === 'string' ? d.subject.length : 0,
    adjuntos_n: Array.isArray(d.attachments) ? d.attachments.length : 0,
  };
  const emailId = String(d.email_id ?? '');
  if (!deps.leer) resumen.lectura = 'omitida_sin_api_key';
  else if (!/^[A-Za-z0-9_-]{6,80}$/.test(emailId)) resumen.lectura = 'email_id_invalido';
  else {
    try {
      const r = await deps.leer(emailId);
      resumen.lectura_http = r.status;
      if (r.status === 200 && r.json) {
        const a = (r.json.authentication && typeof r.json.authentication === 'object' ? r.json.authentication : null) as Record<string, unknown> | null;
        resumen.lectura = 'ok';
        resumen.auth_spf = enumAuth(a?.spf); resumen.auth_dkim = enumAuth(a?.dkim); resumen.auth_dmarc = enumAuth(a?.dmarc);
        resumen.auth_objeto_presente = a !== null;
        resumen.veredicto_regla_actual = autenticacionResend(a);
        const h = r.json.headers && typeof r.json.headers === 'object' ? Object.keys(r.json.headers as object) : [];
        resumen.cabeceras_nombres = h.map((k) => k.toLowerCase()).filter((k) => /^[a-z0-9\-]{1,40}$/.test(k)).slice(0, 40).join(',');
        resumen.tiene_authentication_results = h.some((k) => k.toLowerCase() === 'authentication-results');
        resumen.cuerpo_texto = typeof r.json.text === 'string' && (r.json.text as string).length > 0; resumen.cuerpo_html = typeof r.json.html === 'string' && (r.json.html as string).length > 0;
      } else resumen.lectura = r.status === 401 || r.status === 403 ? 'sin_permiso_api_key' : r.status === 404 ? 'no_encontrado' : 'error_http';
    } catch { resumen.lectura = 'excepcion'; }
  }
  deps.log(resumen);
  return { status: 200, body: { ok: true, resultado: 'recibido', resumen } };
}
