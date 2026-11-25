// Demo mode: a simulated Telegram account with sample channels, so the interface can be
// explored (and tested) without logging in. All data here is made up.

const CHANNELS = [
  { id: 1001, title: "Market Pulse", username: "marketpulse_demo" },
  { id: 1002, title: "Tech Briefing", username: "techbriefing_demo" },
  { id: 1003, title: "Team Updates (private)", username: "" },
];

const SAMPLES = [
  "Bitcoin climbs above resistance as trading volume surges. Full analysis: https://example.com/btc-analysis",
  "Weekly security update: patch your routers now. Details in the advisory.",
  "New AI model release announced today - benchmarks look impressive.",
  "Ethereum network upgrade scheduled for next week. Read more",
  "Market wrap: stocks flat, oil slightly up, gold steady.",
  "Breaking: major cloud outage affects several regions. Status page: https://status.example.com",
  "Our quarterly report is out - thanks to everyone who contributed!",
  "Reminder: the security training session starts at 14:00.",
  "Startup funding round closes at $40M, led by two major funds.",
  "Bitcoin ETF inflows hit a weekly record according to new data.",
  "Opinion: why open-source AI matters for everyone",
  "Phishing campaign alert - do not open attachments from unknown senders.",
];

const mid = (id) => `-100${id}`;

function makeMessage(ch, id, date, text) {
  const msg = { className: "Message", id, date, message: text, entities: [], media: null, replyMarkup: null };
  const hidden = text.match(/Read more|Details in the advisory/);
  if (hidden) {
    msg.entities.push({
      className: "MessageEntityTextUrl",
      offset: hidden.index,
      length: hidden[0].length,
      url: `https://example.com/${ch.username || "internal"}/${id}`,
    });
  }
  if (id % 4 === 0) {
    msg.replyMarkup = { rows: [{ buttons: [{ className: "KeyboardButtonUrl", text: "Open", url: "https://example.com/open" }] }] };
  }
  if (id % 7 === 0) msg.fwdFrom = { fromName: "Global Newswire" };
  if (id % 9 === 0) msg.message = ""; // a photo without caption -> skipped (text & links only)
  return msg;
}

export class DemoService {
  constructor({ liveEveryMs = 6000, historyDays = 45, perDay = 6 } = {}) {
    this.isDemo = true;
    this.liveEveryMs = liveEveryMs;
    this.listeners = new Set();
    this.store = new Map();
    const now = Math.floor(Date.now() / 1000);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const ch of CHANNELS) {
      const msgs = [];
      let id = 1;
      for (let t = now - historyDays * 86400; t < now - 60; t += Math.floor((86400 / perDay) * (0.5 + rand()))) {
        msgs.push(makeMessage(ch, id++, t, SAMPLES[Math.floor(rand() * SAMPLES.length)]));
      }
      this.store.set(mid(ch.id), msgs);
    }
    this.timer = null;
  }

  get sessionString() {
    return "";
  }

  async connect() {
    return true;
  }

  async me() {
    return { name: "Demo User", username: "demo" };
  }

  async logout() {
    this.disconnect();
  }

  disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  async dialogs() {
    return CHANNELS.map((c) => ({
      id: mid(c.id),
      title: c.title,
      username: c.username,
      kind: "Channel",
      members: 1000 + c.id,
    }));
  }

  async resolve(ref) {
    const r = String(ref).trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").toLowerCase();
    const ch = CHANNELS.find((c) => c.username.toLowerCase() === r || mid(c.id) === r || String(c.id) === r);
    if (!ch) throw new Error("No channel with that name in the demo (try @marketpulse_demo)");
    const entity = { className: "Channel", id: ch.id, title: ch.title, username: ch.username || null };
    return { entity, peerId: mid(ch.id), title: ch.title, username: ch.username, ref };
  }

  async *history(channel, offsetDate) {
    const msgs = this.store.get(channel.peerId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].date >= offsetDate) continue;
      if (i % 40 === 0) await new Promise((r) => setTimeout(r, 15)); // feel like a network
      yield msgs[i];
    }
  }

  async newer(channel, minId) {
    return (this.store.get(channel.peerId) || []).filter((m) => m.id > minId);
  }

  async latestId(channel) {
    const msgs = this.store.get(channel.peerId) || [];
    return msgs.length ? msgs[msgs.length - 1].id : 0;
  }

  onNewMessage(cb) {
    this.listeners.add(cb);
    if (!this.timer) {
      this.timer = setInterval(() => this.emitRandom(), this.liveEveryMs);
    }
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** Post a new message in a random demo channel (also used by tests). */
  emitRandom(text) {
    const ch = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
    const msgs = this.store.get(mid(ch.id));
    const msg = makeMessage(ch, msgs[msgs.length - 1].id + 1, Math.floor(Date.now() / 1000),
      text || SAMPLES[Math.floor(Math.random() * SAMPLES.length)]);
    if (!msg.message) msg.message = SAMPLES[0];
    msgs.push(msg);
    for (const cb of this.listeners) cb(msg, mid(ch.id));
    return msg;
  }
}
