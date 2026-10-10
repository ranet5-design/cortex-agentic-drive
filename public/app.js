// Cortex front end — vanilla JS. Talks to the agent API; never touches files directly.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ui = {
  data: null,
  hash: "",
  view: "files",
  folder: null,
  selected: new Set(),
  fresh: new Set(),
  knownFiles: null,
  knownFolders: null,
  pending: [],
};

const TYPES = {
  "meeting-notes": ["MTG", "#0ea5e9", "Meeting notes"],
  invoice: ["INV", "#f59e0b", "Invoice"],
  spreadsheet: ["CSV", "#10b981", "Spreadsheet"],
  contract: ["LGL", "#8b5cf6", "Contract"],
  plan: ["PLN", "#6366f1", "Plan"],
  report: ["RPT", "#14b8a6", "Report"],
  research: ["RSC", "#ec4899", "Research"],
  synthesized: ["AI", "linear-gradient(135deg,#6366f1,#ec4899)", "Generated document"],
  ledger: ["LOG", "#059669", "Auto-maintained ledger"],
  other: ["DOC", "#64748b", "Document"],
};
const AGENTS = {
  Router: "--a-router", Librarian: "--a-librarian", Organizer: "--a-organizer", Automator: "--a-automator", Sentinel: "--a-sentinel",
  Retriever: "--a-retriever", Analyst: "--a-analyst", Writer: "--a-writer", Briefer: "--a-briefer",
};
const FOLDER_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];
const folderColor = (name) => FOLDER_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % FOLDER_COLORS.length];
const INSIGHT_ICONS = { conflict: "⚠", stale: "↻", deadline: "⏰", connection: "🔗", duplicate: "⧉", gap: "◌" };

const CHIPS = [
  ["Ask", "What is the current paid social budget?"],
  ["Ask", "When is the Aurora launch now?"],
  ["Write", "Draft a launch requirements doc from the Aurora meetings"],
  ["Automate", "When a contract is uploaded, extract the landlord, monthly rent, start date and renewal terms into Contracts.csv"],
  ["Ask", "How much have we spent on invoices?"],
  ["Brief", "Brief me on my drive"],
];

// ------------------------------------------------------------------ API

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

async function refresh(force = false) {
  try {
    const data = await api("/api/state");
    const h = JSON.stringify(data);
    if (!force && h === ui.hash) return;
    ui.hash = h;
    // Track newly appeared files/folders so they can animate in.
    if (ui.knownFiles) for (const f of data.files) if (!ui.knownFiles.has(f.id)) ui.fresh.add(f.id);
    ui.knownFiles = new Set(data.files.map((f) => f.id));
    const newFolders = ui.knownFolders ? data.folders.filter((f) => !ui.knownFolders.has(f.id)).map((f) => f.id) : [];
    ui.knownFolders = new Set(data.folders.map((f) => f.id));
    ui.data = data;
    render(newFolders);
    setTimeout(() => ui.fresh.clear(), 2000);
  } catch (err) {
    console.warn(err);
  }
}

// ------------------------------------------------------------------ helpers

const fileById = (id) => ui.data?.files.find((f) => f.id === id);
const folderById = (id) => ui.data?.folders.find((f) => f.id === id);
const fmtDate = (iso) => (iso ? new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(iso);
};

function typeBadge(docType) {
  const [label, color] = TYPES[docType] || TYPES.other;
  return `<span class="ftype" style="background:${color}">${label}</span>`;
}

function fileLink(id) {
  const f = fileById(id);
  return f ? `<button class="file-link" data-open="${f.id}" title="${esc(f.title)}">${esc(f.title)}</button>` : "";
}

function agentChip(name) {
  return `<span class="agent" style="background:var(${AGENTS[name] || "--a-briefer"})">${esc(name)}</span>`;
}

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3500);
}

/** Small, safe Markdown renderer (headings, lists, tables, quotes, emphasis, code). */
function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:)!?]|$)/g, "$1<em>$2</em>");
  const lines = String(src).replace(/\r/g, "").split("\n");
  let out = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out += `<table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      out += ordered ? "<ol>" : "<ul>";
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>`;
      out += ordered ? "</ol>" : "</ul>";
      continue;
    }
    if (/^>\s?/.test(line)) {
      let q = "";
      while (i < lines.length && /^>\s?/.test(lines[i])) q += lines[i++].replace(/^>\s?/, "") + " ";
      out += `<blockquote>${inline(q.trim())}</blockquote>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out += "<hr>"; i++; continue; }
    if (!line.trim()) { i++; continue; }
    let p = "";
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*•]|\d+\.)\s|>|\s*\|)/.test(lines[i])) p += lines[i++] + " ";
    out += `<p>${inline(p.trim())}</p>`;
  }
  return out;
}

function csvTable(text, max = 60) {
  const rows = text.trim().split(/\r?\n/).map((line) => {
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
  if (!rows.length) return "";
  return `<table class="csv"><thead><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
    rows.slice(1, max).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
}

function traceHTML(steps, animate = true) {
  if (!steps?.length) return "";
  return `<div class="trace">${steps.map((s, i) => `
    <div class="step" style="animation-delay:${animate ? i * 0.12 : 0}s">
      <div>${agentChip(s.agent)}<div class="step-ms">${(s.ms / 1000).toFixed(2)}s</div></div>
      <div><div class="step-action">${esc(s.action)}</div>${s.detail ? `<div class="step-detail">${esc(s.detail)}</div>` : ""}</div>
    </div>`).join("")}</div>`;
}

function thinkingHTML(label) {
  return `<div class="thinking"><span class="agents-pulse">
    <span style="background:var(--a-router)"></span><span style="background:var(--a-retriever)"></span><span style="background:var(--a-analyst)"></span><span style="background:var(--a-writer)"></span>
  </span>${esc(label)}</div>`;
}

// ------------------------------------------------------------------ render

function render(newFolders = []) {
  const d = ui.data;
  if (!d) return;
  const mode = $("#mode");
  mode.className = `mode-pill ${d.mode}`;
  mode.textContent = d.mode === "claude" ? `● Agents on ${d.model}` : "● Offline agents (no API key)";
  $("#busy").hidden = !d.busy;
  $("#busyLabel").textContent = d.busy || "";
  $("#countFiles").textContent = d.files.length || "";
  $("#countInsights").textContent = d.insights.length || "";
  $("#countWf").textContent = d.workflows.length || "";
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === ui.view && !(ui.view === "files" && ui.folder)));

  $("#folders").innerHTML = d.folders.map((f) => `
    <button class="folder ${ui.folder === f.id ? "active" : ""} ${newFolders.includes(f.id) ? "new" : ""}" data-folder="${f.id}" title="${esc(f.description || "")}">
      <span class="dot" style="background:${folderColor(f.name)}"></span><span class="fname">${esc(f.name)}</span><span class="count">${f.count}</span>
    </button>`).join("") || `<p class="sidebar-note">No folders yet — upload something.</p>`;

  const views = { files: renderFiles, insights: renderInsights, automations: renderAutomations, activity: renderActivity };
  $("#view").innerHTML = views[ui.view]();
  renderSelection();
}

function insightHTML(i, compact = false) {
  const entries = i.entries?.length ? (() => {
    const newest = [...i.entries].filter((e) => e.date).sort((a, b) => b.date.localeCompare(a.date))[0];
    return `<table class="entries">${i.entries.map((e) => `<tr class="${newest && e === newest ? "newest" : ""}">
      <td class="val">${esc(e.value)}</td><td>${fileLink(e.fileId)}</td><td>${e.date ? esc(fmtDate(e.date)) : "undated"}${newest && e === newest ? " · newest" : ""}</td></tr>`).join("")}</table>`;
  })() : "";
  return `<div class="insight ${i.type}">
    <div class="i-icon">${INSIGHT_ICONS[i.type] || "✦"}</div>
    <div class="i-body">
      <div class="i-title">${esc(i.title)}</div>
      ${entries && !compact ? entries : `<div class="i-detail">${esc(i.detail)}</div>`}
      ${!entries || compact ? `<div class="i-files">${i.fileIds.map(fileLink).join("")}</div>` : ""}
    </div>
    <div class="i-actions">
      ${i.action?.kind === "refresh" ? `<button class="primary-btn" data-refresh="${i.action.fileId}" data-add="${(i.action.addSources || []).join(",")}">↻ Refresh doc</button>` : ""}
      <button class="icon-btn" data-dismiss="${i.id}" title="Dismiss">✕</button>
    </div>
  </div>`;
}

function cardHTML(f) {
  const conflicted = ui.data.insights.some((i) => i.type === "conflict" && i.fileIds.includes(f.id));
  const stale = ui.data.insights.some((i) => i.type === "stale" && i.action?.fileId === f.id);
  const folder = folderById(f.folderId);
  return `<article class="card ${ui.selected.has(f.id) ? "selected" : ""} ${ui.fresh.has(f.id) ? "fresh" : ""}" data-card="${f.id}">
    <div class="select-box" data-select="${f.id}" title="Select for synthesis">${ui.selected.has(f.id) ? "✓" : ""}</div>
    <div class="card-top">${typeBadge(f.docType)}<div class="card-title">${esc(f.title)}</div></div>
    <div class="card-summary">${esc(f.summary || f.preview)}</div>
    <div class="card-foot">
      ${conflicted ? `<span class="pill warn">⚠ conflict</span>` : ""}
      ${stale ? `<span class="pill stale">↻ stale</span>` : ""}
      ${f.origin === "synthesized" ? `<span class="pill living">living doc v${f.version || 1}</span>` : ""}
      ${f.origin === "workflow" ? `<span class="pill auto">⚡ auto-maintained</span>` : ""}
      ${(f.tags || []).slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
    </div>
    <div class="card-foot"><span style="color:${folder ? folderColor(folder.name) : "inherit"}">●</span> ${esc(folder?.name || "—")} · ${esc(fmtDate(f.docDate || f.updatedAt))}</div>
  </article>`;
}

function renderFiles() {
  const d = ui.data;
  const folder = ui.folder && folderById(ui.folder);
  const files = folder ? d.files.filter((f) => f.folderId === folder.id) : d.files;
  const insights = d.insights.filter((i) => !folder || i.fileIds.some((id) => fileById(id)?.folderId === folder.id)).slice(0, 2);
  const pending = ui.pending.map((p) => `<article class="card processing-card"><div class="card-top"><span class="ftype" style="background:var(--faint)">…</span><div class="card-title">${esc(p)}</div></div>
    <div class="shimmer"></div><div class="shimmer" style="width:70%"></div><div class="card-foot">Librarian is reading…</div></article>`).join("");
  return `
    <div class="view-head">
      <div><h2>${esc(folder ? folder.name : "All files")}</h2><div class="sub">${esc(folder ? folder.description || "" : "Everything in your drive — organized, tagged and cross-checked by agents.")}</div></div>
      <div class="sub">${files.length} file${files.length === 1 ? "" : "s"} · click the corner box to multi-select</div>
    </div>
    ${insights.length ? `<div class="alert-strip">${insights.map((i) => insightHTML(i, true)).join("")}${d.insights.length > insights.length ? `<button class="tiny-btn" data-view-link="insights">See all ${d.insights.length} insights →</button>` : ""}</div>` : ""}
    ${files.length || pending ? `<div class="grid ${ui.selected.size ? "selecting" : ""}">${pending}${files.map(cardHTML).join("")}</div>`
      : `<div class="empty">${d.busy ? thinkingHTML(d.busy) : "Nothing here yet. Drop files anywhere to get started."}</div>`}`;
}

function renderInsights() {
  const list = ui.data.insights;
  return `<div class="view-head"><div><h2>Insights</h2><div class="sub">The Sentinel cross-checks every new file against the rest of your drive.</div></div></div>
    ${list.length ? `<div class="alert-strip">${list.map((i) => insightHTML(i)).join("")}</div>` : `<div class="empty">No open insights — your drive is consistent. ✓</div>`}`;
}

function renderAutomations() {
  const wfs = ui.data.workflows;
  return `<div class="view-head"><div><h2>Automations</h2><div class="sub">Trigger-based agents that act on files the moment they arrive.</div></div></div>
    <form class="new-wf" id="wfForm">
      <textarea id="wfText" placeholder="Describe a rule in plain English, e.g. “When a contract is uploaded, extract the landlord, monthly rent and renewal date into Contracts.csv”"></textarea>
      <div class="row"><span>The Automator turns this into a workflow and backfills existing files.</span><button class="primary-btn" type="submit">⚡ Create automation</button></div>
    </form>
    ${wfs.map((w) => {
      const out = ui.data.files.find((f) => f.origin === "workflow" && f.name === w.outputFile);
      return `<div class="wf">
        <div><div class="wf-name">${esc(w.name)}</div><div class="wf-desc">${esc(w.description || w.instruction)}</div></div>
        <div style="text-align:right"><button class="toggle ${w.enabled ? "on" : ""}" data-toggle="${w.id}" aria-label="Enable workflow"></button>
          <div class="wf-desc">${w.runs} run${w.runs === 1 ? "" : "s"}${w.lastRun ? ` · ${ago(w.lastRun)}` : ""}</div></div>
        <div class="wf-flow">
          <span class="wf-step">When a <b>${esc((TYPES[w.trigger.docType] || TYPES.other)[2].toLowerCase())}</b> arrives</span><span class="wf-arrow">→</span>
          <span class="wf-step">${agentChip("Automator")} extracts ${w.columns.map(esc).join(", ")}</span><span class="wf-arrow">→</span>
          <span class="wf-step">appends to ${out ? fileLink(out.id) : `<b>${esc(w.outputFile)}</b>`}</span>
        </div>
      </div>`;
    }).join("")}`;
}

function renderActivity() {
  const acts = ui.data.activity;
  return `<div class="view-head"><div><h2>Agent activity</h2><div class="sub">Every action the agents took, step by step.</div></div></div>
    ${acts.length ? `<div class="timeline">${acts.map((a) => `<details class="act"><summary class="act-head"><span class="act-title">${esc(a.title)}</span><span class="act-time">${ago(a.at)}</span></summary>
      <div style="margin-top:8px">${traceHTML(a.steps, false) || '<span class="sub">No steps recorded.</span>'}</div></details>`).join("")}</div>` : `<div class="empty">No activity yet.</div>`}`;
}

function renderSelection() {
  const n = ui.selected.size;
  $("#selectionBar").hidden = n === 0;
  $("#selCount").textContent = `${n} selected`;
}

// ------------------------------------------------------------------ panel

function openPanel(title, html) {
  $("#panel").hidden = false;
  $("#panelTitle").textContent = title;
  $("#panelBody").innerHTML = html;
  $("#panelBody").scrollTop = 0;
}

async function openFile(id) {
  openPanel("File", thinkingHTML("Opening…"));
  let f;
  try { f = await api(`/api/file?id=${encodeURIComponent(id)}`); } catch (err) { openPanel("File", `<div class="empty">${esc(err.message)}</div>`); return; }
  const folder = folderById(f.folderId);
  const insights = ui.data.insights.filter((i) => i.fileIds.includes(f.id));
  const content = f.ext === "csv" ? csvTable(f.text) : ["md", "markdown"].includes(f.ext) ? `<div class="md">${md(f.text)}</div>` : `<pre class="raw">${esc(f.text)}</pre>`;
  openPanel(TYPES[f.docType]?.[2] || "File", `
    <div style="display:flex;gap:12px;align-items:flex-start">${typeBadge(f.docType)}<h1 class="doc-title">${esc(f.title)}</h1></div>
    <div class="meta-row">
      ${folder ? `<span style="color:${folderColor(folder.name)}">●</span> ${esc(folder.name)} ·` : ""}
      ${f.docDate ? `${esc(fmtDate(f.docDate))} ·` : ""} ${(f.words || 0).toLocaleString()} words ·
      ${f.origin === "synthesized" ? `<span class="pill living">living doc v${f.version || 1}</span>` : f.origin === "workflow" ? `<span class="pill auto">⚡ maintained by an automation</span>` : `uploaded ${esc(ago(f.uploadedAt))}`}
    </div>
    <div class="block"><h3>Summary</h3><div>${esc(f.summary)}</div></div>
    ${insights.length ? `<div class="block"><h3>Insights</h3><div class="alert-strip">${insights.map((i) => insightHTML(i, true)).join("")}</div></div>` : ""}
    ${f.keyFacts?.length ? `<div class="block"><h3>Key facts</h3><table class="facts">${f.keyFacts.slice(0, 10).map((k) => `<tr title="${esc(k.context)}"><td>${esc(k.label)}</td><td>${esc(k.value)}</td></tr>`).join("")}</table></div>` : ""}
    ${f.sources?.length ? `<div class="block"><h3>Synthesized from</h3><div class="chiprow">${f.sources.map(fileLink).join("")}</div>
      <div class="btn-row" style="margin-top:10px"><button class="ghost-btn" data-refresh="${f.id}" data-add="">↻ Regenerate from sources</button></div></div>` : ""}
    ${f.related?.length && !f.sources?.length ? `<div class="block"><h3>Related files</h3><div class="chiprow">${f.related.map(fileLink).join("")}</div></div>` : ""}
    ${(f.people?.length || f.organizations?.length) ? `<div class="block"><h3>People & organizations</h3><div class="chiprow">${[...(f.people || []), ...(f.organizations || [])].map((p) => `<span class="tag">${esc(p)}</span>`).join("")}</div></div>` : ""}
    ${f.tags?.length ? `<div class="block"><h3>Tags</h3><div class="chiprow">${f.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div></div>` : ""}
    <div class="block btn-row">
      <button class="ghost-btn" data-ask-file="${f.id}">✦ Ask about this file</button>
      <button class="ghost-btn" data-select-file="${f.id}">☐ Select for synthesis</button>
      <button class="ghost-btn" data-delete="${f.id}" style="color:var(--danger)">Delete</button>
    </div>
    <div class="block"><h3>Content</h3>${content}</div>
    ${f.trace?.length ? `<div class="block"><details><summary>How the agents processed this file (${f.trace.length} steps)</summary><div style="margin-top:8px">${traceHTML(f.trace, false)}</div></details></div>` : ""}
  `);
}

function resultHTML(question, r) {
  let body = "";
  if (r.answer !== undefined) {
    const html = md(r.answer).replace(/\[(\d+)\]/g, (_, n) => (r.citations?.some((c) => c.n === Number(n)) ? `<button class="cite" data-cite="${n}">${n}</button>` : ""));
    body += `<div class="answer md">${html}</div>`;
    if (r.citations?.length) {
      body += `<div class="block"><h3>Sources</h3><div class="sources">${r.citations.map((c) => `
        <div class="source" data-open="${c.fileId}" id="src-${c.n}"><div class="s-head"><span class="cite">${c.n}</span>${esc(c.title)}${c.date ? ` <span class="sub" style="font-weight:400;color:var(--faint)">· ${esc(fmtDate(c.date))}</span>` : ""}</div>
        <div class="s-text">${esc(c.text)}</div></div>`).join("")}</div></div>`;
    }
  }
  if (r.file) {
    const f = r.file;
    body += `<div class="block"><h3>${f.origin === "synthesized" ? "New document" : "File"}</h3>${cardHTML({ ...f, tags: f.tags || [] })}</div>`;
  }
  if (r.workflow) {
    body += `<div class="block"><h3>New automation</h3><div class="wf"><div><div class="wf-name">${esc(r.workflow.name)}</div>
      <div class="wf-desc">When a ${esc(r.workflow.trigger.docType)} arrives → extract ${r.workflow.columns.map(esc).join(", ")} → ${esc(r.workflow.outputFile)}</div></div></div></div>`;
  }
  return `${question ? `<p class="question">${esc(question)}</p>` : ""}${body}
    <div class="block"><h3>Agent trace</h3>${traceHTML(r.steps)}</div>`;
}

async function run(label, question, promise) {
  openPanel(label, `${question ? `<p class="question">${esc(question)}</p>` : ""}${thinkingHTML("Agents are working…")}`);
  try {
    const r = await promise;
    openPanel(label, resultHTML(question, r));
    refresh(true);
    return r;
  } catch (err) {
    openPanel(label, `${question ? `<p class="question">${esc(question)}</p>` : ""}<div class="insight"><div class="i-icon">⚠</div><div class="i-body"><div class="i-title">Something went wrong</div><div class="i-detail">${esc(err.message)}</div></div></div>`);
    toast(err.message, "error");
  }
}

// ------------------------------------------------------------------ actions

const LABELS = { ask: "Answer", synthesize: "New document", automate: "Automation", brief: "Briefing", reorganize: "Reorganized" };

async function runCommand(text) {
  if (!text.trim()) return;
  $("#commandInput").value = "";
  const selected = [...ui.selected];
  const r = await run("Working", text, api("/api/command", { text, selected }));
  if (r) {
    $("#panelTitle").textContent = LABELS[r.intent] || "Result";
    if (r.intent === "synthesize") { ui.selected.clear(); toast(`Writer created “${r.file.title}”`); }
    if (r.intent === "automate") toast(`New automation: ${r.workflow.name}`);
  }
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  ui.view = "files";
  ui.pending.push(...files.map((f) => f.name));
  render();
  openPanel("Processing upload", thinkingHTML(`Librarian is reading ${files.length} file${files.length > 1 ? "s" : ""}…`));
  let last = null;
  for (const file of files) {
    try {
      const data = await readAsBase64(file);
      last = await api("/api/upload", { name: file.name, data });
      const folder = folderById(last.file.folderId) || null;
      toast(`Filed “${last.file.title}”${folder ? ` into ${folder.name}` : ""}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, "error");
    }
    ui.pending.splice(ui.pending.indexOf(file.name), 1);
    await refresh(true);
  }
  if (last) openPanel("Processed", resultHTML("", last));
  else $("#panel").hidden = true;
}

// ------------------------------------------------------------------ events

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-select],[data-open],[data-card],[data-folder],[data-view],[data-view-link],[data-dismiss],[data-refresh],[data-toggle],[data-cite],[data-ask-file],[data-select-file],[data-delete],.chip");
  if (!t) return;
  const ds = t.dataset;
  if (ds.select) {
    e.stopPropagation();
    ui.selected.has(ds.select) ? ui.selected.delete(ds.select) : ui.selected.add(ds.select);
    render();
  } else if (ds.open) openFile(ds.open);
  else if (ds.card) {
    if (ui.selected.size) { ui.selected.has(ds.card) ? ui.selected.delete(ds.card) : ui.selected.add(ds.card); render(); }
    else openFile(ds.card);
  } else if (ds.folder) { ui.view = "files"; ui.folder = ui.folder === ds.folder ? null : ds.folder; render(); }
  else if (ds.view || ds.viewLink) { ui.view = ds.view || ds.viewLink; ui.folder = null; render(); }
  else if (ds.dismiss) { await api("/api/insights/dismiss", { id: ds.dismiss }); refresh(true); }
  else if (ds.refresh) {
    const add = ds.add ? ds.add.split(",").filter(Boolean) : [];
    const r = await run("Refreshing document", "", api("/api/refresh", { fileId: ds.refresh, addSources: add }));
    if (r) toast(`Updated “${r.file.title}” to v${r.file.version}`);
  } else if (ds.toggle) { await api("/api/workflows/toggle", { id: ds.toggle }); refresh(true); }
  else if (ds.cite) {
    const el = document.getElementById(`src-${ds.cite}`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); }
  } else if (ds.askFile) {
    ui.selected = new Set([ds.askFile]);
    render();
    $("#commandInput").focus();
    $("#commandInput").placeholder = "Ask a question about the selected file…";
  } else if (ds.selectFile) { ui.selected.add(ds.selectFile); render(); toast("Selected — pick more files, then Synthesize."); }
  else if (ds.delete) {
    if (!confirm("Delete this file from the drive?")) return;
    await api("/api/delete", { id: ds.delete });
    $("#panel").hidden = true;
    ui.selected.delete(ds.delete);
    refresh(true);
  } else if (t.classList.contains("chip")) runCommand(t.dataset.text);
});

$("#commandForm").addEventListener("submit", (e) => { e.preventDefault(); runCommand($("#commandInput").value); });
$("#panelClose").addEventListener("click", () => { $("#panel").hidden = true; });
$("#fileInput").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
$("#reorgBtn").addEventListener("click", () => run("Reorganized", "Rebuild my folder structure", api("/api/reorganize", {})));
$("#selClear").addEventListener("click", () => { ui.selected.clear(); $("#commandInput").placeholder = "Ask anything, draft a document, or describe an automation…"; render(); });
$("#selSynth").addEventListener("click", async () => {
  const instruction = $("#selInstruction").value.trim() || "Combine these files into one clear, well-structured summary document.";
  const ids = [...ui.selected];
  const r = await run("New document", instruction, api("/api/synthesize", { fileIds: ids, instruction }));
  if (r) { ui.selected.clear(); $("#selInstruction").value = ""; toast(`Writer created “${r.file.title}”`); refresh(true); }
});
$("#selAsk").addEventListener("click", () => { $("#commandInput").focus(); $("#commandInput").placeholder = "Ask a question about the selected files…"; });
$("#resetBtn").addEventListener("click", async () => {
  if (!confirm("Wipe the drive and reload the demo files?")) return;
  ui.selected.clear(); ui.folder = null; ui.knownFiles = null;
  $("#panel").hidden = true;
  toast("Resetting the demo drive…");
  api("/api/reset", {}).then(() => refresh(true)).catch((err) => toast(err.message, "error"));
  setTimeout(() => refresh(true), 400);
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "wfForm") return;
  e.preventDefault();
  const text = $("#wfText").value.trim();
  if (!text) return;
  const r = await run("Automation", text, api("/api/workflows", { text }));
  if (r) toast(`New automation: ${r.workflow.name}`);
});

// Theme
const savedTheme = (() => { try { return localStorage.getItem("cortex-theme"); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("#themeBtn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("cortex-theme", document.documentElement.dataset.theme); } catch {}
});

// Drag & drop anywhere
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("#dropzone").hidden = false; } });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dropzone").hidden = true; });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#dropzone").hidden = true; if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });

// Boot
$("#chips").innerHTML = CHIPS.map(([k, text]) => `<button class="chip" data-text="${esc(text)}"><b>${k}</b>${esc(text.length > 62 ? text.slice(0, 60) + "…" : text)}</button>`).join("");
refresh(true);
setInterval(refresh, 2500);
