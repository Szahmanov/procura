/* Procura — store.js
   Local-only data layer. No backend, no accounts. Everything lives in localStorage
   under the procura.* namespace and is exportable as one JSON workspace. */
(function (global) {
  "use strict";

  const K = {
    profiles: "procura.companyProfiles",
    activeProfile: "procura.activeCompanyProfileId",
    tenders: "procura.savedTenders",
    vault: "procura.documentVault",
    searches: "procura.savedSearches",
    winloss: "procura.winLossHistory",
    settings: "procura.settings",
    version: "procura.workspaceVersion"
  };
  const WORKSPACE_VERSION = 2;

  function read(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
  }
  function uid(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function now() { return new Date().toISOString(); }

  const DEFAULT_SETTINGS = {
    language: null,                 // null => fall back to procura_lang / bg
    defaultCountry: "BGR",
    defaultMaxValue: null,
    currency: "EUR",
    riskTolerance: "balanced",      // conservative | balanced | aggressive
    preferredSize: "any",           // small | medium | large | any
    decisionStyle: "strict",        // strict | exploratory
    minWorkingDays: 7,              // working days needed before a deadline
    reminderDays: 7
  };

  const PIPELINE_STAGES = [
    "found", "shortlisted", "eligibility", "documents",
    "preparing", "submitted", "waiting", "won", "lost", "abandoned"
  ];

  const VAULT_DOCS = [
    "company_registration", "tax_clearance", "social_security", "financial_statements",
    "insurance", "iso_certificates", "professional_licenses", "project_references",
    "staff_cvs", "equipment_list", "electronic_signature", "bank_guarantee", "espd_template"
  ];

  const Store = {
    K, WORKSPACE_VERSION, PIPELINE_STAGES, VAULT_DOCS, uid, now,

    init() {
      if (read(K.version, null) == null) write(K.version, WORKSPACE_VERSION);
      if (read(K.settings, null) == null) write(K.settings, DEFAULT_SETTINGS);
      if (read(K.vault, null) == null) write(K.vault, this.defaultVault());
    },

    /* ---------- settings ---------- */
    getSettings() { return Object.assign({}, DEFAULT_SETTINGS, read(K.settings, {})); },
    saveSettings(s) { write(K.settings, Object.assign(this.getSettings(), s || {})); return this.getSettings(); },

    /* ---------- company profiles ---------- */
    getProfiles() { return read(K.profiles, []); },
    getActiveProfileId() { return read(K.activeProfile, null); },
    setActiveProfile(id) { write(K.activeProfile, id); },
    getActiveProfile() {
      const id = this.getActiveProfileId();
      return this.getProfiles().find(p => p.id === id) || null;
    },
    blankProfile() {
      return {
        id: uid("co"), name: "", country: this.getSettings().defaultCountry, city: "",
        size: "small", employees: null, yearEstablished: null, annualTurnover: null,
        maxContractValue: null, mainServices: "", secondaryServices: "", industries: "",
        cpvInterests: "", languages: "", publicRefs: false, privateRefs: false,
        pastPublicContracts: false, certifications: "", insurance: false, taxClearance: false,
        socialSecurity: false, financialStatements: false, espdExperience: "unknown",
        teamCapacity: "", geographicCoverage: "", willSubcontract: false, willConsortium: false,
        notes: "", createdAt: now(), updatedAt: now()
      };
    },
    saveProfile(p) {
      const list = this.getProfiles();
      p.updatedAt = now();
      const i = list.findIndex(x => x.id === p.id);
      if (i >= 0) list[i] = p; else { p.createdAt = p.createdAt || now(); list.push(p); }
      write(K.profiles, list);
      if (!this.getActiveProfileId()) this.setActiveProfile(p.id);
      return p;
    },
    duplicateProfile(id) {
      const src = this.getProfiles().find(p => p.id === id);
      if (!src) return null;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid("co"); copy.name = (src.name || "Profile") + " (copy)";
      copy.createdAt = now(); copy.updatedAt = now();
      const list = this.getProfiles(); list.push(copy); write(K.profiles, list);
      return copy;
    },
    deleteProfile(id) {
      let list = this.getProfiles().filter(p => p.id !== id);
      write(K.profiles, list);
      if (this.getActiveProfileId() === id) this.setActiveProfile(list[0] ? list[0].id : null);
    },
    profileCompleteness(p) {
      if (!p) return 0;
      const checks = [
        !!p.name, !!p.country, !!p.mainServices, !!p.maxContractValue,
        !!p.employees, !!p.geographicCoverage, !!p.cpvInterests || !!p.industries,
        p.publicRefs || p.privateRefs, !!p.certifications, p.taxClearance,
        p.financialStatements, p.espdExperience !== "unknown"
      ];
      return Math.round(100 * checks.filter(Boolean).length / checks.length);
    },

    /* ---------- saved tenders / pipeline ---------- */
    getTenders() { return read(K.tenders, []); },
    getTender(id) { return this.getTenders().find(t => t.id === id) || null; },
    saveTender(t) {
      const list = this.getTenders();
      t.updatedAt = now();
      const i = list.findIndex(x => x.id === t.id);
      if (i >= 0) list[i] = t; else { t.createdAt = t.createdAt || now(); list.push(t); }
      write(K.tenders, list);
      return t;
    },
    deleteTender(id) { write(K.tenders, this.getTenders().filter(t => t.id !== id)); },
    isSaved(tedId) { return this.getTenders().some(t => t.tedId === tedId); },

    /* turn an agent result row into a persistent saved-tender object */
    tenderFromResult(row, profileId, source) {
      return {
        id: uid("t"), source: source || "ted", tedId: row.id || null,
        title: row.title || "", buyer: row.buyer || "", country: row.country || "",
        deadline: row.deadline || "", officialLink: row.officialLink || row.link || "",
        cpv: row.cpv || [], value: row.value || "", fit: row.fit ?? null,
        winProbability: row.win ?? null, bidDecision: row.bidDecision || null,
        riskLevel: row.riskLevel || null, biggestRisk: row.risk || "",
        reason: row.reason || "", confidence: row.confidence ?? null,
        nextBestAction: row.nextBestAction || "", pipelineStage: "found",
        matchSource: row.matchSource || "cpv",
        eligibilityChecklist: row.eligibilityChecklist || [],
        documentChecklist: row.documentChecklist || [],
        tasks: row.tasks || [], plan: row.plan || null, consortium: row.consortium || null,
        analysisText: "", analysis: null, dossierNotes: "",
        decisionLog: row.decisionLog || [], profileId: profileId || null,
        createdAt: now(), updatedAt: now()
      };
    },

    pipelineCounts() {
      const c = {}; PIPELINE_STAGES.forEach(s => c[s] = 0);
      this.getTenders().forEach(t => { if (c[t.pipelineStage] != null) c[t.pipelineStage]++; });
      return c;
    },

    /* ---------- document vault ---------- */
    defaultVault() {
      return VAULT_DOCS.map(name => ({
        id: uid("doc"), name, available: false, expiryDate: null, notes: "", lastChecked: null
      }));
    },
    getVault() { return read(K.vault, this.defaultVault()); },
    saveVault(v) { write(K.vault, v); },
    vaultCompleteness() {
      const v = this.getVault(); if (!v.length) return 0;
      return Math.round(100 * v.filter(d => d.available).length / v.length);
    },

    /* ---------- saved searches ---------- */
    getSearches() { return read(K.searches, []); },
    saveSearch(s) {
      const list = this.getSearches();
      const i = list.findIndex(x => x.id === s.id);
      if (i >= 0) list[i] = s; else { s.id = s.id || uid("s"); s.createdAt = now(); list.push(s); }
      write(K.searches, list); return s;
    },
    deleteSearch(id) { write(K.searches, this.getSearches().filter(s => s.id !== id)); },

    /* ---------- win / loss history ---------- */
    getWinLoss() { return read(K.winloss, []); },
    addWinLoss(rec) {
      const list = this.getWinLoss();
      rec.id = rec.id || uid("wl"); rec.createdAt = now();
      list.push(rec); write(K.winloss, list); return rec;
    },

    /* ---------- export / import ---------- */
    exportWorkspace() {
      return {
        _app: "Procura", _version: WORKSPACE_VERSION, _exportedAt: now(),
        companyProfiles: this.getProfiles(),
        activeCompanyProfileId: this.getActiveProfileId(),
        savedTenders: this.getTenders(),
        documentVault: this.getVault(),
        savedSearches: this.getSearches(),
        winLossHistory: this.getWinLoss(),
        settings: this.getSettings()
      };
    },
    importWorkspace(obj) {
      if (!obj || obj._app !== "Procura") throw new Error("not a Procura workspace file");
      if (obj.companyProfiles) write(K.profiles, obj.companyProfiles);
      if (obj.activeCompanyProfileId !== undefined) write(K.activeProfile, obj.activeCompanyProfileId);
      if (obj.savedTenders) write(K.tenders, obj.savedTenders);
      if (obj.documentVault) write(K.vault, obj.documentVault);
      if (obj.savedSearches) write(K.searches, obj.savedSearches);
      if (obj.winLossHistory) write(K.winloss, obj.winLossHistory);
      if (obj.settings) write(K.settings, Object.assign({}, DEFAULT_SETTINGS, obj.settings));
      write(K.version, WORKSPACE_VERSION);
      return true;
    },
    wipe() {
      Object.values(K).forEach(k => localStorage.removeItem(k));
      this.init();
    }
  };

  global.Store = Store;
})(window);
