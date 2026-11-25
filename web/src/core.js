// Pure message-processing logic (no network, no DOM) - mirrors tg_scraper/messages.py.

const WORD_CHAR = "[\\p{L}\\p{N}_]";

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keyword filter. No keywords = every message matches (returns []). */
export class KeywordMatcher {
  constructor(keywords = [], { caseSensitive = false, wholeWord = false, match = "any", searchInLinks = true } = {}) {
    this.keywords = [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))];
    this.match = match === "all" ? "all" : "any";
    this.searchInLinks = searchInLinks;
    const flags = "u" + (caseSensitive ? "" : "i");
    this.patterns = this.keywords.map((kw) => {
      let body = escapeRegExp(kw);
      if (wholeWord) body = `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`;
      return [kw, new RegExp(body, flags)];
    });
    // Used by the UI to highlight matches inside message text.
    this.highlighter = this.patterns.length
      ? new RegExp(this.patterns.map(([, re]) => `(?:${re.source})`).join("|"), "g" + flags)
      : null;
  }

  get active() {
    return this.patterns.length > 0;
  }

  /** @returns {string[] | null} matched keywords, or null when the message is excluded */
  test(text) {
    if (!this.patterns.length) return [];
    const found = this.patterns.filter(([, re]) => re.test(text || "")).map(([kw]) => kw);
    if (this.match === "all") return found.length === this.patterns.length ? found : null;
    return found.length ? found : null;
  }
}

// ---------------------------------------------------------------- links
const URL_RE = /\b(?:https?:\/\/|www\.|t\.me\/)[^\s<>"'\][)(]+/giu;
const TRAILING_PUNCT = /[.,;:!?…»”’]+$/u;

export function cleanUrl(url) {
  let u = String(url || "").trim().replace(TRAILING_PUNCT, "");
  if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  return u;
}

const kind = (obj) => obj?.className || obj?.constructor?.name || "";

/** All URLs in a message: inline links, hidden (text) links, link previews and URL buttons. */
export function extractLinks(msg) {
  const links = [];
  const add = (u) => {
    const c = u ? cleanUrl(u) : "";
    if (c && !links.includes(c)) links.push(c);
  };
  const text = msg.message || "";
  for (const ent of msg.entities || []) {
    const k = kind(ent);
    // Telegram offsets are UTF-16 code units, which is exactly how JS strings index.
    if (k === "MessageEntityTextUrl") add(ent.url);
    else if (k === "MessageEntityUrl") add(text.slice(ent.offset, ent.offset + ent.length));
  }
  for (const m of text.matchAll(URL_RE)) add(m[0]);

  const media = msg.media;
  if (kind(media) === "MessageMediaWebPage" && kind(media.webpage) === "WebPage") add(media.webpage.url);

  for (const row of msg.replyMarkup?.rows || []) {
    for (const button of row.buttons || []) {
      // Older API layers: KeyboardButtonUrl{url}; newer: KeyboardButton{type: InlineButtonTypeUrl{url}}
      const url = typeof button.url === "string" ? button.url : button.type?.url;
      if (typeof url === "string") add(url);
    }
  }
  return links;
}

// ---------------------------------------------------------------- channels
export function entityUsername(entity) {
  if (!entity) return "";
  if (entity.username) return entity.username;
  for (const u of entity.usernames || []) if (u.active && u.username) return u.username;
  return "";
}

export function displayName(entity) {
  if (!entity) return "";
  if (entity.title) return entity.title;
  return [entity.firstName, entity.lastName].filter(Boolean).join(" ");
}

export function nameWithUsername(entity) {
  if (!entity) return "";
  const name = displayName(entity);
  const u = entityUsername(entity);
  if (u) return name ? `${name} (@${u})` : `@${u}`;
  return name;
}

/** Direct t.me link. Private channels use the t.me/c/ form (opens for members only). */
export function messageLink(entity, messageId) {
  const u = entityUsername(entity);
  if (u) return `https://t.me/${u}/${messageId}`;
  if (kind(entity) === "Channel") return `https://t.me/c/${String(entity.id)}/${messageId}`;
  return "";
}

export function channelSource(channel) {
  return channel.username ? `https://t.me/${channel.username}` : `Private channel (ID ${channel.peerId})`;
}

/**
 * Parse what the user typed into a channel reference.
 * @returns {{type:'username', value:string} | {type:'id', value:string} | {type:'invalid'}}
 */
export function parseChannelRef(ref) {
  const s = String(ref || "").trim();
  let m = s.match(/^(?:https?:\/\/)?t\.me\/c\/(\d+)(?:\/\d+)?\/?$/i);
  if (m) return { type: "id", value: `-100${m[1]}` };
  if (/^-?\d+$/.test(s)) return { type: "id", value: s };
  m = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})(?:\/\d+)?\/?$/i);
  if (m) return { type: "username", value: m[1] };
  m = s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/);
  if (m) return { type: "username", value: m[1] };
  return { type: "invalid" };
}

// ---------------------------------------------------------------- records
function senderName(msg, channel) {
  if (msg.postAuthor) return msg.postAuthor;
  let sender;
  try {
    sender = msg.sender;
  } catch {
    sender = undefined;
  }
  if (sender && String(sender.id) !== String(channel.entity?.id)) return nameWithUsername(sender);
  return channel.title;
}

function forwardedFrom(msg) {
  if (!msg.fwdFrom) return "";
  for (const attr of ["chat", "sender"]) {
    let ent;
    try {
      ent = msg.forward?.[attr];
    } catch {
      ent = undefined;
    }
    if (ent) return nameWithUsername(ent);
  }
  return msg.fwdFrom.fromName || msg.fwdFrom.postAuthor || "Hidden/unknown source";
}

/** Convert a Telegram message into a report row, or null when it should be skipped. */
export function buildRecord(msg, channel, matcher, collectedVia) {
  if (msg.action) return null; // service messages (joins, pins, ...)
  const text = msg.message || "";
  if (!text.trim()) return null; // text & links only: skip pure media without a caption
  const links = extractLinks(msg);
  const haystack = matcher.searchInLinks && links.length ? `${text}\n${links.join("\n")}` : text;
  const matched = matcher.test(haystack);
  if (matched === null) return null;
  return {
    key: `${channel.peerId}:${msg.id}`,
    channelTitle: channel.title,
    channelUsername: channel.username ? `@${channel.username}` : "",
    channelId: channel.peerId,
    messageId: msg.id,
    postedAt: new Date(msg.date * 1000),
    sender: senderName(msg, channel),
    forwardedFrom: forwardedFrom(msg),
    text,
    links,
    matchedKeywords: matched,
    messageLink: messageLink(channel.entity, msg.id),
    source: channelSource(channel),
    collectedVia,
  };
}
