// engine.ts — Motor conversacional PURO (sin I/O). Máquina de estados determinística.
// Preguntas, mensajes y cierres son plantillas fijas. La IA solo aporta campos validados (extract.ts).

export const NEEDS = ['renew', 'trade_up', 'first_scanner', 'digital_flow', 'know_sirios', 'information_only'] as const;
export const TIMELINES = ['now', '1_3_months', '3_6_months', 'later', 'evaluating'] as const;
export type Step = 'q1' | 'q1b' | 'q2' | 'q3' | 'q4' | 'q5' | 'done';

export interface Fields {
  uses_intraoral_scanner?: boolean;
  current_scanner?: string;
  need?: string;
  purchase_timeline?: string;
  wants_demo?: boolean;
  wants_quote?: boolean;
  contact_name?: string;
  clinic_name?: string;
  commune?: string;
  high_intent?: boolean;
  high_intent_reason?: string;
  // OUTBOUND 9A (journey outbound_sirios): viven SOLO en session.context.fields; no se persisten en digital_leads.
  customer_profile?: string;    // owner_partner | clinician | postgraduate | explorer
  commercial_route?: string;    // trade_up | first_scanner | renewal_workflow | postgraduate_influencer | exploration
  product_interest?: string;    // sirios | sirios_x3 | compare | undecided
  cta_selected?: string;        // request_evaluation | trade_up_evaluation | demo | specialist | financing | share_clinic | compare | learn_sirios | learn_sirios_x3 | information
}

export type Journey = 'inbound' | 'outbound_sirios';

export interface Ctx {
  fields: Fields;
  journey?: Journey;     // ausente = inbound (Inbound V1 no cambia). outbound_sirios = OUTBOUND 9A (ver outbound-sirios.ts)
  o?: OutState;          // estado del journey outbound_sirios (solo se usa con journey='outbound_sirios')
  pending?: Step;        // última pregunta enviada
  greeted?: boolean;
  first_turn?: boolean;  // no evaluar fuera-de-flujo en el primer turno
  resumed?: boolean;     // sesión nueva que retoma datos de una expirada
  q1b_asked?: boolean;
  privacy_sent?: boolean;
  q5_asks?: number;
  llm_calls?: number;
  msg_count?: number;
}

export interface OutState {
  opened?: boolean;          // apertura ya enviada
  asked: string[];           // tipos de pregunta ya formulados (maximo 5; una repeticion de la misma no cuenta)
  done: string[];            // tipos de pregunta resueltos
  pending_kind?: string;     // pregunta pendiente
  route_msg?: boolean;       // mensaje contextual de la ruta ya enviado
  prospect_id?: string;      // prospecto resuelto de forma inequivoca (inyectado; 9B)
}

export const MAX_Q5_ASKS = 3;

// ---------- Plantillas ----------
export const GREETING =
  'Hola, soy el asistente digital de Straumann Group Chile. Puedo ayudarte a conocer nuestras soluciones de escaneo intraoral y evaluar qué alternativa puede ajustarse mejor a tu clínica. Son solo unas preguntas breves.';
export const RESUME = 'Hola de nuevo. Retomemos tu consulta; solo necesito algunos datos que faltan.';
export const PRIVACY = 'Usaremos tus datos únicamente para gestionar esta consulta comercial y contactarte respecto de soluciones Straumann Group.';
export const OFFFLOW = 'Con gusto un especialista podrá darte ese detalle. Por ahora, para avanzar con tu consulta:';
export const ACK = 'Ya tenemos registrada tu consulta y nuestro equipo la está revisando. Cuéntame si quieres agregar algo.';
export const UNSUPPORTED = 'Por ahora puedo leer solo mensajes de texto. ¿Puedes escribirme tu respuesta?';
export const FINAL_COLD =
  'Gracias por contactarnos. Dejé registrada tu consulta. Cuando quieras evaluar SIRIOS, Trade Up o una demostración, puedes escribirnos nuevamente por este mismo canal.';

export function finalMessage(temperature: string, name?: string): string {
  const n = firstName(name);
  const who = n ? `Gracias, ${n}.` : 'Gracias.';
  if (temperature === 'hot')
    return `${who} Por lo que me comentas, tiene sentido que uno de nuestros especialistas revise tu caso. Dejé tus antecedentes registrados para evaluación comercial. Nuestro equipo te contactará para revisar la alternativa más adecuada para tu clínica.`;
  if (temperature === 'warm')
    return `${who} Dejé registrada tu consulta y tus antecedentes. Podremos ayudarte cuando quieras avanzar con una demostración o propuesta comercial.`;
  return FINAL_COLD;
}

export function firstName(name?: string): string {
  if (!name) return '';
  const parts = name.split(/\s+/).filter((p) => !/^(dr|dra|doctor|doctora|sr|sra|don|doña)\.?$/i.test(p));
  return parts[0] || '';
}

export interface Out {
  kind: 'text' | 'buttons' | 'list';
  body: string;
  step?: Step;
  buttons?: { id: string; title: string }[];
  rows?: { id: string; title: string; description?: string }[];
}

const T = (body: string, step?: Step): Out => ({ kind: 'text', body, step });

export function questionFor(step: Step, ctx: Ctx): Out {
  switch (step) {
    case 'q1':
      return { kind: 'buttons', step, body: '¿Actualmente utilizas un scanner intraoral?', buttons: [{ id: 'q1:yes', title: 'Sí' }, { id: 'q1:no', title: 'No' }] };
    case 'q1b':
      return T('¿Cuál utilizas actualmente?', step);
    case 'q2':
      return {
        kind: 'list', step, body: '¿Qué estás buscando principalmente?',
        rows: [
          { id: 'q2:renew', title: 'Renovar mi scanner' },
          { id: 'q2:trade_up', title: 'Evaluar Trade Up' },
          { id: 'q2:first_scanner', title: 'Mi primer scanner', description: 'Comprar mi primer scanner' },
          { id: 'q2:digital_flow', title: 'Mejorar flujo digital', description: 'Mejorar mi flujo digital' },
          { id: 'q2:know_sirios', title: 'Conocer SIRIOS' },
          { id: 'q2:information_only', title: 'Solo información' },
        ],
      };
    case 'q3':
      return {
        kind: 'list', step, body: '¿En qué plazo estás pensando avanzar?',
        rows: [
          { id: 'q3:now', title: 'Ahora' },
          { id: 'q3:1_3_months', title: '1–3 meses' },
          { id: 'q3:3_6_months', title: '3–6 meses' },
          { id: 'q3:later', title: 'Más adelante' },
          { id: 'q3:evaluating', title: 'Solo estoy evaluando' },
        ],
      };
    case 'q4':
      return {
        kind: 'list', step, body: '¿Qué te interesaría como próximo paso?',
        rows: [
          { id: 'q4:demo', title: 'Una demostración' },
          { id: 'q4:quote', title: 'Una propuesta comercial' },
          { id: 'q4:both', title: 'Ambas' },
          { id: 'q4:info', title: 'Solo información', description: 'Por ahora solo información' },
        ],
      };
    case 'q5': {
      const miss = missingContact(ctx.fields);
      if (!ctx.privacy_sent || miss.length === 3) {
        return T(`${PRIVACY}\n\nPara dejar correctamente registrada tu solicitud: ¿Cuál es tu nombre, nombre de la clínica y comuna?`, step);
      }
      const names: Record<string, string> = { name: 'tu nombre', clinic: 'el nombre de tu clínica', commune: 'tu comuna' };
      const list = miss.map((m) => names[m]);
      const txt = list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0];
      return T(`Gracias. Solo me falta ${txt}.`, step);
    }
    default:
      return T('', step);
  }
}

/** Texto plano con opciones numeradas, por si falla el envío interactivo. */
export function plainFallback(o: Out): Out {
  if (o.kind === 'text') return o;
  const opts = (o.buttons || o.rows || []).map((x, i) => `${i + 1}. ${x.title}`).join('\n');
  return T(`${o.body}\n${opts}\n(Responde con el número o escribe tu respuesta)`, o.step);
}

// ---------- Saneamiento ----------
function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s.length ? s : undefined;
}

export function sanitizeFields(raw: any): Fields {
  const f: Fields = {};
  if (!raw || typeof raw !== 'object') return f;
  if (typeof raw.uses_intraoral_scanner === 'boolean') f.uses_intraoral_scanner = raw.uses_intraoral_scanner;
  const sc = cleanStr(raw.current_scanner, 60);
  if (sc && f.uses_intraoral_scanner !== false) {
    f.current_scanner = sc;
    if (f.uses_intraoral_scanner === undefined) f.uses_intraoral_scanner = true;
  }
  if (typeof raw.need === 'string' && (NEEDS as readonly string[]).includes(raw.need)) f.need = raw.need;
  if (typeof raw.purchase_timeline === 'string' && (TIMELINES as readonly string[]).includes(raw.purchase_timeline)) f.purchase_timeline = raw.purchase_timeline;
  if (typeof raw.wants_demo === 'boolean') f.wants_demo = raw.wants_demo;
  if (typeof raw.wants_quote === 'boolean') f.wants_quote = raw.wants_quote;
  const cn = cleanStr(raw.contact_name, 80); if (cn) f.contact_name = cn;
  const cl = cleanStr(raw.clinic_name, 100); if (cl) f.clinic_name = cl;
  const co = cleanStr(raw.commune, 60); if (co) f.commune = co;
  if (raw.high_intent === true) {
    f.high_intent = true;
    f.high_intent_reason = cleanStr(raw.high_intent_reason, 160);
  }
  return f;
}

// ---------- Estado ----------
export function missingContact(f: Fields): ('name' | 'clinic' | 'commune')[] {
  const m: ('name' | 'clinic' | 'commune')[] = [];
  if (!f.contact_name) m.push('name');
  if (!f.clinic_name) m.push('clinic');
  if (!f.commune) m.push('commune');
  return m;
}

export function nextStep(ctx: Ctx): Step {
  const f = ctx.fields;
  if (f.uses_intraoral_scanner === undefined) return 'q1';
  if (f.uses_intraoral_scanner === true && !f.current_scanner && !ctx.q1b_asked) return 'q1b';
  if (!f.need) return 'q2';
  if (!f.purchase_timeline) return 'q3';
  if (f.wants_demo === undefined && f.wants_quote === undefined) return 'q4';
  if (missingContact(f).length && (ctx.q5_asks ?? 0) < MAX_Q5_ASKS) return 'q5';
  return 'done';
}

export function leadReady(f: Fields): boolean {
  return f.uses_intraoral_scanner !== undefined && !!f.need;
}

export function mergeFields(base: Fields, add: Fields): { fields: Fields; changed: boolean } {
  const out: Fields = { ...base };
  let changed = false;
  for (const k of Object.keys(add) as (keyof Fields)[]) {
    const v = add[k];
    if (v === undefined) continue;
    if (k === 'high_intent_reason') continue;
    if ((out as any)[k] !== v) { (out as any)[k] = v; changed = true; }
  }
  if (add.high_intent && add.high_intent_reason && !out.high_intent_reason) out.high_intent_reason = add.high_intent_reason;
  if (out.uses_intraoral_scanner === false) delete out.current_scanner;
  return { fields: out, changed };
}

export function applyTurn(ctx: Ctx, parsed: Fields): { ctx: Ctx; changed: boolean; after: Step } {
  const m = mergeFields(ctx.fields, parsed);
  const c: Ctx = { ...ctx, fields: m.fields };
  return { ctx: c, changed: m.changed, after: nextStep(c) };
}

// ---------- Interpretación determinística ----------
export function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s\-–/]/g, ' ').replace(/\s+/g, ' ').trim();
}

const INTENT_RES: RegExp[] = [
  /quiero cotizar/, /necesito (una |la )?cotizacion/, /quiero (una |la )?cotizacion/,
  /(quiero|necesito|quisiera|me gustaria|deseo) (agendar |solicitar |coordinar )?(una |la )?(demo|demostracion)/,
  /quiero hacer (un |el )?trade ?up/, /quiero (cambiar|renovar) mi (scanner|escaner)/,
  /(necesito|quiero) comprar (un|mi) (scanner|escaner)/,
];
export function strongIntent(text: string): string | undefined {
  const n = norm(text);
  for (const re of INTENT_RES) { const m = n.match(re); if (m) return m[0].slice(0, 80); }
  return undefined;
}

/** Saludos/cortesías sin contenido: no se interpretan (evita que la IA "adivine" una respuesta). */
export function trivialMessage(text: string): boolean {
  const n = norm(text);
  return n.length > 0 && n.length <= 40 &&
    /^((hola|holi|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|ok|okey|gracias|saludos|alo|que tal|como estas|doctor|doctora|dr|dra|equipo|straumann)\s*)+$/.test(n);
}

/** Consultas de precio/descuento/condiciones: el bot no responde; deriva a un especialista y sigue el flujo. */
export function commercialQuestion(text: string): boolean {
  return /precio|cuesta|cuanto (sale|vale|cuesta)|valor|descuento|financ|cuotas|oferta|promo|stock|garantia/.test(norm(text));
}

export function fromInteractiveId(id: string): Fields {
  const f: Fields = {};
  const [q, v] = String(id).split(':');
  if (q === 'q1') { if (v === 'yes') f.uses_intraoral_scanner = true; if (v === 'no') f.uses_intraoral_scanner = false; }
  else if (q === 'q2' && (NEEDS as readonly string[]).includes(v)) f.need = v;
  else if (q === 'q3' && (TIMELINES as readonly string[]).includes(v)) f.purchase_timeline = v;
  else if (q === 'q4') {
    if (v === 'demo') { f.wants_demo = true; f.wants_quote = false; }
    else if (v === 'quote') { f.wants_demo = false; f.wants_quote = true; }
    else if (v === 'both') { f.wants_demo = true; f.wants_quote = true; }
    else if (v === 'info') { f.wants_demo = false; f.wants_quote = false; }
  }
  return f;
}

/** Interpretación sin IA, solo para la pregunta pendiente (respaldo si la IA falla). */
export function keywordExtract(text: string, pending: Step, cur: Fields): Fields {
  const t = norm(text);
  const f: Fields = {};
  if (!t) return f;
  const num = t.match(/^(\d)$/); // respuesta numérica a opciones en texto plano
  if (pending === 'q1') {
    if (['si', 'claro', 'ya tengo', 'si tengo', 'si utilizo', 'si uso', 'tengo uno', '1'].includes(t)) f.uses_intraoral_scanner = true;
    else if (['no', 'no tengo', 'no utilizo', 'no uso', 'aun no', 'todavia no', '2'].includes(t)) f.uses_intraoral_scanner = false;
  } else if (pending === 'q1b') {
    if (t.length <= 60) f.current_scanner = cleanStr(text, 60);
  } else if (pending === 'q2') {
    const idx = num ? Number(num[1]) - 1 : -1;
    if (idx >= 0 && idx < NEEDS.length) f.need = NEEDS[idx];
    else if (/trade ?up/.test(t)) f.need = 'trade_up';
    else if (/renov|cambiar/.test(t)) f.need = 'renew';
    else if (/primer/.test(t)) f.need = 'first_scanner';
    else if (/flujo/.test(t)) f.need = 'digital_flow';
    else if (/sirios/.test(t)) f.need = 'know_sirios';
    else if (/informacion/.test(t)) f.need = 'information_only';
  } else if (pending === 'q3') {
    const idx = num ? Number(num[1]) - 1 : -1;
    if (idx >= 0 && idx < TIMELINES.length) f.purchase_timeline = TIMELINES[idx];
    else if (/ahora|inmediat/.test(t)) f.purchase_timeline = 'now';
    else if (/(1|uno) ?(-|a|–) ?(3|tres)|un par de meses|dos meses|tres meses|proximo mes/.test(t)) f.purchase_timeline = '1_3_months';
    else if (/(3|tres) ?(-|a|–) ?(6|seis)|seis meses/.test(t)) f.purchase_timeline = '3_6_months';
    else if (/mas adelante|despues|futuro/.test(t)) f.purchase_timeline = 'later';
    else if (/evaluando|solo viendo/.test(t)) f.purchase_timeline = 'evaluating';
  } else if (pending === 'q4') {
    const demo = /demo/.test(t), quote = /cotiz|propuesta|presupuesto/.test(t);
    const idx = num ? Number(num[1]) : 0;
    if (idx === 1 || (demo && !quote && !/ambas|las dos/.test(t))) { f.wants_demo = true; f.wants_quote = false; }
    else if (idx === 2 || (quote && !demo)) { f.wants_demo = false; f.wants_quote = true; }
    else if (idx === 3 || /ambas|las dos|ambos/.test(t) || (demo && quote)) { f.wants_demo = true; f.wants_quote = true; }
    else if (idx === 4 || /solo informacion|por ahora solo|ninguno|ninguna/.test(t)) { f.wants_demo = false; f.wants_quote = false; }
  } else if (pending === 'q5') {
    const parts = text.split(/[,;\n]+/).map((p) => cleanStr(p, 100)).filter(Boolean) as string[];
    const miss = missingContact(cur);
    if (parts.length === 3 && miss.length === 3) { f.contact_name = parts[0]; f.clinic_name = parts[1]; f.commune = parts[2]; }
    else if (parts.length === 1 && miss.length === 1) {
      if (miss[0] === 'name') f.contact_name = parts[0];
      if (miss[0] === 'clinic') f.clinic_name = parts[0];
      if (miss[0] === 'commune') f.commune = parts[0];
    } else if (parts.length === miss.length) {
      miss.forEach((m, i) => { if (m === 'name') f.contact_name = parts[i]; if (m === 'clinic') f.clinic_name = parts[i]; if (m === 'commune') f.commune = parts[i]; });
    }
  }
  return sanitizeFields(f);
}

export const _cleanStr = cleanStr;
