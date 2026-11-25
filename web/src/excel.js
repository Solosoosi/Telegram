// Excel report built in the browser - same layout as the Python version:
// Summary, All Messages, and one sheet per channel.

const MAX_CELL = 32767;
const ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const SAFE_LINK = /^(https?|tg):\/\//i;
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } };
const LINK_FONT = { color: { argb: "FF0563C1" }, underline: true };

export const COLUMNS = [
  ["Channel", 24],
  ["Channel Username", 20],
  ["Posted At", 20],
  ["Sender", 22],
  ["Forwarded From", 22],
  ["Text", 70],
  ["Links", 45],
  ["Matched Keywords", 20],
  ["Message Link", 36],
  ["Source", 30],
  ["Message ID", 11],
  ["Collected Via", 13],
];

export function clean(value) {
  let v = String(value ?? "").replace(ILLEGAL, "");
  if (v.length > MAX_CELL) v = v.slice(0, MAX_CELL - 15) + " …[truncated]";
  return v;
}

export function safeSheetName(name, used) {
  const base = (String(name || "Channel").replace(/[[\]:*?/\\]/g, "_").replace(/^[' ]+|[' ]+$/g, "") || "Channel").slice(0, 31);
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Excel has no time zones: store the wall-clock time of the viewer's zone. */
export function excelLocalDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

export function timeZoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

function link(cell, url, label) {
  const text = clean(label ?? url);
  if (url && SAFE_LINK.test(url)) {
    cell.value = { text, hyperlink: url };
    cell.font = LINK_FONT;
  } else {
    cell.value = text;
  }
}

function header(ws, titles, widths) {
  ws.addRow(titles);
  ws.columns.forEach((col, i) => (col.width = widths[i]));
  ws.getRow(1).eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
    c.alignment = { vertical: "middle" };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function messagesSheet(wb, name, records, tz) {
  const ws = wb.addWorksheet(name);
  header(ws, COLUMNS.map(([h]) => (h === "Posted At" ? `Posted At (${tz})` : h)), COLUMNS.map(([, w]) => w));
  records.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    const set = (col, v) => (row.getCell(col).value = clean(v));
    set(1, r.channelTitle);
    set(2, r.channelUsername);
    const posted = row.getCell(3);
    posted.value = excelLocalDate(r.postedAt);
    posted.numFmt = "yyyy-mm-dd hh:mm:ss";
    set(4, r.sender);
    set(5, r.forwardedFrom);
    set(6, r.text);
    if (r.links.length === 1) link(row.getCell(7), r.links[0]);
    else set(7, r.links.join("\n"));
    set(8, r.matchedKeywords.join(", "));
    link(row.getCell(9), r.messageLink);
    link(row.getCell(10), r.source.startsWith("https://") ? r.source : "", r.source);
    row.getCell(11).value = r.messageId;
    set(12, r.collectedVia);
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.alignment = { vertical: "top", wrapText: [6, 7, 8].includes(col) };
    });
  });
  if (records.length) ws.autoFilter = { from: "A1", to: { row: records.length + 1, column: COLUMNS.length } };
}

/**
 * @param records   report rows (see core.buildRecord)
 * @param meta      ordered [label, value] pairs for the Summary sheet
 * @param channels  [{title, source}] in the order they were requested (keeps empty channels visible)
 */
export async function buildWorkbook(ExcelJS, records, meta, channels = []) {
  const tz = timeZoneLabel();
  const sorted = [...records].sort((a, b) => a.postedAt - b.postedAt || a.channelTitle.localeCompare(b.channelTitle) || a.messageId - b.messageId);
  const groups = new Map();
  for (const c of channels) groups.set(`${c.title}\u0000${c.source}`, { title: c.title, source: c.source, rows: [] });
  for (const r of sorted) {
    const k = `${r.channelTitle}\u0000${r.source}`;
    if (!groups.has(k)) groups.set(k, { title: r.channelTitle, source: r.source, rows: [] });
    groups.get(k).rows.push(r);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Telegram Scraper";
  wb.created = new Date();

  const s = wb.addWorksheet("Summary");
  s.columns = [{ width: 28 }, { width: 60 }, { width: 16 }];
  s.getCell("A1").value = "Telegram Scrape Report";
  s.getCell("A1").font = { bold: true, size: 14 };
  let row = 3;
  for (const [label, value] of [...meta, ["Total messages", sorted.length]]) {
    s.getCell(row, 1).value = label;
    s.getCell(row, 1).font = { bold: true };
    s.getCell(row, 2).value = typeof value === "number" ? value : clean(value);
    s.getCell(row, 2).alignment = { wrapText: true, vertical: "top" };
    row++;
  }
  row++;
  ["Channel", "Source", "Messages"].forEach((h, i) => {
    const c = s.getCell(row, i + 1);
    c.value = h;
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  for (const g of groups.values()) {
    row++;
    s.getCell(row, 1).value = clean(g.title);
    link(s.getCell(row, 2), g.source.startsWith("https://") ? g.source : "", g.source);
    s.getCell(row, 3).value = g.rows.length;
  }

  const used = new Set(["summary", "all messages"]);
  messagesSheet(wb, "All Messages", sorted, tz);
  for (const g of groups.values()) messagesSheet(wb, safeSheetName(g.title, used), g.rows, tz);
  return wb;
}

export function reportFileName(start, end, now = new Date()) {
  const d = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const t = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `telegram_${d(start)}_to_${d(end)}_${d(now)}_${t}.xlsx`;
}

/** Build the workbook and trigger a browser download. */
export async function downloadWorkbook(records, meta, channels, fileName) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = await buildWorkbook(ExcelJS, records, meta, channels);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
