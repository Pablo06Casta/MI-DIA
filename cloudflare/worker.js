// Mi Día — puente de la app con iCloud y con la IA de Cloudflare.
//
// GET  /?url=<enlace>  → lee un calendario público de iCloud (iCloud no deja que una web lo lea directamente).
// POST /consejo        → genera sugerencias para el día con Workers AI (necesita el enlace "AI" en Settings → Bindings).
//
// No guarda nada: recibe la petición, la resuelve y devuelve la respuesta a la app.

const ALLOWED_ORIGINS = ["https://pablo06casta.github.io", "http://localhost:8766"];
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM = `Eres el asistente de la app "Mi Día". Con los datos del tiempo y la agenda del usuario, da 3 sugerencias prácticas y concretas para su día.
- Español de España, tono cercano y directo, como un amigo que sabe de meteorología.
- Máximo 20 palabras por sugerencia.
- Cruza el tiempo con sus planes: qué ponerse, si llevar paraguas y a qué hora llueve respecto a cada plan, cuándo es mejor salir, calidad del aire, sol y UV, viento, la puesta de sol.
- Si no hay planes, propone algo que encaje con el tiempo de hoy.
- No repitas datos sin aportar nada, no inventes planes y no uses emojis.
Responde solo con las 3 sugerencias, una por línea, sin numeración ni guiones.`;

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
    if (request.method === "GET") return calendar(request, cors);
    return new Response("Método no permitido", { status: 405, headers: cors });
  },
};

async function advice(request, env, origin, cors) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origen no permitido" }, 403);
  if (!env.AI) return json({ error: "Falta el enlace AI en Settings → Bindings" }, 500);

  let context = "";
  try {
    context = String((await request.json()).context || "").slice(0, 3000);
  } catch {}
  if (!context) return json({ error: "sin datos" }, 400);

  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM },
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
