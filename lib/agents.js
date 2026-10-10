/**
 * The agent layer. Users never touch the file system directly — every request
 * goes through these agents, which read, organize, cross-reference and write
 * files on their behalf.
 *
 *   Router     – decides what a free-form command wants (ask / synthesize / automate / brief / reorganize)
 *   Librarian  – reads each new file: title, summary, type, tags, entities, key facts
 *   Organizer  – files it into a dynamically generated smart folder
 *   Automator  – runs trigger-based workflows (e.g. invoice → expense ledger)
 *   Sentinel   – cross-checks the new file against the drive: conflicts, links, stale docs
 *   Retriever  – hybrid BM25 + query-expansion search over every passage
 *   Analyst    – answers questions with citations
 *   Writer     – synthesizes new documents from several sources ("living documents")
 *   Briefer    – a briefing on the state of the whole drive
 *
 * Each agent has a Claude implementation and an offline heuristic one; if Claude
 * is unavailable or fails, the offline path runs and the trace says so.
 */
import path from "path";
import * as llm from "./llm.js";
import { db, save, uid, storeBytes, logActivity, fileById, folderById } from "./store.js";
import {
  ChunkIndex, tokenize, splitSentences, fileVectors, cosine, centroid, topTerms,
  extractMoneyFacts, parseCSV, toCSVLine, titleCase, formatMoney, parseMoney, normWord, STOP,
} from "./text.js";

export const DOC_TYPES = [
  "meeting-notes", "invoice", "spreadsheet", "contract", "plan", "report", "research", "synthesized", "ledger", "other",
];

const TEXT_EXTS = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "html", "htm", "xml", "yaml", "yml"];
const MAX_DOC_CHARS = 120_000;

// ---------------------------------------------------------------- tracing

class Trace {
  constructor() { this.steps = []; this.t0 = Date.now(); }
  step(agent, action, detail = "") {
    this.steps.push({ agent, action, detail, ms: Date.now() - this.t0 });
  }
}

/** Run the Claude version of an agent step, falling back to the offline one. */
async function think(trace, agent, claudeFn, offlineFn) {
  if (llm.enabled) {
    try {
      return await claudeFn();
    } catch (err) {
      trace.step(agent, "Claude unavailable — switched to offline reasoning", err.message);
    }
  }
  return offlineFn();
}

// ---------------------------------------------------------------- index

const index = new ChunkIndex();
export function reindex() { index.build(db.files); }

let queue = Promise.resolve();
/** Serialize mutations so concurrent uploads don't race on the JSON store. */
export function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const busy = { count: 0, label: "" };

// ---------------------------------------------------------------- helpers

const extOf = (name) => path.extname(name).slice(1).toLowerCase();
const words = (t) => (String(t).match(/\S+/g) || []).length;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function catalog(files = db.files) {
  return files.map((f) => ({
    id: f.id, title: f.title, docType: f.docType, folder: folderById(f.folderId)?.name || "",
    date: f.docDate || f.uploadedAt.slice(0, 10), summary: f.summary,
  }));
}

function docBlock(f, limit = MAX_DOC_CHARS) {
  const text = f.text.length > limit ? f.text.slice(0, limit) + "\n[…document continues; truncated for length…]" : f.text;
  return `<document id="${f.id}" title="${f.title}" type="${f.docType}" date="${f.docDate || ""}">\n${text}\n</document>`;
}

async function extractText(name, buffer) {
  const ext = extOf(name);
  if (ext === "pdf") {
    const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
    const r = await pdf(buffer);
    return { text: r.text.replace(/\n{3,}/g, "\n\n").trim(), pages: r.numpages };
  }
  const raw = buffer.toString("utf8");
  if (TEXT_EXTS.includes(ext)) {
    const text = ext === "html" || ext === "htm" ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : raw;
    return { text: text.trim() };
  }
  const printable = raw.replace(/[^\x09\x0A\x0D\x20-\x7E -￿]/g, "").length / Math.max(1, raw.length);
  if (printable > 0.95) return { text: raw.trim() };
  throw new Error(`Cortex can't read .${ext} files yet (supported: PDF, TXT, MD, CSV, JSON, HTML).`);
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const DATE_RE = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4})\\b`);

function findDate(text) {
  const m = String(text).match(DATE_RE);
  if (!m) return "";
  if (/^\d{4}-/.test(m[1])) return m[1];
  const d = new Date(m[1].replace(/(\d)(st|nd|rd|th)/, "$1"));
  return isNaN(d) ? m[1] : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ================================================================ LIBRARIAN

const understandSchema = llm.obj({
  title: llm.str("A clear, human title for the document"),
  summary: llm.str("2-3 sentence summary focused on decisions, numbers and what matters"),
  docType: llm.enumOf(DOC_TYPES),
  date: llm.str("The document's own date as YYYY-MM-DD, or empty string"),
  folder: llm.obj({
    name: llm.str("Smart-folder name: reuse an existing folder name exactly if it fits, otherwise propose a new short project/topic name"),
    description: llm.str("One line describing what belongs in this folder"),
  }),
  tags: llm.arr(llm.str(), "3-6 short lowercase topical tags"),
  people: llm.arr(llm.str()),
  organizations: llm.arr(llm.str()),
  keyFacts: llm.arr(llm.obj({
    label: llm.str("What the figure/fact is about, e.g. 'Paid social budget' or 'Launch date'"),
    value: llm.str("The value, e.g. '$52,000' or '2026-10-02'"),
    context: llm.str("Short quote or paraphrase where it appears"),
  }), "The important numbers, dates and commitments in the document (max 8)"),
});

async function understand(file, trace) {
  const result = await think(trace, "Librarian",
    async () => {
      const r = await llm.json({
        system:
          "You are the Librarian agent inside Cortex, an agentic cloud drive. You read every file that arrives and produce " +
          "precise metadata so the drive can organize itself, answer questions and detect conflicts. Prefer reusing an existing " +
          "smart folder when the document clearly belongs to the same project or topic; create a new one only when it doesn't fit.",
        prompt:
          `Existing smart folders:\n${JSON.stringify(db.folders.map((f) => ({ name: f.name, description: f.description })), null, 1)}\n\n` +
          `File name: ${file.name}\n\n${docBlock(file)}`,
        schema: understandSchema,
      });
      trace.step("Librarian", `Read with ${llm.MODEL}`, `${file.words.toLocaleString()} words → ${r.docType}`);
      return {
        title: r.title, summary: r.summary, docType: r.docType, docDate: r.date, tags: r.tags,
        people: r.people, organizations: r.organizations, folderHint: r.folder,
        keyFacts: r.keyFacts.map((k) => ({ ...k, labelTokens: tokenize(k.label) })),
      };
    },
    () => {
      const r = understandOffline(file);
      trace.step("Librarian", "Read with offline heuristics", `${file.words.toLocaleString()} words → ${r.docType}`);
      return r;
    });
  Object.assign(file, result);
  trace.step("Librarian", `Titled “${file.title}”`, file.summary);
  if (file.keyFacts.length) trace.step("Librarian", `Extracted ${file.keyFacts.length} key fact${file.keyFacts.length > 1 ? "s" : ""}`, file.keyFacts.slice(0, 3).map((k) => `${k.label}: ${k.value}`).join(" · "));
}

function classifyOffline(file) {
  const t = file.text.slice(0, 4000);
  if (file.ext === "csv" || file.ext === "tsv") return "spreadsheet";
  if (/\binvoice\b/i.test(t) && /(amount due|total due|bill to|invoice (no|number|#))/i.test(t)) return "invoice";
  const head = t.split(/\n/).find((l) => l.trim()) || "";
  if (/\b(plan|roadmap|proposal|strategy)\b/i.test(head)) return "plan";
  if (/\b(attendees|agenda|transcript|meeting minutes)\b/i.test(t)) return "meeting-notes";
  if (/\b(agreement|lease|tenant|landlord|hereinafter|parties)\b/i.test(head + " " + t.slice(0, 600))) return "contract";
  if (/\b(interview|participants?|usability|survey)\b/i.test(t)) return "research";
  if ((t.match(/^[A-Z][a-z]+:\s/gm) || []).length >= 4) return "meeting-notes";
  if (/\b(agreement|lease|tenant|landlord|hereinafter|parties)\b/i.test(t)) return "contract";
  if (/\b(plan|roadmap|timeline|milestone|proposal)\b/i.test(t)) return "plan";
  if (/\b(report|analysis|findings|results)\b/i.test(t)) return "report";
  return "other";
}

const NOT_PEOPLE = new Set(["Date", "Attendees", "Subject", "Total", "Action", "Notes", "Agenda", "Re", "From", "To", "Bill", "Invoice", "Note", "Decision", "Decisions", "Location", "Time", "Status", "Owner", "Summary", "Next", "Vendor", "Terms", "Due"]);

function proper(text) {
  const counts = new Map();
  const skip = new RegExp(`^(${MONTHS}|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|The|This|That|We|Our|It|If|And|But|So|Q[1-4]|I|A|An|Yes|No|Ok|Okay|Also|Next|Action|Total|Notes|Date|Re|Agreed|Decided|Decision|Owner)$`);
  for (const s of splitSentences(text)) {
    const ws = s.split(/[^A-Za-z]+/).filter(Boolean);
    ws.forEach((w, i) => {
      if (i === 0 || !/^[A-Z][a-z]{2,}$/.test(w) || skip.test(w)) return;
      counts.set(w, (counts.get(w) || 0) + 1);
    });
  }
  return counts;
}

function understandOffline(file) {
  const text = file.text;
  const docType = classifyOffline(file);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Title: first markdown heading, else first short line, else file name.
  const heading = lines.find((l) => /^#\s+/.test(l));
  let title = heading ? heading.replace(/^#+\s*/, "") : "";
  if (!title && docType !== "spreadsheet" && lines[0] && lines[0].length <= 90 && !lines[0].includes(",")) title = lines[0];
  const fromName = path.basename(file.name, path.extname(file.name)).replace(/[_]+/g, " ");
  if (!title || (/[A-Z]/.test(title) && title === title.toUpperCase())) title = fromName.split(/\s+/).length >= 2 ? fromName : titleCase((title || fromName).toLowerCase());
  title = title.replace(/^(title|subject)\s*:\s*/i, "").replace(/\s*\((transcript|draft|notes)\)\s*$/i, "");
  const invoiceNo = (text.match(/invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)/i) || [])[1];
  const vendor = (text.match(/^\s*(?:from|vendor|billed by)\s*:\s*(.+)$/im) || [])[1]?.trim();
  if (docType === "invoice" && invoiceNo) title = `Invoice ${invoiceNo}${vendor ? ` — ${vendor}` : ""}`;

  // People: speaker labels and "Attendees:" lines.
  const people = new Set();
  for (const m of text.matchAll(/^([A-Z][a-z]+(?: [A-Z][a-z]+)?):\s/gm)) if (!NOT_PEOPLE.has(m[1].split(" ")[0])) people.add(m[1]);
  const att = text.match(/attendees\s*:\s*(.+)/i);
  if (att) att[1].split(/,|;| and /).map((s) => s.replace(/\(.*?\)/g, "").trim()).filter((s) => /^[A-Z]/.test(s)).forEach((p) => people.add(p));
  const orgs = new Set();
  for (const m of text.matchAll(/\b([A-Z][\w&]+(?: [A-Z][\w&]+)*) (Inc|LLC|Ltd|Co|Corp|Media|Labs|Group|Partners|Studios|Realty|Properties)\b\.?/g)) orgs.add(`${m[1]} ${m[2]}`);

  // Summary.
  let summary;
  if (docType === "spreadsheet") {
    const rows = parseCSV(text);
    summary = `Spreadsheet with ${rows.length - 1} rows and ${rows[0]?.length || 0} columns (${(rows[0] || []).join(", ")}).`;
    const facts = extractMoneyFacts(text, "csv");
    if (facts.length) summary += ` Largest figure: ${facts.sort((a, b) => b.amount - a.amount)[0].context}.`;
  } else if (docType === "invoice") {
    const totalLine = text.split(/\n/).find((l) => /(total due|amount due|balance due|total)/i.test(l) && /\$/.test(l));
    const total = totalLine ? (totalLine.match(/\$\s?[\d,]+(\.\d+)?/) || [""])[0] : "";
    const items = text.split(/\n/).filter((l) => /\$\s?[\d,]+/.test(l) && !/total|subtotal|tax/i.test(l)).map((l) => l.replace(/\s{2,}.*$/, "").trim()).slice(0, 3);
    summary = `Invoice ${invoiceNo || ""} from ${vendor || "a vendor"}${findDate(text) ? ` dated ${findDate(text)}` : ""} for ${total || "an unstated amount"}.` +
      (items.length ? ` Covers: ${items.join("; ")}.` : "");
  } else {
    const vocab = new Map();
    for (const t of tokenize(text)) vocab.set(t, (vocab.get(t) || 0) + 1);
    const sents = splitSentences(text.split(/^\s*action items?\s*:?\s*$/im)[0].replace(/^#+.*$/gm, ""))
      .map((s, i) => s.replace(/^[-*•]\s*/, ""))
      .filter((s) => s.length > 30 && s.length < 400 && !/^(attendees|date|to|from|bill to)\s*:/i.test(s) && s !== s.toUpperCase());
    const scored = sents.map((s, i) => {
      const toks = tokenize(s);
      let score = toks.reduce((a, t) => a + Math.log(1 + (vocab.get(t) || 0)), 0) / Math.sqrt(toks.length + 1);
      if (/\b(decided|agreed|approved|confirmed|final|will launch|goal|purpose|summary)\b/i.test(s)) score *= 1.6;
      if (/\$\d/.test(s)) score *= 1.25;
      if (i < 3) score *= 1.15;
      return { s, i, score };
    });
    summary = scored.sort((a, b) => b.score - a.score).slice(0, 2).sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
    summary = clip(summary || lines.slice(0, 2).join(" "), 320);
  }

  const keyFacts = extractMoneyFacts(text, file.ext).slice(0, 12);
  const props = [...proper(text).entries()].filter(([w, c]) => c >= 2 && ![...people].some((p) => p.includes(w))).sort((a, b) => b[1] - a[1]);
  // Tags: words that recur in this file (tf ≥ 2), weighted by rarity across the drive.
  const corpus = db.files.filter((f) => f.id !== file.id && f.text);
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  const personWords = new Set([...people].flatMap((p) => p.toLowerCase().split(" ").map(normWord)));
  const tags = [...tf.entries()]
    .filter(([t, c]) => c >= 2 && t.length > 2 && !GENERIC_TAGS.has(t) && !personWords.has(t) && !/^\$|\d/.test(t))
    .map(([t, c]) => [t, c * Math.log(1 + (corpus.length + 1) / (1 + corpus.filter((f) => f.text.toLowerCase().includes(t)).length))])
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
  if (props[0] && !tags.includes(props[0][0].toLowerCase())) tags.unshift(props[0][0].toLowerCase());
  if (docType === "spreadsheet") tags.splice(0, tags.length, ...parseCSV(text).slice(1, 5).map((r) => String(r[0]).toLowerCase()).filter(Boolean));

  return {
    title: clip(title, 90), summary, docType, docDate: findDate(text), tags: tags.slice(0, 5),
    people: dedupePeople([...people]).slice(0, 8), organizations: [...orgs].slice(0, 5), keyFacts, folderHint: null,
  };
}

// ================================================================ ORGANIZER

function ensureFolder(name, description = "", special = false) {
  let folder = db.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!folder) {
    folder = { id: uid("fld"), name, description, special, createdAt: new Date().toISOString() };
    db.folders.push(folder);
  }
  return folder;
}

const GENERIC_TAGS = new Set([
  "transcript", "kickoff", "sync", "review", "notes", "meeting", "minutes", "plan", "draft", "summary", "update", "agreement",
  "invoice", "document", "file", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "decision", "agreed", "item", "action", "stay", "sheet", "week", "first", "next", "today", "q1", "q2", "q3", "q4", "terms",
  "key", "street", "suite", "total", "due", "date", "owner", "attendee", "signed", "summary", "synthesis",
]);

/** Name a cluster after the most distinctive words that appear in its files' titles. */
function folderNameOffline(files, vecs) {
  const c = centroid(files.map((f) => vecs.get(f.id)).filter(Boolean));
  const original = new Map();
  const titleCounts = new Map();
  for (const f of files) {
    for (const w of String(f.title || "").split(/[^A-Za-z]+/)) {
      const n = normWord(w);
      if (n.length < 3 || STOP.has(n) || GENERIC_TAGS.has(n)) continue;
      if (!original.has(n)) original.set(n, w[0].toUpperCase() + w.slice(1).toLowerCase());
      titleCounts.set(n, (titleCounts.get(n) || 0) + 1);
    }
  }
  // Words shared by the most titles win; ties keep title order (so single files use their leading words).
  const order = [...titleCounts.keys()];
  const ranked = [...order].sort((a, b) => titleCounts.get(b) - titleCounts.get(a) || order.indexOf(a) - order.indexOf(b));
  if (ranked.length) return ranked.slice(0, 2).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((n) => original.get(n)).join(" ");
  return titleCase(topTerms(c, 2).join(" ")) || "General";
}

const folderFiles = (folderId) => db.files.filter((f) => f.folderId === folderId);

async function organize(file, trace) {
  let folder;
  if (file.origin === "workflow") folder = ensureFolder("Automations", "Ledgers and trackers maintained by workflows", true);
  else if (file.origin === "synthesized") {
    const counts = new Map();
    for (const s of file.sources || []) { const fid = fileById(s)?.folderId; if (fid) counts.set(fid, (counts.get(fid) || 0) + 1); }
    folder = folderById([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]) || ensureFolder("Generated Documents");
  } else if (file.folderHint?.name) {
    const existed = db.folders.some((f) => f.name.toLowerCase() === file.folderHint.name.toLowerCase());
    folder = ensureFolder(file.folderHint.name, file.folderHint.description);
    trace.step("Organizer", existed ? `Filed into “${folder.name}”` : `Created smart folder “${folder.name}”`, folder.description);
  } else if (file.docType === "invoice") {
    folder = ensureFolder("Finance · Invoices", "Invoices and bills, auto-detected", true);
  } else {
    const candidates = db.files.filter((f) => f.id !== file.id && f.text && f.folderId && !folderById(f.folderId)?.special && f.origin === "upload");
    const { vecs } = fileVectors([...candidates, file]);
    const mine = vecs.get(file.id);
    let best = null, bestScore = 0;
    for (const fl of db.folders.filter((f) => !f.special)) {
      const members = candidates.filter((f) => f.folderId === fl.id).map((f) => vecs.get(f.id));
      if (!members.length) continue;
      // Content similarity, plus a nudge when the title shares a distinctive word with the folder name (e.g. a project codename).
      const nameWords = tokenize(fl.name).filter((t) => !GENERIC_TAGS.has(t));
      const titleHit = tokenize(file.title || "").some((t) => nameWords.includes(t));
      const score = cosine(mine, centroid(members)) + (titleHit ? 0.05 : 0);
      if (score > bestScore) { best = fl; bestScore = score; }
    }
    if (best && bestScore >= 0.11) {
      folder = best;
      trace.step("Organizer", `Filed into “${folder.name}”`, `content similarity ${(bestScore * 100).toFixed(0)}%`);
    } else {
      const name = folderNameOffline([file], vecs);
      folder = ensureFolder(name, `Auto-generated around: ${(file.tags || []).slice(0, 4).join(", ")}`);
      trace.step("Organizer", `Created smart folder “${folder.name}”`, "no existing folder was a close enough match");
    }
  }
  if (file.origin !== "upload" || file.docType === "invoice") {
    if (!file.folderHint?.name) trace.step("Organizer", `Filed into “${folder.name}”`, "");
  }
  file.folderId = folder.id;
}

export async function reorganize() {
  return serial(async () => {
    const trace = new Trace();
    trace.step("Organizer", "Re-reading every file to rebuild the folder structure");
    const files = db.files.filter((f) => f.origin === "upload");
    const plan = await think(trace, "Organizer",
      async () => {
        const r = await llm.json({
          system: "You are the Organizer agent of Cortex, an agentic drive. Design the most useful folder structure for these files: group by project or topic (not by file type, except that invoices/bills may share a finance folder). Every file must appear in exactly one folder.",
          prompt: JSON.stringify(catalog(files), null, 1),
          schema: llm.obj({ folders: llm.arr(llm.obj({ name: llm.str(), description: llm.str(), fileIds: llm.arr(llm.str()) })) }),
          effort: "medium",
        });
        return r.folders;
      },
      () => {
        const { vecs } = fileVectors(files);
        const clusters = [];
        const invoices = files.filter((f) => f.docType === "invoice");
        for (const f of files.filter((x) => x.docType !== "invoice").sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))) {
          let best = null, bestScore = 0;
          for (const c of clusters) {
            const s = cosine(vecs.get(f.id), centroid(c.map((x) => vecs.get(x.id))));
            if (s > bestScore) { best = c; bestScore = s; }
          }
          if (best && bestScore >= 0.11) best.push(f); else clusters.push([f]);
        }
        const out = clusters.map((c) => ({ name: folderNameOffline(c, vecs), description: `Auto-clustered: ${topTerms(centroid(c.map((x) => vecs.get(x.id))), 4).join(", ")}`, fileIds: c.map((x) => x.id) }));
        if (invoices.length) out.push({ name: "Finance · Invoices", description: "Invoices and bills, auto-detected", fileIds: invoices.map((x) => x.id) });
        return out;
      });
    const keep = new Set(db.folders.filter((f) => f.special && f.name !== "Finance · Invoices").map((f) => f.id));
    db.folders = db.folders.filter((f) => keep.has(f.id));
    for (const p of plan) {
      const folder = ensureFolder(p.name, p.description, p.name === "Finance · Invoices");
      for (const id of p.fileIds) { const f = fileById(id); if (f) f.folderId = folder.id; }
      trace.step("Organizer", `“${folder.name}”`, `${p.fileIds.length} file${p.fileIds.length === 1 ? "" : "s"}`);
    }
    // Synthesized documents follow their sources.
    for (const f of db.files.filter((x) => x.origin === "synthesized")) await organize(f, new Trace());
    for (const f of db.files.filter((x) => !folderById(x.folderId))) f.folderId = ensureFolder("General").id;
    save();
    logActivity({ kind: "reorganize", title: `Reorganized ${files.length} files into ${plan.length} smart folders`, steps: trace.steps });
    return { steps: trace.steps };
  });
}

// ================================================================ AUTOMATOR

export const DEFAULT_WORKFLOWS = [
  {
    name: "Invoice → Expense Ledger",
    description: "When an invoice lands anywhere in the drive, extract the total, categorize the expense and log it.",
    trigger: { docType: "invoice" },
    outputFile: "Expense Ledger.csv",
    columns: ["Date", "Vendor", "Invoice #", "Category", "Total (USD)", "Source file"],
    instruction: "Extract the invoice date, vendor name, invoice number, an expense category (Advertising, Events, Software, Facilities, Travel or General) and the total amount due as a plain number.",
  },
  {
    name: "Meetings → Action Item Tracker",
    description: "Every meeting transcript's action items are pulled into one tracker with owners and due dates.",
    trigger: { docType: "meeting-notes" },
    outputFile: "Action Items.csv",
    columns: ["Owner", "Action item", "Due", "Source file"],
    instruction: "Extract every action item / commitment with its owner and due date (empty if none stated). One row per action item.",
  },
];

export function addWorkflow(wf) {
  const w = { id: uid("wf"), enabled: true, runs: 0, lastRun: null, createdAt: new Date().toISOString(), ...wf };
  db.workflows.push(w);
  save();
  return w;
}

const SOURCE_COL = "Source file";

async function extractRows(wf, file, trace) {
  const cols = wf.columns.filter((c) => c !== SOURCE_COL);
  const rows = await think(trace, "Automator",
    async () => {
      const r = await llm.json({
        system: "You are the Automator agent of Cortex. Extract structured rows from a document for a workflow. Return one row per record; cells must follow the column order exactly; use an empty string when a value isn't stated. Amounts are plain numbers without currency symbols.",
        prompt: `Workflow: ${wf.name}\nInstruction: ${wf.instruction}\nColumns (in order): ${JSON.stringify(cols)}\n\n${docBlock(file)}`,
        schema: llm.obj({ rows: llm.arr(llm.obj({ cells: llm.arr(llm.str()) })) }),
      });
      return r.rows.map((row) => row.cells.slice(0, cols.length));
    },
    () => extractRowsOffline(cols, file));
  return wf.columns.includes(SOURCE_COL) ? rows.map((r) => { const out = [...r]; out.splice(wf.columns.indexOf(SOURCE_COL), 0, file.title); return out; }) : rows;
}

const CATEGORY_RULES = [
  [/\b(ad|ads|advertising|campaign|social|media buy|impressions|cpm|sponsored|influencer)\b/i, "Advertising"],
  [/\b(venue|event|catering|booth|conference|expo|av equipment)\b/i, "Events"],
  [/\b(software|subscription|license|saas|seats|hosting|cloud)\b/i, "Software"],
  [/\b(rent|lease|office|furniture|movers|moving|relocation|cleaning|utilities)\b/i, "Facilities"],
  [/\b(flight|hotel|travel|mileage|uber|taxi)\b/i, "Travel"],
];

function extractRowsOffline(cols, file) {
  const text = file.text;
  const lc = cols.map((c) => c.toLowerCase());
  // Action-item style extraction: one row per bullet in an "action items" section.
  if (lc.some((c) => /action|task|todo/.test(c))) {
    const rows = [];
    const section = text.split(/action items?\s*:?\s*\n/i)[1] || "";
    const candidates = section ? section.split(/\n/) : text.split(/\n/).filter((l) => /\bACTION\b|\[ \]|TODO/.test(l));
    for (const raw of candidates) {
      const line = raw.trim();
      if (!line) { if (rows.length) break; continue; }
      if (!/^([-*•]|\d+\.|\[ \])/.test(line) && section) { if (rows.length) break; continue; }
      const body = line.replace(/^([-*•]|\d+\.)\s*(\[ \]\s*)?/, "").replace(/^ACTION:\s*/i, "");
      const m = body.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s*[:—–-]\s*(.+)$/);
      const owner = m ? m[1] : "";
      let task = m ? m[2] : body;
      const due = (task.match(new RegExp(`\\b(?:by|due|before)\\s+((?:${MONTHS})\\.? \\d{1,2}|\\d{4}-\\d{2}-\\d{2}|next \\w+|end of \\w+|\\w+day)`, "i")) || [])[1] || "";
      task = task.replace(/\s*\((?:by|due)[^)]*\)\s*$/i, "").trim();
      rows.push(lc.map((c) => (/owner|who|assignee/.test(c) ? owner : /due|date|deadline/.test(c) ? due : /action|task|todo|item/.test(c) ? task : "")));
    }
    return rows;
  }
  // Single-record extraction (invoices, contracts, …).
  const amounts = [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g)].map((m) => ({ v: parseMoney(m[1], m[2]), at: m.index }));
  const totalLine = text.split(/\n/).find((l) => /(total due|amount due|balance due|grand total|total)/i.test(l) && /\$/.test(l));
  const total = totalLine ? parseMoney(...(totalLine.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/) || []).slice(1)) : Math.max(0, ...amounts.map((a) => a.v));
  // "Label: value" lines, matched to columns by shared (normalized) words.
  const kvLines = text.split(/\n/).map((l) => l.match(/^\s*(?:\d+\.\s*)?([^:]{2,40}):\s*(.+)$/)).filter(Boolean)
    .map((m) => ({ key: new Set(tokenize(m[1])), all: new Set(tokenize(m[0])), value: m[2].trim() }));
  const fuzzy = (col) => {
    const isDate = /date/i.test(col);
    const ct = tokenize(col).filter((t) => !isDate || t !== "date");
    if (!ct.length) return "";
    let best = null, bestScore = 0;
    for (const l of kvLines) {
      if (isDate && !findDate(l.value)) continue;
      const s = ct.filter((t) => l.key.has(t)).length * 2 + ct.filter((t) => l.all.has(t)).length;
      if (s > bestScore) { best = l; bestScore = s; }
    }
    return bestScore >= (isDate ? 1 : 2) ? best.value : "";
  };
  const row = lc.map((c, i) => {
    const kvValue = fuzzy(cols[i]);
    const kv = kvValue ? [null, /date/.test(c) && findDate(kvValue) ? findDate(kvValue) : kvValue] : null;
    if (/total|amount|cost|price|value/.test(c)) return total ? total.toFixed(2) : "";
    if (/invoice\s*(#|no|number)|reference/.test(c)) return (text.match(/invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)/i) || [])[1] || "";
    if (kv) return kv[1].trim();
    if (/date/.test(c)) return findDate(text);
    if (/vendor|supplier|from|company|party|landlord/.test(c)) {
      const from = text.match(/^\s*(?:from|vendor|supplier|billed by|remit to)\s*:\s*(.+)$/im);
      return from ? from[1].trim() : file.organizations?.[0] || text.split(/\n/).find((l) => l.trim())?.trim() || "";
    }
    if (/category|type/.test(c)) return (CATEGORY_RULES.find(([re]) => re.test(text)) || [, "General"])[1];
    return "";
  });
  return [row];
}

function ledgerFile(wf) {
  let f = db.files.find((x) => x.origin === "workflow" && x.name === wf.outputFile);
  if (!f) {
    const now = new Date().toISOString();
    f = {
      id: uid("file"), name: wf.outputFile, ext: "csv", size: 0, uploadedAt: now, updatedAt: now, origin: "workflow",
      workflowId: wf.id, title: wf.outputFile.replace(/\.csv$/i, ""), docType: "ledger", tags: ["automation", "ledger"],
      summary: `Maintained automatically by the “${wf.name}” workflow.`, people: [], organizations: [], keyFacts: [],
      text: toCSVLine(wf.columns) + "\n", words: 0,
    };
    db.files.push(f);
    organize(f, new Trace());
  }
  return f;
}

async function runWorkflow(wf, file, trace) {
  const rows = await extractRows(wf, file, trace);
  if (!rows.length) { trace.step("Automator", `“${wf.name}” found nothing to log`, file.title); return 0; }
  const out = ledgerFile(wf);
  out.text = out.text.replace(/\n*$/, "\n") + rows.map(toCSVLine).join("\n") + "\n";
  out.updatedAt = new Date().toISOString();
  out.size = Buffer.byteLength(out.text);
  const data = parseCSV(out.text).slice(1);
  out.words = words(out.text);
  const totalCol = wf.columns.findIndex((c) => /total|amount/i.test(c));
  out.summary = `Maintained automatically by the “${wf.name}” workflow — ${data.length} row${data.length === 1 ? "" : "s"}` +
    (totalCol >= 0 ? `, ${formatMoney(data.reduce((s, r) => s + (parseFloat(String(r[totalCol]).replace(/[$,]/g, "")) || 0), 0))} total.` : ".");
  wf.runs += 1;
  wf.lastRun = new Date().toISOString();
  trace.step("Automator", `“${wf.name}” → appended ${rows.length} row${rows.length > 1 ? "s" : ""} to ${wf.outputFile}`,
    rows.slice(0, 2).map((r) => r.filter(Boolean).join(" · ")).join(" | "));
  return rows.length;
}

async function runWorkflows(file, trace) {
  if (file.origin !== "upload") return;
  const matching = db.workflows.filter((w) => w.enabled && w.trigger.docType === file.docType);
  for (const wf of matching) await runWorkflow(wf, file, trace);
}

export async function createWorkflow(text) {
  return serial(async () => {
    const trace = new Trace();
    trace.step("Router", "Understood as a new automation rule", text);
    const spec = await think(trace, "Automator",
      async () => llm.json({
        system: "You are the Automator agent of Cortex. Turn the user's natural-language rule into a workflow spec. The trigger is a document type detected when a file is uploaded. Always include a final column named exactly \"Source file\".",
        prompt: text,
        schema: llm.obj({
          name: llm.str("Short name like 'Contracts → Renewal Tracker'"),
          description: llm.str(),
          triggerDocType: llm.enumOf(DOC_TYPES.filter((t) => !["synthesized", "ledger"].includes(t))),
          outputFile: llm.str("CSV file name ending in .csv"),
          columns: llm.arr(llm.str()),
          instruction: llm.str("Extraction instruction for each matching document"),
        }),
      }),
      () => workflowSpecOffline(text));
    const wf = addWorkflow({
      name: spec.name, description: spec.description, trigger: { docType: spec.triggerDocType },
      outputFile: spec.outputFile, columns: spec.columns.includes(SOURCE_COL) ? spec.columns : [...spec.columns, SOURCE_COL],
      instruction: spec.instruction,
    });
    trace.step("Automator", `Created workflow “${wf.name}”`, `when: ${wf.trigger.docType} arrives → log ${wf.columns.join(", ")} into ${wf.outputFile}`);
    // Backfill: apply the new rule to files that are already in the drive.
    const existing = db.files.filter((f) => f.origin === "upload" && f.docType === wf.trigger.docType);
    for (const f of existing) await runWorkflow(wf, f, trace);
    if (existing.length) trace.step("Automator", `Backfilled ${existing.length} existing file${existing.length > 1 ? "s" : ""}`);
    reindex();
    save();
    logActivity({ kind: "workflow", title: `New automation: ${wf.name}`, steps: trace.steps });
    return { workflow: wf, steps: trace.steps };
  });
}

function workflowSpecOffline(text) {
  const t = text.toLowerCase();
  const type =
    /invoice|receipt|bill\b/.test(t) ? "invoice" :
    /meeting|transcript|minutes|notes/.test(t) ? "meeting-notes" :
    /contract|lease|agreement|nda/.test(t) ? "contract" :
    /interview|research|feedback|survey/.test(t) ? "research" :
    /spreadsheet|csv|sheet/.test(t) ? "spreadsheet" :
    /plan|roadmap|proposal/.test(t) ? "plan" : /report/.test(t) ? "report" : "other";
  const label = { invoice: "Invoices", "meeting-notes": "Meetings", contract: "Contracts", research: "Research", spreadsheet: "Spreadsheets", plan: "Plans", report: "Reports", other: "Documents" }[type];
  const outMatch = text.match(/(?:into|to|in)\s+(?:an?\s+|the\s+|my\s+)?["“']?([\w .&-]+?\.csv)/i) ||
    text.match(/(?:into|to|in)\s+(?:an?\s+|the\s+|my\s+)?["“']?([A-Z][\w &-]+?)["”']?\s*(?:sheet|tracker|log|ledger|table)?\s*$/i);
  const outputFile = outMatch ? (outMatch[1].toLowerCase().endsWith(".csv") ? outMatch[1].trim() : `${outMatch[1].trim()}.csv`) : `${label} Log.csv`;
  const colMatch = text.match(/(?:extract|capture|pull out|pull|log|record|track|grab)\s+(?:the\s+)?(.+?)(?:\s+(?:into|to|in)\s+(?:an?\s+|the\s+|my\s+)?["“']?[\w .&-]+?(?:\.csv)?["”']?\s*$|$)/i);
  let columns = colMatch ? colMatch[1].split(/,\s*|\s+and\s+|\s*&\s*/).map((c) => titleCase(c.replace(/^(the|its|their)\s+/i, "").trim())).filter((c) => c && c.length < 40) : [];
  if (!columns.length) columns = ["Date", "Title", "Key figure"];
  return {
    name: `${label} → ${outputFile}`,
    description: text,
    triggerDocType: type,
    outputFile,
    columns,
    instruction: text,
  };
}

// ================================================================ SENTINEL

function addInsight(ins) {
  const existing = ins.key && db.insights.find((i) => i.key === ins.key && i.status === "open");
  if (existing) {
    existing.fileIds = [...new Set([...existing.fileIds, ...ins.fileIds])];
    if (ins.entries) {
      for (const e of ins.entries) if (!existing.entries.some((x) => x.fileId === e.fileId && x.value === e.value)) existing.entries.push(e);
    }
    existing.detail = ins.detail;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const i = { id: uid("ins"), status: "open", createdAt: new Date().toISOString(), ...ins };
  db.insights.unshift(i);
  return i;
}

function relatedFiles(file, n = 5) {
  const pool = db.files.filter((f) => f.text && f.id !== file.id && f.origin !== "workflow");
  const { vecs } = fileVectors([...pool, file]);
  return pool.map((f) => ({ f, score: cosine(vecs.get(file.id), vecs.get(f.id)) + (f.folderId === file.folderId ? 0.08 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, n);
}

async function sentinel(file, trace) {
  if (file.origin === "workflow") return;
  const related = relatedFiles(file, 6);
  file.related = related.filter((r) => r.score > 0.12).slice(0, 4).map((r) => r.f.id);
  let found = [];
  if (file.origin === "upload") {
    found = await think(trace, "Sentinel",
      async () => {
        const r = await llm.json({
          system:
            "You are the Sentinel agent of Cortex, an agentic drive. A new file just arrived. Compare it against related files already in the drive and surface only insights a busy person would genuinely want: " +
            "CONFLICTS (the same figure, date or decision stated differently — say which source is newer), DEADLINES coming up, important CONNECTIONS between files in different projects, DUPLICATES, or GAPS (something referenced but missing). " +
            "Return at most 3 insights; return an empty list if nothing is worth interrupting the user for. fileIds must be ids from the provided documents.",
          prompt:
            `NEW FILE:\n${docBlock(file, 30_000)}\nKey facts: ${JSON.stringify(file.keyFacts)}\n\nRELATED FILES ALREADY IN THE DRIVE:\n` +
            related.map(({ f }) => `- id=${f.id} | “${f.title}” | ${f.docType} | date ${f.docDate || "?"} | ${f.summary}\n  key facts: ${JSON.stringify((f.keyFacts || []).map(({ label, value }) => ({ label, value })))}`).join("\n"),
          schema: llm.obj({
            insights: llm.arr(llm.obj({
              type: llm.enumOf(["conflict", "deadline", "connection", "duplicate", "gap"]),
              title: llm.str("Short headline"),
              detail: llm.str("1-3 sentences with the specific values/dates and which file says what"),
              fileIds: llm.arr(llm.str()),
            })),
          }),
          effort: "medium",
        });
        const valid = new Set([file.id, ...related.map((x) => x.f.id)]);
        return r.insights.map((i) => ({ ...i, fileIds: [...new Set([file.id, ...i.fileIds.filter((id) => valid.has(id))])] }));
      },
      () => sentinelOffline(file, related));
  }
  // Living documents: synthesized docs built from this folder may now be out of date.
  if (file.origin === "upload") {
    const docs = db.files.filter((f) => f.origin === "synthesized");
    const { vecs } = fileVectors([...docs, file]);
    for (const doc of docs) {
      const srcFolders = new Set((doc.sources || []).map((s) => fileById(s)?.folderId).filter(Boolean));
      const similar = cosine(vecs.get(doc.id), vecs.get(file.id)) >= 0.15;
      if ((srcFolders.has(file.folderId) || similar) && !doc.sources.includes(file.id)) {
        found.push({
          type: "stale", key: `stale:${doc.id}`, title: `“${doc.title}” may be out of date`,
          detail: `“${file.title}” arrived in the same project after this document was generated. Refresh to re-synthesize it with the new information.`,
          fileIds: [doc.id, file.id], action: { kind: "refresh", fileId: doc.id, addSources: [file.id] },
        });
      }
    }
  }
  for (const ins of found) {
    const saved = addInsight(ins);
    if (saved.action?.addSources) saved.action.addSources = [...new Set([...(saved.action.addSources || []), ...(ins.action?.addSources || [])])];
    trace.step("Sentinel", `${{ conflict: "⚠ Conflict", stale: "↻ Stale document", deadline: "⏰ Deadline", connection: "🔗 Connection", duplicate: "⧉ Duplicate", gap: "◌ Gap" }[ins.type] || "Insight"}: ${ins.title}`, ins.detail);
  }
  if (!found.length) trace.step("Sentinel", "Cross-checked against related files", `${related.length} compared · no conflicts`);
}

const MEASURES = new Set(["cost", "remaining", "actual", "balance", "variance", "forecast", "date", "deposit", "subtotal"]);

function sentinelOffline(file, related) {
  const out = [];
  const comparable = (f) => f.origin === "upload" && !["invoice", "ledger"].includes(f.docType);
  if (comparable(file)) {
    const peers = db.files.filter((f) => f.id !== file.id && comparable(f) && f.folderId === file.folderId);
    for (const fact of file.keyFacts || []) {
      for (const peer of peers) {
        for (const other of peer.keyFacts || []) {
          const a = fact.labelTokens || tokenize(fact.label), b = other.labelTokens || tokenize(other.label);
          const shared = a.filter((t) => b.includes(t));
          const strong = shared.length >= 2 || (shared.length === 1 && Math.min(a.length, b.length) === 1);
          if (!strong || !fact.amount || !other.amount) continue;
          // "Spent to date" vs "budget" are different measures of the same item, not a conflict.
          const measures = (x) => x.filter((t) => MEASURES.has(t)).sort().join();
          if (measures(a) !== measures(b)) continue;
          if (Math.abs(fact.amount - other.amount) / Math.max(fact.amount, other.amount) < 0.005) continue;
          const ratio = Math.max(fact.amount, other.amount) / Math.min(fact.amount, other.amount);
          if (ratio > 3) continue; // different magnitudes are probably different things (e.g. total vs. line item)
          const topic = shared.join(" ");
          const entries = [
            { fileId: peer.id, value: other.value, amount: other.amount, context: other.context, date: peer.docDate || "" },
            { fileId: file.id, value: fact.value, amount: fact.amount, context: fact.context, date: file.docDate || "" },
          ];
          const newest = [...entries].sort((x, y) => (y.date || "").localeCompare(x.date || ""))[0];
          out.push({
            type: "conflict", key: `conflict:${file.folderId}:${[...shared].sort().join("-")}`,
            title: `Conflicting figures for “${(fact.label || topic).replace(/^\w/, (ch) => ch.toUpperCase())}”`,
            detail: `${fileById(peer.id).title} says ${other.value}, but ${file.title} says ${fact.value}.` +
              (newest.date ? ` The most recent source (${fileById(newest.fileId)?.title || file.title}, ${newest.date}) says ${newest.value}.` : ""),
            fileIds: [peer.id, file.id], entries,
          });
        }
      }
    }
  }
  // Dedupe conflicts with the same key inside this batch.
  const byKey = new Map();
  for (const c of out) {
    const prev = byKey.get(c.key);
    if (prev) {
      prev.fileIds = [...new Set([...prev.fileIds, ...c.fileIds])];
      for (const e of c.entries) if (!prev.entries.some((x) => x.fileId === e.fileId && x.value === e.value)) prev.entries.push(e);
    } else byKey.set(c.key, c);
  }
  const results = [...byKey.values()];
  for (const r of results) {
    const vals = r.entries.map((e) => `${fileById(e.fileId)?.title}: ${e.value}`);
    r.detail = `Sources disagree — ${vals.join(" · ")}.` + (() => {
      const dated = r.entries.filter((e) => e.date).sort((x, y) => y.date.localeCompare(x.date));
      return dated.length ? ` Newest (${dated[0].date}) says ${dated[0].value}.` : "";
    })();
  }
  const dup = related.find((r) => r.score > 0.92);
  if (dup) results.push({ type: "duplicate", key: `dup:${[file.id, dup.f.id].sort().join("-")}`, title: `“${file.title}” looks like a duplicate`, detail: `It is ${(dup.score * 100).toFixed(0)}% similar to “${dup.f.title}”.`, fileIds: [file.id, dup.f.id] });
  const cross = related.find((r) => r.f.folderId !== file.folderId && r.score > 0.22 && r.f.origin === "upload");
  if (cross && file.docType !== "invoice") {
    results.push({
      type: "connection", key: `link:${[file.id, cross.f.id].sort().join("-")}`,
      title: `“${file.title}” relates to “${cross.f.title}”`,
      detail: `They live in different folders (${folderById(file.folderId)?.name} / ${folderById(cross.f.folderId)?.name}) but share topics: ${topTerms(fileVectors([file, cross.f]).vecs.get(file.id), 4).join(", ")}.`,
      fileIds: [file.id, cross.f.id],
    });
  }
  return results;
}

// ================================================================ INGEST (Librarian → Organizer → Automator → Sentinel)

export async function ingest({ name, buffer, origin = "upload" }) {
  return serial(async () => {
    busy.count++; busy.label = `Reading ${name}`;
    const trace = new Trace();
    try {
      const { text, pages } = await extractText(name, buffer);
      if (!text.trim()) throw new Error("No readable text found in this file (scanned PDFs need OCR).");
      const now = new Date().toISOString();
      const file = { id: uid("file"), name, ext: extOf(name), size: buffer.length, uploadedAt: now, updatedAt: now, origin, text, words: words(text) };
      storeBytes(file.id, name, buffer);
      trace.step("Librarian", `Received ${name}`, `${pages ? `${pages} page${pages > 1 ? "s" : ""} · ` : ""}${file.words.toLocaleString()} words`);
      db.files.push(file);
      await understand(file, trace);
      await organize(file, trace);
      reindex();
      await runWorkflows(file, trace);
      reindex();
      await sentinel(file, trace);
      file.trace = trace.steps;
      save();
      logActivity({ kind: "ingest", fileId: file.id, title: `Processed “${file.title}”`, steps: trace.steps });
      return { file: publicFile(file), steps: trace.steps };
    } finally {
      busy.count--; busy.label = "";
    }
  });
}

// ================================================================ RETRIEVER + ANALYST

export async function answer(question, { fileIds = null } = {}) {
  const trace = new Trace();
  const expansion = await think(trace, "Retriever",
    async () => {
      const r = await llm.json({
        system: "You expand search queries for a document drive. Return synonyms, related terms and likely phrasings that documents answering the question would contain (single words or short phrases).",
        prompt: question,
        schema: llm.obj({ terms: llm.arr(llm.str()) }),
      });
      trace.step("Retriever", "Expanded the query semantically", r.terms.slice(0, 8).join(", "));
      return r.terms;
    },
    () => []);
  const { hits } = index.search(question, 8, { fileIds, extraTerms: expansion });
  const files = [...new Set(hits.map((h) => h.fileId))];
  trace.step("Retriever", `Searched ${index.docs.length} passages across ${db.files.length} files`, `${hits.length} relevant passages from ${files.length} file${files.length === 1 ? "" : "s"}`);
  if (!hits.length) {
    trace.step("Analyst", "Nothing in the drive matches");
    return { answer: "I couldn't find anything in your drive about that. Try different wording, or upload the relevant files.", citations: [], steps: trace.steps };
  }
  const sources = hits.map((h, i) => ({ n: i + 1, fileId: h.fileId, title: fileById(h.fileId)?.title, date: fileById(h.fileId)?.docDate || "", text: h.text }));
  const text = await think(trace, "Analyst",
    async () => {
      const out = await llm.write({
        system:
          "You are the Analyst agent of Cortex, an agentic drive. Answer the user's question using ONLY the numbered excerpts from their files. " +
          "Cite every claim with bracketed excerpt numbers like [2] or [1][3]. If excerpts disagree, say so explicitly, give each value with its citation, and say which source is most recent. " +
          "If the excerpts don't contain the answer, say what's missing. Be direct: lead with the answer in one or two sentences, then supporting detail in short bullets if useful. Markdown allowed; no headings.",
        prompt: `Question: ${question}\n\nExcerpts:\n` + sources.map((s) => `[${s.n}] (from “${s.title}”${s.date ? `, dated ${s.date}` : ""})\n${s.text}`).join("\n\n"),
        effort: "medium",
        maxTokens: 16000,
      });
      trace.step("Analyst", `Synthesized an answer with ${llm.MODEL}`);
      return out;
    },
    () => { const out = answerOffline(question, sources, expansion); trace.step("Analyst", "Composed an extractive answer (offline)"); return out; });
  const used = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const citations = sources.filter((s) => used.has(s.n)).map((s) => ({ ...s, text: clip(s.text, 600) }));
  logActivity({ kind: "ask", title: `Answered: ${clip(question, 80)}`, steps: trace.steps });
  return { answer: text, citations, steps: trace.steps };
}

function answerOffline(question, sources) {
  const q = new Set(tokenize(question));
  const dates = [...new Set(sources.map((s) => s.date).filter(Boolean))].sort();
  const recency = (d) => (d && dates.length > 1 ? dates.indexOf(d) / (dates.length - 1) : 0.5);
  const wantsMoney = /\b(budget|cost|spend|spent|price|how much|amount|total|rent|paid|pay)\b/i.test(question);
  const wantsDate = /\b(when|date|deadline|launch|due)\b/i.test(question);
  const cands = [];
  const wantsLedger = /\b(expense|expenses|spent|spend|invoice|invoices|ledger|action items?|to-?dos?|owner|who|tasks?|contracts?)\b/i.test(question);
  for (const s of sources) {
    if (fileById(s.fileId)?.origin === "workflow" && !wantsLedger) continue;
    for (const raw of splitSentences(s.text)) {
      const sent = raw.replace(/\s{3,}/g, " — ");
      if (sent.length < 20) continue;
      if (!/[.!?:)]$/.test(sent) && !/\d/.test(sent) && sent.split(/\s+/).length <= 9) continue; // headings / titles
      const toks = tokenize(sent);
      let score = toks.filter((t) => q.has(t)).length / Math.sqrt(toks.length + 2);
      if (wantsMoney && /\$\s?\d|\b\d{2,3},\d{3}\b/.test(sent)) score *= 1.8;
      if (wantsDate && new RegExp(`\\b(${MONTHS})\\b|\\d{4}-\\d{2}-\\d{2}`).test(sent)) score *= 1.6;
      if (/\b(decision|decided|agreed|approved|final|confirmed|moves? (from|to))\b/i.test(sent)) score *= 1.6;
      if (/^[A-Z][a-z]+:\s.*\b(by|until) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(sent)) score *= 0.6; // action items, not facts
      score *= 1 + 0.6 * recency(s.date); // newer documents supersede older ones
      score *= 1 - (s.n - 1) * 0.03;
      if (score > 0) cands.push({ sent: sent.replace(/^[-*•]\s*/, ""), n: s.n, score, date: s.date });
    }
  }
  const seen = new Set();
  const picked = cands.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.sent) && seen.add(c.sent)).slice(0, 4);
  if (!picked.length) return "I found related files but no passage that directly answers this. The closest sources are cited below. [1]";
  const lead = picked[0];
  let out = `**${lead.sent}** [${lead.n}]`;
  if (picked.length > 1) out += "\n\nAlso relevant:\n" + picked.slice(1).map((p) => `- ${p.sent} [${p.n}]`).join("\n");
  // Surface any known conflict that touches this question.
  const conflicts = db.insights.filter((i) => i.status === "open" && i.type === "conflict" && tokenize(i.title).some((t) => q.has(t)));
  for (const c of conflicts.slice(0, 2)) out += `\n\n> ⚠ **Heads-up:** ${c.detail}`;
  const dated = [...new Set(picked.filter((p) => p.date).map((p) => p.date))];
  if (dated.length > 1 && !conflicts.length) out += `\n\n_Sources span ${dated.sort()[0]} → ${dated.sort().at(-1)}; newer sources were weighted higher._`;
  return out;
}

// ================================================================ WRITER (cross-document synthesis)

export async function synthesize({ fileIds, instruction, title = "" }) {
  return serial(async () => {
    busy.count++; busy.label = "Writing a new document";
    try {
      const trace = new Trace();
      const sources = fileIds.map(fileById).filter(Boolean);
      if (!sources.length) throw new Error("No source files selected.");
      trace.step("Writer", `Reading ${sources.length} source file${sources.length > 1 ? "s" : ""}`, sources.map((s) => s.title).join(" · "));
      const perDoc = Math.floor(400_000 / sources.length);
      if (sources.some((s) => s.text.length > perDoc)) trace.step("Writer", "Some sources are very long and were truncated to fit", `limit ${perDoc.toLocaleString()} chars each`);
      const md = await think(trace, "Writer",
        async () => {
          const out = await llm.write({
            system:
              "You are the Writer agent of Cortex, an agentic drive. You create new documents by synthesizing several source files. " +
              "Write a complete, well-structured Markdown document that fulfils the user's instruction. Start with a single '# Title' line. " +
              "Reconcile information across sources: when sources disagree, use the most recent and add a short note naming the discrepancy. " +
              "Attribute important facts to their source in parentheses, e.g. (Aug 12 sync). Do not invent facts that aren't in the sources; list unknowns under 'Open questions'.",
            prompt: `Instruction: ${instruction}\n${title ? `Preferred title: ${title}\n` : ""}\nSources:\n` + sources.map((s) => docBlock(s, perDoc)).join("\n\n"),
            effort: "medium",
          });
          trace.step("Writer", `Drafted with ${llm.MODEL}`);
          return out;
        },
        () => { const out = synthesizeOffline(sources, instruction, title); trace.step("Writer", "Compiled a structured draft (offline)"); return out; });
      const now = new Date().toISOString();
      const docTitle = (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || title || "Synthesized document";
      const file = {
        id: uid("file"), name: `${docTitle.replace(/[^\w\- ]+/g, "").slice(0, 60)}.md`, ext: "md", size: Buffer.byteLength(md),
        uploadedAt: now, updatedAt: now, origin: "synthesized", text: md, words: words(md), title: docTitle,
        docType: "synthesized", sources: sources.map((s) => s.id), instruction, version: 1,
        tags: ["generated", ...new Set(sources.flatMap((s) => s.tags || []))].slice(0, 5), people: dedupePeople(sources.flatMap((s) => s.people || [])).slice(0, 8),
        organizations: [], keyFacts: [], docDate: now.slice(0, 10),
        summary: llm.enabled
          ? clip((splitSentences(md.replace(/^#.*$/gm, "").replace(/^_.*_$/gm, "").replace(/^\|.*$/gm, "")).find((s) => s.length > 40) || `Synthesized from ${sources.length} files.`).replace(/[*_`>#]|^\s*-\s*/g, ""), 300)
          : `Generated from ${sources.length} source${sources.length > 1 ? "s" : ""} (${sources.map((s) => s.title).join("; ")}) for: “${clip(instruction, 120)}”.`,
      };
      db.files.push(file);
      await organize(file, trace);
      file.related = sources.map((s) => s.id);
      reindex();
      trace.step("Writer", `Saved “${docTitle}” as a living document`, `linked to ${sources.length} sources — Cortex will flag it if they change`);
      file.trace = trace.steps;
      save();
      logActivity({ kind: "synthesize", fileId: file.id, title: `Wrote “${docTitle}”`, steps: trace.steps });
      return { file: publicFile(file), steps: trace.steps };
    } finally {
      busy.count--; busy.label = "";
    }
  });
}

export async function refresh(fileId, addSources = []) {
  const doc = fileById(fileId);
  if (!doc || doc.origin !== "synthesized") throw new Error("Only generated documents can be refreshed.");
  const sources = [...new Set([...doc.sources, ...addSources])].filter(fileById);
  const res = await synthesize({ fileIds: sources, instruction: doc.instruction, title: doc.title });
  // Replace the old version in place so links keep working.
  return serial(async () => {
    const fresh = fileById(res.file.id);
    Object.assign(doc, { text: fresh.text, words: fresh.words, size: fresh.size, sources: fresh.sources, summary: fresh.summary, updatedAt: new Date().toISOString(), version: (doc.version || 1) + 1 });
    db.files = db.files.filter((f) => f.id !== fresh.id);
    for (const i of db.insights) if (i.status === "open" && i.action?.kind === "refresh" && i.action.fileId === fileId) i.status = "resolved";
    reindex();
    save();
    const steps = [...res.steps, { agent: "Writer", action: `Updated “${doc.title}” to v${doc.version}`, detail: `${sources.length} sources`, ms: res.steps.at(-1)?.ms || 0 }];
    logActivity({ kind: "refresh", fileId, title: `Refreshed “${doc.title}” (v${doc.version})`, steps });
    return { file: publicFile(doc), steps };
  });
}

function synthesizeOffline(sources, instruction, title) {
  const docTitle = title || titleFromInstruction(instruction) || "Synthesized Brief";
  const ordered = [...sources].sort((a, b) => (a.docDate || "").localeCompare(b.docDate || ""));
  const grab = (re) => {
    const out = [];
    for (const s of ordered) for (const sent of splitSentences(s.text)) if (re.test(sent) && sent.length > 25 && sent.length < 320) out.push({ sent: sent.replace(/^[-*•]\s*/, ""), src: s });
    const seen = new Set();
    return out.filter((o) => !seen.has(o.sent) && seen.add(o.sent));
  };
  const short = (s) => s.title.length > 40 ? s.title.slice(0, 38) + "…" : s.title;
  const decisions = grab(/\b(decided|agreed|approved|confirmed|final|will launch|moved to|signed off)\b/i).slice(0, 10);
  const actions = [];
  for (const s of ordered) {
    const rows = extractRowsOffline(["Owner", "Action item", "Due"], s);
    for (const [owner, task, due] of rows) if (task) actions.push(`| ${owner || "—"} | ${task} | ${due || "—"} | ${short(s)} |`);
  }
  const questions = grab(/\?\s*$/).slice(0, 6);
  // Key figures: latest value wins, earlier values are noted as changes.
  const facts = new Map();
  for (const s of ordered) for (const f of s.keyFacts || []) {
    const measure = (f.labelTokens || []).filter((t) => MEASURES.has(t));
    const key = [...new Set([...tokenize(f.label), ...measure])].sort().join(" ");
    if (!key) continue;
    const prev = facts.get(key);
    const history = prev ? (prev.value === f.value ? prev.history : [...prev.history, `${prev.value} (${short(prev.src)})`]) : [];
    facts.set(key, { label: f.label + (measure.includes("cost") ? " (spent)" : ""), value: f.value, src: prev && prev.value === f.value ? prev.src : s, history });
  }
  const conflictNotes = db.insights.filter((i) => i.type === "conflict" && i.status === "open" && i.fileIds.some((id) => sources.some((s) => s.id === id)));
  let md = `# ${docTitle}\n\n_Generated by Cortex from ${sources.length} source${sources.length > 1 ? "s" : ""} · instruction: “${instruction}”_\n\n`;
  md += `## Overview\n\n${ordered.map((s) => `- **${s.title}**${s.docDate ? ` (${s.docDate})` : ""}: ${s.summary}`).join("\n")}\n\n`;
  if (decisions.length) md += `## Key decisions\n\n${decisions.map((d) => `- ${d.sent} _(${short(d.src)})_`).join("\n")}\n\n`;
  if (facts.size) {
    md += `## Key figures (latest value wins)\n\n| Item | Current value | Source | Earlier values |\n|---|---|---|---|\n`;
    md += [...facts.values()].slice(0, 14).map((f) => `| ${titleCase(f.label)} | ${f.value} | ${short(f.src)} | ${f.history.join("; ") || "—"} |`).join("\n") + "\n\n";
  }
  if (conflictNotes.length) md += `## ⚠ Discrepancies to resolve\n\n${conflictNotes.map((c) => `- **${c.title}** — ${c.detail}`).join("\n")}\n\n`;
  if (actions.length) md += `## Action items\n\n| Owner | Task | Due | From |\n|---|---|---|---|\n${actions.join("\n")}\n\n`;
  if (questions.length) md += `## Open questions\n\n${questions.map((q) => `- ${q.sent} _(${short(q.src)})_`).join("\n")}\n\n`;
  md += `## Sources\n\n${ordered.map((s) => `- ${s.title}${s.docDate ? ` — ${s.docDate}` : ""}`).join("\n")}\n`;
  return md;
}

function titleFromInstruction(instruction) {
  const m = instruction.match(/(?:draft|write|create|generate|prepare|compose|produce|make|build)\s+(?:me\s+)?(?:an?|the)?\s*(?:unified|single|short|concise|detailed|new)?\s*([\w\s/&-]{3,60}?)(?=\s+(?:from|based|using|for|of|that|which|combining|across|out)\b|[.,]|$)/i);
  return m ? titleCase(m[1].trim()) : "";
}

// ================================================================ BRIEFER

export async function brief() {
  const trace = new Trace();
  const openInsights = db.insights.filter((i) => i.status === "open");
  trace.step("Briefer", `Scanning ${db.files.length} files, ${openInsights.length} open insights, ${db.workflows.length} workflows`);
  const ledgers = db.files.filter((f) => f.origin === "workflow");
  const md = await think(trace, "Briefer",
    async () => {
      const out = await llm.write({
        system: "You are the Briefer agent of Cortex, an agentic drive. Write a crisp executive briefing of the user's drive: what each project is about and its current status, the most important numbers, conflicts that need resolving, upcoming dates, and open action items. Use short sections with headings and bullets. Be specific and reference file titles.",
        prompt:
          `FILES:\n${JSON.stringify(catalog(db.files.filter((f) => f.origin !== "workflow")), null, 1)}\n\nOPEN INSIGHTS:\n${JSON.stringify(openInsights.map(({ type, title, detail }) => ({ type, title, detail })), null, 1)}\n\n` +
          `WORKFLOW LEDGERS:\n${ledgers.map((l) => `## ${l.title}\n${l.text}`).join("\n\n")}`,
        effort: "medium",
      });
      trace.step("Briefer", `Written with ${llm.MODEL}`);
      return out;
    },
    () => {
      let md = `# Drive briefing\n\n`;
      for (const folder of db.folders.filter((f) => !f.special)) {
        const files = folderFiles(folder.id).filter((f) => f.origin !== "workflow").sort((a, b) => (b.docDate || "").localeCompare(a.docDate || ""));
        if (!files.length) continue;
        md += `## ${folder.name}\n\n${files.length} file${files.length > 1 ? "s" : ""}. Latest: **${files[0].title}**${files[0].docDate ? ` (${files[0].docDate})` : ""} — ${files[0].summary}\n\n`;
      }
      if (openInsights.length) md += `## Needs your attention\n\n${openInsights.slice(0, 6).map((i) => `- **${i.title}** — ${i.detail}`).join("\n")}\n\n`;
      for (const l of ledgers) {
        const rows = parseCSV(l.text);
        md += `## ${l.title}\n\n${l.summary}\n\n`;
        if (rows.length > 1) md += `| ${rows[0].join(" | ")} |\n|${rows[0].map(() => "---").join("|")}|\n${rows.slice(1, 9).map((r) => `| ${r.join(" | ")} |`).join("\n")}\n\n`;
      }
      trace.step("Briefer", "Compiled from metadata (offline)");
      return md;
    });
  logActivity({ kind: "brief", title: "Generated a drive briefing", steps: trace.steps });
  return { answer: md, citations: [], steps: trace.steps };
}

// ================================================================ ROUTER

export async function command(text, selectedIds = []) {
  const trace = new Trace();
  const route = await think(trace, "Router",
    async () => {
      const r = await llm.json({
        system:
          "You are the Router agent of Cortex, an agentic drive. Classify the user's command: " +
          "'ask' = a question to answer from their files; 'synthesize' = create a new document from several files; " +
          "'automate' = set up a rule that runs whenever certain files arrive; 'brief' = summarize the state of the whole drive; 'reorganize' = rebuild folders. " +
          "For 'synthesize', choose the source files (by id) from the catalog unless the user already selected some; also propose a document title.",
        prompt: `Command: ${text}\nUser-selected file ids: ${JSON.stringify(selectedIds)}\n\nCatalog:\n${JSON.stringify(catalog(db.files.filter((f) => f.origin !== "workflow")), null, 1)}`,
        schema: llm.obj({
          intent: llm.enumOf(["ask", "synthesize", "automate", "brief", "reorganize"]),
          title: llm.str(), sourceFileIds: llm.arr(llm.str()), reasoning: llm.str(),
        }),
      });
      r.sourceFileIds = r.sourceFileIds.filter(fileById);
      return r;
    },
    () => routeOffline(text, selectedIds));
  const label = { ask: "a question → Retriever + Analyst", synthesize: "a writing task → Writer", automate: "an automation rule → Automator", brief: "a briefing → Briefer", reorganize: "reorganization → Organizer" }[route.intent];
  trace.step("Router", `Routed as ${label}`, route.reasoning || "");
  let result;
  if (route.intent === "synthesize") {
    const ids = selectedIds.length ? selectedIds : route.sourceFileIds;
    if (!ids.length) result = await answer(text);
    else {
      trace.step("Router", `Picked ${ids.length} source file${ids.length > 1 ? "s" : ""}`, ids.map((id) => fileById(id)?.title).join(" · "));
      result = await synthesize({ fileIds: ids, instruction: text, title: route.title });
    }
  } else if (route.intent === "automate") result = await createWorkflow(text);
  else if (route.intent === "brief") result = await brief();
  else if (route.intent === "reorganize") result = await reorganize();
  else result = await answer(text, { fileIds: selectedIds.length ? selectedIds : null });
  return { intent: route.intent, ...result, steps: [...trace.steps, ...result.steps.map((s) => ({ ...s, ms: s.ms + (trace.steps.at(-1)?.ms || 0) }))] };
}

function routeOffline(text, selectedIds) {
  const t = text.trim();
  let intent = "ask";
  if ((/^(when|whenever|every ?time|each time|any ?time|if)\b/i.test(t) && /\b(upload(ed|s)?|arrives?|lands?|added|comes? in|is saved|dropped|new)\b/i.test(t)) || /\bautomat(e|ically|ion)\b/i.test(t)) intent = "automate";
  else if (/\b(brief( me)?|briefing|catch me up|what'?s (new|going on|happening)|state of (my|the) drive|overview of (my|the) drive)\b/i.test(t)) intent = "brief";
  else if (/\b(re-?organi[sz]e|clean up (my|the) (drive|folders)|regroup|rebuild folders)\b/i.test(t)) intent = "reorganize";
  else if (/^(please\s+)?(draft|write|create|generate|compose|combine|merge|synthesi[sz]e|prepare|produce|make|build|turn|summari[sz]e (these|the selected|all))\b/i.test(t)) intent = "synthesize";
  let sourceFileIds = [];
  if (intent === "synthesize" && !selectedIds.length) {
    const { hits } = index.search(t, 40);
    const score = new Map();
    for (const h of hits) { const f = fileById(h.fileId); if (f && f.origin === "upload") score.set(h.fileId, (score.get(h.fileId) || 0) + h.score); }
    let ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0]?.[1] || 0;
    ranked = ranked.filter(([, s]) => s >= top * 0.3);
    if (/\b(meeting|meetings|transcripts?|syncs?|calls?)\b/i.test(t)) {
      const meetings = ranked.filter(([id]) => fileById(id).docType === "meeting-notes");
      if (meetings.length) {
        // Include every meeting in the same folder as the best match.
        const folderId = fileById(meetings[0][0]).folderId;
        sourceFileIds = db.files.filter((f) => f.docType === "meeting-notes" && f.folderId === folderId).map((f) => f.id);
      }
    }
    if (!sourceFileIds.length) sourceFileIds = ranked.slice(0, 5).map(([id]) => id);
  }
  return { intent, title: intent === "synthesize" ? titleFromInstruction(t) : "", sourceFileIds, reasoning: "keyword routing (offline)" };
}

// ================================================================ STATE

export function publicFile(f, full = false) {
  const { text, trace, ...rest } = f;
  return {
    ...rest,
    keyFacts: (f.keyFacts || []).map(({ label, value, context }) => ({ label, value, context })),
    preview: clip(text || "", 220),
    ...(full ? { text, trace } : {}),
  };
}

export function state() {
  return {
    mode: llm.enabled ? "claude" : "offline",
    model: llm.enabled ? llm.MODEL : null,
    busy: busy.count > 0 ? busy.label || "Working" : null,
    files: db.files.map((f) => publicFile(f)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    folders: db.folders.map((f) => ({ ...f, count: folderFiles(f.id).length })).filter((f) => f.count > 0),
    workflows: db.workflows,
    insights: db.insights.filter((i) => i.status === "open"),
    activity: db.activity.slice(0, 40),
  };
}

export function deleteFile(id) {
  return serial(async () => {
    const f = fileById(id);
    if (!f) return;
    db.files = db.files.filter((x) => x.id !== id);
    for (const i of db.insights) if (i.fileIds.includes(id)) { i.fileIds = i.fileIds.filter((x) => x !== id); if (i.fileIds.length < 2 && i.type !== "stale") i.status = "resolved"; if (i.type === "stale" && i.action?.fileId === id) i.status = "resolved"; }
    reindex();
    save();
    logActivity({ kind: "delete", title: `Deleted “${f.title}”`, steps: [] });
  });
}

/** "Priya" and "Priya Raman" are the same person — keep the fuller name. */
function dedupePeople(list) {
  const unique = [...new Set(list.map((p) => p.trim()).filter(Boolean))];
  return unique.filter((p) => !unique.some((o) => o !== p && o.startsWith(p + " ")));
}
