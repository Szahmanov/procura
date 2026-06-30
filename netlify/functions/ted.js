// Procura — TED proxy
// Calls the official EU "Tenders Electronic Daily" Search API (Publications Office).
// Endpoint: POST https://api.ted.europa.eu/v3/notices/search  (no API key needed for published notices)
// This proxy builds an expert query from a company's CPV codes + country, asks for ACTIVE
// (still-open) notices, and normalizes TED's multilingual nested fields into flat records.
//
// Why a proxy: TED does not send permissive CORS headers, so the browser cannot call it
// directly. Running it from a Netlify Function avoids CORS and lets us normalize + add the
// canonical official notice link for every tender (so the agent never invents a tender).

const TED_URL = "https://api.ted.europa.eu/v3/notices/search";

const RICH_FIELDS = [
  "publication-number", "notice-title", "buyer-name", "buyer-country",
  "deadline-date-lot", "deadline-receipt-tender-date-lot", "place-of-performance",
  "classification-cpv", "publication-date", "total-value", "total-value-cur", "notice-type"
];
const MED_FIELDS = [
  "publication-number", "notice-title", "buyer-name", "buyer-country",
  "deadline-date-lot", "classification-cpv", "publication-date"
];
const MIN_FIELDS = ["publication-number"];

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}

// Pick a human-readable string out of TED's multilingual shapes:
// "x" | ["x","y"] | {eng:"x"} | {eng:["x"]} | {bul:[...], eng:[...]}
function pick(v, prefer) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? pick(v[0], prefer) : "";
  if (typeof v === "object") {
    const order = [prefer, "eng", "en", "bul", "bg"].filter(Boolean);
    for (const k of order) if (v[k] != null) return pick(v[k], prefer);
    const first = Object.values(v)[0];
    return first != null ? pick(first, prefer) : "";
  }
  return String(v);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const LANG_BY_COUNTRY = {
  BGR: "bul", DEU: "deu", FRA: "fra", ITA: "ita", ESP: "spa", GRC: "ell",
  ROU: "ron", POL: "pol", NLD: "nld", PRT: "por", HUN: "hun", HRV: "hrv",
  CZE: "ces", SVK: "slk", SVN: "slv", AUT: "deu", BEL: "fra"
};

function normalize(rawNotices, country, source) {
  const prefer = LANG_BY_COUNTRY[country] || "eng";
  const seen = new Set();
  const out = [];
  for (const n of rawNotices || []) {
    const pub = pick(n["publication-number"], prefer) || "";
    if (!pub || seen.has(pub)) continue;
    seen.add(pub);

    let link = "";
    // Canonical, always-valid official notice page built from the publication number.
    // Documented format: https://ted.europa.eu/{lang}/notice/{publication-number}/{format}
    const canonical = `https://ted.europa.eu/en/notice/${encodeURIComponent(pub)}/html`;

    // Deadline lives in lot-level fields; take the first present and keep only the date part
    // (TED appends a timezone offset that the browser Date parser dislikes).
    const rawDeadline = pick(n["deadline-receipt-tender-date-lot"], prefer) ||
                        pick(n["deadline-date-lot"], prefer) || "";
    const deadline = (String(rawDeadline).match(/\d{4}-\d{2}-\d{2}/) || [""])[0];

    const value = pick(n["total-value"], prefer) || "";
    const valueCur = pick(n["total-value-cur"], prefer) || "";

    out.push({
      id: pub,
      title: pick(n["notice-title"], prefer) || "(untitled notice)",
      buyer: pick(n["buyer-name"], prefer) || "",
      country: pick(n["buyer-country"], prefer) || country || "",
      deadline: deadline,
      cpv: asArray(n["classification-cpv"]).map(x => pick(x, prefer)).filter(Boolean).slice(0, 6),
      value: value ? (value + (valueCur ? " " + valueCur : "")) : "",
      noticeType: pick(n["notice-type"], prefer) || "",
      published: pick(n["publication-date"], prefer) || "",
      link: canonical,
      officialLink: canonical,
      matchSource: source || "cpv"   // "cpv" = country+CPV match, "country" = country-only fallback
    });
  }
  out.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  return out;
}

async function tedQuery(query, fields) {
  const body = {
    query,
    fields,
    page: 1,
    limit: 40,
    scope: "ACTIVE",            // only notices still open for submission
    checkQuerySyntax: false,
    onlyLatestVersions: true,   // skip superseded notice versions
    paginationMode: "PAGE_NUMBER"  // required so TED returns ALL requested fields, not just the id
  };
  const r = await fetch(TED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, detail: text.slice(0, 300) };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, status: 502, detail: "bad json from TED" }; }
  const notices = data.notices || data.results || data.content || [];
  return { ok: true, notices };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "invalid JSON body" }); }

  const country = (input.country || "BGR").toUpperCase().slice(0, 3);
  const cpv = Array.isArray(input.cpv)
    ? input.cpv.map(c => String(c).replace(/[^0-9]/g, "")).filter(Boolean).slice(0, 8)
    : [];

  const countryClause = `(buyer-country IN (${country}))`;
  const cpvClause = cpv.length ? `(classification-cpv IN (${cpv.join(" ")}))` : "";

  // Recency clause: notices published in the last ~120 days are far more likely to still be
  // open, and it keeps very old notices (which TED's ACTIVE scope still returns) out of the
  // results. The v3 expert query uses the long field name with a compact yyyymmdd date.
  const since = new Date(Date.now() - 120 * 86400000);
  const pd = `${since.getFullYear()}${String(since.getMonth() + 1).padStart(2, "0")}${String(since.getDate()).padStart(2, "0")}`;
  const recent = `(publication-date>=${pd})`;

  // Query plan: recent + specific first, then progressively broader. If a recency-filtered
  // query is rejected or empty, the loop falls through to the same query without the filter,
  // so a bad date syntax can never break the whole search.
  const queries = [];
  if (cpvClause) {
    queries.push({ q: `${countryClause} AND ${cpvClause} AND ${recent}`, source: "cpv" });
    queries.push({ q: `${countryClause} AND ${cpvClause}`, source: "cpv" });
  }
  queries.push({ q: `${countryClause} AND ${recent}`, source: "country" });
  queries.push({ q: countryClause, source: "country" });

  const fieldSets = [RICH_FIELDS, MED_FIELDS, MIN_FIELDS];

  let lastDetail = "";
  for (const { q, source } of queries) {
    for (const f of fieldSets) {
      const res = await tedQuery(q, f);
      if (res.ok) {
        const notices = normalize(res.notices, country, source);
        if (notices.length > 0) {
          return json(200, {
            notices,
            count: notices.length,
            query: q,
            matchSource: source,           // "cpv" or "country"
            broadened: source === "country" && !!cpvClause,
            cpvSearched: cpv,
            countrySearched: country,
            degraded: f === MIN_FIELDS
          });
        }
        // 200 but empty for this field set -> try next query (break field loop)
        break;
      } else {
        lastDetail = res.detail || `status ${res.status}`;
        // field set may be the problem -> try a smaller one
      }
    }
  }

  // Nothing found (or TED unreachable). Honest empty result, never fabricated.
  return json(200, { notices: [], count: 0, note: "no_active_notices", cpvSearched: cpv, countrySearched: country, detail: lastDetail });
};
