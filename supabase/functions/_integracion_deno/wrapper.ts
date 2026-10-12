// Envuelve un index.ts REAL de Edge Function para ejecutarlo localmente con Deno, sin tocar su codigo:
//  - captura Deno.serve y lo levanta en 127.0.0.1:<puerto>
//  - redirige https://supabase.test -> router local (PostgREST + Storage falso) y https://api.resend.com -> mock de Resend
// Uso: deno run --allow-net --allow-env --allow-read wrapper.ts <ruta index.ts> <puerto>
const [entry, port] = Deno.args;
const mapa: Record<string, string> = { 'https://supabase.test': Deno.env.get('ROUTER_BASE')!, 'https://api.resend.com': Deno.env.get('RESEND_BASE')! };
const original = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: any, init?: any) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  for (const [k, v] of Object.entries(mapa)) if (u.startsWith(k)) return original(v + u.slice(k.length), init ?? (typeof input === 'object' && !(input instanceof URL) ? input : undefined));
  return original(input, init);
}) as typeof fetch;
const serve = Deno.serve.bind(Deno);
(Deno as any).serve = (h: Deno.ServeHandler) => serve({ port: Number(port), hostname: '127.0.0.1', onListen() { console.log('LISTO'); } }, h);
await import(new URL(entry, 'file://' + Deno.cwd() + '/').href);
