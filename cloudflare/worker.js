// Mi Día — puente para leer calendarios públicos de iCloud desde la app.
// iCloud no deja que una web lea sus calendarios directamente; este Worker hace de intermediario.
// No guarda nada: recibe el enlace del calendario, lo descarga y lo devuelve a la app.
// Solo acepta calendarios publicados de iCloud y solo responde a la web de Mi Día.

const ALLOWED_ORIGINS = ["https://pablo06casta.github.io", "http://localhost:8765"];

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("Método no permitido", { status: 405, headers: cors });

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
  },
};
