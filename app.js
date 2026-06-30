/* Procura — app.js
   The whole client: language state, router, all views, the autonomous Groq
   pipeline and the deterministic scoring. Talks to two Netlify Functions:
   /api/groq (reasoning) and /api/ted (live official tender register).
   Data lives in window.Store (store.js); strings in window.I18N (i18n.js). */
(function () {
  "use strict";

  /* ============================================================ language */
  let LANG = Store.getSettings().language || localStorage.getItem("procura_lang") || "bg";
  if (!I18N[LANG]) LANG = "bg";

  function t(key) {
    const dict = I18N[LANG] || I18N.en;
    let v = dict[key];
    if (v === undefined) v = (I18N.en[key] !== undefined ? I18N.en[key] : key);
    if (typeof v === "function") return v.apply(null, [].slice.call(arguments, 1));
    return v;
  }
  function countryName(code) {
    const row = COUNTRIES.find(r => r[0] === code);
    return row ? row[CIDX[LANG]] : code;
  }
  function countryOptions(sel) {
    return COUNTRIES.map(r => `<option value="${r[0]}"${r[0] === sel ? " selected" : ""}>${r[CIDX[LANG]]}</option>`).join("");
  }
  const LANGNAME_FULL = { en: "English", bg: "Bulgarian (български)", de: "German (Deutsch)" };
  function aiLang() { return LANGNAME_FULL[LANG]; }

  /* ============================================================ tiny helpers */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
  const intp = (v) => { const n = parseInt(String(v == null ? "" : v).replace(/[^0-9\-]/g, ""), 10); return isNaN(n) ? null : n; };
  function fmtDate(s) { if (!s) return ""; const d = new Date(s); return isNaN(d) ? String(s) : d.toISOString().slice(0, 10); }
  function fmtMoney(v) {
    const n = num(v); if (n == null) return "";
    try { return n.toLocaleString("en-US") + " " + (Store.getSettings().currency || "EUR"); }
    catch { return n + " " + (Store.getSettings().currency || "EUR"); }
  }
  function daysLeft(deadline) {
    if (!deadline) return null;
    const d = new Date(deadline); if (isNaN(d)) return null;
    return Math.ceil((d.setHours(23, 59, 59, 0) - Date.now()) / 86400000);
  }
  function daysSince(iso) {
    if (!iso) return null;
    const d = new Date(iso); if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function clamp(v, fb) { v = Number(v); if (isNaN(v)) return fb; return Math.max(0, Math.min(100, Math.round(v))); }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  /* ============================================================ backend */
  async function post(path, body) {
    const tryPaths = [path, path.replace("/api/", "/.netlify/functions/")];
    let lastErr;
    for (const p of tryPaths) {
      try {
        const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 404) { lastErr = new Error("404 " + p); continue; }
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error ? (data.error + (data.detail ? ": " + data.detail : "")) : ("HTTP " + r.status));
        return data;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("request failed");
  }
  function parseJSON(text) {
    if (!text) return null;
    let s = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(s); } catch (e) {}
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    return null;
  }
  async function groq(messages, max_tokens) {
    const d = await post("/api/groq", { messages, max_tokens: max_tokens || 2048, json: true, temperature: 0.2 });
    return parseJSON(d.content);
  }

  /* ============================================================ agent decision log (session) */
  const AGENTLOG = [];
  function logEvent(phase, decision, reason, confidence, extra) {
    AGENTLOG.unshift({
      ts: new Date().toTimeString().slice(0, 5),
      phase, decision, reason: reason || "", confidence: confidence == null ? null : confidence,
      input: (extra && extra.input) || "", output: (extra && extra.output) || ""
    });
    if (AGENTLOG.length > 120) AGENTLOG.length = 120;
  }

  /* ============================================================ profile -> agent text */
  function profileBrief(p) {
    if (!p) return "";
    const yn = (b) => b ? "yes" : "no";
    return [
      "Company: " + (p.name || "(unnamed)"),
      "Country: " + p.country + (p.city ? " / " + p.city : ""),
      "Size band: " + (p.size || "small") + (p.employees ? " (" + p.employees + " employees)" : ""),
      p.yearEstablished ? "Established: " + p.yearEstablished : "",
      p.annualTurnover ? "Annual turnover (EUR): " + p.annualTurnover : "",
      p.maxContractValue ? "Max contract value it can handle (EUR): " + p.maxContractValue : "",
      "Main services: " + (p.mainServices || ""),
      p.secondaryServices ? "Secondary services: " + p.secondaryServices : "",
      p.industries ? "Industries served: " + p.industries : "",
      p.cpvInterests ? "CPV interests: " + p.cpvInterests : "",
      p.geographicCoverage ? "Geographic coverage: " + p.geographicCoverage : "",
      p.languages ? "Operating languages: " + p.languages : "",
      "Past public contracts: " + yn(p.pastPublicContracts),
      "Public-sector references: " + yn(p.publicRefs) + "; private references: " + yn(p.privateRefs),
      "Certifications: " + (p.certifications || "none stated"),
      "Tax clearance: " + yn(p.taxClearance) + "; social-security clearance: " + yn(p.socialSecurity) +
        "; financial statements: " + yn(p.financialStatements) + "; insurance: " + yn(p.insurance),
      "ESPD experience: " + (p.espdExperience || "unknown"),
      "Willing to subcontract: " + yn(p.willSubcontract) + "; willing to join consortium: " + yn(p.willConsortium),
      p.teamCapacity ? "Team capacity: " + p.teamCapacity : "",
      p.notes ? "Notes: " + p.notes : ""
    ].filter(Boolean).join("\n");
  }

  /* short memory string from win/loss history, fed into scoring */
  function memoryBrief() {
    const h = Store.getWinLoss();
    if (!h.length) return "";
    const won = h.filter(x => x.result === "won").length;
    const lost = h.filter(x => x.result === "lost").length;
    const reasons = {};
    h.filter(x => x.result === "lost").forEach(x => { if (x.reason) reasons[x.reason] = (reasons[x.reason] || 0) + 1; });
    const topReason = Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a])[0];
    return "Past outcomes: " + won + " won, " + lost + " lost." +
      (topReason ? " Most common loss reason: " + topReason + "." : "");
  }

  /* ============================================================ deterministic logic */
  function capacityCheck(tenderValue, maxCap) {
    const tv = num(tenderValue), cap = num(maxCap);
    if (tv == null) return { level: "verify", label: t("value_missing") };
    if (cap == null) return { level: "verify", label: t("value_missing") };
    if (tv <= cap) return { level: "ok" };
    if (tv <= cap * 1.5) return { level: "conditional", tv, cap };
    return { level: "over", tv, cap };
  }
  function urgency(dl, minDays) {
    if (dl == null) return { key: "urg_unknown", cls: "" };
    if (dl < 0) return { key: "urg_expired", cls: "crit" };
    if (dl <= 2) return { key: "urg_critical", cls: "crit" };
    if (dl <= 7) return { key: "urg_high", cls: "warn" };
    if (dl <= 14) return { key: "urg_moderate", cls: "warn" };
    return { key: "urg_normal", cls: "ok" };
  }
  function bidReadiness(tn) {
    let score = 0, parts = 0;
    const elig = tn.eligibilityChecklist || [];
    if (elig.length) { parts++; const ok = elig.filter(i => i.status === "available" || i.status === "not_required").length; score += 100 * ok / elig.length; }
    const docs = tn.documentChecklist || [];
    if (docs.length) { parts++; const ok = docs.filter(i => i.status === "available" || i.status === "not_required").length; score += 100 * ok / docs.length; }
    parts++; const dl = daysLeft(tn.deadline); score += dl == null ? 50 : (dl < 0 ? 0 : (dl >= 14 ? 100 : Math.round(dl / 14 * 100)));
    parts++; score += tn.analysis ? 100 : 0;
    parts++; score += tn.bidDecision === "bid" ? 100 : (tn.bidDecision === "conditional" ? 60 : 20);
    const prof = Store.getProfiles().find(p => p.id === tn.profileId) || Store.getActiveProfile();
    parts++; score += Store.profileCompleteness(prof);
    return Math.round(score / parts);
  }
  function readinessBand(score) {
    if (score < 40) return { key: "rb_not_ready", cls: "nobid" };
    if (score < 70) return { key: "rb_needs_work", cls: "conditional" };
    if (score < 90) return { key: "rb_nearly", cls: "conditional" };
    return { key: "rb_ready", cls: "bid" };
  }
  function procurementReadiness(p) {
    if (!p) return 0;
    let s = 0;
    s += Store.profileCompleteness(p) * 0.30;
    s += Store.vaultCompleteness() * 0.20;
    s += (p.certifications ? 10 : 0);
    s += ((p.publicRefs ? 8 : 0) + (p.privateRefs ? 4 : 0));
    s += (p.pastPublicContracts ? 12 : 0);
    s += (p.maxContractValue ? 6 : 0);
    s += (Store.getWinLoss().length ? 6 : 0);
    s += (p.espdExperience === "yes" ? 4 : 0);
    return clamp(s, 0);
  }
  function procurementBand(score) {
    if (score < 40) return "rb2_not_ready";
    if (score < 70) return "rb2_developing";
    if (score < 90) return "rb2_competitive";
    return "rb2_tender_ready";
  }

  /* ============================================================ THE AGENT PIPELINE */
  // 1) plan a search strategy from the company profile
  async function planStrategy(profile, country, cap) {
    const plan = await groq([
      { role: "system", content:
        "You are the planning module of Procura, an autonomous agent that finds winnable EU public-procurement tenders for SMEs. " +
        "Read the company profile and decide the search strategy. Respond ONLY with a JSON object: " +
        '{"cpv":[{"code":"8-digit string","why":"short reason"}],"keywords_en":[],"keywords_local":[],' +
        '"capability_summary":"one paragraph","size_band":"micro|small|medium","eligibility_watchouts":["3-6 items"]}. ' +
        "Up to 8 CPV codes, division level, most relevant first. Write capability_summary, the 'why' fields and eligibility_watchouts in " + aiLang() + "." },
      { role: "user", content: "Country: " + country + (cap ? "\nMax contract (EUR): " + cap : "") + "\n\n" + profileBrief(profile) }
    ], 1000) || {};
    plan.cpv = (plan.cpv || []).map(c => typeof c === "string" ? { code: c.replace(/[^0-9]/g, ""), why: "" } : { code: String(c.code || "").replace(/[^0-9]/g, ""), why: c.why || "" }).filter(c => c.code);
    logEvent("strategy", "Planned search", (plan.cpv.map(c => c.code).slice(0, 5).join(", ") || "general"), null,
      { output: (plan.cpv.length) + " CPV codes" });
    return plan;
  }

  // 2) score one batch of tenders for this company
  async function scoreTenders(pool, profile, plan, settings) {
    const input = pool.map(n => ({ id: n.id, title: n.title, buyer: n.buyer, country: n.country, cpv: n.cpv, value: n.value, deadline: fmtDate(n.deadline), days_left: n.daysLeft, match_source: n.matchSource }));
    const scored = await groq([
      { role: "system", content:
        "You are the scoring module of Procura. Judge whether THIS company can realistically WIN each tender, and give a bid decision. " +
        "Be conservative and honest: a small company with no public track record rarely wins large, complex, multi-reference contracts. Never inflate. " +
        "Risk tolerance is '" + (settings.riskTolerance || "balanced") + "' and decision style is '" + (settings.decisionStyle || "strict") + "'. " +
        'Respond ONLY with JSON: {"results":[{"id":"<id>","fit":0,"win_probability":0,"effort":"low|medium|high",' +
        '"bid_decision":"bid|conditional|nobid","risk_level":"low|medium|high","single_biggest_risk":"short phrase",' +
        '"next_best_action":"one concrete next step","confidence":0,"reason":"one plain sentence"}]}. ' +
        "fit=match to capabilities; win_probability=realistic odds this SME wins. " +
        "bid_decision 'bid' only if strong fit, realistic win, feasible deadline, no obvious blocker; 'nobid' if too large, poor fit, deadline too soon, or a mandatory requirement is likely missing; else 'conditional'. " +
        "Penalise tenders whose match_source is 'country' unless the title clearly matches. " +
        "Write single_biggest_risk, next_best_action and reason in " + aiLang() + ". Keep enum fields in English." },
      { role: "user", content: "Capability: " + (plan.capability_summary || "") + "\nSize band: " + (plan.size_band || profile.size || "small") +
        "\nEligibility watchouts: " + JSON.stringify(plan.eligibility_watchouts || []) +
        (profile.maxContractValue ? "\nMax contract value (EUR): " + profile.maxContractValue : "") +
        "\n" + memoryBrief() + "\n\nTenders:\n" + JSON.stringify(input) }
    ], 3200) || {};
    const by = {}; (scored.results || []).forEach(r => by[r.id] = r);
    pool.forEach(n => {
      const r = by[n.id] || {};
      n.fit = clamp(r.fit, 50);
      n.win = clamp(r.win_probability, 30);
      n.effort = r.effort || "medium";
      n.bidDecision = ["bid", "conditional", "nobid"].includes(r.bid_decision) ? r.bid_decision : (n.fit >= 60 && n.win >= 35 ? "bid" : "conditional");
      n.riskLevel = ["low", "medium", "high"].includes(r.risk_level) ? r.risk_level : "medium";
      n.risk = r.single_biggest_risk || "";
      n.nextBestAction = r.next_best_action || "";
      n.confidence = clamp(r.confidence, 60);
      n.reason = r.reason || "";
      // deterministic capacity override
      const cc = capacityCheck(n.value, profile.maxContractValue);
      if (cc.level === "over" && n.bidDecision !== "nobid") { n.bidDecision = "nobid"; n.capacityNote = "over"; }
      else if (cc.level === "conditional" && n.bidDecision === "bid") { n.bidDecision = "conditional"; n.capacityNote = "conditional"; }
    });
    logEvent("scoring", "Scored " + pool.length + " tenders",
      pool.filter(n => n.bidDecision === "bid").length + " bid, " + pool.filter(n => n.bidDecision === "conditional").length + " conditional", null, {});
    return pool;
  }

  // 3) skeptical self-audit pass
  async function auditShortlist(pool, profile, plan) {
    const cand = pool.filter(n => n.bidDecision === "bid" || n.fit >= 70)
      .map(n => ({ id: n.id, title: n.title, buyer: n.buyer, fit: n.fit, win: n.win, decision: n.bidDecision, value: n.value, days_left: n.daysLeft }));
    if (!cand.length) { logEvent("self-audit", "No shortlist to audit", "", null, {}); return pool; }
    const audit = await groq([
      { role: "system", content:
        "You are the audit module of Procura — a skeptical senior procurement advisor reviewing your own shortlist before it reaches the client. " +
        "Catch traps the first pass missed: eligibility the company likely fails (turnover, references, certifications, bid bonds), a deadline too soon to prepare, or scope beyond the company's size band. Demote real traps. " +
        'Respond ONLY with JSON: {"adjustments":[{"id":"...","new_decision":"bid|conditional|nobid","new_fit":0,"audit_note":"what you caught, one sentence"}]}. Only include tenders you change. Write audit_note in ' + aiLang() + "." },
      { role: "user", content: "Size band: " + (plan.size_band || profile.size || "small") + "\nWatchouts: " + JSON.stringify(plan.eligibility_watchouts || []) + "\nShortlist:\n" + JSON.stringify(cand) }
    ], 1500) || {};
    let changed = 0;
    (audit.adjustments || []).forEach(a => {
      const n = pool.find(x => x.id === a.id); if (!n) return;
      if (["bid", "conditional", "nobid"].includes(a.new_decision)) n.bidDecision = a.new_decision;
      if (typeof a.new_fit === "number") n.fit = clamp(a.new_fit, n.fit);
      n.auditNote = a.audit_note || ""; changed++;
      logEvent("self-audit", "Demoted/adjusted: " + (n.title || n.id).slice(0, 48), a.audit_note || "", null, { output: "→ " + n.bidDecision });
    });
    if (!changed) logEvent("self-audit", "Shortlist held up", "no traps found", null, {});
    return pool;
  }

  // eligibility checklist generation for one saved tender
  async function genEligibility(tn, profile) {
    const out = await groq([
      { role: "system", content:
        "You are Procura's eligibility module. Produce a practical public-procurement eligibility checklist for this tender and company. " +
        'Respond ONLY with JSON: {"items":[{"requirement":"","why":"why it matters","risk":"risk if missing","action":"action needed","status":"unknown|available|missing|not_required|needs_verification"}]}. ' +
        "Base statuses on the company profile where possible (e.g. if tax clearance is available, mark it available). 8-14 items. Write all text in " + aiLang() + "." },
      { role: "user", content: profileBrief(profile) + "\n\nTender: " + tn.title + " | buyer " + tn.buyer + " | " + tn.country + (tn.value ? " | value " + tn.value : "") }
    ], 2000) || {};
    return (out.items || []).map(i => ({
      requirement: i.requirement || "", why: i.why || "", risk: i.risk || "", action: i.action || "",
      status: ["unknown", "available", "missing", "not_required", "needs_verification"].includes(i.status) ? i.status : "unknown"
    }));
  }

  // bid plan + 48h + default tasks + consortium reco
  async function genBidPlan(tn, profile) {
    const out = await groq([
      { role: "system", content:
        "You are Procura's bid-planning module. For this tender and company produce a concrete plan. " +
        'Respond ONLY with JSON: {"go_no_go":"go|conditional|no-go","decisive_step":"","documents":["3-6 typical documents"],' +
        '"first_48h":"text","day1":["steps"],"day2":["steps"],"tasks":["6-10 short task titles"],' +
        '"consortium":{"recommendation":"bid alone|bid with subcontractor|form consortium|skip","reason":"","partner_type":"","next":""},' +
        '"questions":["2-4 questions for the contracting authority"]}. ' +
        "Base documents on standard EU practice (ESPD, turnover proof, references, tax & social-security clearance, insurance). Never invent form numbers or fees. Write all text in " + aiLang() + ". Keep enums in English." },
      { role: "user", content: profileBrief(profile) + "\n\nTender: " + tn.title + " | buyer " + tn.buyer + " | " + tn.country + " | deadline " + fmtDate(tn.deadline) + (tn.value ? " | value " + tn.value : "") }
    ], 1800) || {};
    return out;
  }

  // grounded analysis of pasted tender text (anti-hallucination)
  async function analyzeText(text, lang) {
    const out = await groq([
      { role: "system", content:
        "You are Procura's tender-document analysis module. Analyse ONLY the pasted text. " +
        "If something is not present in the text, put the literal value \"__NOT_FOUND__\" for that field or item — never invent requirements, forms, deadlines, fees or thresholds. " +
        'Respond ONLY with JSON: {"mandatory":[],"documents":[],"technical":[],"criteria":[],"weights":[],"disqualifying":[],"steps":[],"deadline":"","questions":[],"unclear":[],"risks":[],"checklist":[{"requirement":"","status":"needs_verification"}]}. ' +
        "Write all text in " + aiLang() + "." },
      { role: "user", content: "TENDER TEXT:\n" + text.slice(0, 12000) }
    ], 2600) || {};
    return out;
  }

  // win/loss learning summary
  async function learnSummary() {
    const h = Store.getWinLoss();
    if (!h.length) return null;
    const out = await groq([
      { role: "system", content:
        "You are Procura's learning module. From this win/loss history, produce a short memory summary. " +
        'Respond ONLY with JSON: {"best_sectors":[],"usual_loss_reasons":[],"strong_cpv":[],"win_rate_pct":0,"recommendation":"one actionable sentence"}. Write text in ' + aiLang() + "." },
      { role: "user", content: JSON.stringify(h.map(x => ({ result: x.result, reason: x.reason, notes: x.notes }))) }
    ], 800) || {};
    return out;
  }

  /* ============================================================ ROUTER */
  const TABS = [
    ["dashboard", "nav_dashboard"], ["profile", "nav_profile"], ["search", "nav_search"],
    ["pipeline", "nav_pipeline"], ["vault", "nav_vault"], ["readiness", "nav_readiness"],
    ["searches", "nav_searches"], ["settings", "nav_settings"], ["log", "nav_log"], ["about", "nav_about"]
  ];
  let CURRENT = "dashboard";
  let DOSSIER_ID = null;

  function renderTabs() {
    const counts = Store.pipelineCounts();
    const active = Object.keys(counts).reduce((a, k) => a + (["found", "shortlisted", "eligibility", "documents", "preparing"].includes(k) ? counts[k] : 0), 0);
    $("#tabs").innerHTML = TABS.map(([id, key]) => {
      let badge = "";
      if (id === "pipeline" && active) badge = `<span class="badge">${active}</span>`;
      return `<button data-go="${id}" class="${CURRENT === id ? "on" : ""}">${esc(t(key))}${badge}</button>`;
    }).join("");
    $$("#tabs button").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
  }
  function go(view) {
    CURRENT = view;
    $$(".view").forEach(v => v.classList.remove("active"));
    const el = $("#v-" + view); if (el) el.classList.add("active");
    renderTabs();
    const fn = RENDER[view]; if (fn) fn(el);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ============================================================ VIEW: dashboard */
  function renderDashboard(root) {
    const profile = Store.getActiveProfile();
    const tenders = Store.getTenders();
    const counts = Store.pipelineCounts();
    if (!profile) {
      root.innerHTML = `<h2 class="vtitle">${esc(t("dash_title"))}</h2><p class="vsub">${esc(t("dash_sub"))}</p>
        <div class="empty"><b>${esc(t("dash_no_profile"))}</b><div class="btnrow" style="margin-top:13px">
        <button class="btn primary" data-go="profile">${esc(t("dash_create_profile"))}</button></div></div>`;
      wireGo(root); return;
    }
    const active = counts.found + counts.shortlisted + counts.eligibility + counts.documents + counts.preparing;
    const expiring = tenders.filter(x => { const d = daysLeft(x.deadline); return d != null && d >= 0 && d <= 7 && !["won", "lost", "abandoned"].includes(x.pipelineStage); }).length;
    const fits = tenders.map(x => x.fit).filter(n => n != null);
    const wins = tenders.map(x => x.winProbability).filter(n => n != null);
    const avg = (a) => a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : 0;
    const pipelineVal = tenders.filter(x => !["found"].includes(x.pipelineStage)).reduce((s, x) => s + (num(x.value) || 0), 0);
    const readyAvg = tenders.length ? Math.round(tenders.reduce((s, x) => s + bidReadiness(x), 0) / tenders.length) : 0;

    const nba = globalNextBestAction(profile, tenders);
    const attn = attentionList(tenders);

    root.innerHTML = `
      <h2 class="vtitle">${esc(t("dash_title"))}</h2><p class="vsub">${esc(t("dash_sub"))}</p>
      <div class="nba"><div class="lab">${esc(t("nba_lab"))}</div>
        <div class="act">${esc(nba.action)}</div><div class="why">${esc(nba.why)}</div>
        ${nba.go ? `<div class="btnrow" style="margin-top:10px"><button class="btn primary sm" data-go="${nba.go}"${nba.dossier ? ` data-dossier="${nba.dossier}"` : ""}>${esc(t("open"))}</button></div>` : ""}</div>
      ${attn.length ? `<div class="attention"><b>${esc(t("attn_title"))}</b><ul>${attn.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>`
        : `<div class="note">${esc(t("attn_none"))}</div>`}
      <div class="stat-row">
        ${stat(active, t("dash_active"))}${stat(expiring, t("dash_expiring"))}${stat(counts.preparing, t("dash_preparing"))}
        ${stat(counts.submitted, t("dash_submitted"))}${stat(counts.won, t("dash_won"))}${stat(counts.lost, t("dash_lost"))}
      </div>
      <div class="stat-row">
        ${stat(avg(fits) + "%", t("dash_avg_fit"))}${stat(avg(wins) + "%", t("dash_avg_win"))}
        ${stat(readyAvg + "%", t("dash_readiness"))}${stat(fmtMoney(pipelineVal) || "—", t("dash_pipeline_value"))}
      </div>
      <div class="btnrow"><button class="btn primary" data-go="search">${esc(t("dash_run_search"))}</button>
        <button class="btn ghost" data-go="pipeline">${esc(t("nav_pipeline"))}</button></div>`;
    wireGo(root);
  }
  function stat(n, l) { return `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`; }

  function attentionList(tenders) {
    const out = [];
    const exp = tenders.filter(x => { const d = daysLeft(x.deadline); return d != null && d >= 0 && d <= 5 && !["won", "lost", "abandoned", "submitted"].includes(x.pipelineStage); }).length;
    if (exp) out.push(t("attn_expire", exp));
    const elig = tenders.filter(x => x.pipelineStage === "found" && !(x.eligibilityChecklist || []).length).length;
    if (elig) out.push(t("attn_elig", elig));
    const waiting = tenders.filter(x => x.pipelineStage === "waiting" || x.pipelineStage === "submitted").length;
    if (waiting) out.push(t("attn_waiting", waiting));
    const stale = Store.getSearches().filter(s => { const d = daysSince(s.lastRun); return d != null && d >= 7; }).length;
    if (stale) out.push(t("attn_stale", stale));
    return out;
  }
  function globalNextBestAction(profile, tenders) {
    // priority: expiring shortlisted -> eligibility missing -> vault gaps -> stale search -> run search
    const soon = tenders.filter(x => { const d = daysLeft(x.deadline); return d != null && d >= 0 && d <= 7 && !["won", "lost", "abandoned"].includes(x.pipelineStage); })
      .sort((a, b) => daysLeft(a.deadline) - daysLeft(b.deadline))[0];
    if (soon) return { action: t("nba_review", (soon.title || "").slice(0, 40)), why: t("nba_review_reason", daysLeft(soon.deadline)), go: "dossier", dossier: soon.id };
    const noElig = tenders.filter(x => x.pipelineStage !== "found" && !(x.eligibilityChecklist || []).length)[0];
    if (noElig) return { action: t("nba_open", (noElig.title || "").slice(0, 40)), why: t("nba_open_reason", daysLeft(noElig.deadline) || 0), go: "dossier", dossier: noElig.id };
    const vaultMissing = tenders.filter(x => x.pipelineStage !== "found").length;
    if (Store.vaultCompleteness() < 50 && vaultMissing) return { action: t("nba_vault"), why: t("nba_vault_reason", vaultMissing), go: "vault" };
    const stale = Store.getSearches().filter(s => { const d = daysSince(s.lastRun); return d != null && d >= 7; })[0];
    if (stale) return { action: t("nba_rerun", stale.name || ""), why: t("nba_rerun_reason", daysSince(stale.lastRun)), go: "searches" };
    return { action: t("nba_search"), why: t("nba_search_reason"), go: "search" };
  }

  /* ============================================================ VIEW: company profile */
  let EDIT_PROFILE = null;
  function renderProfile(root) {
    const profiles = Store.getProfiles();
    const activeId = Store.getActiveProfileId();
    if (EDIT_PROFILE) return renderProfileForm(root, EDIT_PROFILE);

    let list = "";
    if (!profiles.length) {
      list = `<div class="empty"><b>${esc(t("prof_create_first"))}</b></div>`;
    } else {
      list = `<div class="fieldgroup"><label class="fld">${esc(t("prof_active"))}</label>
        <select id="active-profile">${profiles.map(p => `<option value="${p.id}"${p.id === activeId ? " selected" : ""}>${esc(p.name || "—")}</option>`).join("")}</select></div>`;
      const p = Store.getActiveProfile();
      if (p) {
        const comp = Store.profileCompleteness(p);
        list += `<div class="card"><div class="row-between"><div><b style="font-size:16px">${esc(p.name || "—")}</b>
          <div class="muted" style="font-size:13px">${esc(countryName(p.country))}${p.city ? " · " + esc(p.city) : ""} · ${esc(t("size_" + (p.size || "small")))}</div></div>
          <div class="mono" style="color:var(--gold)">${comp}%</div></div>
          <div class="bar" style="margin:10px 0"><i style="width:${comp}%"></i></div>
          <div class="muted" style="font-size:13px">${esc(p.mainServices || "")}</div>
          <div class="btnrow" style="margin-top:12px">
            <button class="btn ghost sm" id="edit-p">${esc(t("prof_edit"))}</button>
            <button class="btn ghost sm" id="dup-p">${esc(t("prof_dup"))}</button>
            <button class="btn danger sm" id="del-p">${esc(t("prof_del"))}</button>
          </div></div>`;
      }
    }
    root.innerHTML = `<h2 class="vtitle">${esc(t("prof_title"))}</h2><p class="vsub">${esc(t("prof_sub"))}</p>
      ${list}
      <div class="btnrow"><button class="btn primary" id="new-p">${esc(t("prof_new"))}</button>
        <button class="btn ghost" id="sample-p">${esc(t("prof_load_sample"))}</button></div>`;

    const sel = $("#active-profile", root);
    if (sel) sel.addEventListener("change", () => { Store.setActiveProfile(sel.value); go("profile"); });
    if ($("#new-p", root)) $("#new-p", root).addEventListener("click", () => { EDIT_PROFILE = Store.blankProfile(); go("profile"); });
    if ($("#sample-p", root)) $("#sample-p", root).addEventListener("click", () => showSamples());
    if ($("#edit-p", root)) $("#edit-p", root).addEventListener("click", () => { EDIT_PROFILE = JSON.parse(JSON.stringify(Store.getActiveProfile())); go("profile"); });
    if ($("#dup-p", root)) $("#dup-p", root).addEventListener("click", () => { Store.duplicateProfile(activeId); toast(t("saved")); go("profile"); });
    if ($("#del-p", root)) $("#del-p", root).addEventListener("click", () => { if (confirm(t("confirm_delete"))) { Store.deleteProfile(activeId); toast(t("deleted")); go("profile"); } });
  }

  function field(label, id, val, type) {
    return `<div class="fieldgroup"><label class="fld" for="${id}">${esc(label)}</label>
      <input id="${id}" type="${type || "text"}" value="${esc(val == null ? "" : val)}" /></div>`;
  }
  function triField(label, id, val) {
    return `<div class="fieldgroup"><label class="fld" for="${id}">${esc(label)}</label>
      <select id="${id}"><option value="true"${val ? " selected" : ""}>${esc(t("tri_yes"))}</option>
      <option value="false"${!val ? " selected" : ""}>${esc(t("tri_no"))}</option></select></div>`;
  }
  function renderProfileForm(root, p) {
    root.innerHTML = `<h2 class="vtitle">${esc(p.name || t("prof_new"))}</h2>
      <div class="panel"><div class="grid">
        ${field(t("f_name"), "p-name", p.name)}
        <div class="fieldgroup"><label class="fld">${esc(t("f_country"))}</label><select id="p-country">${countryOptions(p.country)}</select></div>
        ${field(t("f_city"), "p-city", p.city)}
        <div class="fieldgroup"><label class="fld">${esc(t("f_size"))}</label><select id="p-size">
          ${["micro", "small", "medium", "large"].map(s => `<option value="${s}"${p.size === s ? " selected" : ""}>${esc(t("size_" + s))}</option>`).join("")}</select></div>
        ${field(t("f_employees"), "p-employees", p.employees, "number")}
        ${field(t("f_established"), "p-year", p.yearEstablished, "number")}
        ${field(t("f_turnover"), "p-turnover", p.annualTurnover, "number")}
        ${field(t("f_maxValue"), "p-maxval", p.maxContractValue, "number")}
        <div class="fieldgroup full"><label class="fld" for="p-services">${esc(t("f_services"))}</label><textarea id="p-services">${esc(p.mainServices)}</textarea></div>
        <div class="fieldgroup full"><label class="fld" for="p-secondary">${esc(t("f_secondary"))}</label><textarea id="p-secondary" style="min-height:60px">${esc(p.secondaryServices)}</textarea></div>
        ${field(t("f_industries"), "p-industries", p.industries)}
        ${field(t("f_cpv"), "p-cpv", p.cpvInterests)}
        ${field(t("f_geo"), "p-geo", p.geographicCoverage)}
        ${field(t("f_languages"), "p-langs", p.languages)}
        ${field(t("f_certifications"), "p-cert", p.certifications)}
        ${field(t("f_team"), "p-team", p.teamCapacity)}
        ${triField(t("f_pastPublic"), "p-pastpub", p.pastPublicContracts)}
        ${triField(t("f_publicRefs"), "p-pubref", p.publicRefs)}
        ${triField(t("f_privateRefs"), "p-privref", p.privateRefs)}
        ${triField(t("f_tax"), "p-tax", p.taxClearance)}
        ${triField(t("f_social"), "p-social", p.socialSecurity)}
        ${triField(t("f_financials"), "p-fin", p.financialStatements)}
        ${triField(t("f_insurance"), "p-ins", p.insurance)}
        <div class="fieldgroup"><label class="fld">${esc(t("f_espd"))}</label><select id="p-espd">
          ${["yes", "no", "unknown"].map(s => `<option value="${s}"${p.espdExperience === s ? " selected" : ""}>${esc(t("tri_" + s))}</option>`).join("")}</select></div>
        ${triField(t("f_subcontract"), "p-sub", p.willSubcontract)}
        ${triField(t("f_consortium"), "p-cons", p.willConsortium)}
        <div class="fieldgroup full"><label class="fld" for="p-notes">${esc(t("f_notes"))}</label><textarea id="p-notes" style="min-height:60px">${esc(p.notes)}</textarea></div>
      </div>
      <div class="btnrow" style="margin-top:6px">
        <button class="btn primary" id="save-p">${esc(t("save"))}</button>
        <button class="btn ghost" id="cancel-p">${esc(t("cancel"))}</button></div></div>`;

    $("#save-p", root).addEventListener("click", () => {
      const g = (id) => { const e = $("#" + id, root); return e ? e.value : ""; };
      const b = (id) => g(id) === "true";
      Object.assign(p, {
        name: g("p-name"), country: g("p-country"), city: g("p-city"), size: g("p-size"),
        employees: intp(g("p-employees")), yearEstablished: intp(g("p-year")), annualTurnover: num(g("p-turnover")),
        maxContractValue: num(g("p-maxval")), mainServices: g("p-services"), secondaryServices: g("p-secondary"),
        industries: g("p-industries"), cpvInterests: g("p-cpv"), geographicCoverage: g("p-geo"), languages: g("p-langs"),
        certifications: g("p-cert"), teamCapacity: g("p-team"), pastPublicContracts: b("p-pastpub"),
        publicRefs: b("p-pubref"), privateRefs: b("p-privref"), taxClearance: b("p-tax"), socialSecurity: b("p-social"),
        financialStatements: b("p-fin"), insurance: b("p-ins"), espdExperience: g("p-espd"),
        willSubcontract: b("p-sub"), willConsortium: b("p-cons"), notes: g("p-notes")
      });
      Store.saveProfile(p); EDIT_PROFILE = null; toast(t("saved")); go("profile");
    });
    $("#cancel-p", root).addEventListener("click", () => { EDIT_PROFILE = null; go("profile"); });
  }

  /* ============================================================ VIEW: search (live TED) */
  let LAST_RESULTS = null;
  function renderSearch(root) {
    const profile = Store.getActiveProfile();
    if (!profile) {
      root.innerHTML = `<h2 class="vtitle">${esc(t("srch_title"))}</h2><div class="empty"><b>${esc(t("prof_create_first"))}</b>
        <div class="btnrow" style="margin-top:12px"><button class="btn primary" data-go="profile">${esc(t("dash_create_profile"))}</button></div></div>`;
      wireGo(root); return;
    }
    const s = Store.getSettings();
    root.innerHTML = `
      <h2 class="vtitle">${esc(t("srch_title"))}</h2><p class="vsub">${esc(t("srch_sub"))}</p>
      <div class="panel">
        <div class="grid">
          <div class="fieldgroup"><label class="fld">${esc(t("f_country"))}</label><select id="s-country">${countryOptions(profile.country || s.defaultCountry)}</select></div>
          ${field(t("f_maxValue"), "s-maxval", profile.maxContractValue || s.defaultMaxValue, "number")}
        </div>
        <button class="btn primary full" id="s-run">${esc(t("srch_run_now"))}</button>
      </div>
      <section class="log" id="s-log" style="display:none"></section>
      <div id="s-quality"></div>
      <div id="s-results"></div>`;
    $("#s-run", root).addEventListener("click", () => runSearch(profile));
    if (LAST_RESULTS) paintResults(LAST_RESULTS);
  }

  function logLine(text) {
    const log = $("#s-log"); log.style.display = "block";
    const d = document.createElement("div"); d.className = "ln"; d.innerHTML = `<span class="t">▸</span><span class="x"></span>`;
    $(".x", d).textContent = text; log.appendChild(d); return d;
  }
  function logDone(d, meta) { if (!d) return; d.classList.add("done"); $(".t", d).textContent = "✓"; if (meta) { const m = document.createElement("span"); m.className = "meta"; m.textContent = " " + meta; d.appendChild(m); } }

  async function runSearch(profile) {
    const country = $("#s-country").value;
    const cap = num($("#s-maxval").value);
    const btn = $("#s-run"); btn.disabled = true; btn.textContent = t("srch_running");
    $("#s-log").innerHTML = ""; $("#s-quality").innerHTML = ""; $("#s-results").innerHTML = "";
    try {
      let l = logLine(t("srch_running"));
      const plan = await planStrategy(profile, country, cap);
      const cpv = plan.cpv.map(c => c.code);
      logDone(l, (cpv.slice(0, 5).join(", ") || "general"));

      l = logLine("TED…");
      const ted = await post("/api/ted", { country, cpv });
      let notices = ted.notices || [];
      logDone(l, notices.length + " notices" + (ted.degraded ? " (limited)" : ""));

      if (!notices.length) { renderEmptyResults(country); btn.disabled = false; btn.textContent = t("srch_run_now"); return; }

      l = logLine("gate…");
      let rejected = 0;
      notices.forEach(n => n.daysLeft = daysLeft(n.deadline));
      let live = notices.filter(n => { if (n.daysLeft != null && n.daysLeft < 0) { rejected++; return false; } return true; });
      live.sort((a, b) => (a.daysLeft == null ? 9999 : a.daysLeft) - (b.daysLeft == null ? 9999 : b.daysLeft));
      const pool = live.slice(0, 14);
      logDone(l, rejected + " expired removed · " + pool.length + " screened");
      logEvent("gate", "Screened deadlines", rejected + " expired removed, " + pool.length + " kept", null, {});

      l = logLine("score…");
      await scoreTenders(pool, profile, plan, Store.getSettings());
      logDone(l, pool.filter(n => n.bidDecision === "bid").length + " bid, " + pool.filter(n => n.bidDecision === "conditional").length + " conditional");

      l = logLine("audit…");
      await auditShortlist(pool, profile, plan);
      logDone(l, pool.filter(n => n.auditNote).length + " adjusted");

      // save this search
      const existing = Store.getSearches().find(x => x.profileId === profile.id && x.country === country);
      const rec = existing || { id: Store.uid("s"), profileId: profile.id, name: (profile.name || "") + " · " + countryName(country) };
      rec.country = country; rec.cpv = cpv; rec.keywords = [].concat(plan.keywords_en || [], plan.keywords_local || []);
      rec.maxContractValue = cap; rec.lastRun = Store.now(); rec.lastResultCount = pool.length;
      Store.saveSearch(rec);

      LAST_RESULTS = { pool, plan, country, ted };
      paintResults(LAST_RESULTS);
      renderTabs();
    } catch (e) {
      $("#s-results").innerHTML = `<div class="err"><b>${esc(t("loading"))}</b> ${esc(e.message || String(e))}
        <br><span style="color:#c9b08f">GROQ_API_KEY → Netlify → Environment variables.</span></div>`;
    } finally { btn.disabled = false; btn.textContent = t("srch_run_now"); }
  }

  function renderEmptyResults(country) {
    $("#s-results").innerHTML = `<div class="empty"><b>${esc(t("empty_title"))}</b>
      <div style="margin-top:8px">${esc(t("empty_body"))}</div>
      <ul style="margin-top:8px">${["empty_a1", "empty_a2", "empty_a3", "empty_a4"].map(k => `<li>${esc(t(k))}</li>`).join("")}</ul>
      <div class="btnrow" style="margin-top:12px"><button class="btn ghost sm" data-go="manual">${esc(t("mode_manual"))}</button></div></div>`;
    wireGo($("#s-results"));
  }

  function paintResults(R) {
    const { pool, plan, country, ted } = R;
    // search quality + cpv strategy
    const cpvChips = (plan.cpv || []).map(c => `<div class="crow"><div class="cmain"><div class="cname mono">${esc(c.code)}</div>${c.why ? `<div class="cwhy">${esc(c.why)}</div>` : ""}</div></div>`).join("");
    $("#s-quality").innerHTML = `
      <details class="acc"><summary>${esc(t("strategy_title"))}</summary><div class="body">${cpvChips || "—"}</div></details>
      <details class="acc"><summary>${esc(t("quality_title"))}</summary><div class="body">
        <div>${esc(t("q_country"))}: <b>${esc(countryName(country))}</b></div>
        <div>${esc(t("q_cpv"))}: <span class="mono">${esc((ted.cpvSearched || []).join(", ") || "—")}</span></div>
        <div>${esc(t("q_source"))}: <b>${esc(ted.matchSource === "country" ? t("src_country") : t("src_cpv"))}</b></div>
        <div>${esc(t("q_fetched"))}: ${ted.count || pool.length} · ${esc(t("q_scored"))}: ${pool.length} · ${esc(t("q_recommended"))}: ${pool.filter(n => n.bidDecision === "bid").length}</div>
        ${ted.broadened ? `<div class="note">${esc(t("q_broadened"))}</div>` : ""}
      </div></details>`;

    const order = { bid: 0, conditional: 1, nobid: 2 };
    pool.sort((a, b) => order[a.bidDecision] - order[b.bidDecision] || b.win - a.win || b.fit - a.fit);
    $("#s-results").innerHTML = pool.map(n => resultCard(n)).join("");
    $$("#s-results [data-save]").forEach(b => b.addEventListener("click", () => {
      const n = pool.find(x => x.id === b.dataset.save);
      const tn = Store.tenderFromResult(n, Store.getActiveProfileId(), "ted");
      tn.matchSource = n.matchSource;
      Store.saveTender(tn); toast(t("saved_tender")); renderTabs();
      b.textContent = "✓ " + t("saved"); b.disabled = true;
    }));
  }

  function decBadge(d) { return `<span class="badge-d b-${d === "bid" ? "bid" : d === "conditional" ? "conditional" : "nobid"}">${esc(t("dec_" + (d === "nobid" ? "nobid" : d)))}</span>`; }
  function resultCard(n) {
    const dl = n.daysLeft;
    const u = urgency(dl);
    const saved = Store.isSaved(n.id);
    return `<article class="card lstripe ${n.bidDecision}">
      <div class="stamp ${n.bidDecision}">${esc(t("dec_" + (n.bidDecision === "nobid" ? "nobid" : n.bidDecision)))}</div>
      <div class="mono muted" style="font-size:11px">${esc(n.id)}</div>
      <div style="font-family:'Spectral',serif;font-size:17px;font-weight:600;line-height:1.3;margin:3px 0 6px;padding-right:96px">
        <a href="${esc(n.officialLink)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
      <div class="muted" style="font-size:12.5px;margin-bottom:8px">${esc(n.buyer || "")} · ${esc(n.country)}</div>
      ${(n.cpv || []).length ? `<div class="chips" style="margin-bottom:8px">${n.cpv.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
      <div style="margin-bottom:8px"><span class="pill ${u.cls}">${esc(t(u.key))}</span>
        ${dl != null && dl >= 0 ? `<span class="pill">${esc(t("days_left", dl))}</span>` : ""}
        ${n.deadline ? `<span class="pill">${esc(fmtDate(n.deadline))}</span>` : ""}
        ${n.value ? `<span class="pill">${esc(fmtMoney(n.value))}</span>` : ""}</div>
      <div class="meters">
        <div class="meter"><div class="mh">${esc(t("m_fit"))}<b>${n.fit}</b></div><div class="bar"><i style="width:${n.fit}%"></i></div></div>
        <div class="meter"><div class="mh">${esc(t("m_win"))}<b>${n.win}</b></div><div class="bar win"><i style="width:${n.win}%"></i></div></div>
      </div>
      ${n.reason ? `<div style="font-size:13.5px;margin-bottom:7px">${esc(n.reason)}</div>` : ""}
      ${n.risk ? `<div class="note"><b style="color:var(--red)">${esc(t("dec_risk"))}</b> ${esc(n.risk)}</div>` : ""}
      ${n.auditNote ? `<div class="note" style="border-style:dashed"><b style="color:var(--gold)">${esc(t("dos_log"))}</b> ${esc(n.auditNote)}</div>` : ""}
      ${n.capacityNote ? `<div class="note"><b>${esc(t("cap_warn"))}</b> ${esc(t("cap_tender"))}: ${esc(fmtMoney(n.value))}</div>` : ""}
      ${n.nextBestAction ? `<div style="font-size:13px;margin:7px 0"><b>${esc(t("dec_next"))}</b> ${esc(n.nextBestAction)}</div>` : ""}
      <div class="btnrow" style="margin-top:6px">
        <button class="btn primary sm" data-save="${esc(n.id)}"${saved ? " disabled" : ""}>${esc(saved ? t("saved") : t("save_tender"))}</button>
        <a class="btn ghost sm" href="${esc(n.officialLink)}" target="_blank" rel="noopener">${esc(t("view_official"))}</a></div>
    </article>`;
  }

  /* ============================================================ VIEW: pipeline */
  function renderPipeline(root) {
    const tenders = Store.getTenders();
    const counts = Store.pipelineCounts();
    if (!tenders.length) {
      root.innerHTML = `<h2 class="vtitle">${esc(t("pipe_title"))}</h2><p class="vsub">${esc(t("pipe_sub"))}</p>
        <div class="empty"><b>${esc(t("pipe_empty"))}</b><div class="btnrow" style="margin-top:12px">
        <button class="btn primary" data-go="search">${esc(t("dash_run_search"))}</button></div></div>`;
      wireGo(root); return;
    }
    const summary = STAGES.map(s => counts[s] ? `<span class="pill">${esc(t("st_" + s))}: ${counts[s]}</span>` : "").filter(Boolean).join(" ");
    const order = { found: 0, shortlisted: 1, eligibility: 2, documents: 3, preparing: 4, submitted: 5, waiting: 6, won: 7, lost: 8, abandoned: 9 };
    tenders.sort((a, b) => order[a.pipelineStage] - order[b.pipelineStage] || (daysLeft(a.deadline) || 9999) - (daysLeft(b.deadline) || 9999));
    root.innerHTML = `<h2 class="vtitle">${esc(t("pipe_title"))}</h2><p class="vsub">${esc(t("pipe_sub"))}</p>
      <div class="chips" style="margin-bottom:14px">${summary}</div>
      ${tenders.map(tn => pipelineCard(tn)).join("")}`;
    $$("[data-stage]", root).forEach(sel => sel.addEventListener("change", () => {
      const tn = Store.getTender(sel.dataset.stage); if (!tn) return;
      tn.pipelineStage = sel.value; Store.saveTender(tn);
      if (tn.pipelineStage === "won" || tn.pipelineStage === "lost") openWinLoss(tn);
      logEvent("pipeline", "Stage → " + t("st_" + tn.value || sel.value), tn.title, null, {});
      toast(t("updated")); renderTabs();
    }));
    $$("[data-open]", root).forEach(b => b.addEventListener("click", () => { DOSSIER_ID = b.dataset.open; go("dossier"); }));
  }
  function pipelineCard(tn) {
    const dl = daysLeft(tn.deadline); const u = urgency(dl);
    const missing = (tn.documentChecklist || []).filter(d => d.status === "missing").length + (tn.eligibilityChecklist || []).filter(d => d.status === "missing").length;
    const rdy = bidReadiness(tn);
    return `<article class="card lstripe ${tn.bidDecision || "conditional"}">
      <div class="row-between"><div style="flex:1;min-width:0">
        <div style="font-family:'Spectral',serif;font-size:16px;font-weight:600;line-height:1.3">${esc(tn.title)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:2px">${esc(tn.buyer || "")} · ${esc(tn.country)}</div>
      </div>${tn.bidDecision ? decBadge(tn.bidDecision) : ""}</div>
      <div style="margin:9px 0"><span class="pill ${u.cls}">${esc(t(u.key))}</span>
        ${dl != null && dl >= 0 ? `<span class="pill">${esc(t("days_left", dl))}</span>` : ""}
        <span class="pill">${esc(t("m_fit"))} ${tn.fit ?? "—"}</span><span class="pill">${esc(t("m_win"))} ${tn.winProbability ?? "—"}</span>
        <span class="pill ${rdy >= 70 ? "ok" : rdy < 40 ? "warn" : ""}">${esc(t("dos_readiness"))} ${rdy}%</span>
        ${missing ? `<span class="pill warn">${esc(t("pipe_missing"))}: ${missing}</span>` : ""}</div>
      <div class="row-between" style="margin-top:6px">
        <select data-stage="${esc(tn.id)}">${STAGES.map(s => `<option value="${s}"${tn.pipelineStage === s ? " selected" : ""}>${esc(t("st_" + s))}</option>`).join("")}</select>
        <button class="btn ghost sm" data-open="${esc(tn.id)}">${esc(t("pipe_open"))}</button></div>
      ${tn.nextBestAction ? `<div style="font-size:12.5px;margin-top:8px"><b>${esc(t("pipe_nextaction"))}</b> ${esc(tn.nextBestAction)}</div>` : ""}
    </article>`;
  }

  /* ============================================================ VIEW: dossier */
  function renderDossier(root) {
    const tn = DOSSIER_ID ? Store.getTender(DOSSIER_ID) : null;
    if (!tn) { root.innerHTML = `<div class="empty">${esc(t("pipe_empty"))}</div>`; return; }
    const dl = daysLeft(tn.deadline); const u = urgency(dl);
    const rdy = bidReadiness(tn); const rb = readinessBand(rdy);
    const profile = Store.getProfiles().find(p => p.id === tn.profileId) || Store.getActiveProfile();

    const eligPct = (tn.eligibilityChecklist || []).length ? Math.round(100 * tn.eligibilityChecklist.filter(i => i.status === "available" || i.status === "not_required").length / tn.eligibilityChecklist.length) : 0;

    root.innerHTML = `
      <div class="btnrow" style="margin-bottom:10px"><button class="btn ghost sm" data-go="pipeline">${esc(t("dos_back"))}</button>
        <button class="btn ghost sm" id="d-print">${esc(t("dos_print"))}</button>
        <button class="btn ghost sm" id="d-copy">${esc(t("dos_copy"))}</button>
        <button class="btn ghost sm" id="d-json">${esc(t("dos_exportj"))}</button></div>

      <div class="panel">
        <div class="row-between"><div style="flex:1;min-width:0">
          <div class="eyebrow">${esc(t("dos_title"))}</div>
          <h2 class="vtitle"><a href="${esc(tn.officialLink)}" target="_blank" rel="noopener">${esc(tn.title)}</a></h2>
          <div class="muted">${esc(tn.buyer || "")} · ${esc(tn.country)}</div>
        </div>${tn.bidDecision ? decBadge(tn.bidDecision) : ""}</div>
        <div style="margin-top:10px"><span class="pill ${u.cls}">${esc(t(u.key))}</span>
          ${dl != null && dl >= 0 ? `<span class="pill">${esc(t("days_left", dl))}</span>` : ""}
          ${tn.deadline ? `<span class="pill">${esc(fmtDate(tn.deadline))}</span>` : ""}
          ${tn.value ? `<span class="pill">${esc(fmtMoney(tn.value))}</span>` : `<span class="pill">${esc(t("value_missing"))}</span>`}
          ${(tn.cpv || []).map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
        <div class="meters" style="margin-top:12px">
          <div class="meter"><div class="mh">${esc(t("m_fit"))}<b>${tn.fit ?? "—"}</b></div><div class="bar"><i style="width:${tn.fit || 0}%"></i></div></div>
          <div class="meter"><div class="mh">${esc(t("m_win"))}<b>${tn.winProbability ?? "—"}</b></div><div class="bar win"><i style="width:${tn.winProbability || 0}%"></i></div></div>
          <div class="meter"><div class="mh">${esc(t("dos_readiness"))}<b>${rdy}%</b></div><div class="bar ${rdy < 40 ? "red" : ""}"><i style="width:${rdy}%"></i></div></div>
        </div>
        <div class="note" style="margin-top:10px"><b>${esc(t("rb_" + (rb.key.replace("rb_", "") === "not_ready" ? "not_ready" : rb.key.replace("rb_", ""))))}</b></div>
        ${tn.reason ? `<div style="margin-top:8px">${esc(tn.reason)}</div>` : ""}
        ${tn.biggestRisk ? `<div class="note"><b style="color:var(--red)">${esc(t("dec_risk"))}</b> ${esc(tn.biggestRisk)}</div>` : ""}
        ${tn.nextBestAction ? `<div style="margin-top:6px"><b>${esc(t("dos_nextaction"))}</b> ${esc(tn.nextBestAction)}</div>` : ""}
      </div>

      <div class="panel"><div class="row-between"><div class="sectit">${esc(t("dos_generate"))}</div></div>
        <p class="muted" style="font-size:13px;margin:0 0 10px">${esc(t("dos_gen_hint"))}</p>
        <button class="btn primary" id="d-generate">${esc((tn.eligibilityChecklist || []).length || tn.plan ? t("dos_regenerate") : t("dos_generate"))}</button></div>

      ${tn.consortium ? `<div class="panel"><div class="sectit">${esc(t("dos_consortium"))}</div>
        <div><b>${esc(t("cons_reco"))}:</b> ${esc(tn.consortium.recommendation || "")}</div>
        ${tn.consortium.reason ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(tn.consortium.reason)}</div>` : ""}
        ${tn.consortium.partner_type ? `<div style="margin-top:4px"><b>${esc(t("cons_partner"))}:</b> ${esc(tn.consortium.partner_type)}</div>` : ""}
        ${tn.consortium.next ? `<div style="margin-top:4px"><b>${esc(t("cons_next"))}:</b> ${esc(tn.consortium.next)}</div>` : ""}</div>` : ""}

      ${(tn.eligibilityChecklist || []).length ? `<div class="panel"><div class="row-between"><div class="sectit">${esc(t("dos_eligibility"))}</div>
        <div class="mono" style="color:var(--gold)">${esc(t("elig_progress"))} ${eligPct}%</div></div>
        ${tn.eligibilityChecklist.map((i, idx) => eligRow(tn, i, idx)).join("")}</div>` : ""}

      ${tn.plan ? `<div class="panel"><div class="sectit">${esc(t("dos_plan"))}</div>
        ${tn.plan.decisive_step ? `<div style="margin-bottom:8px"><b>${esc(t("dec_next"))}</b> ${esc(tn.plan.decisive_step)}</div>` : ""}
        ${(tn.plan.documents || []).length ? `<div class="chips" style="margin-bottom:10px">${tn.plan.documents.map(d => `<span class="chip">${esc(d)}</span>`).join("")}</div>` : ""}
        ${(tn.plan.day1 || []).length ? `<div><b>Day 1</b><ol style="margin:5px 0 10px;padding-left:20px">${tn.plan.day1.map(x => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}
        ${(tn.plan.day2 || []).length ? `<div><b>Day 2</b><ol style="margin:5px 0;padding-left:20px">${tn.plan.day2.map(x => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}
        ${(tn.plan.questions || []).length ? `<div class="note" style="margin-top:8px"><b>${esc(t("an_questions"))}</b><ul style="margin:5px 0 0;padding-left:18px">${tn.plan.questions.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}</div>` : ""}

      ${(tn.tasks || []).length ? `<div class="panel"><div class="sectit">${esc(t("dos_tasks"))}</div>
        ${tn.tasks.map((tk, idx) => taskRow(tn, tk, idx)).join("")}</div>` : ""}

      <div class="panel"><div class="sectit">${esc(t("dos_winloss"))}</div>
        <div class="btnrow"><button class="btn ghost sm" id="d-won">${esc(t("wl_mark_won"))}</button>
          <button class="btn ghost sm" id="d-lost">${esc(t("wl_mark_lost"))}</button></div></div>`;

    wireGo(root);
    $("#d-print", root).addEventListener("click", () => window.print());
    $("#d-copy", root).addEventListener("click", () => { navigator.clipboard.writeText(dossierText(tn)).then(() => toast(t("saved"))); });
    $("#d-json", root).addEventListener("click", () => download("procura-dossier-" + tn.id + ".json", JSON.stringify(tn, null, 2)));
    $("#d-generate", root).addEventListener("click", () => generateDossier(tn, profile));
    $("#d-won", root).addEventListener("click", () => { tn.pipelineStage = "won"; Store.saveTender(tn); openWinLoss(tn); });
    $("#d-lost", root).addEventListener("click", () => { tn.pipelineStage = "lost"; Store.saveTender(tn); openWinLoss(tn); });
    $$("[data-elig]", root).forEach(sel => sel.addEventListener("change", () => {
      tn.eligibilityChecklist[+sel.dataset.idx].status = sel.value; Store.saveTender(tn); go("dossier");
    }));
    $$("[data-task]", root).forEach(sel => sel.addEventListener("change", () => {
      tn.tasks[+sel.dataset.idx].status = sel.value; Store.saveTender(tn); toast(t("updated"));
    }));
  }
  function eligRow(tn, i, idx) {
    return `<div class="crow"><div class="cmain"><div class="cname">${esc(i.requirement)}</div>
      ${i.why ? `<div class="cwhy">${esc(i.why)}</div>` : ""}
      ${i.action ? `<div class="cwhy"><b>→</b> ${esc(i.action)}</div>` : ""}</div>
      <select data-elig="1" data-idx="${idx}">${ELIG_STATUS.map(s => `<option value="${s}"${i.status === s ? " selected" : ""}>${esc(t("es_" + s))}</option>`).join("")}</select></div>`;
  }
  function taskRow(tn, tk, idx) {
    return `<div class="crow"><div class="cmain"><div class="cname">${esc(typeof tk === "string" ? tk : tk.title)}</div></div>
      <select data-task="1" data-idx="${idx}">${TASK_STATUS.map(s => `<option value="${s}"${(tk.status || "todo") === s ? " selected" : ""}>${esc(t("ts_" + s))}</option>`).join("")}</select></div>`;
  }
  async function generateDossier(tn, profile) {
    const btn = $("#d-generate"); btn.disabled = true; btn.textContent = t("loading");
    try {
      tn.eligibilityChecklist = await genEligibility(tn, profile);
      logEvent("eligibility check", "Generated checklist", tn.title, null, { output: tn.eligibilityChecklist.length + " items" });
      const plan = await genBidPlan(tn, profile);
      tn.plan = plan;
      tn.tasks = (plan.tasks || []).map(x => ({ title: x, status: "todo", priority: "med" }));
      tn.consortium = plan.consortium || null;
      tn.documentChecklist = (plan.documents || []).map(d => ({ requirement: d, status: "unknown" }));
      logEvent("bid/no-bid", "Built bid plan", tn.title, null, { output: (plan.go_no_go || "") });
      Store.saveTender(tn); toast(t("saved"));
    } catch (e) { toast(e.message || String(e)); }
    finally { go("dossier"); }
  }
  function dossierText(tn) {
    const lines = [];
    lines.push("PROCURA DOSSIER — " + tn.title);
    lines.push(tn.buyer + " · " + tn.country + " · " + fmtDate(tn.deadline));
    lines.push(tn.officialLink);
    lines.push("Decision: " + (tn.bidDecision || "—") + " | Fit " + (tn.fit ?? "—") + " | Win " + (tn.winProbability ?? "—"));
    if (tn.biggestRisk) lines.push("Risk: " + tn.biggestRisk);
    if (tn.nextBestAction) lines.push("Next: " + tn.nextBestAction);
    (tn.eligibilityChecklist || []).forEach(i => lines.push("- [" + i.status + "] " + i.requirement));
    return lines.join("\n");
  }

  /* ============================================================ VIEW: manual analysis */
  function renderManual(root) {
    root.innerHTML = `<h2 class="vtitle">${esc(t("man_title"))}</h2><p class="vsub">${esc(t("man_sub"))}</p>
      <div class="note">${esc(t("man_disclaimer"))}</div>
      <div class="panel"><div class="fieldgroup"><label class="fld">${esc(t("man_paste"))}</label>
        <textarea id="m-text" style="min-height:180px"></textarea></div>
        <button class="btn primary" id="m-run">${esc(t("man_analyze"))}</button></div>
      <div id="m-out"></div>`;
    $("#m-run", root).addEventListener("click", async () => {
      const text = $("#m-text").value.trim();
      if (text.length < 40) { toast(t("man_paste")); return; }
      const btn = $("#m-run"); btn.disabled = true; btn.textContent = t("loading");
      try {
        const a = await analyzeText(text);
        logEvent("document analysis", "Analysed pasted tender text", text.length + " chars", null, {});
        renderAnalysis(a, text);
      } catch (e) { $("#m-out").innerHTML = `<div class="err">${esc(e.message || String(e))}</div>`; }
      finally { btn.disabled = false; btn.textContent = t("man_analyze"); }
    });
  }
  function nf(v) { return (v === "__NOT_FOUND__" || v == null || v === "") ? null : v; }
  function listBlock(label, arr) {
    const items = (arr || []).map(nf).filter(Boolean);
    if (!items.length) return "";
    return `<div style="margin-bottom:10px"><b>${esc(label)}</b><ul style="margin:5px 0 0;padding-left:18px">${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  }
  function renderAnalysis(a, text) {
    const out = $("#m-out");
    const deadline = nf(a.deadline);
    out.innerHTML = `<div class="panel">
      ${listBlock(t("an_mandatory"), a.mandatory)}
      ${listBlock(t("an_documents"), a.documents)}
      ${listBlock(t("an_technical"), a.technical)}
      ${listBlock(t("an_criteria"), a.criteria)}
      ${listBlock(t("an_disqualifying"), a.disqualifying)}
      ${listBlock(t("an_steps"), a.steps)}
      ${deadline ? `<div style="margin-bottom:10px"><b>${esc(t("an_deadline"))}</b> ${esc(deadline)}</div>` : ""}
      ${listBlock(t("an_questions"), a.questions)}
      ${listBlock(t("an_unclear"), a.unclear)}
      ${listBlock(t("an_risks"), a.risks)}
      <div class="note">${esc(t("man_not_found"))}</div>
      <button class="btn primary" id="m-save">${esc(t("man_save"))}</button></div>`;
    $("#m-save").addEventListener("click", () => {
      const tn = Store.tenderFromResult({ id: null, title: (nf(a.mandatory && a.mandatory[0]) || "Manual tender").slice(0, 80), buyer: "", country: Store.getActiveProfile()?.country || "", deadline: deadline || "" }, Store.getActiveProfileId(), "manual");
      tn.analysisText = text; tn.analysis = a;
      tn.eligibilityChecklist = (a.checklist || []).map(i => ({ requirement: i.requirement || "", status: i.status || "needs_verification", why: "", risk: "", action: "" }));
      Store.saveTender(tn); toast(t("saved_tender")); renderTabs();
    });
  }

  /* ============================================================ VIEW: vault */
  function renderVault(root) {
    const v = Store.getVault();
    const docMap = {
      company_registration: "d_registration", tax_clearance: "d_tax_clearance", social_security: "d_social_clearance",
      financial_statements: "d_financials", insurance: "d_insurance", iso_certificates: "d_iso",
      professional_licenses: "d_licenses", project_references: "d_references", staff_cvs: "d_cvs",
      equipment_list: "d_equipment", electronic_signature: "d_esignature", bank_guarantee: "d_bank_guarantee", espd_template: "d_espd"
    };
    const pct = Store.vaultCompleteness();
    root.innerHTML = `<h2 class="vtitle">${esc(t("vault_title"))}</h2><p class="vsub">${esc(t("vault_sub"))}</p>
      <div class="panel"><div class="row-between"><div class="sectit">${esc(t("doc_progress"))}</div><div class="mono" style="color:var(--gold)">${pct}%</div></div>
      <div class="bar" style="margin:6px 0 14px"><i style="width:${pct}%"></i></div>
      ${v.map((d, idx) => `<div class="crow"><div class="cmain"><div class="cname">${esc(t(docMap[d.name] || d.name))}</div>
        ${d.expiryDate ? `<div class="cwhy">${esc(t("vault_expiry"))}: ${esc(d.expiryDate)}</div>` : ""}</div>
        <select data-doc="${idx}"><option value="false"${!d.available ? " selected" : ""}>${esc(t("vault_available"))}: ${esc(t("no"))}</option>
        <option value="true"${d.available ? " selected" : ""}>${esc(t("vault_available"))}: ${esc(t("yes"))}</option></select></div>`).join("")}
      </div>`;
    $$("[data-doc]", root).forEach(sel => sel.addEventListener("change", () => {
      v[+sel.dataset.doc].available = sel.value === "true"; v[+sel.dataset.doc].lastChecked = Store.now();
      Store.saveVault(v); go("vault");
    }));
  }

  /* ============================================================ VIEW: readiness */
  function renderReadiness(root) {
    const p = Store.getActiveProfile();
    if (!p) { root.innerHTML = `<h2 class="vtitle">${esc(t("rdy_title"))}</h2><div class="empty"><b>${esc(t("prof_create_first"))}</b></div>`; return; }
    const score = procurementReadiness(p);
    const band = procurementBand(score);
    root.innerHTML = `<h2 class="vtitle">${esc(t("rdy_title"))}</h2><p class="vsub">${esc(t("rdy_sub"))}</p>
      <div class="panel"><div class="row-between"><div class="sectit">${esc(t("rdy_score"))}</div>
        <div class="mono" style="font-size:22px;color:var(--gold)">${score}%</div></div>
        <div class="bar" style="margin:8px 0"><i style="width:${score}%"></i></div>
        <div><b>${esc(t(band))}</b></div></div>
      <div class="panel"><div class="sectit">${esc(t("rdy_improve"))}</div>
        <button class="btn primary" id="r-gen">${esc(t("rdy_generate"))}</button>
        <div id="r-roadmap" style="margin-top:12px"></div></div>
      <div class="panel"><div class="sectit">${esc(t("mem_title"))}</div><div id="r-mem">${esc(t("mem_empty"))}</div>
        <button class="btn ghost sm" id="r-learn" style="margin-top:10px">${esc(t("rdy_generate"))}</button></div>`;
    $("#r-gen", root).addEventListener("click", () => genRoadmap(p));
    $("#r-learn", root).addEventListener("click", () => showMemory());
  }
  async function genRoadmap(p) {
    const btn = $("#r-gen"); btn.disabled = true; btn.textContent = t("loading");
    try {
      const out = await groq([
        { role: "system", content: "You are Procura's roadmap module. Give a public-procurement competitiveness roadmap for this company. " +
          'Respond ONLY with JSON: {"items":[{"improvement":"","impact":"high|medium|low","difficulty":"high|medium|low","urgency":"high|medium|low","reason":""}]}. 5-9 items, write text in ' + aiLang() + ", keep enums English." },
        { role: "user", content: profileBrief(p) + "\nVault completeness: " + Store.vaultCompleteness() + "%" }
      ], 1400) || {};
      $("#r-roadmap").innerHTML = (out.items || []).map(i => `<div class="crow"><div class="cmain">
        <div class="cname">${esc(i.improvement)}</div><div class="cwhy">${esc(i.reason || "")}</div>
        <div class="chips" style="margin-top:5px"><span class="chip">${esc(t("rm_impact"))}: ${esc(i.impact)}</span>
        <span class="chip">${esc(t("rm_difficulty"))}: ${esc(i.difficulty)}</span><span class="chip">${esc(t("rm_urgency"))}: ${esc(i.urgency)}</span></div></div></div>`).join("");
    } catch (e) { toast(e.message || String(e)); }
    finally { btn.disabled = false; btn.textContent = t("rdy_generate"); }
  }
  async function showMemory() {
    const btn = $("#r-learn"); btn.disabled = true; btn.textContent = t("loading");
    try {
      const m = await learnSummary();
      if (!m) { $("#r-mem").textContent = t("mem_empty"); return; }
      $("#r-mem").innerHTML = `${m.best_sectors && m.best_sectors.length ? `<div><b>${esc(t("mem_sectors"))}:</b> ${esc(m.best_sectors.join(", "))}</div>` : ""}
        ${m.usual_loss_reasons && m.usual_loss_reasons.length ? `<div><b>${esc(t("mem_blocker"))}:</b> ${esc(m.usual_loss_reasons.join(", "))}</div>` : ""}
        ${m.win_rate_pct != null ? `<div><b>${esc(t("mem_winrate"))}:</b> ${esc(m.win_rate_pct)}%</div>` : ""}
        ${m.recommendation ? `<div class="note" style="margin-top:8px">${esc(m.recommendation)}</div>` : ""}`;
    } catch (e) { toast(e.message || String(e)); }
    finally { btn.disabled = false; btn.textContent = t("rdy_generate"); }
  }

  /* ============================================================ VIEW: saved searches */
  function renderSearches(root) {
    const list = Store.getSearches();
    root.innerHTML = `<h2 class="vtitle">${esc(t("sav_title"))}</h2><p class="vsub">${esc(t("sav_sub"))}</p>
      ${!list.length ? `<div class="empty"><b>${esc(t("sav_empty"))}</b></div>` :
        list.map(s => { const stale = (daysSince(s.lastRun) || 0) >= 7;
          return `<article class="card"><div class="row-between"><div><b>${esc(s.name || countryName(s.country))}</b>
            <div class="muted" style="font-size:12.5px">${esc(t("sav_lastrun"))}: ${esc(fmtDate(s.lastRun) || "—")} · ${esc(t("sav_results"))}: ${s.lastResultCount || 0}</div></div>
            ${stale ? `<span class="pill warn">${esc(t("sav_stale"))}</span>` : ""}</div>
            <div class="chips" style="margin:8px 0">${(s.cpv || []).slice(0, 6).map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
            <div class="btnrow"><button class="btn primary sm" data-run="${esc(s.id)}">${esc(t("sav_run"))}</button>
              <button class="btn danger sm" data-del="${esc(s.id)}">${esc(t("del"))}</button></div></article>`; }).join("")}`;
    $$("[data-run]", root).forEach(b => b.addEventListener("click", () => {
      const s = Store.getSearches().find(x => x.id === b.dataset.run); if (!s) return;
      const prof = Store.getProfiles().find(p => p.id === s.profileId); if (prof) Store.setActiveProfile(prof.id);
      go("search"); setTimeout(() => { const c = $("#s-country"); if (c) c.value = s.country; runSearch(Store.getActiveProfile()); }, 60);
    }));
    $$("[data-del]", root).forEach(b => b.addEventListener("click", () => { Store.deleteSearch(b.dataset.del); go("searches"); }));
  }

  /* ============================================================ VIEW: settings */
  function renderSettings(root) {
    const s = Store.getSettings();
    root.innerHTML = `<h2 class="vtitle">${esc(t("set_title"))}</h2><p class="vsub">${esc(t("set_sub"))}</p>
      <div class="panel"><div class="grid">
        <div class="fieldgroup"><label class="fld">${esc(t("set_lang"))}</label><select id="set-lang">
          ${["bg", "de", "en"].map(l => `<option value="${l}"${LANG === l ? " selected" : ""}>${l.toUpperCase()}</option>`).join("")}</select></div>
        <div class="fieldgroup"><label class="fld">${esc(t("set_country"))}</label><select id="set-country">${countryOptions(s.defaultCountry)}</select></div>
        ${field(t("set_maxvalue"), "set-maxval", s.defaultMaxValue, "number")}
        ${field(t("set_currency"), "set-currency", s.currency)}
        <div class="fieldgroup"><label class="fld">${esc(t("set_risk"))}</label><select id="set-risk">
          ${["conservative", "balanced", "aggressive"].map(r => `<option value="${r}"${s.riskTolerance === r ? " selected" : ""}>${esc(t("risk_" + r))}</option>`).join("")}</select></div>
        <div class="fieldgroup"><label class="fld">${esc(t("set_size"))}</label><select id="set-size">
          ${["any", "small", "medium", "large"].map(r => `<option value="${r}"${s.preferredSize === r ? " selected" : ""}>${esc(t("psize_" + r))}</option>`).join("")}</select></div>
        <div class="fieldgroup"><label class="fld">${esc(t("set_style"))}</label><select id="set-style">
          ${["strict", "exploratory"].map(r => `<option value="${r}"${s.decisionStyle === r ? " selected" : ""}>${esc(t("style_" + r))}</option>`).join("")}</select></div>
        ${field(t("set_mindays"), "set-mindays", s.minWorkingDays, "number")}
      </div>
      <button class="btn primary" id="set-save" style="margin-top:6px">${esc(t("save"))}</button></div>

      <div class="panel"><div class="sectit">${esc(t("set_export"))} / ${esc(t("set_import"))}</div>
        <div class="note">${esc(t("export_warn"))}</div>
        <div class="btnrow"><button class="btn ghost sm" id="set-exp">${esc(t("set_export"))}</button>
          <button class="btn ghost sm" id="set-imp">${esc(t("set_import"))}</button>
          <input type="file" id="set-file" accept="application/json" style="display:none" /></div></div>

      <div class="panel"><div class="sectit">${esc(t("privacy_title"))}</div>
        <p class="muted" style="font-size:12.5px;margin:0">${esc(t("footer_dis"))}</p></div>

      <div class="panel"><button class="btn danger" id="set-reset">${esc(t("set_reset"))}</button></div>`;

    $("#set-save", root).addEventListener("click", () => {
      Store.saveSettings({
        language: $("#set-lang").value, defaultCountry: $("#set-country").value,
        defaultMaxValue: num($("#set-maxval").value), currency: $("#set-currency").value || "EUR",
        riskTolerance: $("#set-risk").value, preferredSize: $("#set-size").value,
        decisionStyle: $("#set-style").value, minWorkingDays: intp($("#set-mindays").value) || 7
      });
      setLang($("#set-lang").value); toast(t("saved"));
    });
    $("#set-exp", root).addEventListener("click", () => download("procura-workspace.json", JSON.stringify(Store.exportWorkspace(), null, 2)));
    $("#set-imp", root).addEventListener("click", () => $("#set-file").click());
    $("#set-file", root).addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { try { Store.importWorkspace(JSON.parse(r.result)); toast(t("saved")); go("dashboard"); } catch (err) { toast(err.message || String(err)); } };
      r.readAsText(f);
    });
    $("#set-reset", root).addEventListener("click", () => { if (confirm(t("set_reset_confirm"))) { Store.wipe(); toast(t("deleted")); go("dashboard"); } });
  }

  /* ============================================================ VIEW: agent log */
  function renderLog(root) {
    root.innerHTML = `<h2 class="vtitle">${esc(t("log_title"))}</h2><p class="vsub">${esc(t("log_sub"))}</p>
      ${!AGENTLOG.length ? `<div class="empty">${esc(t("log_empty"))}</div>` :
        `<div class="panel">${AGENTLOG.map(e => `<div class="crow"><div class="cmain">
          <div class="cname"><span class="mono muted">[${esc(e.ts)}]</span> <b>${esc(e.phase)}</b> — ${esc(e.decision)}</div>
          ${e.reason ? `<div class="cwhy">${esc(e.reason)}</div>` : ""}
          ${e.output ? `<div class="cwhy mono">${esc(e.output)}</div>` : ""}</div></div>`).join("")}</div>
        <button class="btn ghost sm" id="log-clear">${esc(t("log_clear"))}</button>`}`;
    if ($("#log-clear", root)) $("#log-clear", root).addEventListener("click", () => { AGENTLOG.length = 0; go("log"); });
  }

  /* ============================================================ VIEW: about */
  function renderAbout(root) {
    root.innerHTML = `<h2 class="vtitle">${esc(t("about_title"))}</h2>
      <div class="panel">
        <p>${esc(t("about_p1"))}</p>
        <p>${esc(t("about_p2"))}</p>
        <p>${esc(t("about_p3"))}</p>
      </div>
      <div class="panel"><div class="sectit">${esc(t("work_title"))}</div>
        <ul style="margin:0;padding-left:18px;color:var(--paper-dim);font-size:13.5px">${(t("work_items") || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  }

  /* ============================================================ win/loss modal (inline) */
  function openWinLoss(tn) {
    DOSSIER_ID = tn.id;
    const root = $("#v-dossier");
    go("dossier");
    const result = tn.pipelineStage === "won" ? "won" : "lost";
    const panel = document.createElement("div"); panel.className = "panel"; panel.id = "wl-panel";
    panel.innerHTML = `<div class="sectit">${esc(t("wl_title"))}</div>
      <div class="fieldgroup"><label class="fld">${esc(t("wl_result"))}</label><select id="wl-result">
        ${["won", "lost", "abandoned"].map(r => `<option value="${r}"${result === r ? " selected" : ""}>${esc(t("res_" + r))}</option>`).join("")}</select></div>
      <div class="fieldgroup"><label class="fld">${esc(t("wl_reason"))}</label><input id="wl-reason" /></div>
      <div class="fieldgroup"><label class="fld">${esc(t("wl_notes"))}</label><textarea id="wl-notes" style="min-height:60px"></textarea></div>
      <button class="btn primary" id="wl-save">${esc(t("wl_save"))}</button>`;
    root.insertBefore(panel, root.firstChild);
    $("#wl-save").addEventListener("click", () => {
      Store.addWinLoss({ tenderId: tn.id, result: $("#wl-result").value, reason: $("#wl-reason").value, notes: $("#wl-notes").value });
      tn.pipelineStage = $("#wl-result").value; Store.saveTender(tn);
      logEvent("learning update", "Recorded outcome: " + $("#wl-result").value, tn.title, null, {});
      toast(t("saved")); renderTabs(); go("dossier");
    });
  }

  /* ============================================================ sample profiles */
  const SAMPLES = [
    { name: "Plovdiv Electro Services", country: "BGR", city: "Plovdiv", size: "small", employees: 9, maxContractValue: 250000,
      mainServices: "Commercial electrical installation, LED lighting retrofits, small solar PV for buildings, building maintenance",
      industries: "Construction, facility management", cpvInterests: "45310000, 31500000, 09332000",
      geographicCoverage: "Bulgaria, Romania, Greece", certifications: "Electrical safety certificate",
      privateRefs: true, publicRefs: false, taxClearance: true, financialStatements: true, espdExperience: "unknown" },
    { name: "Helix IT Consulting", country: "DEU", city: "Munich", size: "small", employees: 14, maxContractValue: 400000,
      mainServices: "Web application development, cloud migration, software integration, cybersecurity for small organisations",
      industries: "IT services", cpvInterests: "72000000, 48000000",
      geographicCoverage: "Germany, Austria", certifications: "ISO 27001",
      privateRefs: true, publicRefs: true, taxClearance: true, financialStatements: true, espdExperience: "yes" },
    { name: "ČistoPro Cleaning", country: "BGR", city: "Sofia", size: "small", employees: 22, maxContractValue: 180000,
      mainServices: "Commercial cleaning, office and facility maintenance, window cleaning, disinfection services",
      industries: "Facility services", cpvInterests: "90910000, 90919200",
      geographicCoverage: "Bulgaria", privateRefs: true, publicRefs: true, taxClearance: true, espdExperience: "no" },
    { name: "NordFlow Logistics", country: "POL", city: "Wrocław", size: "medium", employees: 60, maxContractValue: 900000,
      mainServices: "Road freight, warehousing, last-mile distribution, supply-chain services",
      industries: "Logistics, transport", cpvInterests: "60000000, 63100000",
      geographicCoverage: "Poland, Germany, Czechia", privateRefs: true, publicRefs: false, espdExperience: "unknown" },
    { name: "BuildCare Maintenance", country: "BGR", city: "Varna", size: "micro", employees: 6, maxContractValue: 120000,
      mainServices: "Small construction works, building repair and maintenance, painting, minor renovation",
      industries: "Construction", cpvInterests: "45453000, 45442100",
      geographicCoverage: "Bulgaria", privateRefs: true, publicRefs: false, espdExperience: "unknown" }
  ];
  function showSamples() {
    const root = $("#v-profile");
    root.innerHTML = `<h2 class="vtitle">${esc(t("prof_load_sample"))}</h2>
      ${SAMPLES.map((s, i) => `<article class="card"><div class="row-between"><div><b>${esc(s.name)}</b>
        <div class="muted" style="font-size:12.5px">${esc(countryName(s.country))} · ${esc(t("size_" + s.size))} · ${esc(fmtMoney(s.maxContractValue))}</div></div>
        <button class="btn primary sm" data-sample="${i}">${esc(t("open"))}</button></div>
        <div class="muted" style="font-size:13px;margin-top:7px">${esc(s.mainServices)}</div></article>`).join("")}
      <button class="btn ghost" id="sample-back">${esc(t("back"))}</button>`;
    $$("[data-sample]", root).forEach(b => b.addEventListener("click", () => {
      const base = Store.blankProfile();
      const p = Object.assign(base, SAMPLES[+b.dataset.sample]);
      Store.saveProfile(p); Store.setActiveProfile(p.id); toast(t("saved")); go("profile");
    }));
    $("#sample-back", root).addEventListener("click", () => go("profile"));
  }

  /* ============================================================ misc */
  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function wireGo(root) { $$("[data-go]", root).forEach(b => b.addEventListener("click", () => { if (b.dataset.dossier) DOSSIER_ID = b.dataset.dossier; go(b.dataset.go); })); }

  const RENDER = {
    dashboard: renderDashboard, profile: renderProfile, search: renderSearch, pipeline: renderPipeline,
    dossier: renderDossier, manual: renderManual, vault: renderVault, readiness: renderReadiness,
    searches: renderSearches, settings: renderSettings, log: renderLog, about: renderAbout
  };

  /* ============================================================ language switch + chrome */
  function paintChrome() {
    document.documentElement.lang = (I18N[LANG].htmllang) || LANG;
    $("#brand-sub").textContent = t("brand_sub");
    $("#footer-dis").textContent = t("footer_dis");
    $("#footer-brand").textContent = t("footer_brand");
    $$("#langbar button").forEach(b => b.classList.toggle("on", b.dataset.lang === LANG));
  }
  function setLang(l) {
    if (!I18N[l]) return;
    LANG = l; localStorage.setItem("procura_lang", l);
    Store.saveSettings({ language: l });
    paintChrome(); renderTabs();
    const fn = RENDER[CURRENT]; if (fn) fn($("#v-" + CURRENT));
  }

  /* add manual + dossier into the tab set only if needed — they are reachable via buttons,
     but we also expose a Manual tab between search and pipeline for discoverability */
  function injectExtraTabs() {
    // add Manual analysis tab after "search"
    const idx = TABS.findIndex(x => x[0] === "search");
    if (idx >= 0 && !TABS.some(x => x[0] === "manual")) TABS.splice(idx + 1, 0, ["manual", "mode_manual"]);
  }

  /* ============================================================ init */
  function init() {
    Store.init();
    injectExtraTabs();
    $$("#langbar button").forEach(b => b.addEventListener("click", () => setLang(b.dataset.lang)));
    paintChrome();
    renderTabs();
    go("dashboard");
    if (navigator.serviceWorker) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
  }
  document.addEventListener("DOMContentLoaded", init);
})();
