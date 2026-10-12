// outbound-sirios.ts — OUTBOUND 9A: journey conversacional "outbound_sirios" (funnel de descubrimiento y evaluacion SIRIOS / SIRIOS X3).
// Fuente de verdad: docs/leads-digital/OUTBOUND_9_ESTRATEGIA_SIRIOS.md. Modulo PURO (sin I/O, sin IA, sin red): totalmente deterministico.
// Coexiste con Inbound V1 en el MISMO webhook: se activa solo si session.context.journey === 'outbound_sirios'. NO desplegado (9A).
// Reutiliza q1..q5 de digital_lead_sessions (sin migracion): q1 perfil, q2 situacion, q3 necesidad, q4 scanner|CTA, q5 CTA|contacto|timing.
import { firstName, keywordExtract, norm, trivialMessage, _cleanStr, type Ctx, type Fields, type Out, type Step } from './engine.ts';
import { pickReplyTarget, type SentRow } from './reply.ts';
import { buildSummary } from './summary.ts';

export const MAX_QUESTIONS = 5;
export const JOURNEY = 'outbound_sirios' as const;

export const PROFILES = ['owner_partner', 'clinician', 'postgraduate', 'explorer'] as const;
export const ROUTES = ['trade_up', 'first_scanner', 'renewal_workflow', 'postgraduate_influencer', 'exploration'] as const;
export const PRODUCTS = ['sirios', 'sirios_x3', 'compare', 'undecided'] as const;
export const CTAS = ['request_evaluation', 'trade_up_evaluation', 'demo', 'specialist', 'financing', 'share_clinic', 'compare', 'learn_sirios', 'learn_sirios_x3', 'information'] as const;

// ---------- Textos al cliente (NUNCA mencionan metas, Q4, cierre de trimestre ni presion comercial interna) ----------
export const OPENING =
  '¡Excelente! Podemos ayudarte a evaluar SIRIOS o SIRIOS X3 según tu realidad clínica, tu flujo actual y la alternativa comercial que mejor se ajuste a tu caso.\n\nAdemás, contamos con alternativas de crédito directo de hasta 36 cuotas, sujeto a evaluación comercial.\n\nPara orientarte mejor, son solo unas preguntas rápidas.';
export const FIN_REPLY = 'Las condiciones dependen de la evaluación comercial de cada caso. Nuestro equipo puede revisar contigo las alternativas disponibles.';
export const PRICE_REPLY = 'Los valores y condiciones se revisan con nuestro equipo en la evaluación comercial, según tu caso.';
export const ROUTE_MSG: Record<string, string> = {
  trade_up: 'Perfecto. Tu equipo actual puede ser el punto de partida.\n\nPodemos evaluar tu escáner y revisar una alternativa de Trade Up hacia SIRIOS o SIRIOS X3, junto con las condiciones comerciales y alternativas de financiamiento disponibles.',
  first_scanner: 'Dar el primer paso hacia un flujo digital no tiene por qué ser complejo.\n\nPodemos ayudarte a evaluar si SIRIOS o SIRIOS X3 hace más sentido para tu clínica y revisar alternativas de crédito directo de hasta 36 cuotas, sujeto a evaluación comercial.',
  renewal_workflow: 'Podemos revisar cómo SIRIOS o SIRIOS X3 puede integrarse a tu flujo actual y qué alternativa hace más sentido para lo que quieres mejorar.',
  postgraduate_influencer: 'Si estás en postgrado o formación clínica, conocer distintas soluciones digitales puede ayudarte a entender mejor cómo integrar estas tecnologías a tu práctica.\n\nPodemos mostrarte SIRIOS y SIRIOS X3, comparar las alternativas y, si ves una oportunidad en tu clínica o entorno profesional, preparar una evaluación comercial para revisarla con quienes toman la decisión.',
  exploration: 'Sin problema, podemos mostrarte la tecnología y comparar las alternativas a tu ritmo, sin compromiso.',
};

interface Opt { id: string; title: string; desc?: string }
const PROFILE_OPTS: Opt[] = [
  { id: 'owner_partner', title: 'Dueño/a o socio/a', desc: 'Soy dueño/a o socio/a de una clínica' },
  { id: 'clinician', title: 'Trabajo en una clínica', desc: 'Trabajo en una clínica o centro odontológico' },
  { id: 'postgraduate', title: 'Postgrado / formación', desc: 'Estoy en postgrado / formación clínica' },
  { id: 'explorer', title: 'Conociendo alternativas', desc: 'Solo estoy conociendo alternativas' },
];
const NEED_OPTS: Opt[] = [
  { id: 'renew', title: 'Renovar mi escáner', desc: 'Cambiar o renovar mi escáner' },
  { id: 'trade_up', title: 'Evaluar Trade Up' },
  { id: 'first_scanner', title: 'Mi primer escáner', desc: 'Incorporar mi primer escáner' },
  { id: 'digital_flow', title: 'Mejorar mi flujo digital' },
  { id: 'compare', title: 'Comparar SIRIOS / X3', desc: 'Comparar SIRIOS y SIRIOS X3' },
  { id: 'know_sirios', title: 'Conocer la tecnología' },
];
const CTA_OPTS: Record<string, Opt[]> = {
  trade_up: [
    { id: 'trade_up_evaluation', title: 'Evaluar mi Trade Up' }, { id: 'compare', title: 'Comparar SIRIOS / X3', desc: 'Comparar SIRIOS / SIRIOS X3' },
    { id: 'demo', title: 'Agendar una demostración' }, { id: 'specialist', title: 'Hablar con especialista', desc: 'Hablar con un especialista' }],
  first_scanner: [
    { id: 'compare', title: 'Comparar ambos', desc: 'Comparar SIRIOS y SIRIOS X3' }, { id: 'learn_sirios', title: 'Conocer SIRIOS' },
    { id: 'learn_sirios_x3', title: 'Conocer SIRIOS X3' }, { id: 'demo', title: 'Ver una demostración' }],
  renewal_workflow: [
    { id: 'request_evaluation', title: 'Pedir mi evaluación', desc: 'Pedir mi evaluación comercial' }, { id: 'compare', title: 'Comparar SIRIOS / X3', desc: 'Comparar SIRIOS / SIRIOS X3' },
    { id: 'demo', title: 'Agendar una demostración' }, { id: 'specialist', title: 'Hablar con especialista', desc: 'Hablar con un especialista' }],
  postgraduate_influencer: [
    { id: 'compare', title: 'Comparar SIRIOS / X3', desc: 'Comparar SIRIOS / SIRIOS X3' }, { id: 'demo', title: 'Quiero una demostración' },
    { id: 'financing', title: 'Ver financiamiento', desc: 'Conocer opciones de financiamiento' }, { id: 'share_clinic', title: 'Compartir con mi clínica', desc: 'Compartir esta opción con mi clínica' }],
  exploration: [
    { id: 'compare', title: 'Comparar SIRIOS / X3', desc: 'Comparar SIRIOS / SIRIOS X3' }, { id: 'learn_sirios', title: 'Conocer SIRIOS' }, { id: 'learn_sirios_x3', title: 'Conocer SIRIOS X3' },
    { id: 'demo', title: 'Ver demostración' }, { id: 'specialist', title: 'Hablar con especialista', desc: 'Hablar con un especialista' }],
};
const TIMING_OPTS: Opt[] = [
  { id: 'now', title: 'Ahora / este mes' }, { id: '1_3_months', title: '1–3 meses' }, { id: '3_6_months', title: '3–6 meses' },
  { id: 'later', title: 'Más adelante' }, { id: 'evaluating', title: 'Solo estoy evaluando' },
];

// ---------- Prospecto: resolucion inequivoca + prellenado seguro ----------
export interface ProspectLite { id: string; full_name?: string | null; clinic_name?: string | null; commune?: string | null; outreach_status?: string; is_test?: boolean }

/** Reutiliza la logica CONSERVADORA de reply.ts: solo devuelve un prospecto si es inequivoco; ambiguo/ninguno => null (nunca se elige uno arbitrario). */
export function resolveOutboundProspect(candidates: ProspectLite[], sent: SentRow[]): { kind: 'one'; id: string } | { kind: 'none' | 'ambiguous' } {
  const ids = candidates.filter((c) => c.outreach_status === 'contacted' || c.outreach_status === 'replied').map((c) => c.id);
  const t = pickReplyTarget(ids, sent);
  return t.kind === 'one' ? { kind: 'one', id: t.id } : { kind: t.kind };
}

/** Contexto inicial del journey a partir de un prospecto YA resuelto de forma inequivoca. 9A: solo se inyecta en pruebas. */
export function startOutboundCtx(prospect: ProspectLite): Ctx {
  const fields: Fields = {};
  const n = _cleanStr(prospect.full_name, 80); if (n) fields.contact_name = n;
  const c = _cleanStr(prospect.clinic_name, 100); if (c) fields.clinic_name = c;
  const m = _cleanStr(prospect.commune, 60); if (m) fields.commune = m;
  return { fields, journey: JOURNEY, greeted: true, first_turn: true, llm_calls: 0, msg_count: 0, o: { asked: [], done: [], prospect_id: prospect.id } };
}

// ---------- Ruta comercial ----------
export function computeRoute(f: Fields, needKnown: boolean): string | undefined {
  if (!needKnown) return undefined;
  if (f.need === 'trade_up') return 'trade_up';
  if (f.need === 'first_scanner') return 'first_scanner';
  if (f.need === 'renew' || f.need === 'digital_flow') return 'renewal_workflow';
  return f.customer_profile === 'postgraduate' ? 'postgraduate_influencer' : 'exploration';
}

function needKnown(ctx: Ctx): boolean { const f = ctx.fields; return !!ctx.o!.done.includes('need') || !!f.need || f.product_interest === 'compare'; }

/** Datos de contacto realmente necesarios: nombre, clinica (opcional para postgrado) y comuna. */
export function missingContactOut(f: Fields): ('name' | 'clinic' | 'commune')[] {
  const m: ('name' | 'clinic' | 'commune')[] = [];
  if (!f.contact_name) m.push('name');
  if (!f.clinic_name && f.customer_profile !== 'postgraduate') m.push('clinic');
  if (!f.commune) m.push('commune');
  return m;
}

// ---------- Planificador deterministico ----------
export type Kind = 'profile' | 'digital' | 'need' | 'scanner' | 'cta' | 'contact' | 'timing';
export function planNext(ctx: Ctx): Kind | null {
  const f = ctx.fields, o = ctx.o!, D = o.done;
  let k: Kind | null = null;
  const route = computeRoute(f, needKnown(ctx));
  if (!f.customer_profile && !D.includes('profile')) k = 'profile';
  else if (f.uses_intraoral_scanner === undefined && !D.includes('digital')) k = 'digital';
  else if (!needKnown(ctx)) k = 'need';
  else if ((route === 'trade_up' || route === 'renewal_workflow') && f.uses_intraoral_scanner === true && !f.current_scanner && !D.includes('scanner')) k = 'scanner';
  else if (!f.cta_selected && !D.includes('cta')) k = 'cta';
  else {
    const miss = missingContactOut(f);
    if (miss.length && !D.includes('contact')) k = 'contact';
    else if (!miss.length && !f.purchase_timeline && !D.includes('timing')) k = 'timing';
  }
  if (!k) return null;
  // Presupuesto: maximo 5 preguntas distintas. Repetir la misma pendiente (p. ej. tras un saludo) no consume presupuesto.
  if (!o.asked.includes(k) && o.asked.length >= MAX_QUESTIONS) return null;
  return k;
}

export function stepFor(kind: Kind, ctx: Ctx): Step {
  switch (kind) {
    case 'profile': return 'q1';
    case 'digital': return 'q2';
    case 'need': return 'q3';
    case 'scanner': return 'q4';
    case 'cta': return ctx.o!.asked.includes('scanner') ? 'q5' : 'q4';
    default: return 'q5';
  }
}

export function questionOut(kind: Kind, ctx: Ctx): Out {
  const step = stepFor(kind, ctx), f = ctx.fields;
  const rows = (opts: Opt[]) => opts.map((x) => ({ id: `o9:${kind}:${x.id}`, title: x.title, ...(x.desc ? { description: x.desc } : {}) }));
  switch (kind) {
    case 'profile': return { kind: 'list', step, body: 'Para orientarte mejor, ¿cuál de estas opciones te representa más hoy?', rows: rows(PROFILE_OPTS) };
    case 'digital': {
      const post = f.customer_profile === 'postgraduate';
      const buttons = [{ id: 'o9:digital:yes', title: 'Sí' }, { id: 'o9:digital:no', title: 'No' }, ...(post ? [{ id: 'o9:digital:unsure', title: 'No estoy seguro' }] : [])];
      return { kind: 'buttons', step, buttons, body: post
        ? '¿En la clínica donde trabajas, estudias o tienes mayor cercanía utilizan actualmente un escáner intraoral?'
        : '¿Actualmente trabajan con un escáner intraoral?' };
    }
    case 'need': return { kind: 'list', step, body: '¿Qué te interesaría evaluar principalmente?', rows: rows(NEED_OPTS) };
    case 'scanner': return { kind: 'text', step, body: '¿Qué escáner utilizan actualmente?' };
    case 'cta': return { kind: 'list', step, body: '¿Cómo te gustaría continuar?', rows: rows(ctaOpts(ctx)) };
    case 'timing': return { kind: 'list', step, body: '¿En qué momento te gustaría avanzar?', rows: rows(TIMING_OPTS) };
    case 'contact': {
      const miss = missingContactOut(f), n = firstName(f.contact_name);
      const names: Record<string, string> = { name: 'tu nombre', clinic: 'el nombre de tu clínica', commune: 'tu comuna' };
      const list = miss.map((m) => names[m]);
      const txt = list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0];
      const lead = n ? `Perfecto, ${n}. ` : '';
      return { kind: 'text', step, body: list.length > 1
        ? `${lead}Para conectar tu evaluación con el equipo adecuado, ¿me compartes ${txt}?`
        : `${lead}Para conectar tu evaluación con el equipo adecuado, solo me falta ${txt}.` };
    }
  }
}
function ctaOpts(ctx: Ctx): Opt[] { return CTA_OPTS[computeRoute(ctx.fields, needKnown(ctx)) || 'exploration']; }
function optsFor(kind: string, ctx: Ctx): Opt[] {
  if (kind === 'profile') return PROFILE_OPTS; if (kind === 'need') return NEED_OPTS; if (kind === 'cta') return ctaOpts(ctx); if (kind === 'timing') return TIMING_OPTS;
  if (kind === 'digital') return [{ id: 'yes', title: 'Sí' }, { id: 'no', title: 'No' }, { id: 'unsure', title: 'No estoy seguro' }];
  return [];
}

// ---------- Cierres (listos en codigo; NO activos en produccion hasta 9B) ----------
export function outboundClosing(f: Fields): string {
  const n = firstName(f.contact_name);
  const p = n ? `Perfecto, ${n}.` : 'Perfecto.';
  switch (f.commercial_route) {
    case 'trade_up': return `${p} Ya tenemos lo necesario para evaluar tu caso. Revisaremos tu equipo actual y qué alternativa SIRIOS/SIRIOS X3 puede ajustarse mejor, junto con las condiciones comerciales disponibles. Tu Evaluación de Trade Up quedó solicitada.`;
    case 'first_scanner': return `${p} Ya tenemos lo necesario para evaluar tu caso. Revisaremos qué alternativa SIRIOS/SIRIOS X3 puede ajustarse mejor a tu clínica y las opciones comerciales disponibles. Tu Evaluación SIRIOS quedó solicitada.`;
    case 'renewal_workflow': return `${p} Ya tenemos lo necesario para evaluar cómo SIRIOS/SIRIOS X3 puede integrarse a tu flujo actual. Tu Evaluación SIRIOS quedó solicitada.`;
    case 'postgraduate_influencer':
      if (f.cta_selected === 'share_clinic') return `${p} Dejamos lista la información para que puedas continuar la evaluación de SIRIOS/SIRIOS X3 junto a tu entorno clínico. Nuestro equipo te acompañará en ese paso.`;
      if (f.cta_selected === 'demo') return `${p} Dejamos registrada tu solicitud de demostración de SIRIOS/SIRIOS X3. Nuestro equipo te contactará para coordinarla.`;
      if (f.cta_selected === 'financing') return `${p} Dejamos registrada tu consulta sobre las alternativas de financiamiento. Nuestro equipo te contará cómo funcionan, sujeto a evaluación comercial.`;
      return `${p} Dejamos registrada tu solicitud para comparar SIRIOS y SIRIOS X3. Nuestro equipo te contactará para continuar.`;
    default: return `${p} Gracias por tu interés en SIRIOS y SIRIOS X3. Dejamos registrada tu consulta; cuando quieras ver una demostración o comparar las alternativas, escríbenos por este mismo canal.`;
  }
}

/** ai_summary deterministico: resumen existente + campos del journey (solo valores almacenados). */
export function outboundSummary(f: Fields): string {
  const lab: Record<string, string> = { owner_partner: 'dueño/a o socio/a', clinician: 'trabaja en clínica', postgraduate: 'postgrado/formación', explorer: 'explorando' };
  const x = [buildSummary(f)];
  const extra = [f.customer_profile && `Perfil: ${lab[f.customer_profile] || f.customer_profile}`, f.commercial_route && `Ruta: ${f.commercial_route}`,
    f.product_interest && `Interés: ${f.product_interest}`, f.cta_selected && `CTA: ${f.cta_selected}`].filter(Boolean).join(' · ');
  if (extra) x.push(extra + '.');
  return x.filter(Boolean).join(' ');
}

// ---------- Interpretacion deterministica ----------
const REASON = {
  quote: 'solicita cotización o propuesta', demo: 'solicita una demostración', evaluation: 'solicita evaluación comercial', trade_up: 'solicita evaluación de Trade Up',
  now: 'quiere avanzar ahora', financing: 'consulta por cuotas o financiamiento', specialist: 'quiere hablar con un especialista', x3: 'manifiesta interés directo en SIRIOS X3',
} as const;

function parseProfile(t: string): string | undefined {
  if (/duen|socio|propietari|mi clinica|mi consulta/.test(t)) return 'owner_partner';
  if (/postgrad|formacion|estudi|residen|magister|diplomad|especializ/.test(t)) return 'postgraduate';
  if (/trabajo en|asociado|clinica|centro|odontolog|dentista/.test(t)) return 'clinician';
  if (/conociendo|solo mirando|explor|alternativas|curiosi/.test(t)) return 'explorer';
  return undefined;
}
function parseDigital(t: string): 'yes' | 'no' | 'unsure' | undefined {
  if (/no estoy seguro|no se\b|no sabria|ni idea|no lo se/.test(t)) return 'unsure';
  if (/^(no|aun no|todavia no)$|^no (tenemos|usamos|utilizamos|tengo|uso|utilizo|trabajamos)/.test(t)) return 'no';
  if (/^(si|claro|ya)\b|^(tenemos|usamos|utilizamos|trabajamos|tengo|uso|utilizo)\b/.test(t)) return 'yes';
  return undefined;
}
function parseNeed(t: string): string | undefined {
  if (/trade ?up/.test(t)) return 'trade_up';
  if (/renov|cambiar/.test(t)) return 'renew';
  if (/primer/.test(t)) return 'first_scanner';
  if (/flujo/.test(t)) return 'digital_flow';
  if (/compar|ambos|los dos|las dos|ambas/.test(t)) return 'compare';
  if (/conocer|tecnolog|informacion/.test(t)) return 'know_sirios';
  return undefined;
}
function parseCta(t: string): string | undefined {
  if (/trade ?up/.test(t)) return 'trade_up_evaluation';
  if (/financ|cuota|credito/.test(t)) return 'financing';
  if (/compart.*clinica|mi clinica/.test(t)) return 'share_clinic';
  if (/demo/.test(t)) return 'demo';
  if (/especialista|alguien|asesor|ejecutivo|llamen|llamar/.test(t)) return 'specialist';
  if (/compar|ambos|los dos|ambas/.test(t)) return 'compare';
  if (/x ?3/.test(t)) return 'learn_sirios_x3';
  if (/sirios|conocer/.test(t)) return 'learn_sirios';
  if (/evaluacion|evaluar|cotiz|propuesta/.test(t)) return 'request_evaluation';
  return undefined;
}
function matchOption(opts: Opt[], raw: string, t: string): string | undefined {
  const num = t.match(/^(\d)$/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= opts.length) return opts[Number(num[1]) - 1].id;
  const hit = opts.find((o) => norm(o.title) === t || (o.desc && norm(o.desc) === t));
  return hit?.id;
}

interface Signals { fields: Fields; financing: boolean; price: boolean; any: boolean }
/** Intencion en texto libre (solo journey outbound; NO toca el Inbound V1). high_intent_reason es una etiqueta fija, no eco del texto. */
export function sigsFromText(text: string): Signals {
  const t = norm(text), f: Fields = {}; let any = false, hi: string | undefined;
  const financing = /cuota|financ|credito|\btasa\b|\bcae\b|interes|cuanto queda|cuanto sale la cuota/.test(t);
  const price = !financing && /precio|cuanto (cuesta|sale|vale)|valor|descuento|cotiz.*precio/.test(t);
  const noX3 = t.replace(/sirios ?x ?3|\bx ?3\b/g, ' ');
  const x3 = noX3 !== t, sirios = /sirios/.test(noX3);
  if ((x3 && sirios) || /\b(comparar|ambos|los dos|las dos|ambas)\b/.test(t)) { f.product_interest = 'compare'; any = true; }
  else if (x3) { f.product_interest = 'sirios_x3'; any = true; if (/quiero|necesito|me interesa|prefiero|elijo/.test(t)) hi = hi || REASON.x3; }
  else if (sirios) { f.product_interest = 'sirios'; any = true; }
  else if (/no se cual|no me decido|indeciso|no tengo claro/.test(t)) { f.product_interest = 'undecided'; any = true; }
  const quote = /cotiz|propuesta|presupuesto/.test(t);
  const demo = /\b(demo|demostracion)\b/.test(t) && !/no (quiero|necesito) (una )?(demo|demostracion)/.test(t);
  const trade = /trade ?up/.test(t) && /(quiero|necesito|evaluar|hacer|pedir|solicit)/.test(t);
  const evaluation = /(evaluacion|evaluar)/.test(t) && /(quiero|necesito|pedir|pido|solicit)/.test(t);
  const spec = /(hablar|conversar|contactar|comunicar).{0,25}(alguien|especialista|ejecutivo|asesor|persona)|que me (llamen|contacten)|llamenme/.test(t);
  if (trade) { f.need = 'trade_up'; f.cta_selected = 'trade_up_evaluation'; f.wants_quote = true; hi = hi || REASON.trade_up; any = true; }
  else if (quote) { f.cta_selected = 'request_evaluation'; f.wants_quote = true; hi = hi || REASON.quote; any = true; }
  else if (evaluation) { f.cta_selected = 'request_evaluation'; f.wants_quote = true; hi = hi || REASON.evaluation; any = true; }
  if (demo) { f.cta_selected = f.cta_selected || 'demo'; f.wants_demo = true; hi = hi || REASON.demo; any = true; }
  if (spec) { f.cta_selected = f.cta_selected || 'specialist'; hi = hi || REASON.specialist; any = true; }
  if (/(avanzar|comprar|adquirir|cambiar).{0,25}(ahora|este mes)|este mes|lo antes posible/.test(t)) { f.purchase_timeline = 'now'; hi = hi || REASON.now; any = true; }
  if (financing) { f.cta_selected = f.cta_selected || 'financing'; hi = hi || REASON.financing; any = true; }
  if (hi) { f.high_intent = true; f.high_intent_reason = hi; }
  return { fields: f, financing, price, any: any || financing || price };
}

function applyCtaEffects(f: Fields, cta: string): void {
  f.cta_selected = cta;
  if (cta === 'trade_up_evaluation') { f.wants_quote = true; f.high_intent = true; f.high_intent_reason ||= REASON.trade_up; if (!f.need) f.need = 'trade_up'; }
  else if (cta === 'request_evaluation') { f.wants_quote = true; f.high_intent = true; f.high_intent_reason ||= REASON.evaluation; }
  else if (cta === 'demo') { f.wants_demo = true; f.high_intent = true; f.high_intent_reason ||= REASON.demo; }
  else if (cta === 'specialist') { f.high_intent = true; f.high_intent_reason ||= REASON.specialist; }
  else if (cta === 'financing') { f.high_intent = true; f.high_intent_reason ||= REASON.financing; }
  else if (cta === 'compare') f.product_interest = 'compare';
  else if (cta === 'learn_sirios') f.product_interest = 'sirios';
  else if (cta === 'learn_sirios_x3') f.product_interest = 'sirios_x3';
}

function mergeOut(base: Fields, add: Fields): Fields {
  const out: Fields = { ...base };
  for (const k of Object.keys(add) as (keyof Fields)[]) {
    const v = add[k]; if (v === undefined) continue;
    if (k === 'high_intent_reason') { if (!out.high_intent_reason) out.high_intent_reason = v as string; continue; }
    // wants_*: un "no" posterior no pisa un "si" ya capturado
    (out as any)[k] = v;
  }
  return out;
}

export interface OutTurn { ctx: Ctx; outs: Out[]; done: boolean; kind: Kind | null; step: Step | 'done' }

/** Un turno del journey. Entrada: ctx (journey=outbound_sirios) + mensaje. Salida: ctx nuevo + mensajes a enviar. */
export function outboundTurn(ctxIn: Ctx, inb: { text: string; interactiveId?: string }): OutTurn {
  const o0 = ctxIn.o || { asked: [], done: [] };
  let ctx: Ctx = { ...ctxIn, journey: JOURNEY, greeted: true, fields: { ...ctxIn.fields }, o: { ...o0, asked: [...o0.asked], done: [...o0.done] } };
  const o = ctx.o!;
  const outs: Out[] = [];
  const text = inb.text || '';
  const t = norm(text);
  const trivial = trivialMessage(text);
  const pend = o.pending_kind as Kind | undefined;
  const first = !o.opened;

  let add: Fields = {}; let sig: Signals = { fields: {}, financing: false, price: false, any: false }; let answered = false;
  const id = inb.interactiveId && inb.interactiveId.startsWith('o9:') ? inb.interactiveId.split(':') : null;
  const set = (k: Kind) => { if (!o.done.includes(k)) o.done.push(k); };
  const takeProfile = (v: string) => { add.customer_profile = v; answered = true; };
  const takeDigital = (v: string) => { if (v === 'yes') add.uses_intraoral_scanner = true; else if (v === 'no') add.uses_intraoral_scanner = false; answered = true; /* 'unsure' => queda undefined */ };
  const takeNeed = (v: string) => { if (v === 'compare') add.product_interest = 'compare'; else add.need = v; answered = true; };
  const takeCta = (v: string) => { const g: Fields = {}; applyCtaEffects(g, v); add = mergeOut(add, g); answered = true; };

  if (id && pend && id[1] === pend) {
    const v = id[2];
    if (pend === 'profile' && (PROFILES as readonly string[]).includes(v)) takeProfile(v);
    else if (pend === 'digital' && ['yes', 'no', 'unsure'].includes(v)) takeDigital(v);
    else if (pend === 'need' && optsFor('need', ctx).some((x) => x.id === v)) takeNeed(v);
    else if (pend === 'cta' && (CTAS as readonly string[]).includes(v)) takeCta(v);
    else if (pend === 'timing' && optsFor('timing', ctx).some((x) => x.id === v)) { add.purchase_timeline = v; answered = true; }
  } else if (!id && t) {
    sig = sigsFromText(text);
    if (pend && !trivial) {
      const byOpt = matchOption(optsFor(pend, ctx), text, t);
      if (pend === 'profile') { const v = byOpt || parseProfile(t); if (v) takeProfile(v); }
      else if (pend === 'digital') { const v = byOpt || parseDigital(t); if (v) takeDigital(v); }
      else if (pend === 'need') { const v = byOpt || parseNeed(t); if (v) takeNeed(v); }
      else if (pend === 'cta') { const v = byOpt || parseCta(t) || sig.fields.cta_selected; if (v) takeCta(v); }
      else if (pend === 'timing') { const k = byOpt ? { purchase_timeline: byOpt } as Fields : keywordExtract(text, 'q3', ctx.fields); if (k.purchase_timeline) { add.purchase_timeline = k.purchase_timeline; answered = true; } }
      else if (pend === 'scanner') {
        if (!sig.any && t.length <= 60 && !/no se|no estoy seguro|ni idea/.test(t)) { const c = _cleanStr(text, 60); if (c) { add.current_scanner = c; add.uses_intraoral_scanner = true; } }
        answered = !sig.any;
      } else if (pend === 'contact') {
        const parts = text.split(/[,;\n]+/).map((p) => _cleanStr(p, 100)).filter(Boolean) as string[];
        const miss = missingContactOut(ctx.fields);
        if (!sig.any && parts.length === miss.length) {
          miss.forEach((m, i) => { if (m === 'name') add.contact_name = parts[i]; if (m === 'clinic') add.clinic_name = parts[i]; if (m === 'commune') add.commune = parts[i]; });
          answered = true;
        } else if (!sig.any && parts.length > 0) answered = true; // texto sin forma esperada: no se repregunta (presupuesto)
      }
    }
  }

  ctx.fields = mergeOut(mergeOut(ctx.fields, sig.fields), add);
  // "pendiente resuelta": respondio, o escribio algo sin contenido de señal (no se repregunta en bucle); saludo/solo consulta => se repite sin consumir presupuesto
  if (pend) {
    if (answered || (!trivial && !sig.any && t && !id)) set(pend);
    else if (id && id[1] === pend && !answered) { /* id invalido: se repite */ }
  }
  // un CTA elegido por texto libre cuenta como resuelto
  if (ctx.fields.cta_selected) set('cta');
  // ruta
  const route = computeRoute(ctx.fields, needKnown(ctx));
  const routeNew = route && ctx.fields.commercial_route !== route;
  if (route) ctx.fields.commercial_route = route;

  // ----- salida -----
  if (first) { outs.push({ kind: 'text', body: OPENING }); o.opened = true; }
  if (sig.financing) outs.push({ kind: 'text', body: FIN_REPLY });
  else if (sig.price) outs.push({ kind: 'text', body: PRICE_REPLY });

  const next = planNext(ctx);
  if (next) {
    if (route && routeNew && !o.route_msg) { outs.push({ kind: 'text', body: ROUTE_MSG[route] }); o.route_msg = true; }
    if (!o.asked.includes(next)) o.asked.push(next);
    o.pending_kind = next;
    const q = questionOut(next, ctx);
    ctx.pending = q.step;
    outs.push(q);
    return { ctx, outs, done: false, kind: next, step: q.step as Step };
  }
  // cierre
  if (!ctx.fields.product_interest) ctx.fields.product_interest = 'undecided';
  if (!ctx.fields.commercial_route) ctx.fields.commercial_route = computeRoute(ctx.fields, true);
  if (!ctx.fields.cta_selected) ctx.fields.cta_selected = 'information';
  o.pending_kind = undefined;
  ctx.pending = 'done';
  outs.push({ kind: 'text', body: outboundClosing(ctx.fields) });
  return { ctx, outs, done: true, kind: null, step: 'done' };
}

/** Campos para persistir en digital_leads: SIN high_intent (en 9A la intencion fuerte solo queda en el contexto; el scoring no se toca). */
export function leadFieldsOut(f: Fields): Fields { const c = { ...f }; delete c.high_intent; delete c.high_intent_reason; return c; }
