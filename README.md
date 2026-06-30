# Procura — Autonomous Tender Opportunity & Bid Manager

**Find the contracts worth bidding for, and know exactly what to do next.**

Procura is a procurement agent for small businesses. It reads the official EU tender
register (TED) live, decides which open contracts your company can realistically win,
tracks each opportunity through a bid pipeline, builds eligibility checklists and bid
plans, watches deadlines, and learns from your win/loss outcomes.

It runs on free infrastructure only: the free TED API and the free Groq tier. No login,
no database, no paid services. Everything you save stays in your browser.

A StaGove agent.

---

## What it does

You start by saving a **company profile** once. Procura uses that profile in every search
and every judgement, so you never re-describe your company. From there it covers the whole
path a small firm walks to win a public contract:

- **Live TED search** built from your profile (CPV strategy you can edit before running).
- **Fit and win-probability scoring** that stays conservative on purpose.
- **A self-audit pass** that demotes traps it found in its own shortlist.
- **A BID / CONDITIONAL BID / NO BID decision** with reason, main risk, next step, confidence.
- **A tender pipeline** with ten stages, from Found to Won/Lost.
- **Deadline and urgency tracking** with a "next best action" on every saved tender.
- **Eligibility checklists** you can tick off as you verify each requirement.
- **A document vault** that tracks which papers you hold (tax clearance, ISO, references...).
- **Manual tender analysis**: paste text from a national portal or a PDF, get a grounded
  read that never invents requirements.
- **Bid readiness and procurement readiness scores**, so you know if you can submit.
- **Win/loss learning** that feeds past outcomes back into future judgement.
- **Export / import** of your whole workspace, since there is no server backup.

The interface and the agent's reasoning both run in **Bulgarian, German, or English**.

---

## Why it is autonomous (and not just ChatGPT)

A chatbot can explain how procurement works. It cannot search the live TED register, verify
which notices are still open, link the official tender page, score each one against your saved
profile, audit its own shortlist, track bid stages, watch deadlines, and learn from your
results. Procura combines live official data, deterministic gates (deadline, capacity), and
multi-step reasoning that judges, decides, and self-corrects. Its decision log records every
step with a timestamp, the phase, the decision, the reason, and a confidence number.

---

## File tree (upload exactly like this)

```
procura/
├── index.html            ← app shell + all styling, loads the three scripts below
├── i18n.js               ← every UI string in BG / DE / EN
├── store.js              ← the local data layer (localStorage), all save/load logic
├── app.js                ← the agent: router, all views, scoring, the Groq pipeline
├── test.html             ← diagnostics page (open at your-site.netlify.app/test.html)
├── manifest.json         ← makes it installable as an app
├── service-worker.js     ← offline app shell
├── netlify.toml          ← tells Netlify where the functions are
├── README.md
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── apple-touch-icon.png
└── netlify/
    └── functions/
        ├── ted.js        ← calls the official EU TED API (no key needed)
        └── groq.js       ← calls Groq, keeps your API key server-side
```

`i18n.js`, `store.js`, and `app.js` sit at the **root**, next to `index.html`. The
`netlify/functions/` folder is where Netlify looks for the backend. Keep the folders intact.

---

## Deploy (no terminal needed)

1. **Create the repo on GitHub** (web UI). Upload every file, keeping the folders.
   To make a folder in the GitHub uploader, type the path into the filename: name the TED
   function `netlify/functions/ted.js` and GitHub creates the folders for you.
2. **Connect the repo to Netlify**: *Add new site* → *Import an existing project* → pick the repo.
   Leave the build command empty. Publish directory is `.` (Netlify reads this from `netlify.toml`).
3. **Add your Groq key** in Netlify → *Site settings* → *Environment variables*:
   - Key: `GROQ_API_KEY`
   - Value: your free key from <https://console.groq.com>
4. **Deploy.** After adding the key, use *Trigger deploy* → *Clear cache and deploy site*.
5. Open the site. On a phone, use *Add to Home Screen* to install it.
6. **Check it:** open `your-site.netlify.app/test.html` and run the diagnostics. It confirms
   the functions are reachable, the key is set, TED returns live data, and a full
   plan→search→score run works.

---

## How your data is stored

Everything you save lives in this browser through `localStorage`, under keys that start with
`procura.`: company profiles, saved tenders and their pipeline stage, the document vault, saved
searches, win/loss history, and settings. No account, no server copy.

Because the data is local:

- Clearing browser data, or switching device or browser, loses your saved work.
- Use **Settings → Export Workspace** to download a backup file, and **Import Workspace** to
  restore it on another device.
- Procura sends your company profile and any tender text you paste to Groq for analysis. Avoid
  pasting confidential pricing unless you need it analysed.

---

## How the main features work

**Company profiles.** Create one or more under the Company Profile tab. The active profile drives
CPV selection, capacity checks, eligibility risks, scoring, and bid plans. Five sample profiles
load with one click for testing.

**Tender pipeline.** Save any result into the pipeline. Each saved tender carries a stage (Found,
Shortlisted, Eligibility Check, Documents Needed, Bid Preparing, Submitted, Waiting Result, Won,
Lost, Abandoned), a deadline countdown, a bid decision, and a next best action. The dashboard
shows the counts and the single most urgent action across everything you track.

**Manual tender analysis.** TED only carries higher-value EU notices. Smaller local tenders appear
on national portals (in Bulgaria, ЦАИС ЕОП at `app.eop.bg`). Paste that listing into Manual Tender
Analysis and Procura reads only what you pasted. If a requirement, deadline, or fee is not in the
text, it says so instead of inventing one.

**Export / import.** Settings has Export Workspace and Import Workspace for moving everything
between devices, plus per-tender dossier export.

---

## Limits and troubleshooting

- **TED scope.** TED publishes tenders above EU value thresholds, so small local contracts may not
  appear there. Use Manual Tender Analysis for national-portal listings.
- **No backend run on your computer.** The agent only works on the deployed Netlify site. Opening
  `index.html` as a local file will not reach the functions.
- **"GROQ_API_KEY is not set."** Add it in Netlify environment variables, then redeploy with cache
  cleared.
- **No tenders found.** That sector may have nothing open today. Broaden the description, try a
  neighbouring country, or use Manual Tender Analysis.
- **Functions return 404.** Confirm the files sit at `netlify/functions/ted.js` and
  `netlify/functions/groq.js`, and that `netlify.toml` is in the repo root.
- **App shows old version after an update.** The service worker caches the shell. Open `test.html`,
  or reload twice, or clear site data to pick up the new files.
