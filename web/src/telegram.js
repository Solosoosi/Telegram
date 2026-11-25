// Real Telegram connection, running entirely in the browser (GramJS over secure WebSockets).
// Nothing passes through any server other than Telegram's own.
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { getPeerId } from "telegram/Utils.js";
import bigInt from "big-integer";
import { displayName, entityUsername, parseChannelRef } from "./core.js";

// Errors where asking again won't help -> abort the sign-in flow
const FATAL_AUTH = /API_ID|PHONE_NUMBER_(INVALID|BANNED|FLOOD)|PHONE_PASSWORD_FLOOD|AUTH_RESTART|FLOOD/;

export class TelegramService {
  constructor({ apiId, apiHash, session = "" }) {
    this.apiId = Number(apiId);
    this.apiHash = String(apiHash);
    this.client = new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
      connectionRetries: 5,
      useWSS: true,
      deviceModel: "Telegram Scraper (web)",
      appVersion: "1.0",
    });
    this.client.setLogLevel("error");
    this.client.floodSleepThreshold = 300;
    this.dialogsLoaded = false;
  }

  get sessionString() {
    return this.client.session.save();
  }

  /** @returns {Promise<boolean>} true when the saved session is still logged in */
  async connect(timeoutMs = 25000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        "Couldn't reach Telegram. Check your internet connection (Telegram may be blocked on this network) and try again.",
      )), timeoutMs);
    });
    try {
      await Promise.race([this.client.connect(), timeout]);
      return await Promise.race([this.client.checkAuthorization(), timeout]);
    } catch (err) {
      await this.disconnect();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Interactive sign-in. Callbacks return promises resolved by the UI.
   * @param {{phone:string, askCode:(viaApp:boolean)=>Promise<string>, askPassword:(hint:string)=>Promise<string>,
   *          onError:(msg:string)=>void, isCancelled:()=>boolean}} cb
   */
  async signIn({ phone, askCode, askPassword, onError, isCancelled = () => false }) {
    await this.client.start({
      phoneNumber: async () => phone,
      phoneCode: async (viaApp) => askCode(viaApp),
      password: async (hint) => askPassword(hint),
      onError: async (err) => {
        if (isCancelled()) return true;
        const msg = err?.errorMessage || err?.message || String(err);
        onError(friendlyAuthError(msg));
        return FATAL_AUTH.test(msg) || msg === "AUTH_USER_CANCEL";
      },
    });
  }

  async me() {
    const me = await this.client.getMe();
    return { name: displayName(me) || (me.username ? `@${me.username}` : "you"), username: me.username || "" };
  }

  async logout() {
    try {
      await this.client.invoke(new Api.auth.LogOut());
    } finally {
      await this.disconnect();
    }
  }

  async disconnect() {
    try {
      await this.client.destroy();
    } catch {
      /* ignore */
    }
  }

  async dialogs() {
    const list = await this.client.getDialogs({ limit: 500 });
    this.dialogsLoaded = true;
    return list
      .filter((d) => d.isChannel || d.isGroup)
      .map((d) => ({
        id: String(d.id),
        title: d.title || d.name || String(d.id),
        username: entityUsername(d.entity),
        kind: d.isChannel && !d.isGroup ? "Channel" : "Group",
        members: d.entity?.participantsCount ?? null,
      }));
  }

  _info(entity, ref) {
    return {
      entity,
      peerId: String(getPeerId(entity)),
      title: displayName(entity) || ref,
      username: entityUsername(entity),
      ref,
    };
  }

  async resolve(ref) {
    const parsed = parseChannelRef(ref);
    if (parsed.type === "invalid") throw new Error("not a valid @username, t.me link or channel ID");
    if (parsed.type === "username") return this._info(await this.client.getEntity(parsed.value), ref);
    // Numeric IDs are only known to the client after the dialog list was loaded.
    const id = bigInt(parsed.value);
    try {
      return this._info(await this.client.getEntity(id), ref);
    } catch (err) {
      if (this.dialogsLoaded) throw err;
      await this.client.getDialogs({ limit: 500 });
      this.dialogsLoaded = true;
      return this._info(await this.client.getEntity(id), ref);
    }
  }

  history(channel, offsetDate) {
    return this.client.iterMessages(channel.entity, { offsetDate, waitTime: 1 });
  }

  async newer(channel, minId) {
    if (!minId) return [];
    return this.client.getMessages(channel.entity, { minId, limit: 100 });
  }

  async latestId(channel) {
    const [m] = await this.client.getMessages(channel.entity, { limit: 1 });
    return m?.id || 0;
  }

  onNewMessage(cb) {
    const event = new NewMessage({});
    const handler = (e) => {
      const m = e.message;
      if (m?.peerId) cb(m, String(getPeerId(m.peerId)));
    };
    this.client.addEventHandler(handler, event);
    return () => this.client.removeEventHandler(handler, event);
  }
}

export function friendlyAuthError(msg) {
  const map = [
    [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/, "Telegram rejected the api_id / api_hash. Copy them again from my.telegram.org."],
    [/PHONE_NUMBER_INVALID/, "That phone number isn't valid. Use international format, e.g. +972501234567."],
    [/PHONE_NUMBER_BANNED/, "This phone number is banned by Telegram."],
    [/PHONE_CODE_INVALID/, "Wrong code - please check and try again."],
    [/PHONE_CODE_EXPIRED/, "The code expired. Start the login again to get a new one."],
    [/PASSWORD_HASH_INVALID/, "Wrong 2-step verification password - try again."],
    [/FLOOD/, "Too many attempts. Telegram asks you to wait before trying again."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return msg;
}
