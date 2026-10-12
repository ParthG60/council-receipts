/* Council Receipts — static site. Reads site/data.json (baked by site/build.py). */

/* Receipt palette: council = ink, comparisons = warm grey, money/benchmark = stamp red. */
const ACCENT = "#262420";
const ACCENT_2 = "#8c877a";
const GREY = "#b6ad9c";
const SPEND_COLOR = "#b5372b";

const PLOTLY_CONFIG = {
  displayModeBar: false,
  responsive: true,
  staticPlot: true,
};

/* Every chart inherits receipt typography + transparent paper without touching
   each call site: wrap newPlot once and merge a base layout in. */
const BASE_FONT = { family: "'IBM Plex Mono', ui-monospace, monospace", size: 12, color: "#262420" };
const RAW_NEWPLOT = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (id, traces, layout = {}, config = PLOTLY_CONFIG) =>
  RAW_NEWPLOT(id, traces, {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    ...layout,
    xaxis: { fixedrange: true, ...(layout.xaxis || {}) },
    yaxis: { fixedrange: true, automargin: false, ...(layout.yaxis || {}) },
    font: { ...BASE_FONT, ...(layout.font || {}) },
  }, { ...PLOTLY_CONFIG, ...(config || {}) });

/* RSX service names are too long for a chart margin — short display labels,
   two lines where still long. Keyed by the exact RSX name in data.json. */
const SERVICE_SHORT = {
  "Education services": "Education",
  "Highways and transport services": "Highways &<br>transport",
  "Children Social Care": "Children's<br>social care",
  "Adult Social Care": "Adult social care",
  "Public Health": "Public health",
  "Housing services (GFRA only)": "Housing",
  "Cultural and related services": "Culture & leisure",
  "Environmental and regulatory services": "Environment &<br>regulatory",
  "Planning and development services": "Planning &<br>development",
};
function shortService(s) { return SERVICE_SHORT[s] || s; }

let DATA = null;

function el(id) { return document.getElementById(id); }

function isMobile() {
  return typeof window !== "undefined" && window.innerWidth < 640;
}

function fmtPopulation(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return Math.round(n / 1000) + "k";
}

function fmtGbp(n, decimals = 0) {
  if (n == null) return null;
  const sign = n < 0 ? "-" : "";
  return sign + "£" + Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: decimals });
}

function showPanel(id, show) {
  const p = el(id);
  if (p) p.style.display = show ? "" : "none";
}

function swatch(color, label) {
  return `<span class="key-swatch" style="background:${color}"></span>${label}`;
}

// Outside-positioned bar-end labels get clipped to the plot area by default.
// cliponaxis:false lets Plotly draw them past it; pair with headroom in the
// axis range (computed per chart below) so the figure itself doesn't crop them.
function withClip(trace) {
  return Object.assign({}, trace, { cliponaxis: false });
}
function headroomRange(values, pad = 0.22) {
  const max = Math.max(...values.map(Math.abs), 1);
  return [0, max * (1 + pad)];
}

// ------------------------------------------------------ colour ramp ---
// Colour-blind-safe diverging scale (PiYG-style): green = good (best rank),
// magenta = bad (worst rank), pale in the middle.
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpHex(hex1, hex2, t) {
  const c1 = [1, 3, 5].map((i) => parseInt(hex1.slice(i, i + 2), 16));
  const c2 = [1, 3, 5].map((i) => parseInt(hex2.slice(i, i + 2), 16));
  const c = c1.map((v, i) => Math.round(lerp(v, c2[i], t)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function rankColor(rank, n) {
  if (rank == null || !n || n <= 1) return "#f0f0f0";
  const t = (rank - 1) / (n - 1); // 0 = best, 1 = worst
  const GOOD = "#4d9221", MID = "#f7f7f7", BAD = "#c51b7d";
  return t < 0.5 ? lerpHex(GOOD, MID, t * 2) : lerpHex(MID, BAD, (t - 0.5) * 2);
}
function textOnColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#1a1a1a" : "#ffffff";
}

// ---------------------------------------------------------------- tabs ---
function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      el("tab-" + btn.dataset.tab).classList.add("active");
      window.dispatchEvent(new Event("resize"));
    });
  });
}

// ------------------------------------------------ postcode -> council ---
// Keyless, CORS-enabled UK postcode lookup. Resolves a postcode to the
// citizen's district council and, in two-tier areas, the county council too.
const POSTCODE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/i;

function normaliseCouncilName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(city of|county of|royal borough of|borough of|the|city|council|county|district|borough|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let _nameIndex = null;
function councilNameIndex() {
  if (!_nameIndex) {
    _nameIndex = {};
    Object.keys(DATA.councils).forEach((k) => {
      const n = normaliseCouncilName(k);
      if (n && !(n in _nameIndex)) _nameIndex[n] = k;
    });
  }
  return _nameIndex;
}

function matchCouncilName(name) {
  if (!name) return null;
  const idx = councilNameIndex();
  const n = normaliseCouncilName(name);
  if (!n) return null;
  if (idx[n]) return idx[n];
  const starts = Object.keys(idx).filter((k) => k.startsWith(n + " ") || n.startsWith(k + " "));
  return starts.length === 1 ? idx[starts[0]] : null;
}

const _postcodeCache = {};
function lookupPostcode(raw) {
  const key = raw.toUpperCase().replace(/\s+/g, "");
  if (key in _postcodeCache) return Promise.resolve(_postcodeCache[key]);
  return fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(key))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const res = j && j.result;
      const out = res
        ? {
            postcode: res.postcode,
            district: res.admin_district,
            county: res.admin_county,
            ward: res.admin_ward,
            districtKey: matchCouncilName(res.admin_district),
            countyKey: matchCouncilName(res.admin_county),
          }
        : null;
      _postcodeCache[key] = out;
      return out;
    })
    .catch(() => null);
}

// HTML for the postcode result rows shown inside a search menu.
function postcodeItemsHTML(info) {
  if (!info) return `<div class="pc-none">Postcode not found. Check the format (e.g. SW1A 1AA).</div>`;
  const rows = [];
  if (info.districtKey) {
    const cc = DATA.councils[info.districtKey];
    const kind = cc.tier === "upper" ? "County"
      : cc.la_class === "LB" ? "London Borough"
      : cc.la_class === "MD" ? "Metropolitan Borough"
      : cc.la_class === "UA" ? "Unitary"
      : "District";
    rows.push(
      `<div class="pc-item" data-pc-council="${info.districtKey}">` +
        `<span class="omni-kind">${kind}</span>` +
        `<span class="item-name">${info.districtKey}</span>` +
        (info.ward ? `<span class="pc-ward">${info.ward}</span>` : "") +
      `</div>`
    );
  }
  if (info.countyKey && info.countyKey !== info.districtKey) {
    rows.push(
      `<div class="pc-item" data-pc-council="${info.countyKey}">` +
        `<span class="omni-kind">County</span>` +
        `<span class="item-name">${info.countyKey}</span>` +
        `<span class="pc-ward">Schools, roads &amp; social care</span>` +
      `</div>`
    );
  }
  if (!rows.length) {
    return `<div class="pc-none">${info.postcode} is in ${info.district || "an area"} — not in the current ${QOL_N}-council build. <a href="#" data-goto-feedback>Report it</a> and we'll add it.</div>`;
  }
  const twoTier = rows.length > 1;
  return (
    `<div class="pc-head">${info.postcode}${twoTier ? " · two-tier area, pick a council" : ""}</div>` +
    rows.join("")
  );
}

// ---------------------------------------------- modals & provenance ---
function openModal(id) {
  const m = el(id);
  if (!m) return;
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}
function closeModal(id) {
  const m = el(id);
  if (!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function initModals() {
  const rubricBtn = el("rubric-btn");
  if (rubricBtn) rubricBtn.addEventListener("click", () => openModal("rubric-modal"));
  const howBtn = el("how-made-btn");
  if (howBtn) howBtn.addEventListener("click", () => openModal("how-made-modal"));

  document.querySelectorAll("[data-close]").forEach((b) => {
    b.addEventListener("click", () => closeModal(b.dataset.close));
  });
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal.open").forEach((m) => closeModal(m.id));
  });
  // Any "report a discrepancy" link jumps to the feedback tab (delegated, so it
  // also works for links injected later, e.g. in postcode results).
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto-feedback]");
    if (!a) return;
    e.preventDefault();
    document.querySelectorAll(".modal.open").forEach((m) => closeModal(m.id));
    const b = document.querySelector('.tab[data-tab="feedback"]');
    if (b) b.click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// ------------------------------------------------------- council view ---
function initCouncilSelect() {
  const input = el("council-input");
  const toggleBtn = el("combobox-toggle");
  const menu = el("combobox-menu");
  const names = Object.keys(DATA.councils).sort();

  function renderMenu(query = "") {
    const qRaw = query.trim();
    const q = qRaw.toLowerCase();
    const filtered = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    const isPc = POSTCODE_RE.test(qRaw);
    let html = "";
    if (isPc) html += `<div class="pc-result"><div class="pc-loading">Looking up ${qRaw.toUpperCase()}…</div></div>`;
    html += filtered
      .map((n) => {
        const c = DATA.councils[n];
        const party = c.party ? `<span class="menu-party">${c.party}</span>` : "";
        return `<div class="combobox-item" data-name="${n}"><span class="item-name">${n}</span>${party}</div>`;
      })
      .join("");
    if (!filtered.length && !isPc) html += `<div class="combobox-empty">No matching councils found</div>`;
    menu.innerHTML = html;

    menu.querySelectorAll(".combobox-item").forEach((item) => {
      item.addEventListener("click", () => {
        const name = item.dataset.name;
        input.value = name;
        menu.style.display = "none";
        renderCouncil(name);
      });
    });

    if (isPc) {
      const box = menu.querySelector(".pc-result");
      lookupPostcode(qRaw).then((info) => {
        if (!box || !menu.contains(box)) return;
        box.innerHTML = postcodeItemsHTML(info);
        box.querySelectorAll("[data-pc-council]").forEach((item) => {
          item.addEventListener("click", () => {
            const name = item.dataset.pcCouncil;
            input.value = name;
            menu.style.display = "none";
            renderCouncil(name);
          });
        });
      });
    }
  }

  function openMenu() {
    renderMenu(input.value);
    menu.style.display = "block";
  }

  function closeMenu() {
    menu.style.display = "none";
  }

  input.addEventListener("focus", () => openMenu());
  input.addEventListener("input", () => {
    openMenu();
    if (DATA.councils[input.value]) {
      renderCouncil(input.value);
    }
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.style.display === "none") {
        openMenu();
        input.focus();
      } else {
        closeMenu();
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".combobox-wrap")) {
      closeMenu();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = input.value.trim().toLowerCase();
      const match = names.find((n) => n.toLowerCase() === q) || names.find((n) => n.toLowerCase().startsWith(q));
      if (match) {
        input.value = match;
        closeMenu();
        renderCouncil(match);
      }
    } else if (e.key === "Escape") {
      closeMenu();
    }
  });

  const deepLink = new URLSearchParams(location.search).get("council");
  if (deepLink && DATA.councils[deepLink]) {
    input.value = deepLink;
    renderCouncil(deepLink);
  } else {
    // Start blank without pre-selecting a council
    input.value = "";
    const panels = el("council-data-panels");
    if (panels) panels.style.display = "none";
    const prompt = el("council-prompt");
    if (prompt) prompt.style.display = "";
    el("control-line").innerHTML = "";
    el("election-banner").innerHTML = "";
  }
}

let currentCouncilName = null;

function renderCouncil(name) {
  if (!name || !DATA.councils[name]) return;
  currentCouncilName = name;
  const c = DATA.councils[name];

  const panels = el("council-data-panels");
  if (panels) panels.style.display = "";
  const prompt = el("council-prompt");
  if (prompt) prompt.style.display = "none";

  const input = el("council-input");
  if (input && input.value !== name) input.value = name;

  renderControlLine(c);
  renderElectionBanner(c);
  currentRegion = c.region || null;
  currentClass = c.la_class || null;
  renderBenchmarkBar(c);
  renderStandout(c);
  renderPopulation(c);
  renderAgeChart(c);
  renderTopicsChart(c, name);
  const w = DATA.corpus_window;
  const cap = el("topics-caption");
  if (cap && w && c.topic_share) cap.textContent = `Source: Council Gateway API meeting minutes, ${w.label} (${w.docs.toLocaleString("en-GB")} documents classified). Share of all topic keyword hits.`;
  renderMoneyChart(c);
  renderTalkVsSpend(c);
  renderFinances(c);
  renderContracts(c);
  renderQoL(c);
  renderDocumentSearch(c);
  renderTaxonomyTable();
  const dl = el("dossier-link");
  if (dl) {
    if (c.ons_code) { dl.href = `dossiers/${c.ons_code}.md`; dl.style.display = ""; }
    else { dl.style.display = "none"; }
  }
}

// ---------------------------------------------- standout benchmark flags ---
// Instant "what stands out about this council" pills from national ranks.
// Rank convention in data.json: 1 = best on every QoL indicator.
let QOL_N = 288;

// ---------------------------------------------- comparison scope (global) ---
// One switcher changes the benchmark across every panel: England, the council's
// ONS region, or its authority class. Everything downstream reads these helpers.
let benchmarkScope = "england";
let currentRegion = null;      // region of the selected council
let currentClass = null;       // la_class of the selected council

function scopeCouncils(c) {
  const all = Object.values(DATA.councils);
  if (benchmarkScope === "region" && c.region) return all.filter((x) => x.region === c.region);
  if (benchmarkScope === "type" && c.la_class) return all.filter((x) => x.la_class === c.la_class);
  return all;
}

function scopeLabel(c) {
  if (benchmarkScope === "region" && c.region) return c.region;
  if (benchmarkScope === "type" && c.la_class)
    return (c.la_class_label || "councils").replace(/\s*\(.*\)$/, "");
  return "England";
}

function medianOf(vals) {
  const v = vals.filter((x) => x != null).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// rank within a scope: 1 = best (fewer values strictly better, +1)
function rankIn(val, vals, lowerBetter) {
  if (val == null) return null;
  const ok = vals.filter((v) => v != null);
  if (!ok.length) return null;
  const better = ok.filter((v) => (lowerBetter ? v < val : v > val)).length;
  return better + 1;
}

// QoL indicator metadata — the single source of truth for cards, trends and flags.
const QOL_FIELDS = [
  { key: "life_expectancy", rankKey: "life_expectancy_rank", label: "Life Expectancy", unit: "yrs", lowerBetter: false, dp: 1, hist: true,
    note: "Period life expectancy at birth across sexes (ONS 2025)." },
  { key: "attainment8", rankKey: "attainment8_rank", label: "GCSE Attainment 8", unit: "pts", lowerBetter: false, dp: 1, hist: false,
    note: "Average GCSE Attainment 8 score per pupil across 8 subjects (DfE 2023/24)." },
  { key: "rent_affordability", rankKey: "rent_affordability_rank", label: "Rent Affordability", unit: "%", lowerBetter: true, dp: 1, hist: false,
    note: "Median private rent as a % of median gross full-time earnings (ONS PIPR/ASHE)." },
  { key: "air_quality_pm25_pct", rankKey: "air_quality_rank", label: "Air Quality (PM2.5)", unit: "%", lowerBetter: true, dp: 2, hist: true,
    note: "Estimated % of adult all-cause mortality attributable to human-made fine particulate air pollution PM2.5 (Defra/OHID)." },
  { key: "child_poverty_pct", rankKey: "child_poverty_rank", label: "Child Poverty", unit: "%", lowerBetter: true, dp: 1, hist: true,
    note: "Share of children aged under 16 living in families in relative low income (DWP)." },
  { key: "claimant_rate_pct", rankKey: "claimant_rate_rank", label: "Claimant Rate", unit: "%", lowerBetter: true, dp: 1, hist: false,
    note: "Universal Credit / JSA claimants as a % of resident population aged 16-64 (Nomis July 2026)." },
  { key: "crime_per_1000", rankKey: "crime_rank", label: "Crime Rate", unit: "", lowerBetter: true, dp: 1, hist: false,
    note: "Total recorded offences (excluding fraud) per 1,000 residents (ONS CSP 2024)." },
  { key: "house_earnings", rankKey: "house_earnings_rank", label: "House / Earnings", unit: "×", lowerBetter: true, dp: 1, hist: false,
    note: "Mean house price ÷ median gross full-time annual pay (HPI/ASHE). Lower is more affordable." },
];
const QOL_BY_KEY = Object.fromEntries(QOL_FIELDS.map((f) => [f.key, f]));

function fmtQolVal(field, v) {
  if (v == null) return "—";
  const n = Number(v);
  if (field.key === "crime_per_1000") return n.toFixed(field.dp);
  const unit = field.unit || "";
  if (unit === "%" || unit === "×") return n.toFixed(field.dp) + unit;
  return n.toFixed(field.dp) + (unit ? " " + unit : "");
}

// ---------------------------------------------- QoL history (lazy) ---
let QOL_HISTORY = null;
let qolHistoryPromise = null;
function loadQolHistory() {
  if (QOL_HISTORY) return Promise.resolve(QOL_HISTORY);
  if (qolHistoryPromise) return qolHistoryPromise;
  qolHistoryPromise = fetch("qol_history.json?v=20261012e")
    .then((r) => r.json())
    .then((d) => { QOL_HISTORY = d; return d; })
    .catch(() => (QOL_HISTORY = null));
  return qolHistoryPromise;
}

let qolTrendMode = "value"; // "value" | "rank"

// Global comparison switcher: England / region / authority class.
function renderBenchmarkBar(c) {
  const bar = el("benchmark-bar");
  const tog = el("benchmark-toggle");
  if (!bar || !tog) return;
  const opts = [{ id: "england", label: `England (${QOL_N})` }];
  if (c.region) {
    const n = Object.values(DATA.councils).filter((x) => x.region === c.region).length;
    opts.push({ id: "region", label: `${c.region} (${n})` });
  }
  if (c.la_class) {
    const n = Object.values(DATA.councils).filter((x) => x.la_class === c.la_class).length;
    const short = (c.la_class_label || "Type").replace(/\s*\(.*\)$/, "");
    opts.push({ id: "type", label: `${short} (${n})` });
  }
  if (!opts.some((o) => o.id === benchmarkScope)) benchmarkScope = "england";
  tog.innerHTML = opts.map((o) =>
    `<button class="toggle-btn${o.id === benchmarkScope ? " active" : ""}" data-scope="${o.id}">${o.label}</button>`
  ).join("");
  tog.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      benchmarkScope = btn.dataset.scope;
      const cur = DATA.councils[currentCouncilName];
      if (cur) {
        renderBenchmarkBar(cur);
        renderQoL(cur);
        renderFinances(cur);
        renderStandout(cur);
      }
    });
  });
  bar.style.display = "";
}

function initQolModeToggle() {
  const tog = el("qol-mode-toggle");
  if (!tog) return;
  tog.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      qolTrendMode = btn.dataset.qolMode;
      tog.querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
      const cur = DATA.councils[currentCouncilName];
      if (cur && QOL_HISTORY) renderQolTrends(cur, QOL_HISTORY);
    });
  });
}



// Statutory/demand-led services (children's education incl. the ring-fenced
// Dedicated Schools Grant, and adult/children's social care) are determined by
// national formula and statutory duty, so committee debate is structurally low
// there. The talk-vs-spend flag therefore looks only at the council's genuinely
// discretionary services.
const DISCRETIONARY_TOPICS = new Set([
  "Housing & Planning", "Transport & Highways", "Climate & Environment",
  "Local Economy", "Health",
]);

let _discGapP80;
function discretionaryGapP80() {
  if (_discGapP80 !== undefined) return _discGapP80;
  const gaps = [];
  Object.values(DATA.councils).forEach((cc) => {
    const tvs = (cc.talk_vs_spend && cc.talk_vs_spend.topics) || [];
    const disc = tvs.filter((r) => DISCRETIONARY_TOPICS.has(r.topic))
      .map((r) => Math.abs(r.spend_pct - r.discussion_pct));
    if (disc.length) gaps.push(Math.max(...disc));
  });
  if (!gaps.length) return (_discGapP80 = null);
  gaps.sort((a, b) => a - b);
  return (_discGapP80 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.8))]);
}

// Keep the static methodology page's benchmark figures in lockstep with the data,
// so a refresh can never leave a stale hardcoded number on the page.
function updateMethodologyEngland() {
  const e = (DATA && (DATA.qol_benchmark || DATA.qol_england)) || {};
  const set = (id, v, dp) => {
    const n = document.getElementById(id);
    if (n && v != null) n.textContent = Number(v).toFixed(dp);
  };
  set("method-eng-le", e.life_expectancy, 1);
  set("method-eng-att8", e.attainment8, 1);
  set("method-eng-rent", e.rent_affordability, 1);
  set("method-eng-aq", e.air_quality_pm25_pct, 2);
  set("method-eng-cp", e.child_poverty_pct, 1);
  set("method-eng-claim", e.claimant_rate_pct, 1);
  set("method-eng-crime", e.crime_per_1000, 1);
}

function renderStandout(c) {
  const box = el("standout-badges");
  if (!box) return;
  const q = c.qol || {};
  const badges = [];
  const scope = scopeCouncils(c);
  const label = scopeLabel(c);
  const sN = scope.filter((x) => x.qol).length || QOL_N;
  const sRank = (key, lowerBetter) =>
    rankIn(q[key], scope.map((x) => (x.qol ? x.qol[key] : null)), lowerBetter);
  const fmtShort = (key, v) => {
    const f = QOL_BY_KEY[key];
    return f ? fmtQolVal(f, v) : v;
  };

  // Financial distress first — the most consequential signal.
  const d = c.financial_distress;
  if (d && d.severity >= 2) {
    badges.push(d.severity === 3
      ? { cls: "crit", icon: "⚠️", text: `Section 114 notice${d.s114_year ? " (" + d.s114_year + ")" : ""}` }
      : { cls: "crit", icon: "⚡", text: `Exceptional Financial Support${d.efs_amount_gbp_m != null ? " (£" + d.efs_amount_gbp_m + "m)" : ""}` });
  }

  // Crime — both extremes are worth flagging (ranked within the active scope).
  const crimeRank = sRank("crime_per_1000", true);
  if (crimeRank != null) {
    if (crimeRank >= sN * 0.8) badges.push({ cls: "bad", icon: "🚨", text: `High crime: ${q.crime_per_1000}/1k (#${crimeRank} of ${sN})` });
    else if (crimeRank <= sN * 0.2) badges.push({ cls: "good", icon: "🟢", text: `Low crime: ${q.crime_per_1000}/1k (#${crimeRank} of ${sN})` });
  }

  // Housing affordability pressure.
  const rentRank = sRank("rent_affordability", true);
  if (rentRank != null) {
    if (rentRank >= sN * 0.8) badges.push({ cls: "bad", icon: "🚨", text: `Severe rent strain: ${q.rent_affordability}% of pay (#${rentRank} of ${sN})` });
    else if (rentRank <= sN * 0.2) badges.push({ cls: "good", icon: "🟢", text: `Affordable rents: ${q.rent_affordability}% of pay (#${rentRank} of ${sN})` });
  }

  // Child poverty.
  const cpRank = sRank("child_poverty_pct", true);
  if (cpRank != null && cpRank >= sN * 0.8)
    badges.push({ cls: "bad", icon: "🚩", text: `High child poverty: ${q.child_poverty_pct}% (#${cpRank} of ${sN})` });

  // House price vs local earnings (rank 1 = most affordable).
  const heRank = sRank("house_earnings", true);
  if (q.house_earnings != null && heRank != null) {
    const priceTxt = q.house_price != null ? `£${Math.round(q.house_price).toLocaleString("en-GB")} · ` : "";
    if (heRank >= sN * 0.8) badges.push({ cls: "bad", icon: "🏠", text: `Expensive to buy: ${priceTxt}${q.house_earnings}× pay (#${heRank} of ${sN})` });
    else if (heRank <= sN * 0.2) badges.push({ cls: "good", icon: "🏠", text: `Affordable to buy: ${priceTxt}${q.house_earnings}× pay (#${heRank} of ${sN})` });
  }

  // Borrowing per resident vs the active scope's deciles.
  const b = c.borrowing;
  if (b && b.per_resident != null) {
    const bvals = scope.map((x) => (x.borrowing ? x.borrowing.per_resident : null)).filter((v) => v != null).sort((a, z) => a - z);
    if (bvals.length) {
      const p10 = bvals[Math.floor(bvals.length * 0.1)];
      const p90 = bvals[Math.floor(bvals.length * 0.9)];
      if (b.per_resident >= p90) badges.push({ cls: "bad", icon: "🔴", text: `Heavy debt: £${Math.round(b.per_resident).toLocaleString("en-GB")}/resident` });
      else if (b.per_resident <= p10) badges.push({ cls: "good", icon: "🟢", text: `Low debt: £${Math.round(b.per_resident).toLocaleString("en-GB")}/resident` });
    }
  }

  // Talk-vs-spend disconnect (the "receipts" check) — discretionary services only,
  // and only when the gap is unusually large nationally (top 20%).
  const tvs = (c.talk_vs_spend && c.talk_vs_spend.topics) || [];
  const disc = tvs.filter((r) => DISCRETIONARY_TOPICS.has(r.topic));
  const gap = disc.slice().sort((a, b2) => Math.abs(b2.spend_pct - b2.discussion_pct) - Math.abs(a.spend_pct - a.discussion_pct))[0];
  const p80 = discretionaryGapP80();
  if (gap && p80 != null && Math.abs(gap.spend_pct - gap.discussion_pct) >= p80)
    badges.push({ cls: "warn", icon: "⚡", text: `${gap.topic}: ${gap.spend_pct.toFixed(0)}% of spend, ${gap.discussion_pct.toFixed(0)}% of debate` });

  // Quality-of-life trends: materially improved/worsened since the earliest year.
  (c.qol_trends || []).forEach((t) => {
    const f = QOL_BY_KEY[t.metric];
    if (!f) return;
    const worse = t.direction === "worse";
    const u = (f.unit === "%" || f.unit === "×") ? f.unit : (f.unit ? " " + f.unit : "");
    const ch = (t.change > 0 ? "+" : "") + t.change.toFixed(1);
    badges.push({
      cls: worse ? "bad" : "good",
      icon: worse ? "📉" : "📈",
      text: `QoL ${worse ? "worsening" : "improving"}: ${f.label} (${ch}${u})`,
    });
  });

  // Recent change of political control — a governance signal worth surfacing.
  const ctrl = c.control;
  if (ctrl && ctrl.changed && ctrl.since_year >= 2025)
    badges.push({ cls: "warn", icon: "🗳", text: `Control changed ${ctrl.since}: now ${ctrl.current}` });

  const shown = badges.slice(0, 6);
  box.innerHTML = shown.length
    ? shown.map((b2) => `<span class="standout-badge ${b2.cls}" data-rubric="1" title="Click to see how this flag is calculated"><span class="standout-icon">${b2.icon}</span>${b2.text}</span>`).join("")
    : `<span class="standout-badge neutral">No standout extremes for this council in ${label}.</span>`;
  box.querySelectorAll(".standout-badge[data-rubric]").forEach((pill) => {
    pill.addEventListener("click", () => openModal("rubric-modal"));
  });
}

// ------------------------------------------------ AI-native citizen brief ---
// One-click, token-efficient Markdown dossier a resident can paste into their
// own ChatGPT / Claude to interrogate their council's numbers.
function buildCitizenBriefing(c) {
  const q = c.qol || {};
  const eng = DATA.qol_benchmark || DATA.qol_england || {};
  const d = c.financial_distress || {};
  const b = c.borrowing || {};
  const be = DATA.borrowing_england || {};
  const tvs = (c.talk_vs_spend && c.talk_vs_spend.topics) || [];
  const disc = tvs.filter((r) => DISCRETIONARY_TOPICS.has(r.topic));
  const gap = (disc.length ? disc : tvs).slice().sort((a, b2) => Math.abs(b2.spend_pct - b2.discussion_pct) - Math.abs(a.spend_pct - a.discussion_pct))[0];
  const name = c.name || currentCouncilName || "this council";
  const L = [];
  L.push(`# Citizen briefing: ${name} (${c.ons_code || "n/a"})`);
  L.push(`- Tier: ${c.la_class_label || c.tier || "n/a"}${c.parent_county ? " (part of " + c.parent_county + ")" : ""}`);
  if (c.region) L.push(`- ONS region: ${c.region}`);
  L.push(`- Political control: ${c.party_full || c.party || "n/a"}`);
  if (c.control && c.control.changed)
    L.push(`- Control history: ${c.control.current} since ${c.control.since}` + (c.control.previous ? " (previously " + c.control.previous + ")" : ""));
  if (c.election)
    L.push(`- Upcoming election: ${c.election.title} — polls ${c.election.poll_date}`);
  L.push(`- Population: ${c.population != null ? c.population.toLocaleString("en-GB") : "n/a"}`);
  L.push("");

  const scope = scopeCouncils(c);
  const label = scopeLabel(c);
  L.push(`## Outcomes vs ${label} (#1 = best in the group)`);
  QOL_FIELDS.forEach((f) => {
    const val = q[f.key];
    if (val == null) return;
    const vals = scope.map((x) => (x.qol ? x.qol[f.key] : null));
    const n = vals.filter((v) => v != null).length;
    const med = medianOf(vals);
    const rank = rankIn(val, vals, f.lowerBetter);
    const parts = [`${val}`];
    if (rank != null) parts.push(`rank #${rank} of ${n}`);
    if (med != null) parts.push(`${label} median ${med}`);
    L.push(`- ${f.label}: ${parts.join("; ")}`);
  });
  L.push("- Note: crime per 1,000 residents is inflated in city/town centres by commuters, shoppers and nightlife who are counted in offences but not in residents.");
  L.push("");

  const trends = c.qol_trends || [];
  if (trends.length) {
    L.push("## Quality-of-life trends (OHID Fingertips annual series)");
    trends.forEach((t) => {
      const f = QOL_BY_KEY[t.metric];
      if (!f) return;
      L.push(`- ${f.label}: ${t.direction} — ${t.change > 0 ? "+" : ""}${t.change} since the earliest year (change in the best/worst ~10% of councils)`);
    });
    L.push("");
  }

  L.push("## Financial health (benchmarked)");
  L.push(`- Distress: ${d.severity >= 2 ? d.distress_status : "No active Section 114 notice or EFS intervention"}`);
  if (d.is_efs && d.efs_amount_gbp_m != null) L.push(`- Exceptional Financial Support: £${d.efs_amount_gbp_m}m`);
  if (b.per_resident != null) {
    const bvals = scope.map((x) => (x.borrowing ? x.borrowing.per_resident : null));
    const bn = bvals.filter((v) => v != null).length;
    const brank = rankIn(b.per_resident, bvals, true);
    const bmed = medianOf(bvals);
    const parts = [`£${Math.round(b.per_resident).toLocaleString("en-GB")} per resident`];
    if (brank != null) parts.push(`rank #${brank} of ${bn} highest in ${label}`);
    if (bmed != null) parts.push(`${label} median £${Math.round(bmed).toLocaleString("en-GB")}`);
    L.push(`- Borrowing: ${parts.join("; ")}${b.total_gbp_m != null ? ` (total £${Math.round(b.total_gbp_m).toLocaleString("en-GB")}m)` : ""}`);
    L.push("  (MHCLG Q1 2026/27. Total outstanding loans incl. PWLB/commercial; mixes General Fund and Housing Revenue Account debt, so partly rent-serviced.)");
  }
  if (!(d.is_efs) && b.per_resident == null) L.push("- No reserves, debt-servicing cost or schools-deficit figures are included here, so 'financial risk' cannot be measured directly from these numbers.");
  L.push("");

  if (gap) {
    L.push("## Committee scrutiny vs budget");
    L.push(`- Biggest talk-vs-spend gap: ${gap.topic} takes ${gap.spend_pct.toFixed(0)}% of gross spend but ${gap.discussion_pct.toFixed(0)}% of committee debate.`);
    L.push("  (English councils spend most of their budgets on statutory adult/children's social care and the ring-fenced schools grant, which committees do not set. The gap is drawn from discretionary services; treat it as indicative.)");
    L.push("");
  }

  const contracts = c.contracts || [];
  if (contracts.length) {
    L.push("## Largest published contract awards (Contracts Finder, 2025–2026)");
    contracts.slice(0, 5).forEach((r) => {
      L.push(`- ${r.supplier}: ${fmtAward(r.value_gbp)}${r.latest ? ` (awarded ${r.latest})` : ""}${r.title ? ` — ${r.title}` : ""}${r.url ? ` — ${r.url}` : ""}`);
    });
    L.push("");
  }

  const official = c.official_links || [];
  if (official.length) {
    L.push("## Primary sources");
    official.forEach((l) => L.push(`- ${l.title}: ${l.url}`));
    L.push("");
  }

  L.push("## Ask");
  L.push(`You are advising a local resident on this council. Using ONLY the verified figures and peer benchmarks above (outcome comparisons are against the median of ${label}, the active comparison group):`);
  L.push("1. Give three sharp, specific questions I can put to my councillor at their next surgery, grounded in the gap between this council and the group median or in its debt rank.");
  L.push("2. Identify the single biggest fiscal or governance risk visible in these figures, contrasting debt, budget concentration and outcomes against the benchmarks.");
  L.push(`3. Summarise how this area compares with ${label}, and flag where the commuter-inflation or schools-grant caveats apply.`);
  L.push("If a question needs data not provided here (such as usable reserves or Ofsted/inspection grades), say explicitly what is missing rather than guessing.");
  return L.join("\n");
}

function initCopyBriefing() {
  const btn = el("copy-briefing-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!currentCouncilName || !DATA || !DATA.councils[currentCouncilName]) return;
    const text = buildCitizenBriefing(DATA.councils[currentCouncilName]);
    const done = () => {
      const old = btn.textContent;
      btn.textContent = "✓ Copied for your AI";
      setTimeout(() => { btn.textContent = old; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { /* noop */ }
  document.body.removeChild(ta);
}

function renderControlLine(c) {
  const line = el("control-line");
  const tierInfo = c.parent_county ? ` · District Council (part of ${c.parent_county})` : (c.la_class_label ? ` · ${c.la_class_label}` : "");
  if (!c.control) { line.innerHTML = `Controlled by <strong>${c.party_full}</strong>${tierInfo}`; return; }
  const { current, since, previous, changed } = c.control;
  line.innerHTML = changed
    ? `<strong>${current}</strong> · since ${since} · previously ${previous}${tierInfo}`
    : `<strong>${current}</strong> · since ${since}${tierInfo}`;
}

function renderElectionBanner(c) {
  const box = el("election-banner");
  if (!c.election) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="election-banner">🗳 Upcoming election: <strong>${c.election.title}</strong> — polls open ${c.election.poll_date}</div>`;
}

// ---------------------------------------------------- executive briefing ---
function fmtGbpM(n) {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return "£" + (n / 1000).toFixed(2) + "bn";
  return "£" + Math.round(n).toLocaleString("en-GB") + "m";
}

// Contract-award money: precise and readable at any size — £14.57m, £567k, £42k.
function fmtAward(gbp) {
  if (gbp == null) return "—";
  const v = Math.abs(gbp);
  if (v >= 1_000_000) return "£" + (gbp / 1_000_000).toFixed(2) + "m";
  if (v >= 1_000) return "£" + Math.round(gbp / 1_000) + "k";
  return "£" + Math.round(gbp);
}

function fmtGbpFull(gbp) {
  if (gbp == null) return "";
  return "£" + Math.round(gbp).toLocaleString("en-GB");
}

// ------------------------------------------- financial health & debt ---
// One panel: statutory standing (Section 114 / EFS) + the debt the council carries.
function distressBannerHtml(d) {
  if (!d) return "";
  if (d.severity === 3) {
    return `<div class="distress-banner critical">
        <div class="distress-status-header"><span class="distress-icon">⚠️</span>
          <strong>CRITICAL FINANCIAL DISTRESS: Section 114 Notice Issued (${d.s114_year || "Active"})</strong></div>
        <p class="distress-desc">${d.s114_details || ""}</p>
        ${d.is_efs ? `<p class="distress-extra"><strong>Government Intervention:</strong> ${d.efs_details || ""}</p>` : ""}
      </div>`;
  }
  if (d.severity === 2) {
    return `<div class="distress-banner high">
        <div class="distress-status-header"><span class="distress-icon">⚡</span>
          <strong>HIGH FINANCIAL RISK: Exceptional Financial Support (£${d.efs_amount_gbp_m}m)</strong></div>
        <p class="distress-desc">${d.efs_details || ""}</p>
      </div>`;
  }
  if (d.severity === 1) {
    return `<div class="distress-banner warning">
        <div class="distress-status-header"><span class="distress-icon">ℹ️</span>
          <strong>ELEVATED AUDIT RISK: Statutory External Warning / Account Delays</strong></div>
        <p class="distress-desc">Under statutory external auditor recommendation or commissioner monitoring.</p>
      </div>`;
  }
  return `<div class="distress-banner stable">
      <div class="distress-status-header"><span class="distress-icon">✓</span>
        <strong>STABLE FINANCIAL STANDING</strong></div>
      <p class="distress-desc">No active Section 114 spending freeze notices or emergency MHCLG Exceptional Financial Support directions recorded.</p>
    </div>`;
}

function renderFinances(c) {
  const b = c.borrowing;
  const d = c.financial_distress;
  showPanel("panel-finances", !!(b || d));
  if (!b && !d) return;

  el("finances-status-box").innerHTML = distressBannerHtml(d);

  const scope = scopeCouncils(c);
  const scopeVals = scope.map((x) => (x.borrowing ? x.borrowing.per_resident : null));
  const scopeN = scopeVals.filter((v) => v != null).length;
  const scopeMed = medianOf(scopeVals);
  const scopeRank = b && b.per_resident != null ? rankIn(b.per_resident, scopeVals, true) : null;
  const label = scopeLabel(c);

  const eng = DATA.borrowing_england || {};
  const engAvg = eng.mean_per_resident;

  const cards = [
    {
      label: "Total outstanding debt",
      value: b && b.total_gbp_m != null ? fmtGbpM(b.total_gbp_m) : "—",
      corner: engAvg != null ? `England avg £${Math.round(engAvg).toLocaleString("en-GB")}/resident` : "",
      sub: "all loan & securities categories (MHCLG)",
    },
    {
      label: "Debt per resident",
      value: b && b.per_resident != null ? "£" + Math.round(b.per_resident).toLocaleString("en-GB") : "—",
      corner: scopeRank != null ? `Rank #${scopeRank} of ${scopeN} in ${label}` : "",
      sub: scopeMed != null ? `${label} median £${Math.round(scopeMed).toLocaleString("en-GB")}/resident` : "",
    },
  ];
  el("finances-body").innerHTML = cards.map((card) => `
    <div class="stat-card">
      <div class="stat-header">
        <span class="stat-label">${card.label}</span>
        ${card.corner ? `<span class="stat-corner">${card.corner}</span>` : ""}
      </div>
      <div class="stat-value">${card.value}</div>
      <div class="stat-sub">${card.sub}</div>
    </div>`).join("");

  // Synthesis: join the two signals into one read.
  const synth = el("finances-synth");
  if (synth && b && b.per_resident != null) {
    const heavy = scopeRank != null && scopeRank <= Math.max(1, scopeN * 0.25);
    const light = scopeRank != null && scopeRank >= scopeN * 0.75;
    const stable = !d || d.severity === 0;
    let txt;
    if (stable && heavy)
      txt = `Stable statutory standing, but among the most indebted in ${label} — debt servicing absorbs a large share of discretionary income.`;
    else if (stable && light)
      txt = `Stable statutory standing and low borrowing by ${label} standards.`;
    else if (!stable)
      txt = `Elevated financial risk on the statutory registers; debt position is a secondary consideration.`;
    else
      txt = `Stable statutory standing with a mid-range debt position for ${label}.`;
    synth.textContent = txt;
  } else if (synth) {
    synth.textContent = "";
  }
}

// ---------------------------------------------------- top contracts ---
function contractsFinderUrl(q) {
  return "https://www.contractsfinder.service.gov.uk/Search/Results?&searchTerm=" +
    encodeURIComponent(q) + "&sort=relevance";
}

function renderContracts(c) {
  const rows = c.contracts;
  showPanel("panel-contracts", !!(rows && rows.length));
  if (!rows || !rows.length) return;
  const total = rows.reduce((s, r) => s + (r.value_gbp || 0), 0);
  const body = rows.map((r) => {
    const href = r.url || contractsFinderUrl(r.supplier);
    const titleAttr = r.title ? ` title="${r.title.replace(/"/g, "&quot;")}"` : "";
    return `
    <tr>
      <td><a href="${href}" target="_blank" rel="noopener"${titleAttr}>${r.supplier}</a>${r.title ? `<div class="contract-title">${r.title}</div>` : ""}</td>
      <td class="num-cell"><span title="${fmtGbpFull(r.value_gbp)}">${fmtAward(r.value_gbp)}</span></td>
      <td class="num-cell">${r.latest ? r.latest.replace(/-/g, "/") : "—"}</td>
    </tr>`;
  }).join("");
  const councilQuery = currentCouncilName || "";
  el("contracts-body").innerHTML = `
    <table class="league contracts-table">
      <thead><tr><th>Supplier</th><th class="num-th">Awarded value</th><th class="num-th">Awarded</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="contracts-total">Combined value of the awards shown: <strong>${fmtAward(total)}</strong> <span class="contracts-window">(awards dated 2025–2026)</span></p>
    <p class="contracts-note">Each row is a single contract award; the supplier links to that award notice on Contracts Finder (the UK government's public register). Values are as published and can include multi-year frameworks. Only awards where <strong>the council itself</strong> is the named buyer are shown — procurement by arms-length bodies (housing ALMOs such as Barnet Homes, council-owned trading companies, joint waste partnerships) publishes under those entities' own names and is not counted here. <a href="${contractsFinderUrl(councilQuery + " Council")}" target="_blank" rel="noopener">See all ${councilQuery} awards →</a></p>`;
}

function renderPopulation(c) {
  const hasPop = c.population != null;
  showPanel("panel-population", hasPop || !!c.ethnicity);
  if (hasPop) {
    el("population-headline").textContent = fmtPopulation(c.population);
  } else {
    el("population-headline").textContent = "—";
  }

  const hasEth = !!c.ethnicity;
  const chartEl = el("race-chart");
  if (!hasEth) {
    chartEl.innerHTML = "";
    el("race-key").innerHTML = "";
    return;
  }
  const cats = Object.keys(c.ethnicity);
  const councilVals = cats.map((k) => c.ethnicity[k]);
  const hasEngland = !!c.ethnicity_england;
  const traces = [];
  const allVals = councilVals.slice();
  if (hasEngland) {
    const engVals = cats.map((k) => c.ethnicity_england[k]);
    allVals.push(...engVals);
    traces.push(withClip({
      x: engVals.slice().reverse(), y: cats.slice().reverse(), type: "bar", orientation: "h",
      marker: { color: GREY }, text: engVals.slice().reverse().map((v) => v.toFixed(0) + "%"),
      textposition: "outside", hoverinfo: "skip",
    }));
  }
  traces.push(withClip({
    x: councilVals.slice().reverse(), y: cats.slice().reverse(), type: "bar", orientation: "h",
    marker: { color: ACCENT }, text: councilVals.slice().reverse().map((v) => v.toFixed(0) + "%"),
    textposition: "outside", hoverinfo: "skip",
  }));

  el("race-key").innerHTML = hasEngland ? swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England") : swatch(ACCENT, "This council");
  el("ethnicity-caption").textContent = c.ethnicity_source || "Ethnicity, Census 2021 (ONS)";

  const mob = isMobile();
  Plotly.newPlot(
    "race-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 48 : 60, r: mob ? 35 : 40, t: 10, b: 25 },
      height: chartHeight(cats.length, mob ? 28 : 32),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false, range: headroomRange(allVals) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function chartHeight(n, perRow = 34, base = 50) {
  return base + n * perRow;
}

function renderAgeChart(c) {
  const mode = DATA.age_bands_mode;
  if (mode === "pyramid") {
    renderAgePyramid(c);
  } else if (mode === "paired") {
    renderAgePaired(c);
  } else {
    showPanel("panel-age", false);
  }
}

function renderAgePaired(c) {
  const hasData = c.age_bands && DATA.age_bands_england;
  showPanel("panel-age", !!hasData);
  if (!hasData) return;
  el("age-heading").textContent = "Age profile vs England";
  const bands = DATA.age_bands_order.filter((b) => b in c.age_bands && b in DATA.age_bands_england);
  const councilVals = bands.map((b) => c.age_bands[b]);
  const englandVals = bands.map((b) => DATA.age_bands_england[b]);

  el("age-key").innerHTML = swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England");

  const mob = isMobile();
  Plotly.newPlot(
    "age-chart",
    [
      withClip({ x: englandVals, y: bands, type: "bar", orientation: "h", marker: { color: GREY }, text: englandVals.map((v) => v.toFixed(0) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: councilVals, y: bands, type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.map((v) => v.toFixed(0) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 42 : 50, r: mob ? 30 : 40, t: 10, b: 25 },
      height: chartHeight(bands.length, mob ? 34 : 44),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false, range: headroomRange([...councilVals, ...englandVals]) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function renderAgePyramid(c) {
  const hasData = c.age_bands && DATA.age_pyramid_england;
  showPanel("panel-age", !!hasData);
  if (!hasData) return;
  el("age-heading").textContent = "Population pyramid vs England";
  const bands = DATA.age_bands_order.filter((b) => b in c.age_bands);
  const cMale = bands.map((b) => -(c.age_bands[b].male || 0));
  const cFemale = bands.map((b) => c.age_bands[b].female || 0);
  const eng = DATA.age_pyramid_england;
  const eMale = bands.map((b) => -((eng[b] && eng[b].male) || 0));
  const eFemale = bands.map((b) => (eng[b] && eng[b].female) || 0);

  el("age-key").innerHTML = swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England");

  // Grouped (not overlaid) bars: within each age band, a council bar sits next
  // to an England bar on both the male (negative, left) and female (positive,
  // right) side — easier to read than the old transparent-outline overlay.
  const traces = [
    withClip({ x: cMale, y: bands, type: "bar", orientation: "h", marker: { color: ACCENT }, text: cMale.map((v) => Math.abs(v).toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    withClip({ x: eMale, y: bands, type: "bar", orientation: "h", marker: { color: GREY }, text: eMale.map((v) => Math.abs(v).toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    withClip({ x: cFemale, y: bands, type: "bar", orientation: "h", marker: { color: ACCENT }, text: cFemale.map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    withClip({ x: eFemale, y: bands, type: "bar", orientation: "h", marker: { color: GREY }, text: eFemale.map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
  ];
  const maxAbs = Math.max(...cMale.map(Math.abs), ...cFemale, ...eMale.map(Math.abs), ...eFemale, 1) * 1.3;

  const mob = isMobile();
  Plotly.newPlot(
    "age-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 38 : 50, r: mob ? 24 : 30, t: 25, b: 25 },
      height: chartHeight(bands.length, mob ? 32 : 52),
      font: { ...BASE_FONT, size: mob ? 10 : 12 },
      xaxis: { title: "", zeroline: true, range: [-maxAbs, maxAbs], tickvals: [-maxAbs * 0.7, 0, maxAbs * 0.7], ticktext: ["◀ Male", "", "Female ▶"] },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function renderTopicsChart(c, name) {
  const hasData = c.topic_share && Object.keys(c.topic_share).length;
  showPanel("panel-topics", !!hasData);
  if (!hasData) return;
  const topics = Object.keys(c.topic_share).sort((a, b) => c.topic_share[b] - c.topic_share[a]);
  const councilVals = topics.map((t) => c.topic_share[t]);
  const avgVals = topics.map((t) => DATA.corpus_avg_topic_share[t] ?? 0);

  el("topics-key").innerHTML = swatch(ACCENT, name) + " &nbsp; " + swatch(GREY, "England average");

  const mob = isMobile();
  Plotly.newPlot(
    "topics-chart",
    [
      withClip({ x: avgVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: GREY }, text: avgVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: councilVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 115 : 168, r: mob ? 35 : 45, t: 10, b: 25 },
      height: chartHeight(topics.length, mob ? 34 : 40),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false, range: headroomRange([...councilVals, ...avgVals]) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

let moneyView = "absolute";

function renderMoneyChart(c) {
  const hasAbsolute = c.money && c.money.length;
  const hasShare = c.money_share && c.money_share.length;
  showPanel("panel-money", !!(hasAbsolute || hasShare));
  if (!hasAbsolute && !hasShare) return;

  const toggle = el("money-toggle");
  if (!hasShare) moneyView = "absolute";
  toggle.style.display = hasShare ? "" : "none";
  toggle.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === moneyView);
    btn.onclick = () => {
      moneyView = btn.dataset.view;
      renderMoneyChart(c);
    };
  });

  if (moneyView === "share" && hasShare) {
    drawMoneyShare(c);
  } else {
    drawMoneyAbsolute(c);
  }
}

function drawMoneyAbsolute(c) {
  const tierCallout = (c.la_class === "SD" && c.parent_county)
    ? `<div class="tier-callout">ℹ️ <strong>District Council Remit:</strong> As a lower-tier district council, ${c.name || "this council"} delivers Housing, Environment, Planning, and Leisure. Major statutory services (<strong>Education, Social Care, Public Health</strong>) are £0 here because they are funded & managed by <strong>${c.parent_county} County Council</strong>.</div>`
    : "";

  el("money-lede").innerHTML = `What your council puts into each service — £ per resident (staff + running costs).${tierCallout}`;
  const services = c.money.map((m) => m.service);
  const labels = services.map(shortService);
  const values = c.money.map((m) => m.gbp_per_resident);
  const averages = services.map((s) => (DATA.money_average_per_resident || DATA.money_median_per_resident || {})[s]);
  const hasAverage = averages.some((v) => v != null);

  el("money-key").innerHTML = hasAverage
    ? swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England average (pop. weighted)")
    : swatch(ACCENT, "This council");

  const traces = [
    withClip({ x: values.slice().reverse(), y: labels.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: values.slice().reverse().map((v) => fmtGbp(v)), textposition: "outside", hoverinfo: "skip" }),
  ];
  if (hasAverage) {
    traces.push(withClip({
      x: averages.slice().reverse(), y: labels.slice().reverse(), type: "bar", orientation: "h",
      marker: { color: GREY }, text: averages.slice().reverse().map((v) => (v != null ? fmtGbp(v) : "")),
      textposition: "outside", hoverinfo: "skip",
    }));
  }

  const mob = isMobile();
  Plotly.newPlot(
    "money-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 95 : 130, r: mob ? 48 : 65, t: 10, b: 25 },
      height: chartHeight(services.length, mob ? 40 : 52),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", tickprefix: "£", zeroline: true, zerolinecolor: "#999", zerolinewidth: 1, range: headroomRange([...values, ...averages.filter((v) => v != null)]) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function drawMoneyShare(c) {
  const tierCallout = (c.la_class === "SD" && c.parent_county)
    ? `<div class="tier-callout">ℹ️ <strong>District Council Remit:</strong> As a lower-tier district council, ${c.name || "this council"} delivers Housing, Environment, Planning, and Leisure. Major statutory services (<strong>Education, Social Care, Public Health</strong>) are funded & managed by <strong>${c.parent_county} County Council</strong>.</div>`
    : "";

  el("money-lede").innerHTML = `Share of matched-topic spend, this council vs the England population-weighted average.${tierCallout}`;
  const rows = c.money_share;
  const topics = rows.map((r) => r.topic);
  const councilVals = rows.map((r) => r.council_pct);
  const englandVals = rows.map((r) => r.england_pct);

  el("money-key").innerHTML = swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England average (pop. weighted)");

  const traces = [
    withClip({ x: councilVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    withClip({ x: englandVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: GREY }, text: englandVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
  ];

  const mob = isMobile();
  Plotly.newPlot(
    "money-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 115 : 170, r: mob ? 35 : 45, t: 10, b: 25 },
      height: chartHeight(topics.length, mob ? 40 : 52),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false, range: headroomRange([...councilVals, ...englandVals]) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function renderTalkVsSpend(c) {
  const hasData = c.talk_vs_spend && c.talk_vs_spend.topics && c.talk_vs_spend.topics.length;
  showPanel("panel-tvs", !!hasData);
  if (!hasData) return;
  const rows = c.talk_vs_spend.topics;
  const topics = rows.map((r) => r.topic);
  const discussion = rows.map((r) => r.discussion_pct);
  const spend = rows.map((r) => r.spend_pct);

  el("tvs-key").innerHTML = swatch(ACCENT, "Discussion share") + " &nbsp; " + swatch(SPEND_COLOR, "Spend share");

  const cw = (DATA && DATA.corpus_window && DATA.corpus_window.label) || "the last two years";
  let caption = `Topics without a budget line excluded; minutes ${cw} vs spend year 2024-25. ` +
    "English councils spend most of their budgets on statutory social care and the ring-fenced schools grant, " +
    "which committees do not set — so debate concentrates on discretionary services (planning, highways, environment, regeneration).";
  if (c.talk_vs_spend.note) caption += " " + c.talk_vs_spend.note.charAt(0).toUpperCase() + c.talk_vs_spend.note.slice(1) + ".";
  el("tvs-caption").textContent = caption;

  const mob = isMobile();
  Plotly.newPlot(
    "tvs-chart",
    [
      withClip({ x: spend.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: SPEND_COLOR }, text: spend.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: discussion.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: discussion.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: mob ? 115 : 168, r: mob ? 35 : 45, t: 10, b: 25 },
      height: chartHeight(topics.length, mob ? 34 : 40),
      font: { ...BASE_FONT, size: mob ? 10.5 : 12 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false, range: headroomRange([...spend, ...discussion]) },
      yaxis: { title: "" },
      template: "simple_white",
    },
    PLOTLY_CONFIG
  );
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Deprivation colour law: decile 1 (most deprived) = magenta/bad, decile 10
// (least deprived) = green/good — the inverse of rankColor's rank-based scale.
function decileColor(decile) {
  if (decile == null) return "#f0f0f0";
  const t = (10 - decile) / 9; // 0 = least deprived (green/good), 1 = most deprived (magenta/bad)
  const GOOD = "#4d9221", MID = "#f7f7f7", BAD = "#c51b7d";
  return t < 0.5 ? lerpHex(GOOD, MID, t * 2) : lerpHex(MID, BAD, (t - 0.5) * 2);
}

// ---------------------------------------------------- quality of life ---
function renderQoL(c) {
  const q = c.qol;
  showPanel("panel-qol", !!q);
  if (!q) return;

  const scope = scopeCouncils(c);
  const label = scopeLabel(c);

  const lede = el("qol-lede");
  if (lede) lede.textContent = `How has this area's quality of life changed over time, and where does it sit today against ${label}?`;

  // ---- cards (latest snapshot), benchmarked to the active scope ----
  const cardsHtml = QOL_FIELDS.map((f) => {
    const val = q[f.key];
    const scopeVals = scope.map((x) => (x.qol ? x.qol[f.key] : null));
    const n = scopeVals.filter((v) => v != null).length;
    const med = medianOf(scopeVals);
    const rank = rankIn(val, scopeVals, f.lowerBetter);

    let diffBadge = "";
    if (val != null && med != null) {
      const diff = val - med;
      const isBetter = f.lowerBetter ? diff < 0 : diff > 0;
      const tol = f.key === "air_quality_pm25_pct" ? 0.1 : 0.2;
      const sign = diff > 0 ? "+" : "";
      const cls = Math.abs(diff) < tol ? "neutral" : isBetter ? "better" : "worse";
      diffBadge = `<span class="qol-tag ${cls}">${sign}${diff.toFixed(1)} vs ${label}</span>`;
    }
    const rankTxt = rank != null ? `<span class="qol-rank-tag">Rank #${rank} of ${n} in ${label}</span>` : "";
    const medTxt = med != null ? `${fmtQolVal(f, med)}` : "—";
    return `
      <div class="qol-card">
        <div class="qol-header">
          <span class="qol-label">${f.label}</span>
          ${diffBadge}
        </div>
        <div class="qol-value">${fmtQolVal(f, val)}</div>
        <div class="qol-benchmark">${rankTxt} · ${label} median: <strong>${medTxt}</strong></div>
        <div class="qol-sub">${f.note}</div>
      </div>`;
  }).join("");
  el("qol-grid").innerHTML = cardsHtml;

  // ---- trends by default ----
  loadQolHistory().then((hist) => renderQolTrends(c, hist));
}

// Compact OWID-style line chart: council (blue) vs scope benchmark (grey dashed).
function _svgSegs(vals, xf, yf) {
  const segs = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (v == null) { if (cur.length) { segs.push(cur); cur = []; } return; }
    cur.push(`${xf(i).toFixed(1)},${yf(v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  return segs;
}

function qolTrendCard(f, series, benchVals, periods, mode, label) {
  const W = 300, H = 132, padL = 6, padR = 58, padT = 12, padB = 18;
  const iw = W - padL - padR, ih = H - padT - padB;
  const useRank = mode === "rank";

  const council = useRank ? series.r : series.v;
  const bench = useRank ? null : benchVals;
  const nPts = periods.length;
  const xf = (i) => padL + (nPts <= 1 ? iw / 2 : (i / (nPts - 1)) * iw);

  const pool = (council || []).concat(bench || []).filter((v) => v != null);
  if (!pool.length) return "";
  let lo = Math.min(...pool), hi = Math.max(...pool);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  // rank mode: rank 1 at top (invert)
  const yf = useRank
    ? (v) => padT + ((v - 1) / Math.max(1, QOL_N - 1)) * ih
    : (v) => padT + (1 - (v - lo) / (hi - lo)) * ih;

  const grid = [0, 0.5, 1].map((t) => {
    const y = padT + t * ih;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + iw).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eee" stroke-width="1"/>`;
  }).join("");

  const benchPath = bench
    ? _svgSegs(bench, xf, yf).map((s) => `<polyline points="${s.join(" ")}" fill="none" stroke="#9a9a9a" stroke-width="1.5" stroke-dasharray="3 3"/>`).join("")
    : `<line x1="${padL}" y1="${yf((QOL_N + 1) / 2).toFixed(1)}" x2="${(padL + iw).toFixed(1)}" y2="${yf((QOL_N + 1) / 2).toFixed(1)}" stroke="#9a9a9a" stroke-width="1.5" stroke-dasharray="3 3"/>`;

  const councilPath = _svgSegs(council, xf, yf).map((s) => `<polyline points="${s.join(" ")}" fill="none" stroke="#4C6A9C" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`).join("");

  // end label: latest non-null
  let lastI = -1;
  (council || []).forEach((v, i) => { if (v != null) lastI = i; });
  let endLabel = "";
  if (lastI >= 0) {
    const lv = council[lastI];
    const txt = useRank ? `#${lv}` : fmtQolVal(f, lv);
    endLabel = `<text x="${(xf(lastI) + 5).toFixed(1)}" y="${(yf(lv) + 3.5).toFixed(1)}" font-size="11" font-weight="700" fill="#4C6A9C">${txt}</text>`;
  }

  const x0 = periods[0], x1 = periods[nPts - 1];
  return `
    <div class="qol-trend-card">
      <div class="qol-trend-head">
        <span class="qol-trend-name">${f.label}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${f.label} trend">
        ${grid}${benchPath}${councilPath}${endLabel}
      </svg>
      <div class="qol-trend-foot"><span>${x0}</span><span>${x1}</span></div>
    </div>`;
}

function renderQolTrends(c, hist) {
  const box = el("qol-trends");
  if (!box) return;
  if (!hist || !hist.metrics || !c.ons_code) { box.innerHTML = ""; return; }
  const series = hist.councils[c.ons_code] || {};
  const label = scopeLabel(c);

  // pick the benchmark series for the active scope
  let benchScope = hist.benchmarks.england;
  if (benchmarkScope === "region" && c.region && hist.benchmarks.region[c.region]) benchScope = hist.benchmarks.region[c.region];
  else if (benchmarkScope === "type" && c.la_class && hist.benchmarks.type[c.la_class]) benchScope = hist.benchmarks.type[c.la_class];

  const title = el("qol-trends-title");
  if (title) title.textContent = qolTrendMode === "rank"
    ? `National rank over time (1 = best)`
    : `Trend over time vs ${label}`;

  const cards = QOL_FIELDS.filter((f) => f.hist && series[f.key] && hist.metrics[f.key])
    .map((f) => {
      const meta = hist.metrics[f.key];
      const b = benchScope[f.key] ? benchScope[f.key].v : null;
      return qolTrendCard(f, series[f.key], b, meta.periods, qolTrendMode, label);
    }).join("");
  box.innerHTML = cards;
}


// ---------------------------------------------------- document search ---
let docSearchCache = null;      // per-council raw doc list (compact format)
let docSearchCouncil = null;
let docSearchIndex = null;      // mini inverted index: token -> Set(docIdx)
let docSearchTopics = new Set(); // active exact-topic filters (decoupled from text input)
const DOC_RESULT_LIMIT = 25;     // cap rendered results to keep the page short

// Compact search index field names: d=date, m=meeting, s=snippet, u=pdf_url, t=topics[]
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "was", "were", "are", "not", "but",
  "from", "has", "have", "had", "will", "would", "can", "could", "should", "may",
  "been", "being", "into", "over", "under", "also", "than", "then", "there", "their",
  "they", "them", "she", "he", "it", "its", "on", "at", "in", "is", "to", "of", "a",
]);

function buildDocIndex(docs) {
  const idx = new Map();
  docs.forEach((d, di) => {
    const text = ((d.m || "") + " " + (d.s || "") + " " + (d.t || []).join(" ")).toLowerCase();
    const toks = text.match(/[a-z]+/g) || [];
    toks.forEach((tk) => {
      if (tk.length < 2 || STOPWORDS.has(tk)) return;
      if (!idx.has(tk)) idx.set(tk, new Set());
      idx.get(tk).add(di);
    });
  });
  return idx;
}

function docSearchLoad(c) {
  docSearchCouncil = c;
  docSearchCache = null;
  docSearchIndex = null;
  docSearchTopics = new Set();
  el("docsearch-results").innerHTML = `<p class="empty-note">Loading documents…</p>`;
  el("docsearch-stats").textContent = "";
  // Search index file named by the council's ONS code
  fetch(`search_index/${c.ons_code}.json`)
    .then((r) => r.json())
    .then((docs) => {
      docSearchCache = docs;
      docSearchIndex = buildDocIndex(docs);
      renderDocSearchResults();
    })
    .catch(() => {
      el("docsearch-results").innerHTML = `<p class="empty-note">No document index for this council.</p>`;
      el("docsearch-stats").textContent = "";
    });
}

function docSearchActiveTopics(docs) {
  const counts = {};
  docs.forEach((d) => {
    (d.t || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  });
  return counts;
}

function renderDocumentSearch(c) {
  const hasData = !!c.ons_code;
  showPanel("panel-docsearch", hasData);
  if (!hasData) return;

  // Wire input + topic chips once
  const input = el("docsearch-input");
  const clearBtn = el("docsearch-clear");
  if (!input.dataset.wired) {
    input.dataset.wired = "1";
    input.addEventListener("input", () => renderDocSearchResults());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") renderDocSearchResults(); });
    clearBtn.addEventListener("click", () => { input.value = ""; renderDocSearchResults(); });
  }

  // Reload only when council changes (lazy-once per council)
  if (docSearchCouncil !== c) {
    docSearchLoad(c);
  } else {
    renderDocSearchResults();
  }
}

function renderDocSearchResults() {
  const c = docSearchCouncil;
  if (!docSearchCache) return;
  const docs = docSearchCache;
  const q = (el("docsearch-input").value || "").trim().toLowerCase();

  // Topic chip row (built from the council's doc index; shows doc counts)
  const topicChips = el("docsearch-topics");
  const counts = docSearchActiveTopics(docs);
  const chips = Object.keys(DATA.topic_colors || {}).map((t) => {
    const n = counts[t] || 0;
    return `<button type="button" class="docsearch-chip" data-topic="${t}" data-count="${n}">
      <span class="key-swatch" style="background:${DATA.topic_colors[t] || GREY}"></span>${t} <em>${n}</em>
    </button>`;
  }).join("");
  if (!topicChips.dataset.built || topicChips.dataset.council !== c.ons_code) {
    topicChips.dataset.built = "1";
    topicChips.dataset.council = c.ons_code;
    topicChips.innerHTML = `<span class="docsearch-chip-label">Filter by topic:</span>` + chips;
    topicChips.querySelectorAll(".docsearch-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.topic;
        // Toggle this topic in/out of the active filter set (exact-name, case-insensitive).
        if (docSearchTopics.has(t)) docSearchTopics.delete(t);
        else docSearchTopics.add(t);
        btn.classList.toggle("active", docSearchTopics.has(t));
        renderDocSearchResults();
      });
    });
  }

  // Search: split into text tokens (topic filters are held separately in a Set).
  const tokens = q.split(/\s+/).filter(Boolean);
  const textTokens = tokens.filter((t) => /[a-z0-9]/.test(t));

  let results = docs;
  if (textTokens.length) {
    const sets = textTokens.map((tk) => docSearchIndex.get(tk) || new Set());
    let combined = new Set(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      const next = new Set();
      combined.forEach((v) => { if (sets[i].has(v)) next.add(v); });
      combined = next;
    }
    results = combined.size ? [...combined].sort((a, b) => a - b).map((i) => docs[i]) : [];
  }

  // Apply topic filter (OR across selected topics, case-insensitive exact name match)
  const topicFilter = [...docSearchTopics];
  if (topicFilter.length) {
    const wanted = topicFilter.map((t) => t.toLowerCase());
    results = results.filter((d) => (d.t || []).some((t) => wanted.includes(t.toLowerCase())));
  }

  // Sort newest first (dates are ISO strings)
  results.sort((a, b) => (a.d < b.d ? 1 : -1));

  const shown = results.slice(0, DOC_RESULT_LIMIT);
  const total = results.length;

  el("docsearch-stats").innerHTML = total
    ? `${total} document${total === 1 ? "" : "s"} matched${total > DOC_RESULT_LIMIT ? ` — showing the ${DOC_RESULT_LIMIT} most recent` : ""}`
    : "No documents matched.";

  const wrap = el("docsearch-results");
  if (!shown.length) {
    wrap.innerHTML = `<p class="empty-note">No documents found — try a broader keyword, or a topic chip above.</p>`;
    return;
  }

  const rows = shown.map((d) => {
    const topicTags = (d.t || []).map((t) =>
      `<span class="docsearch-topic" style="border-color:${DATA.topic_colors[t] || GREY};color:${DATA.topic_colors[t] || ACCENT}">${t}</span>`
    ).join(" ");
    const meeting = (d.m || "").split(" - ")[0];
    const dateFmt = d.d ? d.d.replace(/-/g, "/") : "";
    return `
      <div class="docsearch-result">
        <div class="docsearch-result-head">
          <span class="docsearch-result-date">📄 ${dateFmt}</span>
          <span class="docsearch-result-meeting">${meeting}</span>
          <a class="docsearch-result-link" href="${d.u}" target="_blank" rel="noopener">Open PDF ⤴</a>
          <button type="button" class="mini-btn docsearch-cite" data-cite="${citationFor(c, meeting, d.d, d.u).replace(/"/g, "&quot;")}">Copy citation</button>
        </div>
        <p class="docsearch-result-snippet">${d.s || "(no snippet)"}</p>
        <div class="docsearch-result-topics">${topicTags}</div>
      </div>`;
  }).join("");

  wrap.innerHTML = rows;
  wrap.querySelectorAll(".docsearch-cite").forEach((btn) => {
    btn.addEventListener("click", () => {
      const txt = btn.dataset.cite;
      navigator.clipboard && navigator.clipboard.writeText(txt);
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1500);
    });
  });
}

function citationFor(council, meeting, date, url) {
  const nm = currentCouncilName || (council && council.name) || "Council";
  const dt = date ? date : "n.d.";
  const mtg = meeting ? meeting : "Meeting";
  return `${nm} Council, ${mtg}, ${dt}. ${url}`;
}

function renderTaxonomyTable() {
  const table = el("taxonomy-table");
  if (!DATA.taxonomy_examples || table.dataset.built) return;
  const rows = DATA.topics
    .map((t) => `<tr><td><span class="key-swatch" style="background:${DATA.topic_colors[t]}"></span>${t}</td><td>${DATA.taxonomy_examples[t] || ""}</td></tr>`)
    .join("");
  table.innerHTML = `<thead><tr><th>Category</th><th>Example keywords</th></tr></thead><tbody>${rows}</tbody>`;
  table.dataset.built = "1";
}

// ------------------------------------------------------- national view ---
let partyTier = "single";

function currentPartyGroups(metric) {
  if (partyTier === "all") {
    return metric === "spend" ? DATA.party_groups_spend : DATA.party_groups_discussion;
  }
  const t = DATA.party_by_tier && DATA.party_by_tier[partyTier];
  if (!t) return [];
  return metric === "spend" ? t.spend : t.discussion;
}

function redrawPartyCharts() {
  renderPartyChart("party-chart", "party-key", currentPartyGroups("spend"), "spend_share");
  renderPartyChart("party-discussion-chart", "party-discussion-key", currentPartyGroups("discussion"), "discussion_share");
  const labels = {
    single: "single-tier authorities — unitaries, mets and London boroughs, which run all services",
    district: "shire districts — lower-tier councils that do not run social care or education",
    county: "shire counties — upper-tier councils that run social care, education and highways",
    all: `all ${QOL_N} English authorities`,
  };
  const cap = el("party-caption");
  if (cap) cap.textContent = `Equal-weighted mean spend share across ${labels[partyTier]}. n = number of councils in each party group. Source: MHCLG Revenue Outturn 2024-25 · control from Open Council Data UK (2026).`;
}

function renderNational() {
  renderDistressWatchlist();
  const toggle = el("party-tier-toggle");
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = "1";
    toggle.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        partyTier = btn.dataset.tier;
        toggle.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        redrawPartyCharts();
      });
    });
  }
  redrawPartyCharts();
  renderLeagueTable();
}

function renderDistressWatchlist() {
  const wrap = el("distress-watchlist-wrap");
  const list = DATA.distress_watchlist || [];
  if (!list.length) {
    showPanel("panel-distress-national", false);
    return;
  }
  showPanel("panel-distress-national", true);

  const rows = list.map((item) => {
    const is114 = item.severity === 3;
    const badgeCls = is114 ? "distress-chip critical" : "distress-chip high";
    const statusTxt = is114 ? `Section 114 (${item.s114_year || "Active"})` : `EFS Support (£${item.efs_m}m)`;
    return `
      <tr>
        <td><a href="?council=${encodeURIComponent(item.council)}" class="council-link">${item.council}</a></td>
        <td><span class="${badgeCls}">${statusTxt}</span></td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `
    <table class="league distress-table">
      <thead>
        <tr>
          <th>Local Authority</th>
          <th>Distress Status / Intervention</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderPartyChart(chartId, keyId, groups, shareKey) {
  const panelId = chartId === "party-chart" ? "panel-party" : "panel-party-discussion";
  const hasData = groups && groups.length;
  showPanel(panelId, !!hasData);
  if (!hasData) return;

  const mob = isMobile();
  const topics = DATA.topics.filter((t) => groups.some((g) => (g[shareKey] || {})[t] != null));
  const labels = groups.map((g) => {
    if (!mob) return `${g.party} (n=${g.n})`;
    let p = g.party;
    if (p === "Liberal Democrat") p = "Lib Dem";
    else if (p === "Conservative") p = "Cons.";
    return `${p} (n=${g.n})`;
  });

  el(keyId).innerHTML = topics.map((t) => swatch(DATA.topic_colors[t] || GREY, t)).join(" &nbsp; ");

  const traces = topics.map((t) => {
    const vals = groups.map((g) => (g[shareKey] || {})[t] || 0);
    return {
      x: vals,
      y: labels,
      type: "bar",
      orientation: "h",
      name: t,
      marker: { color: DATA.topic_colors[t] || GREY },
      text: vals.map((v) => (v >= (mob ? 8 : 6) ? v.toFixed(0) + "%" : "")),
      textposition: "inside",
      insidetextanchor: "middle",
      textfont: { color: "#fff", size: mob ? 10 : 12 },
      hoverinfo: "skip",
    };
  });

  Plotly.newPlot(
    chartId, traces,
    {
      barmode: "stack", showlegend: false,
      margin: { l: mob ? 105 : 210, r: mob ? 10 : 20, t: 10, b: 25 },
      height: chartHeight(groups.length, mob ? 48 : 64),
      font: { ...BASE_FONT, size: mob ? 10.5 : 13 },
      xaxis: { title: "", ticksuffix: "%", zeroline: false },
      yaxis: { title: "" },
      template: "simple_white",
    },
    { ...PLOTLY_CONFIG, useResizeHandler: true }
  );
}

let leagueSort = null;
let leagueTopN = 10;
let leagueSearchQuery = "";

function renderLeagueTable() {
  const lt = DATA.league_table;
  const hasData = lt && lt.rows && lt.rows.length;
  if (!hasData) {
    el("league-table-wrap").innerHTML = `<p class="empty-note">League table data not available yet.</p>`;
    el("league-caption").textContent = "";
    showPanel("league-toggle", false);
    return;
  }
  if (!leagueSort) leagueSort = { col: "life_expectancy", asc: false };
  el("league-caption").textContent =
    "Ranked by Quality of Life indicators across England. Click any column header to re-sort. Filter rows by council name using the search bar.";

  // Wire search input
  const searchInput = el("league-search");
  if (searchInput && !searchInput.dataset.wired) {
    searchInput.dataset.wired = "1";
    searchInput.addEventListener("input", (e) => {
      leagueSearchQuery = (e.target.value || "").trim().toLowerCase();
      drawLeagueTable(lt);
    });
  }

  // Wire Top N toggle buttons
  const toggle = el("league-toggle");
  if (toggle) {
    toggle.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.onclick = () => {
        toggle.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const val = btn.dataset.n;
        leagueTopN = val === "all" ? "all" : Number(val);
        drawLeagueTable(lt);
      };
    });
  }

  drawLeagueTable(lt);
}

function shortenControl(s) {
  if (!s) return "—";
  return s
    .replace(/No overall control/g, "NOC")
    .replace(/Liberal Democrat/g, "LibDem")
    .replace(/\(elected mayor\)/g, "(Mayor)")
    .replace(/\s*\/\s*/g, "/");
}

function sortedLeagueRows(lt) {
  const { col, asc } = leagueSort;
  let rows = lt.rows.slice();

  rows.sort((a, b) => {
    let av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return asc ? av - bv : bv - av;
  });
  return rows;
}

function drawLeagueTable(lt) {
  const cols = [
    { key: "council", label: "Council", unit: "" },
    { key: "control", label: "Control", unit: "" },
    { key: "life_expectancy", label: "Life Exp.", unit: " yrs" },
    { key: "attainment8", label: "GCSE Score", unit: " pts" },
    { key: "rent_affordability", label: "Rent Afford.", unit: "%" },
    { key: "child_poverty_pct", label: "Child Poverty", unit: "%" },
    { key: "claimant_rate_pct", label: "Claimant %", unit: "%" },
    { key: "air_quality_pm25_pct", label: "Air Quality", unit: "%" },
    { key: "crime_per_1000", label: "Crime / 1k", unit: "" },
    { key: "house_earnings", label: "House / Earnings", unit: "×" },
  ];

  // 1. Sort all rows and assign global sort rank
  const allSorted = sortedLeagueRows(lt);
  allSorted.forEach((r, idx) => { r._globalRank = idx + 1; });

  // 2. Filter by search query if present
  let displayRows = allSorted;
  if (leagueSearchQuery) {
    displayRows = displayRows.filter((r) => (r.council || "").toLowerCase().includes(leagueSearchQuery));
  }

  // 3. Slice by active top N
  const rows = leagueTopN === "all" ? displayRows : displayRows.slice(0, leagueTopN);

  const rowsHtml = rows
    .map((r) => {
      const cells = cols.map((col) => {
        const val = r[col.key];
        if (col.key === "council") {
          return `<td class="council-cell"><a href="?council=${encodeURIComponent(val)}" class="council-link" title="${val}">${val}</a></td>`;
        }
        if (col.key === "control") {
          const short = shortenControl(val);
          return `<td class="control-cell" title="${val ?? ''}">${short}</td>`;
        }
        if (val == null) return `<td class="num-cell">—</td>`;
        return `<td class="num-cell">${val}${col.unit}</td>`;
      });
      return `<tr><td class="rank-cell">#${r._globalRank}</td>${cells.join("")}</tr>`;
    })
    .join("");

  const headHtml =
    `<th class="rank-cell">Rank</th>` +
    cols
      .map((col) => {
        const active = leagueSort.col === col.key;
        const arrow = active ? (leagueSort.asc ? " ▲" : " ▼") : "";
        const isNum = col.key !== "council" && col.key !== "control";
        return `<th data-col="${col.key}" class="sortable${active ? " sorted" : ""}${isNum ? " num-th" : ""}">${col.label}${arrow}</th>`;
      })
      .join("");

  const emptyMsg = rows.length === 0 ? `<tr><td colspan="${cols.length + 1}" class="empty-note" style="text-align:center;padding:16px;">No councils matching "${leagueSearchQuery}"</td></tr>` : "";

  el("league-table-wrap").innerHTML = `<div style="overflow-x:auto"><table class="league">
    <thead><tr>${headHtml}</tr></thead>
    <tbody>${rowsHtml || emptyMsg}</tbody>
  </table></div>`;

  document.querySelectorAll("table.league th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (leagueSort.col === col) {
        leagueSort.asc = !leagueSort.asc;
      } else {
        const higherIsBetter = col === "life_expectancy" || col === "attainment8";
        leagueSort = { col, asc: higherIsBetter ? false : (col === "council" || col === "control") };
      }
      drawLeagueTable(lt);
    });
  });
}

function initFeedbackForm() {
  const form = el("feedback-form");
  const status = el("feedback-status");
  const btn = el("feedback-submit-btn");
  if (!form || form.dataset.wired) return;
  form.dataset.wired = "1";

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (btn) btn.disabled = true;
    if (status) {
      status.style.color = "var(--ink-soft)";
      status.textContent = "Sending your note…";
    }

    const formData = new FormData(form);
    fetch("https://formsubmit.co/ajax/parthgoyal60@gmail.com", {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      body: formData
    })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        if (data && data.success === "false") throw new Error("rejected");
        if (btn) btn.disabled = false;
        if (status) {
          status.style.color = "#166534";
          status.textContent = "✓ Thank you! Your feedback has been received.";
        }
        form.reset();
      })
      .catch((err) => {
        if (btn) btn.disabled = false;
        if (status) {
          status.style.color = "var(--stamp)";
          status.textContent = "Could not send directly. Please email parthgoyal60@gmail.com.";
        }
      });
  });
}

// ---------------------------------------------------------- omnibox ---
let globalIndex = null;
let globalIndexPromise = null;

function loadGlobalIndex() {
  if (globalIndexPromise) return globalIndexPromise;
  globalIndexPromise = fetch("search_index_global.json?v=20261012e")
    .then((r) => r.json())
    .then((d) => { globalIndex = d; return d; })
    .catch(() => { globalIndex = {}; return {}; });
  return globalIndexPromise;
}

function globalTokens(q) {
  return (q.toLowerCase().match(/[a-z]{4,}/g) || []).filter((t) => !STOPWORDS.has(t));
}

function initOmnibox() {
  const input = el("omnibox");
  const menu = el("omnibox-menu");
  if (!input || !menu) return;
  const names = Object.keys(DATA.councils).sort();

  function close() { menu.style.display = "none"; }
  function render() {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const ql = q.toLowerCase();
    const isPc = POSTCODE_RE.test(q);
    const councilHits = names.filter((n) => n.toLowerCase().includes(ql)).slice(0, 6);
    let html = "";
    if (isPc) html += `<div class="pc-result"><div class="pc-loading">Looking up ${q.toUpperCase()}…</div></div>`;
    councilHits.forEach((n) => {
      const c = DATA.councils[n];
      html += `<div class="omnibox-item" data-council="${n}"><span class="omni-kind">Council</span><span class="item-name">${n}</span>${c.party ? `<span class="menu-party">${c.party}</span>` : ""}</div>`;
    });
    html += `<div class="omnibox-item omni-search" data-query="${q.replace(/"/g, "&quot;")}"><span class="omni-kind">Search</span><span>Search all councils for &ldquo;${q}&rdquo;</span></div>`;
    menu.innerHTML = html;
    menu.style.display = "block";
    menu.querySelectorAll(".omnibox-item").forEach((item) => {
      item.addEventListener("click", () => {
        if (item.dataset.council) {
          const nm = item.dataset.council;
          input.value = nm;
          close();
          const b = document.querySelector('.tab[data-tab="council"]');
          if (b) b.click();
          renderCouncil(nm);
        } else {
          close();
          openGlobalSearch(item.dataset.query);
        }
      });
    });
    if (isPc) {
      const box = menu.querySelector(".pc-result");
      lookupPostcode(q).then((info) => {
        if (!box || !menu.contains(box)) return;
        box.innerHTML = postcodeItemsHTML(info);
        box.querySelectorAll("[data-pc-council]").forEach((item) => {
          item.addEventListener("click", () => {
            const nm = item.dataset.pcCouncil;
            input.value = nm;
            close();
            const b = document.querySelector('.tab[data-tab="council"]');
            if (b) b.click();
            renderCouncil(nm);
          });
        });
      });
    }
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = input.value.trim();
      if (!q) return;
      const exact = names.find((n) => n.toLowerCase() === q.toLowerCase());
      close();
      if (exact) {
        const b = document.querySelector('.tab[data-tab="council"]');
        if (b) b.click();
        renderCouncil(exact);
      } else {
        openGlobalSearch(q);
      }
    } else if (e.key === "Escape") {
      close();
    }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".omnibox-wrap")) close(); });
}

function openGlobalSearch(q) {
  const b = document.querySelector('.tab[data-tab="national"]');
  if (b) b.click();
  el("panel-global-search").style.display = "";
  el("global-search-heading").textContent = `Cross-council search: “${q}”`;
  el("global-search-lede").textContent = "Councils whose published meeting documents mention every word you searched for, ranked by how many documents match.";
  el("global-search-results").innerHTML = `<p class="empty-note">Searching…</p>`;
  const toks = globalTokens(q);
  if (!toks.length) {
    el("global-search-results").innerHTML = `<p class="empty-note">Type at least one word of four or more letters.</p>`;
    return;
  }
  loadGlobalIndex().then((idx) => {
    let councils = null;
    toks.forEach((tk) => {
      const entries = idx[tk] || [];
      const m = new Map(entries);
      if (councils === null) {
        councils = m;
      } else {
        const next = new Map();
        councils.forEach((v, k) => { if (m.has(k)) next.set(k, v + m.get(k)); });
        councils = next;
      }
    });
    renderGlobalResults(q, councils, toks);
  });
}

function renderGlobalResults(q, councils, toks) {
  const wrap = el("global-search-results");
  const missing = toks.filter((tk) => !globalIndex || !globalIndex[tk]);
  if (!councils || !councils.size) {
    wrap.innerHTML = `<p class="empty-note">No council documents matched ${missing.length ? "all of these terms" : "your search"}. Try fewer or broader words.</p>`;
    return;
  }
  const rows = [...councils.entries()]
    .map(([ons, n]) => {
      const c = Object.values(DATA.councils).find((x) => x.ons_code === ons);
      return { ons, n, name: c ? c.name : ons, party: c ? c.party : null };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 20);

  const body = rows.map((r, i) => `
    <tr>
      <td class="rank-cell">${i + 1}</td>
      <td class="council-cell"><a class="council-link" href="?council=${encodeURIComponent(r.name)}">${r.name}</a></td>
      <td>${r.party || "—"}</td>
      <td class="num-cell">${r.n}</td>
      <td><button class="mini-btn" data-open-council="${r.name}">Open dossier</button></td>
    </tr>`).join("");

  const note = missing.length
    ? `<p class="empty-note">No documents matched: ${missing.map((m) => `“${m}”`).join(", ")}. Showing councils matching the rest.</p>`
    : "";

  wrap.innerHTML = `${note}
    <div style="overflow-x:auto"><table class="league">
      <thead><tr><th class="rank-cell">#</th><th>Council</th><th>Control</th><th class="num-th">Matching docs</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="caption">Based on the most recent 500 classified documents per council. Open a dossier to search its full text.</p>`;

  wrap.querySelectorAll("[data-open-council]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nm = btn.dataset.openCouncil;
      const b = document.querySelector('.tab[data-tab="council"]');
      if (b) b.click();
      renderCouncil(nm);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

// -------------------------------------------------------------- init ---
window.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initFeedbackForm();
  initCopyBriefing();
  initQolModeToggle();

  // Instant navigation when clicking any council link in tables
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".council-link");
    if (link && link.href) {
      try {
        const url = new URL(link.href, window.location.origin);
        const councilName = url.searchParams.get("council");
        if (councilName && DATA && DATA.councils[councilName]) {
          e.preventDefault();
          history.pushState(null, "", `?council=${encodeURIComponent(councilName)}`);
          const councilTabBtn = document.querySelector('.tab[data-tab="council"]');
          if (councilTabBtn) councilTabBtn.click();
          renderCouncil(councilName);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } catch (err) {
        // fallback to normal link navigation
      }
    }
  });

  fetch("data.json?v=20261012e")
    .then((r) => r.json())
    .then((data) => {
      DATA = data;
      QOL_N = Object.keys(data.councils || {}).length || QOL_N;
      document.querySelectorAll(".council-count").forEach((n) => { n.textContent = QOL_N; });
      updateMethodologyEngland();
      initCouncilSelect();
      initOmnibox();
      initModals();
      renderNational();
      const tabParam = new URLSearchParams(location.search).get("tab");
      const tabBtn = tabParam && document.querySelector(`.tab[data-tab="${tabParam}"]`);
      if (tabBtn) tabBtn.click();
    })
    .catch((err) => {
      document.querySelector(".container").innerHTML =
        `<p>Could not load data.json — run <code>python site/build.py</code> and serve this folder with <code>python -m http.server</code>.</p>`;
      console.error(err);
    });
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentCouncilName && DATA && DATA.councils[currentCouncilName]) {
      const c = DATA.councils[currentCouncilName];
      renderPopulation(c);
      renderAgeChart(c);
      renderTopicsChart(c, currentCouncilName);
      renderMoneyChart(c);
      renderTalkVsSpend(c);
    }
    if (DATA) {
      redrawPartyCharts();
    }
  }, 150);
});
