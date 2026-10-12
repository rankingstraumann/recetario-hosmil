// summary.ts — ai_summary DETERMINÍSTICO: solo campos almacenados, sin interpretación.
import type { Fields } from './engine.ts';

const NEED_PHRASE: Record<string, string> = {
  renew: 'busca renovar su scanner',
  trade_up: 'está evaluando Trade Up',
  first_scanner: 'busca comprar su primer scanner',
  digital_flow: 'busca mejorar su flujo digital',
  know_sirios: 'quiere conocer SIRIOS',
  information_only: 'solo busca información',
};
const TL_PHRASE: Record<string, string> = {
  now: 'de forma inmediata', '1_3_months': 'en 1–3 meses', '3_6_months': 'en 3–6 meses',
  later: 'más adelante', evaluating: 'aún evaluando plazos',
};

export function buildSummary(f: Fields): string {
  const s: string[] = [];
  const who = [f.contact_name, f.clinic_name].filter(Boolean).join(', ');
  if (who) s.push(`${who}${f.commune ? ` en ${f.commune}` : ''}.`);
  else if (f.commune) s.push(`Contacto en ${f.commune}.`);

  const scanner = f.uses_intraoral_scanner === true
    ? (f.current_scanner ? `Actualmente utiliza ${f.current_scanner}` : 'Actualmente utiliza un scanner intraoral')
    : f.uses_intraoral_scanner === false ? 'No utiliza scanner intraoral actualmente' : '';
  const need = f.need ? NEED_PHRASE[f.need] : '';
  const tl = f.purchase_timeline ? TL_PHRASE[f.purchase_timeline] : '';
  const mid = [need, tl].filter(Boolean).join(' ');
  if (scanner && mid) s.push(`${scanner} y ${mid}.`);
  else if (scanner) s.push(`${scanner}.`);
  else if (mid) s.push(`${mid[0].toUpperCase()}${mid.slice(1)}.`);

  if (f.wants_demo && f.wants_quote) s.push('Solicita demo y propuesta comercial.');
  else if (f.wants_demo) s.push('Solicita una demo.');
  else if (f.wants_quote) s.push('Solicita una propuesta comercial.');
  else if (f.wants_demo === false && f.wants_quote === false) s.push('Por ahora solo solicita información.');

  if (f.high_intent) s.push('Manifestó intención explícita de avanzar.');
  return s.join(' ');
}
