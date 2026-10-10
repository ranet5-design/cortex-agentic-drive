/**
 * Tiny JSON-file persistence layer. The whole drive (file metadata + text,
 * smart folders, workflows, insights, activity log) lives in data/db.json;
 * original uploaded bytes live in data/files/.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
export const FILES_DIR = path.join(DATA_DIR, "files");

const EMPTY = () => ({ files: [], folders: [], workflows: [], insights: [], activity: [], seeded: false });

export const db = load();

function load() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return EMPTY();
  try {
    return { ...EMPTY(), ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
  } catch (err) {
    console.error("Could not read db.json, starting fresh:", err.message);
    return EMPTY();
  }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH + ".tmp", JSON.stringify(db, null, 2));
    fs.renameSync(DB_PATH + ".tmp", DB_PATH);
  }, 150);
}

export function reset() {
  Object.assign(db, EMPTY());
  fs.rmSync(FILES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  save();
}

export const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

export function storeBytes(id, name, buffer) {
  const safe = name.replace(/[^\w.\- ]+/g, "_");
  fs.writeFileSync(path.join(FILES_DIR, `${id}-${safe}`), buffer);
}

export function logActivity(entry) {
  db.activity.unshift({ id: uid("act"), at: new Date().toISOString(), ...entry });
  db.activity = db.activity.slice(0, 200);
  save();
}

export const fileById = (id) => db.files.find((f) => f.id === id);
export const folderById = (id) => db.folders.find((f) => f.id === id);
