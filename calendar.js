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
