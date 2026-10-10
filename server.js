/**
 * Cortex — the agentic drive. Zero-framework Node HTTP server:
 * serves the UI from public/ and a small JSON API that fronts the agents.
 *
 *   npm start            start (seeds the demo drive on first run)
 *   npm run reset        wipe data/ and re-seed
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, reset, fileById } from "./lib/store.js";
import * as agents from "./lib/agents.js";
import * as llm from "./lib/llm.js";

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function seed() {
  console.log("Seeding the demo drive…");
  db.seeded = true;
  for (const wf of agents.DEFAULT_WORKFLOWS) agents.addWorkflow(wf);
  const dir = path.join(ROOT, "seed");
  for (const name of fs.readdirSync(dir).sort()) {
    const buffer = fs.readFileSync(path.join(dir, name));
    // Strip the "01-" ordering prefix used to control seed order.
    const res = await agents.ingest({ name: name.replace(/^\d+-/, ""), buffer });
    console.log(`  ✓ ${res.file.title}`);
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJSON(req, limit = 30 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Upload too large (30 MB max)."), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const routes = {
  "GET /api/state": () => agents.state(),
  "GET /api/file": (_, q) => {
    const f = fileById(q.get("id"));
    if (!f) throw Object.assign(new Error("File not found"), { status: 404 });
    return agents.publicFile(f, true);
  },
  "POST /api/upload": async (body) => {
    if (!body.name || !body.data) throw Object.assign(new Error("name and data are required"), { status: 400 });
    return agents.ingest({ name: body.name, buffer: Buffer.from(body.data, "base64") });
  },
  "POST /api/command": (body) => agents.command(String(body.text || "").slice(0, 2000), body.selected || []),
  "POST /api/ask": (body) => agents.answer(String(body.question || ""), { fileIds: body.fileIds?.length ? body.fileIds : null }),
  "POST /api/synthesize": (body) => agents.synthesize({ fileIds: body.fileIds || [], instruction: body.instruction || "Combine these files into one clear summary document.", title: body.title || "" }),
  "POST /api/refresh": (body) => agents.refresh(body.fileId, body.addSources || []),
  "POST /api/brief": () => agents.brief(),
  "POST /api/reorganize": () => agents.reorganize(),
  "POST /api/workflows": (body) => agents.createWorkflow(String(body.text || "")),
  "POST /api/workflows/toggle": (body) => {
    const wf = db.workflows.find((w) => w.id === body.id);
    if (wf) wf.enabled = !wf.enabled;
    return { workflow: wf };
  },
  "POST /api/insights/dismiss": (body) => {
    const i = db.insights.find((x) => x.id === body.id);
    if (i) i.status = "dismissed";
    return { ok: true };
  },
  "POST /api/delete": async (body) => { await agents.deleteFile(body.id); return { ok: true }; },
  "POST /api/reset": async () => { reset(); await seed(); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) {
    try {
      const body = req.method === "POST" ? await readJSON(req) : {};
      const out = await routes[key](body, url.searchParams);
      if (req.method === "POST") (await import("./lib/store.js")).save();
      return send(res, 200, out);
    } catch (err) {
      console.error(key, err);
      return send(res, err.status || 500, { error: err.message });
    }
  }
  if (req.method !== "GET") return send(res, 404, { error: "Not found" });
  // Static files.
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

if (process.argv.includes("--reset")) reset();
agents.reindex();
server.listen(PORT, () => {
  console.log(`\nCortex agentic drive → http://localhost:${PORT}`);
  console.log(llm.enabled ? `Agents powered by ${llm.MODEL}` : "No ANTHROPIC_API_KEY found — running agents in offline heuristic mode");
  if (!db.seeded) seed().catch((err) => console.error("Seeding failed:", err));
});
