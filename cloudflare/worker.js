// Mi Día — puente de la app con iCloud y con la IA de Cloudflare.
//
// GET  /?url=<enlace>  → lee un calendario público de iCloud (iCloud no deja que una web lo lea directamente).
// POST /consejo        → genera sugerencias para el día con Workers AI (necesita el enlace "AI" en Settings → Bindings).
// POST /noticias       → lee titulares de Google Noticias y El País y la IA hace el briefing del día.
// /push/...            → avisos en el iPhone (30 min antes de que llueva, y la noche antes si mañana hace frío). Necesita:
//                          · un espacio KV enlazado como "MIDIA" (Settings → Bindings → KV namespace)
//                          · un Cron Trigger "*/15 * * * *" (Settings → Triggers)
//
// Lo único que se guarda (en tu KV) es lo necesario para el aviso: la suscripción del móvil,
// la ubicación, la hora del aviso de frío y los enlaces de calendario.

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
    if (path.startsWith("/push/")) return push(request, env, origin, cors, path);
    if (request.method === "GET") return calendar(request, cors);
    return new Response("Método no permitido", { status: 405, headers: cors });
  },

  // Cada 15 minutos: mira si a alguien le toca un aviso de lluvia o de frío.
  async scheduled(event, env, ctx) {
    if (!env.MIDIA) return;
    const { keys } = await env.MIDIA.list({ prefix: "sub:" });
    for (const { name } of keys) {
      const sub = await env.MIDIA.get(name, "json");
      if (!sub) continue;
      try {
        const next = await checkAlerts(env, sub);
        if (next === "gone") await env.MIDIA.delete(name);
        else if (next) await env.MIDIA.put(name, JSON.stringify(next));
      } catch {}
    }
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

/* ---------- aviso de la mañana (Web Push) ---------- */

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

async function push(request, env, origin, cors, path) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origen no permitido" }, 403);
  if (!env.MIDIA) return json({ error: "Falta el KV \"MIDIA\" en Settings → Bindings" }, 500);

  if (path === "/push/key") return json({ key: (await vapidKeys(env)).publicKey });
  if (request.method !== "POST") return json({ error: "método" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "datos" }, 400); }
  const endpoint = String(body.subscription?.endpoint || body.endpoint || "");
  let host = "";
  try { host = new URL(endpoint).hostname; } catch {}
  if (!PUSH_HOSTS.test(host)) return json({ error: "suscripción no válida" }, 400);
  const id = "sub:" + (await sha256(endpoint)).slice(0, 24);

  if (path === "/push/unsubscribe") {
    await env.MIDIA.delete(id);
    return json({ ok: true });
  }
  if (path === "/push/subscribe") {
    const prev = (await env.MIDIA.get(id, "json")) || {};
    const sub = {
      subscription: body.subscription,
      lat: +body.lat, lon: +body.lon,
      place: String(body.place || "").slice(0, 60),
      tz: String(body.tz || "Europe/Madrid").slice(0, 60),
      coldHour: /^\d{2}:\d{2}$/.test(body.coldHour) ? body.coldHour : "21:00",
      calendar: (Array.isArray(body.calendar) ? body.calendar : []).slice(0, 10).map(String),
      lastRain: prev.lastRain || 0,
      lastCold: prev.lastCold || "",
    };
    if (!sub.subscription?.keys?.p256dh || !Number.isFinite(sub.lat)) return json({ error: "datos incompletos" }, 400);
    await env.MIDIA.put(id, JSON.stringify(sub));
    return json({ ok: true });
  }
  if (path === "/push/test") {
    const sub = await env.MIDIA.get(id, "json");
    if (!sub) return json({ error: "no suscrito" }, 404);
    const status = await sendPush(env, sub.subscription, JSON.stringify(await testText(sub)));
    return json({ ok: status >= 200 && status < 300, status });
  }
  return json({ error: "ruta" }, 404);
}

function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month - 1, d: +p.day, minutes: +p.hour * 60 + +p.minute, hour: +p.hour };
}


const RAIN_EVERY = 3 * 3600 * 1000; // como mucho un aviso de lluvia cada 3 horas
const WET = 0.1;                      // mm en 15 minutos

// Devuelve la suscripción actualizada si ha enviado algo, "gone" si el móvil ya no existe, o null.
async function checkAlerts(env, sub) {
  const local = localNow(sub.tz);
  let changed = null;
  const send = async (msg) => {
    const status = await sendPush(env, sub.subscription, JSON.stringify({ ...msg, url: "./" }));
    if (status === 404 || status === 410) throw "gone";
    return status >= 200 && status < 300;
  };
  try {
    // 1) lluvia en unos 30 minutos (solo de 7:00 a 23:00)
    if (local.hour >= 7 && local.hour < 23 && Date.now() - (sub.lastRain || 0) > RAIN_EVERY) {
      const msg = await rainAlert(sub);
      if (msg && await send(msg)) changed = { ...(changed || sub), lastRain: Date.now() };
    }
    // 2) la noche antes: ¿mañana baja mucho la temperatura?
    const [h, m] = (sub.coldHour || "21:00").split(":").map(Number);
    const inWindow = local.minutes >= h * 60 + m && local.minutes < h * 60 + m + 120;
    if (inWindow && sub.lastCold !== local.date) {
      const msg = await coldAlert(sub);
      if (msg) await send(msg);
      changed = { ...(changed || sub), lastCold: local.date };
    }
  } catch (e) {
    if (e === "gone") return "gone";
    throw e;
  }
  return changed;
}

async function forecast(sub, params) {
  return fetch(`https://api.open-meteo.com/v1/forecast?latitude=${sub.lat}&longitude=${sub.lon}&${params}&timezone=${encodeURIComponent(sub.tz)}`).then((r) => r.json());
}

// "Empieza a llover en 30 min": seco ahora y en 15 min, y lluvia en el tramo que empieza dentro de 30 min.
// Como el puente mira cada 15 minutos, si la lluvia llega más tarde se avisa en una vuelta posterior.
async function rainAlert(sub) {
  const w = await forecast(sub, "minutely_15=precipitation&forecast_minutely_15=4");
  const p = w.minutely_15?.precipitation || [];
  if (p.length < 4 || p[0] >= WET || p[1] >= WET || p[2] < WET) return null;
  const k = 2;
  const startsAt = new Date(w.minutely_15.time[k] + "Z").getTime() - (w.utc_offset_seconds || 0) * 1000;
  const mins = Math.min(30, Math.max(20, Math.round((startsAt - Date.now()) / 300000) * 5));
  const mmh = p[2] * 4;
  const kind = mmh < 2 ? "lluvia débil" : mmh < 8 ? "lluvia moderada" : "lluvia fuerte";
  return {
    title: `Va a llover${sub.place ? ` en ${sub.place}` : ""}`,
    body: `Empieza a llover en unos ${mins} min (${kind}). Si vas a salir, coge el paraguas.`,
  };
}

// La noche antes: mañana mínima muy baja o bajada fuerte respecto a hoy.
async function coldAlert(sub) {
  const w = await forecast(sub, "daily=temperature_2m_max,temperature_2m_min,apparent_temperature_min&forecast_days=2");
  const D = w.daily;
  const [maxT, minT] = [D.temperature_2m_max, D.temperature_2m_min].map((a) => a.map(Math.round));
  const feels = Math.round(D.apparent_temperature_min?.[1] ?? minT[1]);
  const dropMin = minT[0] - minT[1], dropMax = maxT[0] - maxT[1];
  const veryCold = minT[1] <= 3 || feels <= 0;
  if (!veryCold && dropMin < 5 && dropMax < 5) return null;

  const parts = [`Mañana ${minT[1]}° a ${maxT[1]}° (hoy ${minT[0]}° a ${maxT[0]}°).`];
  if (dropMax >= 5 || dropMin >= 5) parts.push(`Hará unos ${Math.max(dropMin, dropMax)}° menos que hoy.`);
  if (feels < minT[1] - 1) parts.push(`Sensación de ${feels}° a primera hora.`);
  const first = await firstPlanTomorrow(sub);
  if (first) parts.push(`Tu primer plan: ${first}.`);
  parts.push(minT[1] <= 3 ? "Saca el abrigo gordo, guantes y bufanda." : "Deja preparado algo de abrigo.");
  return { title: veryCold ? "Mañana hace mucho frío" : "Mañana bajan las temperaturas", body: parts.join(" ") };
}

async function firstPlanTomorrow(sub) {
  if (!sub.calendar?.length) return "";
  try {
    const local = localNow(sub.tz);
    const texts = await Promise.all(sub.calendar.map((l) => icloudText(l).catch(() => "")));
    const evs = texts.filter(Boolean).flatMap((t) => MiDiaCal.parseICS(t, sub.tz));
    const from = new Date(Date.UTC(local.y, local.m, local.d + 1));
    const e = MiDiaCal.expand(evs, from, new Date(from.getTime() + 86400000)).find((x) => !x.allDay);
    return e ? `${e.title} a las ${e.start.toISOString().slice(11, 16)}` : "";
  } catch {
    return "";
  }
}

async function testText(sub) {
  const [rain, cold] = await Promise.all([rainAlert(sub).catch(() => null), coldAlert(sub).catch(() => null)]);
  return {
    title: "Avisos de Mi Día activados",
    body: rain ? rain.body : cold ? cold.body
      : `Te avisaré media hora antes de que llueva y a las ${sub.coldHour || "21:00"} si mañana baja mucho la temperatura.`,
  };
}

async function icloudText(link) {
  const u = new URL(link.replace(/^webcals?:\/\//i, "https://"));
  if (!/^p\d+-caldav\.icloud\.com$/.test(u.hostname) || !u.pathname.startsWith("/published/")) return "";
  const r = await fetch(u.toString(), { headers: { "User-Agent": "MiDia/1.0" } });
  return r.ok ? r.text() : "";
}

/* ---------- Web Push: claves VAPID y cifrado (RFC 8291 / RFC 8292) ---------- */

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Las claves se crean solas la primera vez y se guardan en el KV.
async function vapidKeys(env) {
  let keys = await env.MIDIA.get("vapid", "json");
  if (!keys) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    keys = {
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
      publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    };
    await env.MIDIA.put("vapid", JSON.stringify(keys));
  }
  return keys;
}

async function vapidAuth(env, endpoint) {
  const keys = await vapidKeys(env);
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: ALLOWED_ORIGINS[0] + "/MI-DIA/" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function encryptPayload(subscription, text) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(utf8(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function sendPush(env, subscription, text) {
  const body = await encryptPayload(subscription, text);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(env, subscription.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "14400",
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}

/* ---------- copia de calendar.js (no editar aquí: se copia desde calendar.js) ---------- */
const window = {};
// Mi Día — lector de calendarios iCloud (formato iCalendar / .ics).
// Los enlaces del calendario se guardan solo en el móvil (localStorage), nunca en el repositorio.
(() => {
  const DAY = 86400000;

  /* ---------- parsing ---------- */
  const unfold = (t) => t.replace(/\r?\n[ \t]/g, "");
  const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  const LINE = /^([^:;]+)((?:;[^:;=]+=(?:"[^"]*"|[^:;]*))*):(.*)$/;

  function tzOffset(t, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  }

  function zoned(y, mo, d, h, mi, s, tz) {
    try {
      const utc = Date.UTC(y, mo, d, h, mi, s);
      const off = tzOffset(utc, tz);
      let t = utc - off;
      const off2 = tzOffset(t, tz);
      if (off2 !== off) t = utc - off2;
      return new Date(t);
    } catch {
      return new Date(y, mo, d, h, mi, s);
    }
  }

  // wallTz: used by the Cloudflare bridge, which runs in UTC. Dates are then kept as
  // "wall clock time in wallTz" so recurring events keep their hour across summer/winter time.
  const toWall = (date, tz) => new Date(date.getTime() + tzOffset(date.getTime(), tz));

  function parseDate(val, params, wallTz) {
    const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (h === undefined) return { date: new Date(+y, mo - 1, +d), allDay: true };
    if (wallTz) {
      const tz = (params.TZID || "").replace(/"/g, "");
      if (!z && (!tz || tz === wallTz)) return { date: new Date(+y, mo - 1, +d, +h, +mi, +s), allDay: false };
      const instant = z ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s)) : zoned(+y, mo - 1, +d, +h, +mi, +s, tz);
      return { date: toWall(instant, wallTz), allDay: false };
    }
    if (z) return { date: new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s)), allDay: false };
    if (params.TZID) return { date: zoned(+y, mo - 1, +d, +h, +mi, +s, params.TZID.replace(/"/g, "")), allDay: false };
    return { date: new Date(+y, mo - 1, +d, +h, +mi, +s), allDay: false };
  }

  function parseICS(text, wallTz) {
    const events = [];
    let ev = null;
    for (const raw of unfold(text).split(/\r?\n/)) {
      const m = raw.match(LINE);
      if (!m) continue;
      const name = m[1].toUpperCase();
      const params = {};
      m[2].split(";").filter(Boolean).forEach((p) => { const [k, v] = p.split("="); params[k.toUpperCase()] = v; });
      const value = m[3];
      if (name === "BEGIN" && value === "VEVENT") { ev = { exdates: [], wallTz }; continue; }
      if (name === "END" && value === "VEVENT") { if (ev?.start) events.push(ev); ev = null; continue; }
      if (!ev) continue;
      switch (name) {
        case "UID": ev.uid = value; break;
        case "SUMMARY": ev.title = unescape(value); break;
        case "LOCATION": ev.location = unescape(value); break;
        case "STATUS": ev.status = value.toUpperCase(); break;
        case "DTSTART": { const d = parseDate(value, params, wallTz); if (d) { ev.start = d.date; ev.allDay = d.allDay; } break; }
        case "DTEND": { const d = parseDate(value, params, wallTz); if (d) ev.end = d.date; break; }
        case "DURATION": ev.duration = parseDuration(value); break;
        case "RRULE": ev.rrule = Object.fromEntries(value.split(";").map((p) => p.split("="))); break;
        case "EXDATE": value.split(",").forEach((v) => { const d = parseDate(v, params, wallTz); if (d) ev.exdates.push(d.date.getTime()); }); break;
        case "RECURRENCE-ID": { const d = parseDate(value, params, wallTz); if (d) ev.recurrenceId = d.date.getTime(); break; }
      }
    }
    events.forEach((e) => {
      if (!e.end) e.end = new Date(e.start.getTime() + (e.duration ?? (e.allDay ? DAY : 0)));
    });
    return events.filter((e) => e.status !== "CANCELLED");
  }

  function parseDuration(v) {
    const m = v.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
    if (!m) return 0;
    const [, w = 0, d = 0, h = 0, mi = 0, s = 0] = m;
    return ((+w * 7 + +d) * 24 * 3600 + +h * 3600 + +mi * 60 + +s) * 1000;
  }

  /* ---------- recurrence ---------- */
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const atTime = (day, ref) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), ref.getHours(), ref.getMinutes(), ref.getSeconds());

  function nthWeekday(y, m, dow, n) {
    if (n > 0) {
      const first = new Date(y, m, 1);
      const d = 1 + ((dow - first.getDay() + 7) % 7) + (n - 1) * 7;
      return d <= new Date(y, m + 1, 0).getDate() ? new Date(y, m, d) : null;
    }
    const last = new Date(y, m + 1, 0);
    const d = last.getDate() - ((last.getDay() - dow + 7) % 7) + (n + 1) * 7;
    return d >= 1 ? new Date(y, m, d) : null;
  }

  function* occurrences(ev) {
    const r = ev.rrule;
    const freq = r.FREQ;
    const interval = +(r.INTERVAL || 1);
    const s = ev.start;
    const byday = (r.BYDAY || "").split(",").filter(Boolean).map((t) => {
      const m = t.match(/^([+-]?\d+)?(\w\w)$/);
      return m ? { n: m[1] ? +m[1] : 0, dow: DOW[m[2]] } : null;
    }).filter(Boolean);

    for (let i = 0; i < 20000; i++) {
      if (freq === "DAILY") {
        yield atTime(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i * interval), s);
      } else if (freq === "WEEKLY") {
        const mon = new Date(s.getFullYear(), s.getMonth(), s.getDate() - ((s.getDay() + 6) % 7) + i * 7 * interval);
        const days = byday.length ? byday.map((b) => (b.dow + 6) % 7).sort((a, b) => a - b) : [(s.getDay() + 6) % 7];
        for (const k of days) yield atTime(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + k), s);
      } else if (freq === "MONTHLY") {
        const y = s.getFullYear(), m = s.getMonth() + i * interval;
        if (byday.length) {
          const list = byday.map((b) => b.n ? nthWeekday(y, m, b.dow, b.n) : null).filter(Boolean).sort((a, b) => a - b);
          for (const d of list) yield atTime(d, s);
        } else {
          const d = new Date(y, m, s.getDate());
          if (d.getDate() === s.getDate()) yield atTime(d, s);
        }
      } else if (freq === "YEARLY") {
        const d = new Date(s.getFullYear() + i * interval, s.getMonth(), s.getDate());
        if (d.getMonth() === s.getMonth()) yield atTime(d, s);
      } else {
        yield s;
        return;
      }
    }
  }

  function expand(events, from, to) {
    const overridden = new Set(events.filter((e) => e.recurrenceId).map((e) => e.uid + "|" + e.recurrenceId));
    const out = [];
    for (const ev of events) {
      const dur = ev.end - ev.start;
      if (!ev.rrule || ev.recurrenceId) {
        if (ev.start < to && ev.end > from) out.push(ev);
        continue;
      }
      const until = ev.rrule.UNTIL ? parseDate(ev.rrule.UNTIL, {}, ev.wallTz).date : null;
      const count = ev.rrule.COUNT ? +ev.rrule.COUNT : Infinity;
      let n = 0;
      for (const start of occurrences(ev)) {
        if (start < ev.start) continue;
        if (start >= to || (until && start > until) || n >= count) break;
        n++;
        const t = start.getTime();
        if (ev.exdates.includes(t) || overridden.has(ev.uid + "|" + t)) continue;
        const end = new Date(t + dur);
        if (end > from) out.push({ ...ev, start, end });
      }
    }
    return out.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
  }

  /* ---------- loading ---------- */
  async function fetchICS(link, proxy) {
    const url = link.trim();
    let target;
    if (/^(\.|\/)/.test(url)) target = url; // archivo local (pruebas)
    else {
      if (!proxy) throw new Error("noproxy");
      target = `${proxy}?url=${encodeURIComponent(url.replace(/^webcals?:\/\//i, "https://"))}`;
    }
    const r = await fetch(target, { cache: "no-store" });
    if (!r.ok) throw new Error("http " + r.status);
    return r.text();
  }

  // Devuelve los eventos de hoy y mañana de todos los calendarios.
  async function load(links, proxy) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from.getTime() + 2 * DAY + 3600000);
    const results = await Promise.allSettled(links.map((l) => fetchICS(l, proxy)));
    const ok = results.filter((r) => r.status === "fulfilled");
    if (!ok.length) throw results[0]?.reason || new Error("empty");
    const events = expand(ok.flatMap((r) => parseICS(r.value)), from, to);
    return { events, failed: results.length - ok.length };
  }

  window.MiDiaCal = { load, parseICS, expand };
})();
const MiDiaCal = window.MiDiaCal;
/* ---------- fin de la copia de calendar.js ---------- */
