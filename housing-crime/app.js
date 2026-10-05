/* Housing & Crime Forensic Terminal — reads housing-crime/data.json (baked by
   site/build_forensic.py). */

let DATA = null;
let currentOns = null;
let activeCats = new Set();

const CAT_LABEL = {
  housing_ta: "Emergency housing / TA",
  planning_s106: "Planning & S106",
  enforcement_asb: "Enforcement & ASB",
  contracts: "Contracts & procurement",
};

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function gbp(n) { return n == null ? "n/a" : "£" + Math.round(n).toLocaleString("en-GB"); }

// --------------------------------------------------------------- tabs ---
document.querySelectorAll(".vtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".vtab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    el("view-" + btn.dataset.view).classList.add("active");
    if (btn.dataset.view === "matrix") window.dispatchEvent(new Event("resize"));
  });
});

// ------------------------------------------------------------- matrix ---
function renderMatrix() {
  const m = DATA.matrix.filter((d) => d.rent != null && d.crime != null);
  const rents = m.map((d) => d.rent);
  const spends = m.map((d) => d.housing_spend).filter((v) => v != null);
  const smin = Math.min(...spends), smax = Math.max(...spends);
  const trace = {
    x: rents, y: m.map((d) => d.crime),
    text: m.map((d) => d.name),
    customdata: m.map((d) => [d.housing_spend, d.flagged, d.ons_code]),
    mode: "markers", type: "scatter",
    marker: {
      size: m.map((d) => 6 + Math.min(d.flagged, 20) * 0.7),
      color: m.map((d) => d.housing_spend),
      colorscale: [[0, "#2f3a45"], [0.5, "#4c9a7a"], [1, "#e0563f"]],
      cmin: smin, cmax: smax, opacity: 0.82,
      colorbar: { title: { text: "Housing £/head", font: { family: "IBM Plex Mono", size: 10 } },
        tickfont: { family: "IBM Plex Mono", size: 9 }, thickness: 12 },
    },
    hovertemplate: "<b>%{text}</b><br>Rent burden: %{x:.1f}% of pay<br>Crime: %{y:.0f} per 1k<br>" +
      "Housing spend: £%{customdata[0]:.0f}/head<br>Flagged decisions: %{customdata[1]}<extra></extra>",
  };
  const layout = {
    template: "plotly_dark",
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "IBM Plex Mono", size: 11, color: "#e7e4dc" },
    margin: { l: 55, r: 20, t: 20, b: 55 },
    xaxis: { title: "Rent affordability (% of median pay)", gridcolor: "#2a2f35", zeroline: false },
    yaxis: { title: "Recorded crime per 1,000", gridcolor: "#2a2f35", zeroline: false },
    hovermode: "closest",
  };
  Plotly.newPlot("matrix-chart", [trace], layout, { responsive: true, displayModeBar: false });
  el("matrix-chart").on("plotly_click", (ev) => {
    const ons = ev.points[0].customdata[2];
    openDossier(ons, true);
  });
  const engRent = 32.7, engCrime = 79.4;
  el("matrix-caption").textContent =
    `${m.length} councils plotted. Dashed England reference: rent ${engRent}%, crime ${engCrime}/1k. ` +
    `Bubble colour = housing spend per resident. Click a bubble to open its paper trail.`;
}

// ------------------------------------------------------------ dossier ---
function openDossier(ons, switchView) {
  const c = DATA.councils[ons];
  if (!c) return;
  currentOns = ons;
  activeCats = new Set();
  document.title = `${c.name} — Housing & Crime paper trail`;
  if (switchView) {
    document.querySelector('.vtab[data-view="dossier"]').click();
    el("council-input").value = c.name;
  }
  const p = c.pressure;
  const cards = [
    { lbl: "Rent burden", val: p.rent_affordability != null ? p.rent_affordability + "%" : "n/a",
      rank: rankTxt(p.rent_affordability_rank, "most unaffordable"), bad: p.rent_affordability_rank >= 226 },
    { lbl: "Crime / 1k", val: p.crime_per_1000 != null ? p.crime_per_1000 : "n/a",
      rank: rankTxt(p.crime_rank, "highest crime"), bad: p.crime_rank >= 226 },
    { lbl: "Housing spend", val: c.spend.housing != null ? gbp(c.spend.housing) + "/head" : "n/a", rank: "" },
    { lbl: "Safety spend", val: c.spend.env_regulatory != null ? gbp(c.spend.env_regulatory) + "/head" : "n/a", rank: "env & regulatory" },
    { lbl: "Housing debate", val: c.spend.discussion_housing != null ? c.spend.discussion_housing + "%" : "n/a", rank: "of all discussion" },
    { lbl: "Borrowing", val: c.borrowing_per_resident != null ? gbp(c.borrowing_per_resident) + "/head" : "n/a", rank: "" },
  ];
  const leads = c.leads.length
    ? c.leads.map((l) => `<div class="lead"><div class="t">🚩 ${esc(l.label)}</div><div class="a">${esc(l.advice)}</div></div>`).join("")
    : `<p class="empty">No algorithmic red flags triggered — fewer than three matching decisions in this council's record.</p>`;
  const counts = c.decision_counts || {};
  const fchips = Object.keys(CAT_LABEL).map((k) =>
    `<button class="fchip" data-cat="${k}">${CAT_LABEL[k]} (${counts[k] || 0})</button>`).join("");

  el("dossier").innerHTML = `
    <div class="dossier-head">
      <h2>${esc(c.name)}</h2>
      <div class="sub">${esc(c.party || "")}${c.population ? " · pop " + c.population.toLocaleString("en-GB") : ""} · ${c.total_decisions} flagged decisions on record</div>
    </div>
    <div class="press-grid">
      ${cards.map((k) => `<div class="press-card ${k.bad ? "bad" : ""}"><div class="lbl">${k.lbl}</div><div class="val">${k.val}</div><div class="rank">${k.rank || ""}</div></div>`).join("")}
    </div>
    <div class="actions">
      <button class="ai-btn" id="copy-dossier">✦ Copy dossier for AI</button>
      <button class="ai-btn alt" id="gen-foi">⚖ Generate FOI request</button>
      <a class="ai-btn alt" style="text-decoration:none;display:inline-flex;align-items:center" href="../?council=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">↗ Full council profile</a>
    </div>
    <div class="section-title">Automated investigative leads</div>
    <div class="leads">${leads}</div>
    <div class="section-title">Evidence stream — executive decisions</div>
    <div class="filters" id="filters">${fchips}<button class="fchip" data-cat="__all">Show all</button></div>
    <div id="decisions"></div>`;

  el("copy-dossier").addEventListener("click", () => copyDossier(c));
  el("gen-foi").addEventListener("click", () => generateFoi(c));
  el("filters").querySelectorAll(".fchip").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.cat === "__all") { activeCats = new Set(); }
    else if (activeCats.has(b.dataset.cat)) activeCats.delete(b.dataset.cat);
    else activeCats.add(b.dataset.cat);
    renderDecisions(c);
  }));
  renderDecisions(c);
}

function rankTxt(rank, label) { return rank != null ? `Rank #${rank} of 282 (${label})` : ""; }

function renderDecisions(c) {
  let decs = c.decisions || [];
  if (activeCats.size) decs = decs.filter((d) => d.categories.some((k) => activeCats.has(k)));
  document.querySelectorAll("#filters .fchip").forEach((b) => {
    b.classList.toggle("active", b.dataset.cat === "__all" ? activeCats.size === 0 : activeCats.has(b.dataset.cat));
  });
  const wrap = el("decisions");
  if (!decs.length) { wrap.innerHTML = `<p class="empty">No matching decisions.</p>`; return; }
  wrap.innerHTML = decs.map((d) => `
    <div class="decision">
      <div class="meta"><span>${d.date || "n/a"}</span><span>${esc(d.decision_maker || "")}</span>${d.is_key ? "<span>KEY DECISION</span>" : ""}</div>
      <div class="topline">${esc(d.topline || "(no topline)")}</div>
      ${d.snippet ? `<div class="snip">${esc(d.snippet)}…</div>` : ""}
      <div class="tags">
        ${d.categories.map((k) => `<span class="tag ${k}">${CAT_LABEL[k] || k}</span>`).join("")}
        ${d.value_gbp ? `<span class="tag value">${gbp(d.value_gbp)}</span>` : ""}
        ${d.url ? `<a href="${d.url}" target="_blank" rel="noopener">official notice ↗</a>` : ""}
      </div>
    </div>`).join("");
}

// -------------------------------------------------------- AI dossier ---
function buildDossierText(c) {
  const p = c.pressure, s = c.spend;
  const L = [];
  L.push(`# INVESTIGATION DOSSIER: ${c.name} (${c.ons_code})`);
  L.push(`Control: ${c.party || "n/a"} | Population: ${c.population || "n/a"}`);
  L.push("");
  L.push("## Pressure");
  if (p.rent_affordability != null) L.push(`- Rent burden: ${p.rent_affordability}% of median pay (rank #${p.rent_affordability_rank}/282, higher = worse)`);
  if (p.crime_per_1000 != null) L.push(`- Recorded crime: ${p.crime_per_1000}/1k (rank #${p.crime_rank}/282, higher = worse)`);
  if (p.child_poverty_pct != null) L.push(`- Child poverty: ${p.child_poverty_pct}%`);
  L.push("");
  L.push("## Money");
  if (s.housing != null) L.push(`- Housing spend: ${gbp(s.housing)}/resident`);
  if (s.env_regulatory != null) L.push(`- Environmental & regulatory (ASB/licensing/security): ${gbp(s.env_regulatory)}/resident`);
  if (c.borrowing_per_resident != null) L.push(`- Borrowing: ${gbp(c.borrowing_per_resident)}/resident`);
  L.push("");
  L.push("## Recent flagged executive decisions");
  (c.decisions || []).slice(0, 12).forEach((d) => {
    L.push(`- [${d.date}] (${d.categories.map((k) => CAT_LABEL[k]).join(", ")}) ${d.topline || d.snippet}` +
      (d.value_gbp ? ` — ${gbp(d.value_gbp)}` : "") + (d.url ? ` [${d.url}]` : ""));
  });
  L.push("");
  L.push("## Task");
  L.push("You are an investigative local-government reporter. Using ONLY the dossier above:");
  L.push("1. Identify procurement red flags, single-tender exemptions, or commercial leakages.");
  L.push("2. Draft three specific Freedom of Information requests targeting hidden costs.");
  L.push("3. Write three tough interview questions for the Cabinet Member for Housing / Community Safety.");
  L.push("Flag anything the data does not support rather than inventing detail.");
  return L.join("\n");
}

function copyDossier(c) {
  const text = buildDossierText(c);
  const btn = el("copy-dossier");
  const done = () => { const o = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(() => (btn.textContent = o), 1600); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(() => fallback(text, done));
  else fallback(text, done);
}

function fallback(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  document.body.removeChild(ta);
}

// -------------------------------------------------------------- FOI ---
const FOI_TEMPLATES = {
  housing_ta: {
    title: "Temporary accommodation spend & out-of-borough placements",
    body: `1. The total annual expenditure on temporary accommodation for each of the last three financial years, broken down by accommodation type (B&B, nightly-paid, private landlord, council-owned).
2. The nightly rate paid for emergency B&B/hotel accommodation, and the number of households placed in such accommodation.
3. The number of households placed in temporary accommodation outside the borough, and the five highest-value providers paid.
4. Any exemptions from your Contract Procedure Rules applied to temporary accommodation procurement, with the value and justification for each.`,
  },
  planning_s106: {
    title: "S106 affordable housing & viability assessments",
    body: `1. For each major residential application determined in the last three years, the affordable housing percentage required by policy versus that finally secured under the Section 106 agreement.
2. The number of applications where a Financial Viability Assessment resulted in a reduction of affordable housing, and the reduction in units for each.
3. Total Section 106 and CIL receipts collected, allocated, and currently unspent.
4. Any independent review of developer viability appraisals commissioned, and its conclusions.`,
  },
  enforcement_asb: {
    title: "ASB enforcement, PSPO and CCTV spending",
    body: `1. Total spend on Public Spaces Protection Orders, private security patrols, wardens, and CCTV over the last three years.
2. The number of fixed penalty notices issued under each PSPO, and the amount collected.
3. Budget for youth services and community-safety prevention over the same period.
4. Copies of any assessment weighing enforcement measures against prevention/diversion.`,
  },
  contracts: {
    title: "Procurement waivers and single-tender awards",
    body: `1. All exemptions, waivers, or direct awards under your Contract Procedure Rules in the last two years, with supplier, value, and stated justification.
2. The ten suppliers receiving the highest total payments in the last financial year.
3. Any contract extensions granted without competition, and their value.`,
  },
};

function buildFoiText(c, choice) {
  const t = FOI_TEMPLATES[choice];
  return `To: ${c.name} — Freedom of Information Team
Subject: Freedom of Information Act 2000 request — ${t.title}

Dear Sir/Madam,

Under the Freedom of Information Act 2000, please provide the following information relating to ${c.name}:

${t.body}

Where possible, please provide this in a machine-readable spreadsheet (CSV/XLSX). If any part exceeds the appropriate cost limit, please advise which parts can be answered within it.

Yours faithfully,
[Your name]
[Date]`;
}

function generateFoi(c) {
  const cats = c.leads.length ? c.leads.map((l) => l.category) : Object.keys(FOI_TEMPLATES);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">
    <h3>Generate FOI request</h3>
    <p class="muted">Choose a topic for ${esc(c.name)}:</p>
    <div class="modal-choices">${cats.map((k) => `<button class="fchip" data-cat="${k}">${esc(FOI_TEMPLATES[k].title)}</button>`).join("")}</div>
    <pre id="foi-out" class="foi-out"></pre>
    <div class="modal-actions">
      <button class="ai-btn" id="foi-copy">Copy request</button>
      <button class="ai-btn alt" id="foi-close">Close</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const out = overlay.querySelector("#foi-out");
  let current = "";
  const show = (k) => {
    current = buildFoiText(c, k);
    out.textContent = current;
    overlay.querySelectorAll(".fchip").forEach((b) => b.classList.toggle("active", b.dataset.cat === k));
  };
  overlay.querySelectorAll(".fchip").forEach((b) => b.addEventListener("click", () => show(b.dataset.cat)));
  overlay.querySelector("#foi-copy").addEventListener("click", () => {
    const btn = overlay.querySelector("#foi-copy");
    const done = () => { btn.textContent = "✓ Copied"; setTimeout(() => (btn.textContent = "Copy request"), 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(current).then(done).catch(() => fallback(current, done));
    else fallback(current, done);
  });
  overlay.querySelector("#foi-close").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  show(cats[0]);
}

// -------------------------------------------------------------- init ---
window.addEventListener("DOMContentLoaded", () => {
  fetch("data.json?v=20261005a").then((r) => r.json()).then((d) => {
    DATA = d;
    const names = Object.values(d.councils).map((c) => c.name).sort();
    el("council-list").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    el("foot-meta").textContent = `${d.meta.councils} councils · ${d.meta.decisions.toLocaleString("en-GB")} flagged decisions`;
    renderMatrix();

    const load = () => {
      const nm = el("council-input").value.trim().toLowerCase();
      const hit = Object.values(d.councils).find((c) => c.name.toLowerCase() === nm) ||
        Object.values(d.councils).find((c) => c.name.toLowerCase().includes(nm));
      if (hit) openDossier(hit.ons_code, false);
    };
    el("load-btn").addEventListener("click", load);
    el("council-input").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });

    const deep = new URLSearchParams(location.search).get("council");
    if (deep && d.councils[deep]) openDossier(deep, false);
    else { const nm = new URLSearchParams(location.search).get("q"); if (nm) { el("council-input").value = nm; load(); } }
  }).catch((err) => {
    document.querySelector("main").innerHTML = "<p class='empty'>Could not load data.json — run <code>python site/build_forensic.py</code>.</p>";
    console.error(err);
  });
});
