import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { Collector } from "../src/collector.js";
import { buildRecord, extractLinks, KeywordMatcher, messageLink, parseChannelRef } from "../src/core.js";
import { DemoService } from "../src/demo.js";
import { buildWorkbook, excelLocalDate, safeSheetName } from "../src/excel.js";
import { credentialsFileText, decryptJSON, encryptJSON, parseCredentialsFile, validateCredentials } from "../src/storage.js";

const channel = (username = "newschan", id = 1234567890, title = "News Channel") => ({
  entity: { className: "Channel", id, title, username },
  peerId: `-100${id}`,
  title,
  username: username || "",
});
const msg = (text, extra = {}) => ({ id: 10, date: Date.UTC(2026, 10, 20, 8, 30) / 1000, message: text, ...extra });

describe("KeywordMatcher", () => {
  it("matches any keyword, case-insensitive", () => {
    const m = new KeywordMatcher(["Bitcoin", "ETH"]);
    expect(m.test("bitcoin is up")).toEqual(["Bitcoin"]);
    expect(m.test("nothing")).toBeNull();
  });
  it("supports all-mode", () => {
    const m = new KeywordMatcher(["a1", "b2"], { match: "all" });
    expect(m.test("a1 b2")).toEqual(["a1", "b2"]);
    expect(m.test("a1")).toBeNull();
  });
  it("whole words work with Hebrew and symbols", () => {
    const m = new KeywordMatcher(["art", "#tag", "שלום"], { wholeWord: true });
    expect(m.test("start")).toBeNull();
    expect(m.test("modern art.")).toEqual(["art"]);
    expect(m.test("see #tag!")).toEqual(["#tag"]);
    expect(m.test("אמר שלום לכולם")).toEqual(["שלום"]);
    expect(m.test("שלומית")).toBeNull();
  });
  it("no keywords = everything", () => {
    expect(new KeywordMatcher([]).test("x")).toEqual([]);
  });
  it("highlighter finds every keyword", () => {
    const m = new KeywordMatcher(["btc", "eth"]);
    expect([..."BTC and eth".matchAll(m.highlighter)].map((x) => x[0])).toEqual(["BTC", "eth"]);
  });
});

describe("links", () => {
  it("extracts inline, hidden, preview and button links (UTF-16 offsets)", () => {
    const text = "Read 🚀 example.com/a, and click here.";
    const m = msg(text, {
      entities: [
        { className: "MessageEntityUrl", offset: 8, length: 13 },
        { className: "MessageEntityTextUrl", offset: 30, length: 4, url: "https://hidden.example/x" },
      ],
      media: { className: "MessageMediaWebPage", webpage: { className: "WebPage", url: "https://preview.example/p" } },
      replyMarkup: { rows: [{ buttons: [{ className: "KeyboardButtonUrl", url: "https://button.example" },
        { className: "KeyboardButton", type: { className: "InlineButtonTypeUrl", url: "https://new-layer.example" } }] }] },
    });
    expect(extractLinks(m)).toEqual(["https://example.com/a", "https://hidden.example/x", "https://preview.example/p",
      "https://button.example", "https://new-layer.example"]);
  });
  it("finds plain URLs and trims punctuation", () => {
    expect(extractLinks(msg("see https://x.io/p?q=1. and t.me/chan"))).toEqual(["https://x.io/p?q=1", "https://t.me/chan"]);
  });
  it("builds message links", () => {
    expect(messageLink(channel().entity, 55)).toBe("https://t.me/newschan/55");
    expect(messageLink(channel(null).entity, 55)).toBe("https://t.me/c/1234567890/55");
  });
  it("parses channel references", () => {
    expect(parseChannelRef("@foo_bar")).toEqual({ type: "username", value: "foo_bar" });
    expect(parseChannelRef("https://t.me/foo_bar/12")).toEqual({ type: "username", value: "foo_bar" });
    expect(parseChannelRef("t.me/s/foo_bar")).toEqual({ type: "username", value: "foo_bar" });
    expect(parseChannelRef("https://t.me/c/1234/99")).toEqual({ type: "id", value: "-1001234" });
    expect(parseChannelRef("-1001234")).toEqual({ type: "id", value: "-1001234" });
    expect(parseChannelRef("not a channel!")).toEqual({ type: "invalid" });
  });
});

describe("buildRecord", () => {
  it("filters and fills all fields", () => {
    const r = buildRecord(msg("Big LAUNCH today", { fwdFrom: { fromName: "Wire" } }), channel(), new KeywordMatcher(["launch"]), "History");
    expect(r).toMatchObject({
      matchedKeywords: ["launch"], messageLink: "https://t.me/newschan/10", source: "https://t.me/newschan",
      channelId: "-1001234567890", forwardedFrom: "Wire", sender: "News Channel", channelUsername: "@newschan",
    });
    expect(r.postedAt.toISOString()).toBe("2026-11-20T08:30:00.000Z");
    expect(buildRecord(msg("unrelated"), channel(), new KeywordMatcher(["launch"]), "History")).toBeNull();
    expect(buildRecord(msg(""), channel(), new KeywordMatcher([]), "History")).toBeNull();
    expect(buildRecord(msg("x", { action: {} }), channel(), new KeywordMatcher([]), "History")).toBeNull();
  });
  it("can match keywords inside links", () => {
    const m = msg("look", { entities: [{ className: "MessageEntityTextUrl", offset: 0, length: 4, url: "https://s/launch-news" }] });
    expect(buildRecord(m, channel(), new KeywordMatcher(["launch"]), "Live").matchedKeywords).toEqual(["launch"]);
    expect(buildRecord(m, channel(), new KeywordMatcher(["launch"], { searchInLinks: false }), "Live")).toBeNull();
  });
});

describe("Collector with the demo service", () => {
  it("collects history in range, reports missing channels", async () => {
    const svc = new DemoService({ historyDays: 20, perDay: 4 });
    const c = new Collector(svc);
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 86400000);
    const recs = await c.run({ channels: ["@marketpulse_demo", "-1001003", "@nope_channel"], keywords: ["bitcoin"],
      options: {}, start, end: new Date(end.getTime() - 1000), mode: "both" });
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => /bitcoin/i.test(r.text))).toBe(true);
    expect(recs.every((r) => r.postedAt >= start && r.postedAt <= end)).toBe(true);
    expect(c.summary.failed).toEqual(["@nope_channel"]);
    expect(c.summary.doLive).toBe(false); // end in the past -> history only
    expect(new Set(recs.map((r) => r.channelTitle))).toEqual(new Set(["Market Pulse", "Team Updates (private)"]));
  });

  it("picks up live messages (push + polling) and de-duplicates", async () => {
    const svc = new DemoService({ liveEveryMs: 1e9 });
    const c = new Collector(svc);
    const start = new Date(Date.now() - 3600e3);
    const end = new Date(Date.now() + 1500);
    const p = c.run({ channels: ["@techbriefing_demo"], keywords: ["breaking"], options: {}, start, end, mode: "live", pollSeconds: 0.5 });
    await new Promise((r) => setTimeout(r, 200));
    svc.emitRandom("BREAKING: something happened");
    svc.emitRandom("BREAKING: second");
    svc.emitRandom("nothing relevant");
    const recs = await p;
    const live = recs.filter((r) => r.collectedVia === "Live");
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(new Set(recs.map((r) => r.key)).size).toBe(recs.length);
    expect(recs.every((r) => /breaking/i.test(r.text))).toBe(true);
  });

  it("can be stopped", async () => {
    const svc = new DemoService({ liveEveryMs: 1e9 });
    const c = new Collector(svc);
    const p = c.run({ channels: ["@marketpulse_demo"], keywords: [], options: {}, start: new Date(Date.now() - 86400e3),
      end: new Date(Date.now() + 3600e3), mode: "both", pollSeconds: 30 });
    setTimeout(() => c.stop(), 300);
    await p;
    expect(c.stopped).toBe(true);
  });

  it("rejects live mode with a past end date", async () => {
    const c = new Collector(new DemoService());
    await expect(c.run({ channels: ["@marketpulse_demo"], keywords: [], options: {}, start: new Date(0),
      end: new Date(Date.now() - 1000), mode: "live" })).rejects.toThrow(/future/);
  });
});

describe("Excel", () => {
  it("writes Summary, All Messages and per-channel sheets", async () => {
    const a = channel();
    const b = channel(null, 42, "Private: Ops/Team");
    const m = new KeywordMatcher([]);
    const recs = [
      buildRecord(msg("=SUM(1,2) not a formula\x07", { id: 1 }), a, m, "History"),
      buildRecord(msg("second https://x.io", { id: 2, date: Date.UTC(2026, 10, 21) / 1000 }), b, m, "Live"),
    ];
    const wb = await buildWorkbook(ExcelJS, recs, [["Keywords", "x"]], [{ title: a.title, source: "https://t.me/newschan" }]);
    const buf = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    expect(back.worksheets.map((w) => w.name)).toEqual(["Summary", "All Messages", "News Channel", "Private_ Ops_Team"]);
    const ws = back.getWorksheet("All Messages");
    expect(ws.getCell("A1").value).toBe("Channel");
    expect(ws.getCell("F2").value).toBe("=SUM(1,2) not a formula");
    expect(ws.getCell("F2").type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell("I2").value).toEqual({ text: "https://t.me/newschan/1", hyperlink: "https://t.me/newschan/1" });
    expect(ws.getCell("I3").value).toEqual({ text: "https://t.me/c/42/2", hyperlink: "https://t.me/c/42/2" });
    expect(ws.getCell("G3").value).toEqual({ text: "https://x.io", hyperlink: "https://x.io" });
    expect(ws.getCell("L3").value).toBe("Live");
    expect(ws.getCell("C2").value).toBeInstanceOf(Date);
    expect(back.getWorksheet("News Channel").rowCount).toBe(2);
  });
  it("sheet names are valid and unique", () => {
    const used = new Set(["summary"]);
    expect(safeSheetName("Summary", used)).toBe("Summary (2)");
    expect(safeSheetName("x".repeat(40), used)).toBe("x".repeat(31));
    expect(safeSheetName("x".repeat(40), used)).toBe("x".repeat(27) + " (2)");
  });
  it("stores local wall-clock time", () => {
    const d = new Date(2026, 0, 5, 14, 30);
    expect(excelLocalDate(d).toISOString().slice(0, 16)).toBe("2026-01-05T14:30");
  });
});

describe("storage", () => {
  it("encrypts and decrypts, wrong passphrase fails", async () => {
    const blob = await encryptJSON({ session: "secret-session" }, "correct horse");
    expect(blob).not.toContain("secret-session");
    expect(await decryptJSON(blob, "correct horse")).toEqual({ session: "secret-session" });
    await expect(decryptJSON(blob, "wrong")).rejects.toThrow("Wrong passphrase");
  });
  it("reads the Python credentials.ini format and JSON", () => {
    const ini = credentialsFileText({ apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef", phone: "+972 50-123-4567" });
    expect(parseCredentialsFile(ini)).toEqual({ apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef", phone: "+972501234567" });
    expect(parseCredentialsFile('{"api_id": 1, "api_hash": "h", "phone": "+1"}')).toEqual({ apiId: "1", apiHash: "h", phone: "+1" });
  });
  it("validates credentials", () => {
    expect(validateCredentials({ apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef", phone: "+972501234567" })).toEqual([]);
    expect(validateCredentials({ apiId: "x", apiHash: "short", phone: "12" })).toHaveLength(3);
  });
});
