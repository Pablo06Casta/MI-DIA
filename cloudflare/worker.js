// Mi Día — puente de la app con iCloud y con la IA de Cloudflare.
//
// GET  /?url=<enlace>  → lee un calendario público de iCloud (iCloud no deja que una web lo lea directamente).
// POST /consejo        → genera sugerencias para el día con Workers AI (necesita el enlace "AI" en Settings → Bindings).
// POST /noticias       → lee titulares de Google Noticias y El País y la IA hace el briefing del día.
//
// No guarda nada: recibe la petición, la resuelve y devuelve la respuesta a la app.

const ALLOWED_ORIGINS = ["https://pablo06casta.github.io", "http://localhost:8766"];
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Instrucciones por defecto. La app envía las suyas en "system", así se pueden cambiar sin tocar este puente.
const SYSTEM = `Eres el asistente de la app "Mi Día". Da 3 sugerencias prácticas para el día en español de España, una por línea, sin numeración.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/consejo") return advice(request, env, origin, cors);
    if (request.method === "POST" && path === "/noticias") return news(request, env, origin, cors);
    if (request.method === "GET") return calendar(request, cors);
    return new Response("Método no permitido", { status: 405, headers: cors });
  },
};

async function advice(request, env, origin, cors) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origen no permitido" }, 403);
  if (!env.AI) return json({ error: "Falta el enlace AI en Settings → Bindings" }, 500);

  let context = "", system = SYSTEM;
  try {
    const body = await request.json();
    context = String(body.context || "").slice(0, 3000);
    if (body.system) system = String(body.system).slice(0, 2000);
  } catch {}
  if (!context) return json({ error: "sin datos" }, 400);

  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: context },
      ],
      max_tokens: 220,
      temperature: 0.6,
    });
    const tips = String(out.response || "")
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((l) => l.length > 3)
      .slice(0, 4);
    return json({ tips });
  } catch (e) {
    return json({ error: "La IA no ha respondido" }, 502);
  }
}

async function calendar(request, cors) {
  const raw = new URL(request.url).searchParams.get("url") || "";
  let target;
  try {
    target = new URL(raw.replace(/^webcals?:\/\//i, "https://"));
  } catch {
    return new Response("Enlace no válido", { status: 400, headers: cors });
  }
  if (target.protocol !== "https:" || !/^p\d+-caldav\.icloud\.com$/.test(target.hostname) || !target.pathname.startsWith("/published/")) {
    return new Response("Solo se aceptan calendarios públicos de iCloud", { status: 403, headers: cors });
  }

  const res = await fetch(target.toString(), { headers: { "User-Agent": "MiDia/1.0" }, redirect: "follow" });
  return new Response(res.body, {
    status: res.status,
    headers: { ...cors, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/* ---------- briefing de noticias ---------- */

const GN = (path) => `https://news.google.com/rss/${path}${path.includes("?") ? "&" : "?"}hl=es&gl=ES&ceid=ES:es`;
const SECTIONS = [
  { id: "politica", title: "Política", feeds: [GN("headlines/section/topic/NATION"), "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/espana/portada"] },
  { id: "economia", title: "Economía", feeds: ["https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/economia/portada", GN("headlines/section/topic/BUSINESS")] },
  { id: "local", title: "", feeds: [] },
  { id: "deportes", title: "Deportes", feeds: [GN("headlines/section/topic/SPORTS")] },
];

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (t) => t
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m);
const strip = (t) => decode(decode(t)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function parseRSS(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = (n) => (it.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || "";
    let title = strip(tag("title"));
    let source = strip(tag("source"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const link = strip(tag("link"));
    const desc = link.includes("news.google.com") ? "" : strip(tag("description")).slice(0, 220);
    return { title, source: source || (link.includes("elpais.com") ? "El País" : ""), url: link, desc, date: Date.parse(strip(tag("pubDate"))) || 0 };
  }).filter((x) => x.title && x.url.startsWith("http"));
}

async function readFeed(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (MiDia)" }, cf: { cacheTtl: 900 } });
    return r.ok ? parseRSS(await r.text()) : [];
  } catch {
    return [];
  }
}

const NEWS_SYSTEM = `Eres el editor del briefing matinal de la app "Mi Día". Recibes titulares numerados por sección.
Para cada sección elige las 3 noticias más importantes (descarta loterías, horarios de partidos, publicidad y repetidas) y escribe un resumen de una o dos frases que explique qué ha pasado y por qué importa.
Escribe en español de España, claro y neutral. No inventes datos que no estén en el titular o la descripción.
Responde solo con JSON: {"intro":"una frase con lo más destacado del día","secciones":{"politica":[{"n":número,"resumen":"..."}],"economia":[...],"local":[...],"deportes":[...]}}`;

async function news(request, env, origin, cors) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origen no permitido" }, 403);

  let local = "", system = NEWS_SYSTEM;
  try {
    const body = await request.json();
    local = String(body.local || "").slice(0, 60).trim();
    if (body.system) system = String(body.system).slice(0, 3000);
  } catch {}

  const sections = SECTIONS.map((s) => ({ ...s }))
    .map((s) => s.id !== "local" ? s : local ? {
      ...s, title: local,
      feeds: [GN(`search?q=${encodeURIComponent(`"${local}" -fútbol -LaLiga -partido -baloncesto when:1d`)}`)],
    } : null)
    .filter(Boolean);

  // headlines of the last day and a half, newest first, without repeats
  const since = Date.now() - 36 * 3600 * 1000;
  let n = 0;
  const all = [];
  for (const s of sections) {
    const lists = await Promise.all(s.feeds.map(readFeed));
    const seen = new Set();
    s.items = lists.flat()
      .filter((x) => !x.date || x.date > since)
      .filter((x) => { const k = x.title.toLowerCase().slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 14)
      .map((x) => { x.n = ++n; all.push(x); return x; });
  }

  const fallback = () => sections.map((s) => ({ id: s.id, title: s.title, items: s.items.slice(0, 3).map(({ title, source, url }) => ({ title, source, url, summary: "" })) }));
  if (!env.AI) return json({ intro: "", sections: fallback(), ai: false });

  const prompt = sections.map((s) =>
    `## ${s.id}${s.id === "local" ? ` (noticias de ${local}, sin deportes)` : ""}\n` +
    s.items.map((x) => `${x.n}. ${x.title}${x.source ? ` (${x.source})` : ""}${x.desc ? ` — ${x.desc}` : ""}`).join("\n")
  ).join("\n\n");

  try {
    const out = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: 1400,
      temperature: 0.3,
    });
    const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
    const data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const byN = new Map(all.map((x) => [x.n, x]));
    const result = sections.map((s) => {
      const picks = (data.secciones?.[s.id] || [])
        .map((p) => ({ item: byN.get(+p.n), summary: String(p.resumen || "").trim() }))
        .filter((p) => p.item && s.items.includes(p.item))
        .slice(0, 3)
        .map(({ item, summary }) => ({ title: item.title, source: item.source, url: item.url, summary }));
      return { id: s.id, title: s.title, items: picks.length ? picks : s.items.slice(0, 3).map(({ title, source, url }) => ({ title, source, url, summary: "" })) };
    });
    return json({ intro: String(data.intro || ""), sections: result, ai: true });
  } catch {
    return json({ intro: "", sections: fallback(), ai: false });
  }
}
