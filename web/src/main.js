import "./style.css";
import { Collector, humanError } from "./collector.js";
import { KeywordMatcher, parseChannelRef } from "./core.js";
import { DemoService } from "./demo.js";
import { downloadWorkbook, reportFileName, timeZoneLabel } from "./excel.js";
import {
  credentialsFileText, normalizePhone, parseCredentialsFile, settingsStore, tabLogin, validateCredentials, vault,
} from "./storage.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SAFE_URL = /^https?:\/\//i;
const PAGE = 100;

const state = {
  service: null,
  demo: false,
  settings: settingsStore.load(),
  collector: null,
  running: false,
  records: [],
  newKeys: new Set(),
  channels: new Map(),
  run: null,
  exported: 0,
  visible: PAGE,
  dialogs: null,
};

// ================================================================ helpers
function toast(msg, kind = "info", ms = 4500) {
  const t = el("div", `toast ${kind}`, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

const fmtDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtNum = new Intl.NumberFormat();

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function avatar(title) {
  const a = el("span", "avatar", ([...String(title || "?").trim()][0] || "?").toUpperCase());
  a.style.background = `hsl(${hue(title)} 55% 50%)`;
  a.setAttribute("aria-hidden", "true");
  return a;
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v) {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : null;
}

function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ================================================================ theme
const THEME_KEY = "tgscraper.theme";
function initTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t) document.documentElement.dataset.theme = t;
  } catch {
    /* ignore */
  }
  $("#theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  });
}

// ================================================================ auth
let pending = null;
let authError = "";
let cancelled = false;

function showStep(name) {
  for (const s of $$(".auth-step")) s.hidden = s.dataset.step !== name;
  const step = $(`.auth-step[data-step="${name}"]`);
  const input = step && $("input:not([type=checkbox]):not([type=file])", step);
  if (input && !matchMedia("(pointer: coarse)").matches) setTimeout(() => input.focus(), 30);
}
function formError(step, msg) {
  const box = $(`.auth-step[data-step="${step}"] .form-error`);
  if (!box) return;
  box.textContent = msg || "";
  box.hidden = !msg;
}
function busy(text) {
  $("#busy-text").textContent = text;
  showStep("busy");
}
function waitFor(step) {
  return new Promise((resolve) => {
    pending = { step, resolve };
    showStep(step);
    formError(step, authError);
    authError = "";
  });
}

function readCredForm() {
  return { apiId: $("#api-id").value.trim(), apiHash: $("#api-hash").value.trim(), phone: normalizePhone($("#phone").value) };
}
function fillCredForm(c) {
  if (!c) return;
  $("#api-id").value = c.apiId || "";
  $("#api-hash").value = c.apiHash || "";
  $("#phone").value = c.phone || "";
}

async function login(creds, { passphrase = null, returnStep = "credentials" } = {}) {
  cancelled = false;
  authError = "";
  busy("Loading Telegram client…");
  let svc;
  try {
    const { TelegramService } = await import("./telegram.js");
    svc = new TelegramService({ apiId: creds.apiId, apiHash: creds.apiHash, session: creds.session || "" });
    busy("Connecting to Telegram…");
    const authorized = await svc.connect();
    if (!authorized) {
      busy("Sending login code…");
      await svc.signIn({
        phone: creds.phone,
        askCode: (viaApp) => {
          $("#code").value = "";
          $("#code-hint").textContent = viaApp
            ? "Telegram sent a code to your Telegram app. Look for a message from \"Telegram\"."
            : "Telegram sent the code to your phone by SMS.";
          return waitFor("code").then((v) => (busy("Checking code…"), v));
        },
        askPassword: (hint) => {
          $("#password").value = "";
          $("#password-hint").textContent = hint
            ? `Your account has an extra password. Hint: ${hint}`
            : "Your account is protected with an extra password.";
          return waitFor("password").then((v) => (busy("Checking password…"), v));
        },
        onError: (msg) => (authError = msg),
        isCancelled: () => cancelled,
      });
    }
    const data = { apiId: creds.apiId, apiHash: creds.apiHash, phone: creds.phone, session: svc.sessionString };
    if (passphrase) await vault.save(data, passphrase);
    tabLogin.save(data);
    await enterApp(svc, false);
  } catch (err) {
    if (svc) await svc.disconnect();
    const msg = authError || humanError(err);
    authError = "";
    fillCredForm(creds);
    showStep(returnStep);
    if (!cancelled) formError(returnStep, msg);
  }
}

function initAuth() {
  $("#remember").addEventListener("change", (e) => {
    $("#remember-fields").hidden = !e.target.checked;
  });
  $$(".reveal-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.reveal);
      input.type = input.type === "password" ? "text" : "password";
      b.textContent = input.type === "password" ? "Show" : "Hide";
    }),
  );

  $("#cred-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 64 * 1024) return formError("credentials", "That file is too large to be a credentials file.");
    try {
      const c = parseCredentialsFile(await file.text());
      fillCredForm(c);
      const problems = validateCredentials(c);
      formError("credentials", problems.length ? `Loaded ${file.name}, but: ${problems.join(" ")}` : "");
      if (!problems.length) toast(`Loaded credentials from ${file.name}`);
    } catch {
      formError("credentials", "Couldn't read that file. Use a credentials.ini or .json file.");
    }
  });

  $("#cred-save-file").addEventListener("click", () => {
    const c = readCredForm();
    const problems = validateCredentials(c);
    if (problems.length) return formError("credentials", problems.join(" "));
    formError("credentials", "");
    download("credentials.ini", credentialsFileText(c));
    toast("Saved credentials.ini. Keep it private.");
  });

  $("#cred-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = readCredForm();
    const problems = validateCredentials(c);
    let passphrase = null;
    if ($("#remember").checked) {
      const p1 = $("#pass1").value;
      if (p1.length < 6) problems.push("Choose a passphrase of at least 6 characters.");
      else if (p1 !== $("#pass2").value) problems.push("The passphrases don't match.");
      passphrase = p1;
    }
    if (problems.length) return formError("credentials", problems.join(" "));
    formError("credentials", "");
    login(c, { passphrase });
  });

  for (const step of ["code", "password"]) {
    $(`#${step}-form`).addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $(`#${step}`).value.trim();
      if (!v || pending?.step !== step) return;
      const p = pending;
      pending = null;
      p.resolve(v);
    });
  }
  $$(".auth-cancel").forEach((b) =>
    b.addEventListener("click", () => {
      cancelled = true;
      if (pending) {
        const p = pending;
        pending = null;
        p.resolve("");
      }
      showStep("credentials");
    }),
  );

  $("#unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("#unlock-pass").value;
    try {
      busy("Unlocking…");
      const data = await vault.open(pass);
      $("#unlock-pass").value = "";
      await login(data, { passphrase: pass, returnStep: data.session ? "unlock" : "credentials" });
    } catch (err) {
      showStep("unlock");
      formError("unlock", err.message);
    }
  });
  $("#forget-btn").addEventListener("click", () => {
    if (!confirm("Remove the saved login from this device?")) return;
    vault.clear();
    tabLogin.clear();
    showStep("credentials");
  });

  $("#demo-btn").addEventListener("click", () => startDemo());
}

function startDemo() {
  state.demo = true;
  state.settings = {
    ...settingsStore.load(),
    channels: ["@marketpulse_demo", "@techbriefing_demo", "-1001003"],
    labels: { "-1001003": "Team Updates (private)" },
    keywords: ["bitcoin", "security", "outage"],
    mode: "both",
  };
  enterApp(new DemoService({ liveEveryMs: 4000 }), true);
}

async function enterApp(svc, demo) {
  state.service = svc;
  state.demo = demo;
  let me = { name: "" };
  try {
    me = await svc.me();
  } catch {
    /* ignore */
  }
  $("#account-pill").textContent = demo ? "Demo account" : me.name;
  $("#account-pill").hidden = false;
  $("#demo-badge").hidden = !demo;
  $("#logout-btn").textContent = demo ? "Exit demo" : "Log out";
  $("#logout-btn").hidden = false;
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  renderSetup();
  setDefaultDates();
  renderAll();
}

async function logout() {
  if (state.running && !confirm("A collection is running. Stop it and log out?")) return;
  if (!state.demo && !confirm("Log out of Telegram on this site? The saved login on this device will be removed too.")) return;
  state.collector?.stop();
  const svc = state.service;
  state.service = null;
  try {
    await svc?.logout();
  } catch {
    /* ignore */
  }
  if (!state.demo) {
    vault.clear();
    tabLogin.clear();
  }
  location.hash = "";
  location.reload();
}

// ================================================================ setup panel
function saveSettings() {
  if (!state.demo) settingsStore.save(state.settings);
}

function chip(label, title, onRemove, cls = "") {
  const c = el("span", `chip ${cls}`);
  const l = el("span", "chip-label", label);
  if (title) c.title = title;
  const x = el("button", "", "✕");
  x.type = "button";
  x.setAttribute("aria-label", `Remove ${label}`);
  x.addEventListener("click", onRemove);
  c.append(l, x);
  return c;
}

function renderSetup() {
  const s = state.settings;
  const chans = $("#channel-chips");
  chans.replaceChildren(
    ...s.channels.map((ref) =>
      chip(s.labels?.[ref] || ref, ref, () => {
        s.channels = s.channels.filter((r) => r !== ref);
        saveSettings();
        renderSetup();
        renderPicker();
      }),
    ),
  );
  if (!s.channels.length) chans.append(el("span", "muted small", "No channels yet. Add one below or browse your channels."));

  $("#keyword-chips").replaceChildren(
    ...s.keywords.map((kw) =>
      chip(kw, null, () => {
        s.keywords = s.keywords.filter((k) => k !== kw);
        saveSettings();
        renderSetup();
      }, "chip-kw"),
    ),
  );
  $("#keyword-hint").textContent = s.keywords.length
    ? `A message is kept if it contains ${s.options.match === "all" ? "all of these keywords" : "at least one of these keywords"}.`
    : "No keywords, so every message with text will be collected.";
  for (const b of $$("[data-match]")) b.setAttribute("aria-checked", String(b.dataset.match === s.options.match));
  for (const b of $$("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  $("#opt-case").checked = s.options.caseSensitive;
  $("#opt-word").checked = s.options.wholeWord;
  $("#opt-links").checked = s.options.searchInLinks;
  $("#tz-label").textContent = timeZoneLabel();
  updateModeHint();
}

function updateModeHint() {
  const end = fromLocalInput($("#end").value);
  const future = end && end.getTime() > Date.now();
  const until = end ? fmtDate.format(end) : "the end date";
  const hint = $("#mode-hint");
  hint.style.color = "";
  switch (state.settings.mode) {
    case "history":
      hint.textContent = "Collects the past messages in the period.";
      break;
    case "live":
      hint.textContent = future ? `Collects only new messages, from now until ${until}.` : "Live only needs a \"To\" date in the future.";
      if (!future) hint.style.color = "var(--danger)";
      break;
    default:
      hint.textContent = future
        ? `Collects history from the start date, then keeps listening for new messages until ${until}.`
        : "The \"To\" date has passed, so only history will be collected. Pick a future date to keep listening.";
  }
}

function setDefaultDates() {
  const now = new Date();
  $("#start").value = toLocalInput(new Date(now.getTime() - 7 * 86400000));
  const eod = new Date(now);
  eod.setHours(23, 59, 0, 0);
  $("#end").value = toLocalInput(state.settings.mode === "history" ? now : eod);
  updateModeHint();
}

function applyPreset(target, preset) {
  const now = new Date();
  let d = new Date(now);
  const m = preset.match(/^([+-])(\d+)([hd])$/);
  if (m) {
    const ms = Number(m[2]) * (m[3] === "h" ? 3600000 : 86400000);
    d = new Date(now.getTime() + (m[1] === "+" ? ms : -ms));
  } else if (preset === "eod") {
    d.setHours(23, 59, 0, 0);
  }
  $(`#${target}`).value = toLocalInput(d);
  updateModeHint();
}

function addChannels(text) {
  const s = state.settings;
  const bad = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const p = parseChannelRef(part);
    if (p.type === "invalid") {
      bad.push(part);
      continue;
    }
    const ref = p.type === "username" ? `@${p.value}` : p.value;
    if (!s.channels.some((r) => r.toLowerCase() === ref.toLowerCase())) s.channels.push(ref);
  }
  saveSettings();
  renderSetup();
  if (bad.length) toast(`Not a valid channel: ${bad.join(", ")}. Use @username, a t.me link or an ID.`, "warn");
  return !bad.length;
}

function initSetup() {
  $("#channel-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#channel-input");
    if (input.value.trim() && addChannels(input.value)) input.value = "";
  });
  $("#keyword-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#keyword-input");
    const s = state.settings;
    for (const kw of input.value.split(/[,\n]+/).map((k) => k.trim()).filter(Boolean)) {
      if (!s.keywords.includes(kw)) s.keywords.push(kw);
    }
    input.value = "";
    saveSettings();
    renderSetup();
  });
  for (const b of $$("[data-match]")) {
    b.addEventListener("click", () => {
      state.settings.options.match = b.dataset.match;
      saveSettings();
      renderSetup();
    });
  }
  for (const b of $$("[data-mode]")) {
    b.addEventListener("click", () => {
      state.settings.mode = b.dataset.mode;
      saveSettings();
      renderSetup();
    });
  }
  const opt = { "#opt-case": "caseSensitive", "#opt-word": "wholeWord", "#opt-links": "searchInLinks" };
  for (const [sel, key] of Object.entries(opt)) {
    $(sel).addEventListener("change", (e) => {
      state.settings.options[key] = e.target.checked;
      saveSettings();
    });
  }
  for (const group of $$(".presets")) {
    for (const b of $$("button", group)) b.addEventListener("click", () => applyPreset(group.dataset.target, b.dataset.preset));
  }
  $("#start").addEventListener("input", updateModeHint);
  $("#end").addEventListener("input", updateModeHint);
  $("#run-btn").addEventListener("click", startRun);
  $("#stop-btn").addEventListener("click", () => {
    state.collector?.stop();
    $("#stop-btn").disabled = true;
    $("#stop-btn").textContent = "Stopping…";
  });
  $("#logout-btn").addEventListener("click", logout);
  $("#browse-btn").addEventListener("click", openPicker);
}

function setRunning(running) {
  state.running = running;
  for (const e of $$(".setup input, .setup button, .setup select")) e.disabled = running;
  $("#run-btn").hidden = running;
  $("#stop-btn").hidden = !running;
  $("#stop-btn").disabled = false;
  $("#stop-btn").textContent = "Stop";
}

function setupError(msg) {
  const box = $("#setup-error");
  box.textContent = msg || "";
  box.hidden = !msg;
}

// ================================================================ run
async function startRun() {
  setupError("");
  const s = state.settings;
  const start = fromLocalInput($("#start").value);
  const end = fromLocalInput($("#end").value);
  if (!s.channels.length) return setupError("Add at least one channel.");
  if (!start || !end) return setupError("Choose both a \"From\" and a \"To\" date.");
  if (start >= end) return setupError("\"From\" must be before \"To\".");
  if (s.mode === "live" && end <= new Date()) return setupError("Live only needs a \"To\" date in the future.");
  if (state.records.length > state.exported &&
      !confirm("Start a new collection? Results you haven't exported yet will be cleared.")) return;

  state.records = [];
  state.newKeys.clear();
  state.channels.clear();
  state.exported = 0;
  state.visible = PAGE;
  state.run = { start, end, mode: s.mode, keywords: [...s.keywords], options: { ...s.options }, failed: [] };
  state.run.highlighter = new KeywordMatcher(state.run.keywords, state.run.options).highlighter;
  $("#run-panel").hidden = false;
  setRunning(true);
  renderAll();

  const collector = new Collector(state.service, {
    onStatus: (st) => {
      state.run.phase = st.phase;
      state.run.until = st.until;
      scheduleRender();
    },
    onChannel: (ch) => {
      state.channels.set(ch.peerId || `ref:${ch.ref}`, { ...ch });
      scheduleRender();
    },
    onRecord: (rec) => {
      state.records.push(rec);
      if (rec.collectedVia === "Live") state.newKeys.add(rec.key);
      scheduleRender();
    },
    onLog: (level, msg) => toast(msg, level === "warn" ? "warn" : "info"),
  });
  state.collector = collector;
  try {
    await collector.run({ channels: [...s.channels], keywords: s.keywords, options: s.options, start, end, mode: s.mode, pollSeconds: s.pollSeconds });
    state.run.failed = collector.summary.failed;
    state.run.doLive = collector.summary.doLive;
    state.run.doHistory = collector.summary.doHistory;
    toast(`Finished: ${fmtNum.format(state.records.length)} messages collected.`);
  } catch (err) {
    state.run.phase = "stopped";
    state.run.failed = collector.summary?.failed || [];
    setupError(humanError(err));
  } finally {
    if (collector.summary) {
      state.run.doLive = collector.summary.doLive;
      state.run.doHistory = collector.summary.doHistory;
    }
    state.collector = null;
    setRunning(false);
    renderAll();
  }
}

// ================================================================ rendering
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderAll();
  });
}

function renderAll() {
  renderStats();
  renderProgress();
  renderFilterOptions();
  renderResults();
  $("#export-btn").disabled = !state.records.length;
}

function renderStats() {
  const chans = [...state.channels.values()].filter((c) => !c.failed);
  $("#stat-kept").textContent = fmtNum.format(state.records.length);
  $("#stat-scanned").textContent = fmtNum.format(chans.reduce((n, c) => n + (c.scanned || 0), 0));
  $("#stat-channels").textContent = fmtNum.format(chans.length);
  $("#stat-live").textContent = fmtNum.format(state.records.filter((r) => r.collectedVia === "Live").length);
}

const PHASES = {
  resolving: "Finding channels…",
  history: "Collecting history…",
  live: "Listening for new messages",
  done: "Finished",
  stopped: "Stopped",
};

function renderProgress() {
  const run = state.run;
  if (!run) return;
  const phase = $("#phase");
  phase.dataset.phase = run.phase || "resolving";
  phase.textContent = PHASES[run.phase] || "Starting…";
  $("#phase-detail").textContent =
    run.phase === "live" && run.until ? `until ${fmtDate.format(run.until)}. Press Stop to finish early.` :
    `${fmtDate.format(run.start)} → ${fmtDate.format(run.end)}`;

  const startSec = run.start.getTime() / 1000;
  const endSec = run.end.getTime() / 1000;
  const items = [...state.channels.values()].map((c) => {
    const li = el("li", "progress-item");
    li.dataset.status = c.status;
    const title = el("span", "progress-title", c.title || c.ref);
    title.append(el("span", "status-tag", c.status));
    const count = el("span", "progress-count",
      c.failed ? c.error || "" : `${fmtNum.format(c.kept || 0)} kept · ${fmtNum.format(c.scanned || 0)} scanned`);
    const bar = el("div", "bar");
    const fill = el("i");
    let pct = 0;
    if (["scanned", "done"].includes(c.status)) pct = 100;
    else if (c.status === "scanning" && c.oldestSeen) pct = Math.min(99, ((endSec - c.oldestSeen) / (endSec - startSec)) * 100);
    fill.style.width = `${Math.max(0, pct)}%`;
    bar.append(fill);
    li.append(title, count, bar);
    if (c.status === "error" && c.error) li.title = c.error;
    return li;
  });
  $("#progress-list").replaceChildren(...items);
}

function renderFilterOptions() {
  const sel = $("#channel-filter");
  const current = sel.value;
  const counts = new Map();
  for (const r of state.records) counts.set(r.channelId, (counts.get(r.channelId) || 0) + 1);
  const opts = [el("option", "", `All channels (${fmtNum.format(state.records.length)})`)];
  opts[0].value = "";
  for (const c of state.channels.values()) {
    if (c.failed) continue;
    const o = el("option", "", `${c.title} (${fmtNum.format(counts.get(c.peerId) || 0)})`);
    o.value = c.peerId;
    opts.push(o);
  }
  sel.replaceChildren(...opts);
  sel.value = [...sel.options].some((o) => o.value === current) ? current : "";
}

function highlightInto(node, text, regex) {
  if (!regex) {
    node.textContent = text;
    return;
  }
  let last = 0;
  regex.lastIndex = 0;
  for (const m of text.matchAll(regex)) {
    if (!m[0]) continue;
    node.append(document.createTextNode(text.slice(last, m.index)), el("mark", "", m[0]));
    last = m.index + m[0].length;
  }
  node.append(document.createTextNode(text.slice(last)));
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const s = x.host + (x.pathname === "/" ? "" : x.pathname) + x.search;
    return s.length > 48 ? s.slice(0, 46) + "…" : s;
  } catch {
    return u;
  }
}

function messageEl(rec, regex) {
  const li = el("li", "msg");
  if (state.newKeys.has(rec.key)) li.classList.add("is-new");
  const body = el("div", "msg-body");
  const head = el("div", "msg-head");
  head.append(el("span", "msg-channel", rec.channelTitle), el("time", "msg-time", fmtDate.format(rec.postedAt)));
  head.lastChild.dateTime = rec.postedAt.toISOString();
  if (rec.sender && rec.sender !== rec.channelTitle) head.append(el("span", "msg-meta", `by ${rec.sender}`));
  if (rec.forwardedFrom) head.append(el("span", "msg-meta", `↪ forwarded from ${rec.forwardedFrom}`));
  if (rec.collectedVia === "Live") head.append(el("span", "tag tag-live", "Live"));
  for (const kw of rec.matchedKeywords) head.append(el("span", "tag tag-kw", kw));

  const text = el("p", "msg-text clamped");
  highlightInto(text, rec.text, regex);
  text.title = "Click to expand";
  text.addEventListener("click", () => text.classList.toggle("clamped"));
  body.append(head, text);

  const safeLinks = rec.links.filter((u) => SAFE_URL.test(u));
  if (safeLinks.length) {
    const links = el("div", "msg-links");
    for (const u of safeLinks) {
      const a = el("a", "", "🔗 " + shortUrl(u));
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.title = u;
      links.append(a);
    }
    body.append(links);
  }
  const actions = el("div", "msg-actions");
  if (rec.messageLink) {
    const a = el("a", "", "Open in Telegram ↗");
    a.href = rec.messageLink;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const copy = el("a", "", "Copy link");
    copy.href = rec.messageLink;
    copy.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(rec.messageLink);
        toast("Link copied");
      } catch {
        toast("Couldn't copy the link", "warn");
      }
    });
    actions.append(a, copy);
  }
  body.append(actions);
  li.append(avatar(rec.channelTitle), body);
  return li;
}

function filteredRecords() {
  const q = $("#search").value.trim().toLowerCase();
  const ch = $("#channel-filter").value;
  let list = state.records;
  if (ch) list = list.filter((r) => r.channelId === ch);
  if (q) {
    list = list.filter((r) =>
      r.text.toLowerCase().includes(q) || r.channelTitle.toLowerCase().includes(q) ||
      r.sender.toLowerCase().includes(q) || r.links.some((l) => l.toLowerCase().includes(q)));
  }
  return [...list].sort((a, b) => b.postedAt - a.postedAt || b.messageId - a.messageId);
}

function renderResults() {
  const list = filteredRecords();
  const regex = state.run?.highlighter || null;
  const shown = list.slice(0, state.visible);
  $("#results-list").replaceChildren(...shown.map((r) => messageEl(r, regex)));
  state.newKeys.clear();
  $("#empty-state").hidden = state.records.length > 0;
  $("#more-btn").hidden = list.length <= shown.length;
  $("#more-btn").textContent = `Show more (${fmtNum.format(list.length - shown.length)} more)`;
  const total = state.records.length;
  $("#results-meta").textContent = !total ? "" :
    list.length === total ? `Showing ${fmtNum.format(shown.length)} of ${fmtNum.format(total)} messages, newest first` :
    `${fmtNum.format(list.length)} of ${fmtNum.format(total)} messages match your search`;
}

function initResults() {
  let t;
  $("#search").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.visible = PAGE;
      renderResults();
    }, 150);
  });
  $("#channel-filter").addEventListener("change", () => {
    state.visible = PAGE;
    renderResults();
  });
  $("#more-btn").addEventListener("click", () => {
    state.visible += PAGE;
    renderResults();
  });
  $("#export-btn").addEventListener("click", exportExcel);
}

async function exportExcel() {
  const run = state.run;
  if (!run || !state.records.length) return;
  const btn = $("#export-btn");
  btn.disabled = true;
  try {
    const tz = timeZoneLabel();
    const chans = [...state.channels.values()].filter((c) => !c.failed);
    const failed = [...state.channels.values()].filter((c) => c.failed).map((c) => c.ref);
    const method = [run.doHistory !== false && run.mode !== "live" ? "Chat history" : null,
      (run.doLive ?? run.mode !== "history") ? "Live new messages" : null].filter(Boolean).join(" + ");
    const o = run.options;
    const meta = [
      ["Generated at", `${fmtDate.format(new Date())} (${tz})`],
      ["Collection period", `${fmtDate.format(run.start)} -> ${fmtDate.format(run.end)} (${tz})`],
      ["Collection method", method],
      ["Channels", chans.map((c) => `${c.title} - ${c.source}`).join("\n")],
      ["Channels not found", failed.join("\n") || "-"],
      ["Keywords", run.keywords.join(", ") || "(none - all messages)"],
      ["Keyword match", `${o.match}; case-sensitive=${o.caseSensitive}; whole-word=${o.wholeWord}; search-in-links=${o.searchInLinks}`],
    ];
    if (state.running) meta.push(["Note", "Exported while collection was still running"]);
    const count = state.records.length;
    await downloadWorkbook(state.records, meta, chans.map((c) => ({ title: c.title, source: c.source })), reportFileName(run.start, run.end));
    state.exported = count;
    toast(`Excel file downloaded (${fmtNum.format(count)} messages).`);
  } catch (err) {
    toast(`Export failed: ${err.message || err}`, "error");
  } finally {
    btn.disabled = !state.records.length;
  }
}

// ================================================================ channel picker
async function openPicker() {
  const dlg = $("#picker");
  dlg.showModal();
  $("#picker-search").value = "";
  if (!state.dialogs) {
    $("#picker-list").replaceChildren(el("li", "picker-empty", "Loading your channels…"));
    try {
      state.dialogs = await state.service.dialogs();
    } catch (err) {
      $("#picker-list").replaceChildren(el("li", "picker-empty", `Couldn't load channels: ${humanError(err)}`));
      return;
    }
  }
  renderPicker();
  $("#picker-search").focus();
}

function renderPicker() {
  if (!state.dialogs || !$("#picker").open) return;
  const q = $("#picker-search").value.trim().toLowerCase();
  const s = state.settings;
  const has = (ref) => s.channels.some((r) => r.toLowerCase() === ref.toLowerCase());
  const items = state.dialogs
    .filter((d) => !q || d.title.toLowerCase().includes(q) || d.username.toLowerCase().includes(q))
    .map((d) => {
      const ref = d.username ? `@${d.username}` : d.id;
      const li = el("li", "picker-item");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      const info = el("div");
      const sub = [d.kind, d.username ? `@${d.username}` : "private", d.members ? `${fmtNum.format(d.members)} members` : null].filter(Boolean).join(" · ");
      info.append(el("div", "picker-name", d.title), el("div", "picker-sub", sub));
      li.append(avatar(d.title), info, el("span", "added", has(ref) ? "Added ✓" : ""));
      const toggle = () => {
        if (has(ref)) s.channels = s.channels.filter((r) => r.toLowerCase() !== ref.toLowerCase());
        else {
          s.channels.push(ref);
          if (!d.username) s.labels = { ...(s.labels || {}), [ref]: d.title };
        }
        saveSettings();
        renderSetup();
        renderPicker();
      };
      li.addEventListener("click", toggle);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      return li;
    });
  $("#picker-list").replaceChildren(...(items.length ? items : [el("li", "picker-empty", "No matching channels or groups.")]));
}

// ================================================================ boot
function init() {
  initTheme();
  initAuth();
  initSetup();
  initResults();
  $("#picker-search").addEventListener("input", renderPicker);

  window.addEventListener("beforeunload", (e) => {
    if (state.running || state.records.length > state.exported) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if (location.hash === "#demo") return startDemo();
  const tab = tabLogin.load();
  if (tab?.session) {
    fillCredForm(tab);
    login(tab, { returnStep: "credentials" });
  } else if (vault.exists()) {
    showStep("unlock");
  } else {
    showStep("credentials");
  }
}

init();
