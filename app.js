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
  const select = el("council-select");
  const names = Object.keys(DATA.councils).sort();
  select.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join("");
  select.addEventListener("change", () => renderCouncil(select.value));
  renderCouncil(names[0]);
}

function renderCouncil(name) {
  const c = DATA.councils[name];

  renderControlLine(c);
  renderElectionBanner(c);
  renderPopulation(c);
  renderAgeChart(c);
  renderTopicsChart(c, name);
  renderMoneyChart(c);
  renderTalkVsSpend(c);
  renderScorecard(c);
  renderReadingLinks(c);
  renderTaxonomyTable();
}

function renderControlLine(c) {
  const line = el("control-line");
  if (!c.control) { line.innerHTML = `Controlled by <strong>${c.party_full}</strong>`; return; }
  const { current, since, previous, changed } = c.control;
  line.innerHTML = changed
    ? `<strong>${current}</strong> · since ${since} · previously ${previous}`
    : `<strong>${current}</strong> · since ${since}`;
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
  const n = Object.keys(DATA.councils).length;

  el("topics-key").innerHTML = swatch(ACCENT, name) + " &nbsp; " + swatch(GREY, `${n}-council average`);

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
  el("money-lede").textContent = "What your council puts into each service — £ per resident (staff + running costs).";
  const services = c.money.map((m) => m.service);
  const labels = services.map(shortService);
  const values = c.money.map((m) => m.gbp_per_resident);
  const medians = services.map((s) => (DATA.money_median_per_resident || {})[s]);
  const n = DATA.money_median_n;
  const hasMedian = medians.some((v) => v != null);

  el("money-key").innerHTML = hasMedian
    ? swatch(ACCENT, "This council") + " &nbsp; " + swatch(GREY, `${n}-council median`)
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
  el("money-lede").textContent = "Share of matched-topic spend, this council vs the England average.";
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

function renderScorecard(c) {
  const hasData = c.scorecard && c.scorecard.length;
  showPanel("panel-scorecard", !!hasData);
  if (!hasData) return;
  el("scorecard-heat").innerHTML = c.scorecard
    .map((m) => {
      const bg = rankColor(m.rank, m.n);
      const fg = textOnColor(bg);
      const proxyTxt = m.proxy ? " *county-wide figure" : "";
      const rankTxt = m.rank != null ? `rank ${m.rank} / ${m.n}` : "";
      return `<div class="heat-cell" style="background:${bg};color:${fg}">
        <div class="heat-label">${m.label}${proxyTxt}</div>
        <div class="heat-value">${m.value}</div>
        <div class="heat-sub">${rankTxt}${m.england_value != null ? " · England " + m.england_value : ""}</div>
      </div>`;
    })
    .join("");
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
  renderPartyChart("party-chart", "party-key", DATA.party_groups_spend, "spend_share");
  renderPartyChart("party-discussion-chart", "party-discussion-key", DATA.party_groups_discussion, "discussion_share");
  renderLeagueTable();
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

function renderLeagueTable() {
  const lt = DATA.league_table;
  const hasData = lt && lt.metrics && lt.metrics.length;
  if (!hasData) {
    el("league-table-wrap").innerHTML = `<p class="empty-note">Scorecard data not available yet.</p>`;
    el("league-caption").textContent = "";
    return;
  }
  const hasTraffic = lt.metrics.includes("aroad_delay");
  if (!leagueSort) {
    leagueSort = { col: hasTraffic ? "aroad_delay" : "council", asc: true };
  }
  el("league-caption").textContent = hasTraffic
    ? "Sorted best-first on the traffic column by default. Lower is better throughout except Attainment 8 (higher is better)."
    : "Lower is better throughout except Attainment 8 (higher is better). Click a column to sort.";
  drawLeagueTable(lt);
}

function sortedLeagueRows(lt) {
  const { col, asc } = leagueSort;
  const rows = lt.rows.slice();
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
    { key: "council", label: "Council" },
    { key: "party", label: "Party" },
    ...lt.metrics.map((m) => ({ key: m, label: lt.metric_labels[m] || m })),
  ];
  const rows = sortedLeagueRows(lt);
  const rowsHtml = rows
    .map((r, i) => {
      const cells = cols.map((col) => {
        if (col.key === "council" || col.key === "party") return r[col.key] ?? "—";
        const v = r[col.key];
        return v == null ? "—" : v;
      });
      return `<tr><td class="rank-cell">${i + 1}</td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
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
  el("league-table-wrap").innerHTML = `<div style="overflow-x:auto"><table class="league">
    <thead><tr>${headHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>`;

  document.querySelectorAll("table.league th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (leagueSort.col === col) leagueSort.asc = !leagueSort.asc;
      else leagueSort = { col, asc: true };
      drawLeagueTable(lt);
    });
  });
}

// -------------------------------------------------------------- init ---
window.addEventListener("DOMContentLoaded", () => {
  initTabs();
  fetch("data.json")
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
