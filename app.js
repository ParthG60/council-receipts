/* Council Receipts — static site. Reads site/data.json (baked by site/build.py). */

/* Receipt palette: council = ink, comparisons = warm grey, money/benchmark = stamp red. */
const ACCENT = "#262420";
const ACCENT_2 = "#8c877a";
const GREY = "#b6ad9c";
const SPEND_COLOR = "#b5372b";

const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };

/* Every chart inherits receipt typography + transparent paper without touching
   each call site: wrap newPlot once and merge a base layout in. */
const BASE_FONT = { family: "'IBM Plex Mono', ui-monospace, monospace", size: 12, color: "#262420" };
const RAW_NEWPLOT = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (id, traces, layout = {}, config) =>
  RAW_NEWPLOT(id, traces, {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    ...layout,
    font: { ...BASE_FONT, ...(layout.font || {}) },
  }, config);

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
    });
  });
}

// ------------------------------------------------------- council view ---
function initCouncilSelect() {
  const input = el("council-input");
  const toggleBtn = el("combobox-toggle");
  const menu = el("combobox-menu");
  const names = Object.keys(DATA.councils).sort();

  function renderMenu(query = "") {
    const q = query.trim().toLowerCase();
    const filtered = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    if (!filtered.length) {
      menu.innerHTML = `<div class="combobox-empty">No matching councils found</div>`;
      return;
    }
    menu.innerHTML = filtered
      .map((n) => {
        const c = DATA.councils[n];
        const party = c.party ? `<span class="menu-party">${c.party}</span>` : "";
        return `<div class="combobox-item" data-name="${n}"><span class="item-name">${n}</span>${party}</div>`;
      })
      .join("");

    menu.querySelectorAll(".combobox-item").forEach((item) => {
      item.addEventListener("click", () => {
        const name = item.dataset.name;
        input.value = name;
        menu.style.display = "none";
        renderCouncil(name);
      });
    });
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

function renderCouncil(name) {
  if (!name || !DATA.councils[name]) return;
  const c = DATA.councils[name];

  const panels = el("council-data-panels");
  if (panels) panels.style.display = "";
  const prompt = el("council-prompt");
  if (prompt) prompt.style.display = "none";

  const input = el("council-input");
  if (input && input.value !== name) input.value = name;

  renderControlLine(c);
  renderElectionBanner(c);
  renderDistress(c);
  renderPopulation(c);
  renderAgeChart(c);
  renderTopicsChart(c, name);
  renderMoneyChart(c);
  renderTalkVsSpend(c);
  renderQoL(c);
  renderReadingLinks(c);
  renderTaxonomyTable();
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

  Plotly.newPlot(
    "race-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: 60, r: 40, t: 10, b: 30 },
      height: chartHeight(cats.length, 32),
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

  Plotly.newPlot(
    "age-chart",
    [
      withClip({ x: englandVals, y: bands, type: "bar", orientation: "h", marker: { color: GREY }, text: englandVals.map((v) => v.toFixed(0) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: councilVals, y: bands, type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.map((v) => v.toFixed(0) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: 50, r: 40, t: 10, b: 30 },
      height: chartHeight(bands.length, 44),
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

  Plotly.newPlot(
    "age-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: 50, r: 30, t: 30, b: 30 },
      height: chartHeight(bands.length, 60),
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

  Plotly.newPlot(
    "topics-chart",
    [
      withClip({ x: avgVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: GREY }, text: avgVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: councilVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: 168, r: 45, t: 10, b: 30 },
      height: chartHeight(topics.length, 40),
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
  const medians = services.map((s) => (DATA.money_median_per_resident || {})[s]);
  const hasMedian = medians.some((v) => v != null);

  el("money-key").innerHTML = hasMedian
    ? swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England median")
    : swatch(ACCENT, "This council");

  const traces = [
    withClip({ x: values.slice().reverse(), y: labels.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: values.slice().reverse().map((v) => fmtGbp(v)), textposition: "outside", hoverinfo: "skip" }),
  ];
  if (hasMedian) {
    traces.push(withClip({
      x: medians.slice().reverse(), y: labels.slice().reverse(), type: "bar", orientation: "h",
      marker: { color: GREY }, text: medians.slice().reverse().map((v) => (v != null ? fmtGbp(v) : "")),
      textposition: "outside", hoverinfo: "skip",
    }));
  }

  Plotly.newPlot(
    "money-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: 130, r: 65, t: 10, b: 30 },
      height: chartHeight(services.length, 52),
      xaxis: { title: "", tickprefix: "£", zeroline: true, zerolinecolor: "#999", zerolinewidth: 1, range: headroomRange([...values, ...medians.filter((v) => v != null)]) },
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

  el("money-lede").innerHTML = `Share of matched-topic spend, this council vs the England average.${tierCallout}`;
  const rows = c.money_share;
  const topics = rows.map((r) => r.topic);
  const councilVals = rows.map((r) => r.council_pct);
  const englandVals = rows.map((r) => r.england_pct);

  el("money-key").innerHTML = swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, "England average");

  const traces = [
    withClip({ x: councilVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: councilVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    withClip({ x: englandVals.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: GREY }, text: englandVals.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
  ];

  Plotly.newPlot(
    "money-chart", traces,
    {
      barmode: "group", showlegend: false,
      margin: { l: 170, r: 45, t: 10, b: 30 },
      height: chartHeight(topics.length, 52),
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

  let caption = "Topics without a budget line excluded; minutes Oct 2024–Mar 2025 vs spend year 2024-25.";
  if (c.talk_vs_spend.note) caption += " " + c.talk_vs_spend.note.charAt(0).toUpperCase() + c.talk_vs_spend.note.slice(1) + ".";
  el("tvs-caption").textContent = caption;

  Plotly.newPlot(
    "tvs-chart",
    [
      withClip({ x: spend.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: SPEND_COLOR }, text: spend.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
      withClip({ x: discussion.slice().reverse(), y: topics.slice().reverse(), type: "bar", orientation: "h", marker: { color: ACCENT }, text: discussion.slice().reverse().map((v) => v.toFixed(1) + "%"), textposition: "outside", hoverinfo: "skip" }),
    ],
    {
      barmode: "group", showlegend: false,
      margin: { l: 168, r: 45, t: 10, b: 30 },
      height: chartHeight(topics.length, 40),
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

function renderDistress(c) {
  const d = c.financial_distress;
  showPanel("panel-distress", !!d);
  if (!d) return;

  const box = el("distress-status-box");
  let statusHtml = "";
  if (d.severity === 3) {
    statusHtml = `
      <div class="distress-banner critical">
        <div class="distress-status-header">
          <span class="distress-icon">⚠️</span>
          <strong>CRITICAL FINANCIAL DISTRESS: Section 114 Notice Issued (${d.s114_year || "Active"})</strong>
        </div>
        <p class="distress-desc">${d.s114_details}</p>
        ${d.is_efs ? `<p class="distress-extra"><strong>Government Intervention:</strong> ${d.efs_details}</p>` : ""}
      </div>`;
  } else if (d.severity === 2) {
    statusHtml = `
      <div class="distress-banner high">
        <div class="distress-status-header">
          <span class="distress-icon">⚡</span>
          <strong>HIGH FINANCIAL RISK: Exceptional Financial Support (£${d.efs_amount_gbp_m}m)</strong>
        </div>
        <p class="distress-desc">${d.efs_details}</p>
      </div>`;
  } else if (d.severity === 1) {
    statusHtml = `
      <div class="distress-banner warning">
        <div class="distress-status-header">
          <span class="distress-icon">ℹ️</span>
          <strong>ELEVATED AUDIT RISK: Statutory External Warning / Account Delays</strong>
        </div>
        <p class="distress-desc">Under statutory external auditor recommendation or commissioner monitoring.</p>
      </div>`;
  } else {
    statusHtml = `
      <div class="distress-banner stable">
        <div class="distress-status-header">
          <span class="distress-icon">✓</span>
          <strong>STABLE FINANCIAL STANDING</strong>
        </div>
        <p class="distress-desc">No active Section 114 spending freeze notices or emergency MHCLG Exceptional Financial Support directions recorded.</p>
      </div>`;
  }
  box.innerHTML = statusHtml;
}

function renderQoL(c) {
  const q = c.qol;
  showPanel("panel-qol", !!q);
  if (!q) return;

  const eng = DATA.qol_england || {};

  // 7 Outcome Indicators
  const items = [
    {
      label: "Life Expectancy",
      val: q.life_expectancy != null ? `${q.life_expectancy} yrs` : "—",
      eng: eng.life_expectancy != null ? `${eng.life_expectancy} yrs` : "81.9 yrs",
      note: "Period life expectancy at birth across sexes (ONS 2025).",
      higherGood: true,
      valNum: q.life_expectancy,
      engNum: eng.life_expectancy || 81.9,
    },
    {
      label: "GCSE Attainment 8",
      val: q.attainment8 != null ? `${q.attainment8} pts` : "—",
      eng: eng.attainment8 != null ? `${eng.attainment8} pts` : "46.1 pts",
      note: "Average GCSE Attainment 8 score per pupil across 8 subjects (DfE 2023/24).",
      higherGood: true,
      valNum: q.attainment8,
      engNum: eng.attainment8 || 46.1,
    },
    {
      label: "Rent Affordability",
      val: q.rent_affordability != null ? `${q.rent_affordability}%` : "—",
      eng: eng.rent_affordability != null ? `${eng.rent_affordability}%` : "31.0%",
      note: "Median private rent as a % of median gross full-time earnings (ONS PIPR/ASHE).",
      higherGood: false,
      valNum: q.rent_affordability,
      engNum: eng.rent_affordability || 31.0,
    },
    {
      label: "Air Quality (PM2.5)",
      val: q.air_quality_pm25_pct != null ? `${q.air_quality_pm25_pct}%` : "—",
      eng: eng.air_quality_pm25_pct != null ? `${eng.air_quality_pm25_pct}%` : "5.3%",
      note: "Estimated % of adult all-cause mortality attributable to human-made fine particulate air pollution PM2.5 (Defra/OHID).",
      higherGood: false,
      valNum: q.air_quality_pm25_pct,
      engNum: eng.air_quality_pm25_pct || 5.3,
    },
    {
      label: "Child Poverty",
      val: q.child_poverty_pct != null ? `${q.child_poverty_pct}%` : "—",
      eng: eng.child_poverty_pct != null ? `${eng.child_poverty_pct}%` : "19.8%",
      note: "Share of children aged under 16 living in families in relative low income (DWP).",
      higherGood: false,
      valNum: q.child_poverty_pct,
      engNum: eng.child_poverty_pct || 19.8,
    },
    {
      label: "Claimant Rate",
      val: q.claimant_rate_pct != null ? `${q.claimant_rate_pct}%` : "—",
      eng: eng.claimant_rate_pct != null ? `${eng.claimant_rate_pct}%` : "4.0%",
      note: "Universal Credit / JSA claimants as a % of resident population aged 16-64 (Nomis July 2026).",
      higherGood: false,
      valNum: q.claimant_rate_pct,
      engNum: eng.claimant_rate_pct || 4.0,
    },
    {
      label: "Crime Rate",
      val: q.crime_per_1000 != null ? `${q.crime_per_1000}` : "—",
      eng: eng.crime_per_1000 != null ? `${eng.crime_per_1000}` : "89.5",
      note: "Total recorded offences (excluding fraud) per 1,000 residents (ONS CSP 2024).",
      higherGood: false,
      valNum: q.crime_per_1000,
      engNum: eng.crime_per_1000 || 89.5,
    },
  ];

  const cardsHtml = items.map((item) => {
    let diffBadge = "";
    if (item.valNum != null && item.engNum != null) {
      const diff = item.valNum - item.engNum;
      const isBetter = item.higherGood ? diff > 0 : diff < 0;
      const sign = diff > 0 ? "+" : "";
      const cls = Math.abs(diff) < 0.2 ? "neutral" : isBetter ? "better" : "worse";
      diffBadge = `<span class="qol-tag ${cls}">${sign}${diff.toFixed(1)} vs England</span>`;
    }
    return `
      <div class="qol-card">
        <div class="qol-header">
          <span class="qol-label">${item.label}</span>
          ${diffBadge}
        </div>
        <div class="qol-value">${item.val}</div>
        <div class="qol-benchmark">England: <strong>${item.eng}</strong></div>
        <div class="qol-sub">${item.note}</div>
      </div>`;
  }).join("");

  el("qol-grid").innerHTML = cardsHtml;
}

function renderReadingLinks(c) {
  const hasData = c.reading_links && c.reading_links.length;
  showPanel("panel-links", !!hasData);
  if (!hasData) return;
  el("reading-links").innerHTML = c.reading_links
    .map((l) => `<li><a href="${l.url}" target="_blank" rel="noopener">${l.title}</a><span class="source-tag">${l.source}</span></li>`)
    .join("");
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
function renderNational() {
  renderDistressWatchlist();
  renderPartyChart("party-chart", "party-key", DATA.party_groups_spend, "spend_share");
  renderPartyChart("party-discussion-chart", "party-discussion-key", DATA.party_groups_discussion, "discussion_share");
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

  const topics = DATA.topics.filter((t) => groups.some((g) => (g[shareKey] || {})[t] != null));
  const labels = groups.map((g) => `${g.party} (n=${g.n})`);

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
      text: vals.map((v) => (v >= 6 ? v.toFixed(0) + "%" : "")),
      textposition: "inside",
      insidetextanchor: "middle",
      textfont: { color: "#fff", size: 12 },
      hoverinfo: "skip",
    };
  });

  Plotly.newPlot(
    chartId, traces,
    {
      barmode: "stack", showlegend: false,
      margin: { l: 210, r: 20, t: 10, b: 30 },
      height: chartHeight(groups.length, 64),
      font: { size: 13 },
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

function sortedLeagueRows(lt) {
  const { col, asc } = leagueSort;
  let rows = lt.rows.slice();

  if (leagueSearchQuery) {
    rows = rows.filter((r) => (r.council || "").toLowerCase().includes(leagueSearchQuery));
  }

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
  ];

  const allSorted = sortedLeagueRows(lt);
  const rows = leagueTopN === "all" ? allSorted : allSorted.slice(0, leagueTopN);

  const rowsHtml = rows
    .map((r, i) => {
      const cells = cols.map((col) => {
        const val = r[col.key];
        if (col.key === "council") {
          return `<td><a href="?council=${encodeURIComponent(val)}" class="council-link">${val}</a></td>`;
        }
        if (col.key === "control") {
          return `<td>${val ?? "—"}</td>`;
        }
        if (val == null) return `<td>—</td>`;
        return `<td>${val}${col.unit}</td>`;
      });
      return `<tr><td class="rank-cell">${i + 1}</td>${cells.join("")}</tr>`;
    })
    .join("");

  const headHtml =
    `<th class="rank-cell">#</th>` +
    cols
      .map((col) => {
        const active = leagueSort.col === col.key;
        const arrow = active ? (leagueSort.asc ? " ▲" : " ▼") : "";
        return `<th data-col="${col.key}" class="sortable${active ? " sorted" : ""}">${col.label}${arrow}</th>`;
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
      .then((res) => res.json())
      .then((data) => {
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

// -------------------------------------------------------------- init ---
window.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initFeedbackForm();
  fetch("data.json?v=20260824h")
    .then((r) => r.json())
    .then((data) => {
      DATA = data;
      initCouncilSelect();
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
