// Credentials & settings storage. Nothing here ever leaves the browser.
//
// - "Remember on this device": credentials + login session are encrypted with a passphrase
//   (PBKDF2-SHA256, 310k iterations -> AES-256-GCM) and stored in localStorage.
// - Otherwise they live in sessionStorage only and are gone when the tab is closed.
// - Settings (channels, keywords, options) are not secret and are stored in plain localStorage.

const VAULT_KEY = "tgscraper.vault.v1";
const TAB_KEY = "tgscraper.tab.v1";
const SETTINGS_KEY = "tgscraper.settings.v1";
const ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function safeGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store, key, value) {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function safeRemove(store, key) {
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJSON(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return JSON.stringify({ v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

export async function decryptJSON(blob, passphrase) {
  const { iter, salt, iv, ct } = JSON.parse(blob);
  const key = await deriveKey(passphrase, unb64(salt), iter);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error("Wrong passphrase");
  }
}

// ---------------------------------------------------------------- vault (remembered login)
export const vault = {
  exists: () => !!safeGet(localStorage, VAULT_KEY),
  async save(data, passphrase) {
    safeSet(localStorage, VAULT_KEY, await encryptJSON(data, passphrase));
  },
  async open(passphrase) {
    const blob = safeGet(localStorage, VAULT_KEY);
    if (!blob) throw new Error("Nothing saved on this device");
    return decryptJSON(blob, passphrase);
  },
  clear: () => safeRemove(localStorage, VAULT_KEY),
};

// ---------------------------------------------------------------- this-tab-only login
export const tabLogin = {
  load() {
    try {
      return JSON.parse(safeGet(sessionStorage, TAB_KEY) || "null");
    } catch {
      return null;
    }
  },
  save: (data) => safeSet(sessionStorage, TAB_KEY, JSON.stringify(data)),
  clear: () => safeRemove(sessionStorage, TAB_KEY),
};

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  channels: [],
  labels: {},
  keywords: [],
  options: { match: "any", caseSensitive: false, wholeWord: false, searchInLinks: true },
  mode: "both",
  pollSeconds: 30,
};

export const settingsStore = {
  load() {
    try {
      const s = JSON.parse(safeGet(localStorage, SETTINGS_KEY) || "{}");
      return { ...DEFAULT_SETTINGS, ...s, options: { ...DEFAULT_SETTINGS.options, ...(s.options || {}) } };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  },
  save: (s) => safeSet(localStorage, SETTINGS_KEY, JSON.stringify(s)),
};

// ---------------------------------------------------------------- credentials file
export function validateCredentials({ apiId, apiHash, phone }) {
  const problems = [];
  if (!/^\d{3,12}$/.test(String(apiId || "").trim())) problems.push("api_id must be a number (e.g. 1234567).");
  if (!/^[0-9a-f]{32}$/i.test(String(apiHash || "").trim())) problems.push("api_hash must be the 32-character code from my.telegram.org.");
  const p = normalizePhone(phone);
  if (!/^\+?\d{7,15}$/.test(p)) problems.push("Phone must be in international format, e.g. +972501234567.");
  return problems;
}

export const normalizePhone = (p) => String(p || "").replace(/[\s\-().]/g, "");

/** Parse credentials.ini (same file the Python version uses) or a JSON file. */
export function parseCredentialsFile(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    return { apiId: String(j.api_id ?? j.apiId ?? ""), apiHash: String(j.api_hash ?? j.apiHash ?? ""), phone: String(j.phone ?? "") };
  }
  const out = {};
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const m = line.match(/^([A-Za-z_]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return { apiId: out.api_id || "", apiHash: out.api_hash || "", phone: out.phone || "" };
}

export function credentialsFileText({ apiId, apiHash, phone }) {
  return [
    "# Telegram API credentials - KEEP THIS FILE PRIVATE. Do not share or commit it.",
    "# Works with both the web app (Load credentials file) and the Python scraper.",
    "[telegram]",
    `api_id = ${String(apiId).trim()}`,
    `api_hash = ${String(apiHash).trim()}`,
    `phone = ${normalizePhone(phone)}`,
    "session_name = telegram_scraper",
    "",
  ].join("\n");
}
