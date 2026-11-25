// Orchestrates a collection run against a "service" (real Telegram or the demo).
//
// Service interface:
//   resolve(ref)                -> ChannelInfo {entity, peerId, title, username, ref}  (throws if not found)
//   history(channel, endSec)    -> async iterable of messages, newest first, older than endSec
//   newer(channel, minId)       -> Promise<messages with id > minId>
//   latestId(channel)           -> Promise<number>
//   onNewMessage(cb)            -> unsubscribe fn; cb(message, peerId)
import { buildRecord, channelSource, KeywordMatcher } from "./core.js";

export const MODES = ["both", "history", "live"];

export class Collector {
  /**
   * @param service  Telegram/demo service
   * @param handlers {onStatus, onChannel, onRecord, onLog}
   */
  constructor(service, handlers = {}) {
    this.service = service;
    this.h = { onStatus() {}, onChannel() {}, onRecord() {}, onLog() {}, ...handlers };
    this.records = new Map();
    this.stopped = false;
    this._wake = null;
  }

  stop() {
    this.stopped = true;
    if (this._wake) this._wake();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this._wake = done;
    });
  }

  _add(rec) {
    if (!rec || this.records.has(rec.key)) return false;
    this.records.set(rec.key, rec);
    this.h.onRecord(rec);
    return true;
  }

  /**
   * @param {{channels:string[], keywords:string[], options:object, start:Date, end:Date, mode:string, pollSeconds:number}} p
   */
  async run(p) {
    const startSec = Math.floor(p.start.getTime() / 1000);
    const endSec = Math.floor(p.end.getTime() / 1000);
    let doHistory = p.mode !== "live";
    let doLive = p.mode !== "history";
    if (doLive && p.end.getTime() <= Date.now()) {
      if (p.mode === "live") throw new Error("Live mode needs an end date in the future.");
      this.h.onLog("info", "End date is in the past - collecting history only.");
      doLive = false;
    }
    this.matcher = new KeywordMatcher(p.keywords, p.options);
    this.summary = { requested: [...p.channels], channels: [], failed: [], doHistory, doLive, ...p };

    // 1. Resolve channels
    this.h.onStatus({ phase: "resolving" });
    const channels = [];
    const seen = new Set();
    for (const ref of p.channels) {
      if (this.stopped) break;
      try {
        const ch = await this.service.resolve(ref);
        if (seen.has(ch.peerId)) continue;
        seen.add(ch.peerId);
        const state = { ...ch, source: channelSource(ch), scanned: 0, kept: 0, status: "waiting", lastId: 0 };
        channels.push(state);
        this.h.onChannel(state);
      } catch (err) {
        this.summary.failed.push(ref);
        this.h.onLog("warn", `Could not find channel "${ref}": ${err.message || err}`);
        this.h.onChannel({ ref, title: ref, failed: true, status: "not found", error: String(err.message || err) });
      }
    }
    this.summary.channels = channels;
    if (!channels.length) throw new Error("None of the channels could be found. Check the channel list.");
    const byPeer = new Map(channels.map((c) => [String(c.peerId), c]));

    // 2. Live handler first, so nothing posted during the history pass is missed
    let unsubscribe = null;
    if (doLive) {
      unsubscribe = this.service.onNewMessage((msg, peerId) => {
        try {
          const ch = byPeer.get(String(peerId));
          if (!ch || msg.date < startSec || msg.date > endSec) return;
          ch.lastId = Math.max(ch.lastId, msg.id);
          if (this._add(buildRecord(msg, ch, this.matcher, "Live"))) {
            ch.kept++;
            this.h.onChannel(ch);
          }
        } catch (err) {
          this.h.onLog("warn", `Failed to process a live message: ${err.message || err}`);
        }
      });
    }

    try {
      // 3. History
      if (doHistory) {
        this.h.onStatus({ phase: "history" });
        for (const ch of channels) {
          if (this.stopped) break;
          await this._history(ch, startSec, endSec);
        }
      }

      // 4. Live: push updates (joined channels) + polling (works for every channel)
      if (doLive && !this.stopped) {
        for (const ch of channels) {
          if (!ch.lastId) {
            try {
              ch.lastId = await this.service.latestId(ch);
            } catch {
              ch.lastId = 0;
            }
          }
          ch.status = "listening";
          this.h.onChannel(ch);
        }
        this.h.onStatus({ phase: "live", until: p.end });
        const pollMs = Math.max(10, p.pollSeconds || 30) * 1000;
        while (!this.stopped && Date.now() < p.end.getTime()) {
          await this._sleep(Math.min(pollMs, p.end.getTime() - Date.now()));
          if (this.stopped) break;
          for (const ch of channels) await this._poll(ch, startSec, endSec);
        }
      }
    } finally {
      if (unsubscribe) unsubscribe();
    }
    for (const ch of channels) {
      if (ch.status !== "error") ch.status = this.stopped ? "stopped" : "done";
      this.h.onChannel(ch);
    }
    this.h.onStatus({ phase: this.stopped ? "stopped" : "done" });
    return [...this.records.values()];
  }

  async _history(ch, startSec, endSec) {
    ch.status = "scanning";
    this.h.onChannel(ch);
    try {
      for await (const msg of this.service.history(ch, endSec + 1)) {
        if (this.stopped) break;
        if (msg.date < startSec) break;
        ch.lastId = Math.max(ch.lastId, msg.id);
        if (msg.date > endSec) continue;
        ch.scanned++;
        ch.oldestSeen = msg.date;
        if (this._add(buildRecord(msg, ch, this.matcher, "History"))) ch.kept++;
        if (ch.scanned % 25 === 0) this.h.onChannel(ch);
      }
      ch.status = "scanned";
    } catch (err) {
      ch.status = "error";
      ch.error = humanError(err);
      this.h.onLog("warn", `${ch.title}: ${ch.error} (partial results kept)`);
    }
    this.h.onChannel(ch);
  }

  async _poll(ch, startSec, endSec) {
    try {
      const msgs = await this.service.newer(ch, ch.lastId);
      for (const msg of [...msgs].sort((a, b) => a.id - b.id)) {
        ch.lastId = Math.max(ch.lastId, msg.id);
        if (msg.date < startSec || msg.date > endSec) continue;
        if (this._add(buildRecord(msg, ch, this.matcher, "Live"))) ch.kept++;
      }
      this.h.onChannel(ch);
    } catch (err) {
      this.h.onLog("warn", `${ch.title}: polling failed - ${humanError(err)}`);
    }
  }
}

export function humanError(err) {
  const msg = err?.errorMessage || err?.message || String(err);
  if (/FLOOD/i.test(msg)) {
    const s = err?.seconds ? ` (${err.seconds}s)` : "";
    return `Telegram rate limit${s} - try again later`;
  }
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/.test(msg)) return "No access to this channel (join it first)";
  return msg;
}
