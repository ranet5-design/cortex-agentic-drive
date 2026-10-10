/**
 * Text utilities: tokenizing, chunking, BM25 retrieval, TF-IDF similarity,
 * and money/fact extraction. Pure functions, no dependencies — these power
 * retrieval in both modes and every agent in offline mode.
 */

export const STOP = new Set(
  `a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been being
  this that these those it its it's we our us you your they their them he she his her i me my mine
  do does did done doing have has had having will would shall should can could may might must
  not no nor so than too very just also only own same such both each few more most other some any all
  what which who whom whose when where why how there here up down out off again further once
  am pm re ve ll yes okay ok um uh like let lets get got go going gonna yeah thanks thank
  per via etc vs said say says one two three new want need make made think know see well`.split(/\s+/)
);

const SYNONYMS = {
  rent: "lease", leases: "lease", monthly: "month", months: "month", mo: "month",
  costs: "cost", spend: "cost", spending: "cost", spent: "cost", price: "cost", fee: "cost", fees: "cost",
  budgets: "budget", allocated: "budget", allocation: "budget",
  ads: "ad", advertising: "ad", advert: "ad",
  socials: "social", launches: "launch", launched: "launch", launching: "launch",
  meetings: "meeting", invoices: "invoice", customers: "customer", users: "user",
  commencing: "start", commence: "start", commences: "start", effective: "start", starting: "start", begins: "start",
};

export function normWord(w) {
  w = w.toLowerCase();
  if (SYNONYMS[w]) return SYNONYMS[w];
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return SYNONYMS[w] || w;
}

export function tokenize(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9$]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(normWord(raw));
  }
  return out;
}

export function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/** Split text into ~maxLen character chunks on paragraph/line boundaries. */
export function chunkText(text, maxLen = 700) {
  const paras = String(text).split(/\n\s*\n|\r\n\s*\r\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of paras) {
    if (p.length > maxLen) {
      push();
      // Long paragraph (e.g. a transcript without blank lines): split by lines, then sentences.
      const pieces = p.includes("\n") ? p.split(/\n/) : splitSentences(p);
      for (const piece of pieces) {
        if ((cur + "\n" + piece).length > maxLen) push();
        cur += (cur ? "\n" : "") + piece;
      }
      push();
    } else {
      if ((cur + "\n\n" + p).length > maxLen) push();
      cur += (cur ? "\n\n" : "") + p;
    }
  }
  push();
  return chunks.length ? chunks : [String(text).slice(0, maxLen)];
}

export function splitSentences(text) {
  return String(text)
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

/** BM25 index over chunks. */
export class ChunkIndex {
  constructor() { this.docs = []; this.df = new Map(); this.avgLen = 0; }

  build(files) {
    this.docs = [];
    this.df = new Map();
    for (const f of files) {
      if (!f.text) continue;
      chunkText(f.text).forEach((text, i) => {
        const tokens = tokenize(text + " " + (i === 0 ? f.title || "" : ""));
        const tf = termFreq(tokens);
        this.docs.push({ fileId: f.id, chunkNo: i, text, tf, len: tokens.length });
        for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
    return this;
  }

  idf(term) {
    const n = this.docs.length;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query, k = 8, { fileIds = null, extraTerms = [] } = {}) {
    const terms = [...new Set([...tokenize(query), ...extraTerms.flatMap(tokenize)])];
    const k1 = 1.4, b = 0.75;
    const scored = [];
    for (const d of this.docs) {
      if (fileIds && !fileIds.includes(d.fileId)) continue;
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += this.idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (s > 0) scored.push({ ...d, score: s });
    }
    scored.sort((a, b2) => b2.score - a.score);
    return { terms, hits: scored.slice(0, k) };
  }
}

/** TF-IDF vectors for whole files (used for clustering and "related files"). */
export function fileVectors(files) {
  const df = new Map();
  const tfs = files.map((f) => {
    const tf = termFreq(tokenize(`${f.title || ""} ${f.title || ""} ${(f.tags || []).join(" ")} ${f.text || ""}`));
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const n = files.length;
  const vecs = new Map();
  files.forEach((f, i) => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tfs[i]) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / (df.get(t) || 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    vecs.set(f.id, v);
  });
  return { vecs, df, n };
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) { const o = big.get(t); if (o) s += w * o; }
  return s;
}

export function centroid(vectors) {
  const c = new Map();
  for (const v of vectors) for (const [t, w] of v) c.set(t, (c.get(t) || 0) + w / vectors.length);
  let norm = 0;
  for (const w of c.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of c) c.set(t, w / norm);
  return c;
}

export function topTerms(vec, n = 5, exclude = []) {
  return [...vec.entries()]
    .filter(([t]) => t.length > 2 && !exclude.includes(t) && !/^\$/.test(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

// ---------- Money & fact extraction ----------

const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|K|m|M|million|thousand)?\b/g;

export function parseMoney(numStr, dec = "", suffix = "") {
  let v = parseFloat(String(numStr).replace(/,/g, "") + (dec || ""));
  const s = (suffix || "").toLowerCase();
  if (s === "k" || s === "thousand") v *= 1e3;
  if (s === "m" || s === "million") v *= 1e6;
  return v;
}

export function formatMoney(v) {
  return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const LABEL_NOISE = new Set([
  "agreed", "decided", "raise", "raised", "increase", "increased", "cut", "reduce", "reduced", "move", "moving",
  "set", "total", "amount", "approx", "approximately", "around", "about", "roughly", "pull", "pulling", "put",
  "keep", "keeping", "proposed", "propose", "bump", "bumped", "come", "coming", "take", "taking", "back", "now",
  "still", "sitting", "already", "line", "item", "right", "come", "goe", "go", "give", "gives", "get", "gets",
  "invoice", "due", "subtotal", "tax", "dollar", "usd", "number", "quarter", "q3", "q4", "q1", "q2", "plan", "budget",
]);

const DISPLAY_NOISE = new Set(["agreed", "decided", "raise", "raised", "cutting", "cut", "funded", "approved", "increase", "increased", "reduce", "reduced", "bump", "pulling", "set", "approx", "approximately", "around", "roughly", "far", "spent", "has", "is", "was"]);

function labelTokens(words) {
  return words.map(normWord).filter((w) => w.length > 2 && !STOP.has(w) && !LABEL_NOISE.has(w) && !/^\d/.test(w));
}

/**
 * Heuristic key-fact extraction: every money amount plus the few content words
 * around it become a fact { label, value, amount, context }.
 */
export function extractMoneyFacts(text, ext = "") {
  const facts = [];
  if (ext === "csv") {
    const rows = parseCSV(text);
    if (rows.length > 1) {
      const header = rows[0];
      for (const row of rows.slice(1)) {
        const rowLabel = row[0];
        row.forEach((cell, ci) => {
          if (ci === 0) return;
          const m = String(cell).replace(/[$,\s]/g, "");
          if (/^\d+(\.\d+)?$/.test(m) && parseFloat(m) >= 100) {
            const words = labelTokens(`${rowLabel} ${header[ci]}`.split(/\s+/));
            facts.push({
              label: words.join(" "), labelTokens: words, amount: parseFloat(m),
              value: formatMoney(parseFloat(m)), context: `${rowLabel} — ${header[ci]}: ${cell}`,
            });
          }
        });
      }
    }
    return facts;
  }
  for (const sentence of splitSentences(text)) {
    const re = new RegExp(MONEY_RE.source, "g");
    let m;
    while ((m = re.exec(sentence))) {
      const amount = parseMoney(m[1], m[2], m[3]);
      if (amount < 100) continue;
      // "raise X to $52,000 (from $45,000)": the "from" value is history, not a current figure.
      if (/\b(from|was|previously|formerly)\s*\(?\s*$/i.test(sentence.slice(0, m.index))) continue;
      const beforeText = sentence.slice(0, m.index).replace(/^[A-Z][a-z]+( [A-Z][a-z]+)?:\s*(?=\S)/, (s) => (/^(Rent|Total|Budget|Price|Cost|Fee)/.test(s) ? s : ""));
      const before = beforeText.split(/[^A-Za-z0-9]+/).filter((w) => w && !/^\d+$/.test(w)).slice(-4);
      const after = sentence.slice(m.index + m[0].length).split(/[^A-Za-z0-9]+/).filter((w) => w && !/^\d+$/.test(w)).slice(0, 2);
      const words = [...new Set(labelTokens([...before, ...after]))];
      if (!words.length) continue;
      // Human-readable label: the content words right before the amount, as written.
      const display = before.filter((w) => !STOP.has(w.toLowerCase()) && !DISPLAY_NOISE.has(w.toLowerCase())).slice(-3).join(" ") ||
        after.filter((w) => !STOP.has(w.toLowerCase())).join(" ");
      facts.push({ label: display || words.join(" "), labelTokens: words, amount, value: formatMoney(amount), context: sentence.slice(0, 240) });
    }
  }
  return facts;
}

export function parseCSV(text) {
  const rows = [];
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

export function toCSVLine(cells) {
  return cells.map((c) => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}

export function titleCase(s) {
  return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
}
