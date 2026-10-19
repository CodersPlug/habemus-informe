// Informe diario Habemus. No es el informe de Alianza.
// El reloj (GitHub Actions, tres horarios) solo invoca esta función.
// La función publica el HTML y manda el resumen. KV evita un segundo WhatsApp el mismo día.
async function handler(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const KAPSO_KEY = env.KAPSO_API_KEY || "";
  const INTEGRATION_ID = "421d9cd5-f199-40a4-954e-c08a9bb9aace";
  const PHONE_NUMBER_ID = "2785440984814264";
  const SABRINA = "5491132668495";
  const TEMPLATE_NAME = "habemus_informe_diario";
  const TEMPLATE_NAMES = ["fecha", "total", "n", "nmov", "url"];
  const TZ = "America/Argentina/Buenos_Aires";

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const input = body.input || body;
  const dryRun = !!(input.dry_run || input.dryRun);
  const force = !!(input.force || input.ignore_weekend);

  if (!KAPSO_KEY) return json({ error: "missing_KAPSO_API_KEY_secret" }, 500, cors);

  const local = localParts(TZ);
  const isWeekday = local.weekday >= 1 && local.weekday <= 5;
  if (!isWeekday && !force && !dryRun) {
    return json({
      skipped: true,
      reason: "weekend",
      date: local.ymd,
      message: "Informe Habemus: solo dias habiles (lun-vie) America/Argentina/Buenos_Aires"
    }, 200, cors);
  }

  const inv = await fetch(`https://app.kapso.ai/api/v1/integrations/${INTEGRATION_ID}/invoke`, {
    method: "POST",
    headers: {
      "X-API-Key": KAPSO_KEY,
      "Content-Type": "application/json",
      "User-Agent": "HabemusInforme/1.0"
    },
    body: "{}"
  });
  const invText = await inv.text();
  let invJson;
  try { invJson = JSON.parse(invText); } catch (_) {
    return json({ error: "sheet_parse_failed", status: inv.status }, 502, cors);
  }
  if (!inv.ok || !invJson.success) {
    return json({ error: "sheet_invoke_failed", status: inv.status }, 502, cors);
  }
  const table = (invJson.data && invJson.data.ret) || [];
  const built = buildReport(table, local);
  const published = await publishReportHtml(built.html, env, { dryRun });
  if (!dryRun && published.host !== "github_pages") {
    return json({
      error: "html_publish_failed",
      meta: built.meta,
      report_text: built.reportText,
      publish: published,
      hint: "Set GITHUB_TOKEN secret on the function. Pages repo keeps a single index.html."
    }, 502, cors);
  }

  const url = published.url || "https://codersplug.github.io/habemus-informe/";
  const reportText = built.reportText.replace(
    "https://codersplug.github.io/habemus-informe/",
    url
  );
  const idemKey = `informe:habemus:${local.ymd}`;

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      date: local.ymd,
      weekday: local.weekday,
      to: SABRINA,
      idem_key: idemKey,
      report_text: reportText,
      meta: Object.assign({ detail_url: url, host: published.host }, built.meta)
    }, 200, cors);
  }

  if (!env.KV) return json({ error: "missing_kv" }, 500, cors);
  const already = await env.KV.get(idemKey);
  if (already && !input.force_resend) {
    return json({
      skipped: true,
      reason: "already_sent_today",
      date: local.ymd,
      to: SABRINA,
      idem_key: idemKey,
      report_text: reportText,
      meta: Object.assign({ detail_url: url, host: published.host }, built.meta)
    }, 200, cors);
  }

  const templateParams = {
    fecha: local.dmy,
    total: fmtMoney(built.meta.total),
    n: String(built.meta.cuentas),
    nmov: String(built.meta.recientes),
    url
  };
  const templateAttempt = await sendWhatsApp(KAPSO_KEY, PHONE_NUMBER_ID, {
    messaging_product: "whatsapp",
    to: SABRINA,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: "es_AR" },
      components: [{
        type: "body",
        parameters: TEMPLATE_NAMES.map((name) => ({
          type: "text",
          parameter_name: name,
          text: sanitizeTemplateParam(templateParams[name])
        }))
      }]
    }
  });
  let sendVia = null;
  let whatsapp = templateAttempt;
  if (templateAttempt.ok) {
    sendVia = "template";
  } else {
    const textAttempt = await sendWhatsApp(KAPSO_KEY, PHONE_NUMBER_ID, {
      messaging_product: "whatsapp",
      to: SABRINA,
      type: "text",
      text: { body: reportText, preview_url: true }
    });
    whatsapp = { template: templateAttempt, text: textAttempt };
    if (textAttempt.ok) sendVia = "text_fallback";
  }
  if (!sendVia) {
    return json({
      error: "whatsapp_send_failed",
      date: local.ymd,
      to: SABRINA,
      report_text: reportText,
      meta: Object.assign({ detail_url: url, host: published.host }, built.meta),
      whatsapp
    }, 502, cors);
  }

  await env.KV.put(idemKey, JSON.stringify({
    sent_at: new Date().toISOString(),
    to: SABRINA,
    via: sendVia,
    report: "habemus"
  }), { expirationTtl: 60 * 60 * 36 });

  return json({
    ok: true,
    dry_run: false,
    date: local.ymd,
    weekday: local.weekday,
    to: SABRINA,
    idem_key: idemKey,
    send_via: sendVia,
    report_text: reportText,
    meta: Object.assign({ detail_url: url, host: published.host }, built.meta),
    whatsapp
  }, 200, cors);
}

function buildReport(table, local) {
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i] || [];
    const proveedor = String(r[1] || "").trim();
    const importe = money(r[2]);
    if (!proveedor && importe == null) continue;
    rows.push({
      fila: i + 1,
      fecha: String(r[0] || "").trim(),
      proveedor: proveedor || "(sin proveedor)",
      importe: importe == null ? 0 : importe,
      factura: String(r[5] || "").trim(),
      estado: String(r[6] || "").trim(),
      pagador: String(r[7] || "").trim()
    });
  }
  const cc = rows.filter((r) => r.estado.toLowerCase() === "debemos");
  cc.sort((a, b) => a.proveedor.localeCompare(b.proveedor, "es") || a.fecha.localeCompare(b.fecha));
  const totalCc = cc.reduce((s, r) => s + r.importe, 0);
  const since = addDays(local.ymd, -3);
  const recent = rows.filter((r) => r.fecha && r.fecha >= since && r.fecha <= local.ymd);
  recent.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.fila - a.fila);

  const groups = new Map();
  for (const r of cc) {
    if (!groups.has(r.proveedor)) groups.set(r.proveedor, []);
    groups.get(r.proveedor).push(r);
  }

  let ccHtml = `<div class="block"><h2 class="block-title">Cuentas corrientes</h2>`;
  ccHtml += `<p class="summary">${escapeHtml(fmtMoney(totalCc))} · ${cc.length} factura${cc.length === 1 ? "" : "s"} en Debemos.</p>`;
  if (!cc.length) ccHtml += `<p class="empty">Sin cuentas corrientes abiertas</p>`;
  for (const [name, list] of groups) {
    const sub = list.reduce((s, r) => s + r.importe, 0);
    ccHtml += `<h2>${escapeHtml(name)} <span>${escapeHtml(fmtMoney(sub))}</span></h2>`;
    for (const r of list) {
      ccHtml += `<article>
        <div class="who">${escapeHtml(fmtMoney(r.importe))}</div>
        <div class="meta">Fila ${r.fila} · ${escapeHtml(fmtDate(r.fecha) || "sin fecha")}${r.factura ? " · " + escapeHtml(r.factura) : ""}</div>
      </article>`;
    }
  }
  ccHtml += `</div>`;

  let recHtml = `<div class="block"><h2 class="block-title">Movimientos desde el ${escapeHtml(fmtDate(since))}</h2>`;
  recHtml += `<p class="summary">${recent.length} movimiento${recent.length === 1 ? "" : "s"}.</p>`;
  if (!recent.length) recHtml += `<p class="empty">Nada con fecha en estos días</p>`;
  for (const r of recent) {
    const tag = r.estado.toLowerCase() === "debemos" ? "A deber" : (r.pagador ? r.estado + " · " + r.pagador : r.estado);
    recHtml += `<article>
      <div class="who">${escapeHtml(r.proveedor)}</div>
      <div class="meta">${escapeHtml(fmtDate(r.fecha))} · fila ${r.fila}${r.factura ? " · " + escapeHtml(r.factura) : ""}</div>
      <div class="amt">${escapeHtml(fmtMoney(r.importe))} · ${escapeHtml(tag || "sin estado")}</div>
    </article>`;
  }
  recHtml += `</div>`;

  const html = reportHtmlShell(
    `Informe Habemus · ${local.dmy}`,
    `Habemus Bar · ${local.dmy}`,
    ccHtml + recHtml,
    "Cuentas corrientes = filas en Debemos. Un gasto con Mercado Pago no es una deuda. Fila = planilla Movimientos."
  );
  const reportText = [
    "Informe Habemus",
    `Fecha: ${local.dmy}`,
    `Cuentas corrientes: ${fmtMoney(totalCc)} (${cc.length})`,
    `Movimientos desde el ${fmtDate(since)}: ${recent.length}`,
    "Detalle: https://codersplug.github.io/habemus-informe/"
  ].join("\n");
  return {
    html,
    reportText,
    meta: { cuentas: cc.length, total: totalCc, recientes: recent.length, desde: since }
  };
}

function sanitizeTemplateParam(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200) || "-";
}

function money(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) s = parts[0].replace(/\./g, "") + "." + parts[1];
    else s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtMoney(n) {
  const abs = Math.abs(Number(n) || 0);
  const cents = Math.round((abs % 1) * 100);
  const formatted = abs.toLocaleString("es-AR", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: 2
  });
  return (n < 0 ? "-$" : "$") + formatted;
}

function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || "");
  if (!m) return ymd || "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function addDays(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function localParts(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return { ymd, dmy: fmtDate(ymd), weekday: map[parts.weekday] ?? 1 };
}

function reportHtmlShell(title, subtitle, bodyHtml, footer) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; background: #111; color: #f4f4f5; }
  main { max-width: 42rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
  h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 .25rem; }
  .sub { color: #a1a1aa; margin: 0 0 1.5rem; font-size: .95rem; }
  h2 { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; color: #a1a1aa; margin: 1.5rem 0 .6rem; display: flex; justify-content: space-between; }
  .block { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #2a2a2e; }
  .block > h2.block-title { font-size: 1rem; letter-spacing: .04em; color: #e4e4e7; text-transform: none; margin: 0 0 .75rem; }
  .summary { color: #d4d4d8; font-size: .9rem; margin: 0 0 .75rem; }
  article { background: #1c1c1f; border: 1px solid #2a2a2e; border-radius: 12px; padding: .9rem 1rem; margin: 0 0 .6rem; }
  .who { font-weight: 700; font-size: 1.05rem; }
  .meta { color: #a1a1aa; font-size: .8rem; margin: .2rem 0 .45rem; }
  .amt { margin-top: .35rem; font-size: .95rem; font-weight: 600; }
  .empty { color: #71717a; }
  footer { margin-top: 2rem; color: #71717a; font-size: .75rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(subtitle)}</p>
  ${bodyHtml}
  <footer>${escapeHtml(footer)}</footer>
</main>
</body>
</html>`;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function ghApiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "HabemusInforme",
    Accept: "application/vnd.github+json"
  };
}

async function cleanupExtraHtmlFiles(token, repo) {
  const listRes = await fetch(`https://api.github.com/repos/${repo}/contents/`, {
    headers: ghApiHeaders(token)
  });
  if (!listRes.ok) return;
  const files = await listRes.json();
  if (!Array.isArray(files)) return;
  for (const f of files) {
    if (f.type !== "file") continue;
    const name = f.name || "";
    if (name === "index.html" || !name.endsWith(".html")) continue;
    await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { ...ghApiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Remove stale ${name}`, sha: f.sha, branch: "main" })
    });
  }
}

async function publishReportHtml(html, env, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const repo = env.GITHUB_PAGES_REPO || "CodersPlug/habemus-informe";
  const pagesUrl = env.GITHUB_PAGES_URL || "https://codersplug.github.io/habemus-informe/";
  if (dryRun) return { url: pagesUrl, host: "dry_run" };
  const token = env.GITHUB_TOKEN || "";
  if (!token) return { url: "", host: "failed", error: "missing_GITHUB_TOKEN" };
  await cleanupExtraHtmlFiles(token, repo);
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/index.html`, {
    headers: ghApiHeaders(token)
  });
  let sha;
  if (getRes.ok) {
    const j = await getRes.json();
    sha = j.sha;
  }
  const putBody = {
    message: "Update informe Habemus",
    content: utf8ToBase64(html),
    branch: "main"
  };
  if (sha) putBody.sha = sha;
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/index.html`, {
    method: "PUT",
    headers: { ...ghApiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(putBody)
  });
  if (putRes.ok) return { url: pagesUrl, host: "github_pages" };
  const errBody = await putRes.text();
  if (/identical/i.test(errBody)) return { url: pagesUrl, host: "github_pages" };
  return { url: "", host: "failed", status: putRes.status, body: errBody.slice(0, 200) };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function sendWhatsApp(key, phoneNumberId, payload) {
  const res = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/json",
      "User-Agent": "HabemusInforme/1.0"
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildReport };
}
