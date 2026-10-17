/* Caivan Deficiency Log — pure logic (no screen, no network). Tested by tests/logic.test.js. */
(function (root) {
  const CATS = [
    ["CB (catch basin)", "--u-green", "CB"], ["GLB (ground-level box)", "--u-red", "GLB"], ["CMB (mailbox)", "--u-orange", "CMB"],
    ["Landscaping / sod / trees", "--u-green", "Landscaping"], ["Fencing", "--u-brown", "Fencing"],
    ["Concrete – curb / sidewalk", "--u-grey"], ["Asphalt / road", "--u-grey"], ["Storm MH / sewer", "--u-green"], ["Sanitary sewer", "--u-green"],
    ["Watermain / valve / hydrant", "--u-blue"], ["Grading / drainage", "--u-purple"], ["Streetlight / electrical", "--u-red"],
    ["Signage / pavement marking", "--u-yellow"], ["Safety / site condition", "--u-red"], ["Other", "--u-grey"]];
  const TABS = [["All", null], ["CB", "CB (catch basin)"], ["GLB", "GLB (ground-level box)"], ["CMB", "CMB (mailbox)"],
    ["Landscaping", "Landscaping / sod / trees"], ["Fencing", "Fencing"], ["Other", "__other"]];
  const MAIN = new Set(TABS.slice(1, 6).map(t => t[1]));
  const STAT = ["Open", "In progress", "Ready for re-inspection", "Closed"];
  const DEFAULT_DUE = 14;
  const PROJECTS = ["Conservancy", "Fox Run", "Richmond North", "Cassette", "The Ridge", "Orleans Village"];

  // Dates: always local calendar days, ISO strings in storage.
  let todayOverride = null;
  const today = () => { const d = todayOverride ? new Date(todayOverride) : new Date(); d.setHours(0, 0, 0, 0); return d; };
  const parseD = s => { if (!s) return null; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const days = (a, b) => Math.round((b - a) / 86400000);
  const dueOf = it => { const d = parseD(it.due); if (d) return d; const r = parseD(it.raised); if (!r) return null; const x = new Date(r); x.setDate(x.getDate() + DEFAULT_DUE); return x; };
  const isClosed = it => it.status === "Closed";
  const ageOf = it => { const r = parseD(it.raised); if (!r) return 0; const end = isClosed(it) && parseD(it.closed) ? parseD(it.closed) : today(); return Math.max(0, days(r, end)); };
  const isLate = it => { if (isClosed(it)) return false; const d = dueOf(it); return d ? today() > d : false; };
  const daysLate = it => { const d = dueOf(it); return d ? days(d, today()) : 0; };
  const isNew = it => { const d = parseD(it.first_seen || it.raised); return d ? days(d, today()) <= 7 : false; };
  const catShort = c => (CATS.find(k => k[0] === c) || [])[2] || c || "Other";
  const catColor = c => { const f = CATS.find(x => x[0] === c); return f ? f[1] : "--u-grey"; };
  const inTab = (it, tab) => tab === "All" || (tab === "Other" ? !MAIN.has(it.category) : (TABS.find(t => t[0] === tab) || [])[1] === it.category);

  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const keyOf = it => it.ext_ref ? "ref:" + norm(it.ext_ref) : "loc:" + norm(it.project) + "|" + norm(it.location) + "|" + norm(it.category) + "|" + norm(it.description).slice(0, 40);

  // ---------- import normalizers ----------
  function normDate(s) {
    if (s instanceof Date && !isNaN(s)) return iso(s);
    s = String(s == null ? "" : s).trim(); if (!s) return "";
    if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Math.round((+s - 25569) * 86400000)); return iso(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
    let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(s);
    if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; const a = +m[1], b = +m[2]; const mo = a > 12 ? b : a, da = a > 12 ? a : b; return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`; }
    const d = new Date(s); return isNaN(d) ? "" : iso(d);
  }
  function normStatus(s) { s = String(s || "").toLowerCase(); if (/clos|complet|done|accept|resolv|fixed/.test(s)) return "Closed"; if (/re-?insp|ready|review|verify/.test(s)) return "Ready for re-inspection"; if (/progress|working|started|ongoing/.test(s)) return "In progress"; return "Open"; }
  function normPri(s) { s = String(s || "").toLowerCase(); if (/high|urgent|critical|^1$/.test(s)) return "High"; if (/low|^3$|minor/.test(s)) return "Low"; return "Medium"; }
  function normCat(...parts) {
    const s = " " + parts.join(" ").toLowerCase() + " ";
    if (CATS.some(c => c[0].toLowerCase() === s.trim())) return CATS.find(c => c[0].toLowerCase() === s.trim())[0];
    if (/\bcmb\b|mailbox|mail box|canada post/.test(s)) return "CMB (mailbox)";
    if (/\bglb\b|ground.?level box|hydro box|pedestal|transformer|vault/.test(s)) return "GLB (ground-level box)";
    if (/\bcbs?\b|catch ?basin|cbmh/.test(s)) return "CB (catch basin)";
    if (/fenc/.test(s)) return "Fencing";
    if (/sod|landscap|tree|topsoil|seed|planting/.test(s)) return "Landscaping / sod / trees";
    if (/curb|sidewalk|concrete/.test(s)) return "Concrete – curb / sidewalk";
    if (/asphalt|pavement|road|pothole/.test(s)) return "Asphalt / road";
    if (/\bmh\b|manhole|storm/.test(s)) return "Storm MH / sewer";
    if (/sanitary|\bsan\b/.test(s)) return "Sanitary sewer";
    if (/valve|hydrant|water/.test(s)) return "Watermain / valve / hydrant";
    if (/grad|swale|drain|ponding/.test(s)) return "Grading / drainage";
    if (/streetlight|light|electric/.test(s)) return "Streetlight / electrical";
    if (/sign|marking/.test(s)) return "Signage / pavement marking";
    if (/safety|hazard/.test(s)) return "Safety / site condition";
    return "Other";
  }

  const ALIAS = {
    ext_ref: ["id", "item", "item #", "item no", "item no.", "no", "no.", "#", "ref", "reference", "deficiency #", "def #", "number"],
    project: ["project", "site", "subdivision", "development", "job"],
    location: ["location", "lot", "address", "block", "station", "street", "area", "lot/block", "civic", "page label", "space"],
    category: ["category", "type", "item type", "trade", "discipline", "asset", "subject"],
    description: ["description", "deficiency", "comment", "comments", "issue", "details", "contents", "work required"],
    contractor: ["contractor", "assigned to", "assignee", "responsible", "responsibility", "sub", "subcontractor", "trade contractor", "company"],
    priority: ["priority", "severity", "urgency"],
    raised: ["raised", "date", "date raised", "created", "date created", "inspection date", "date identified", "identified", "found", "reported"],
    due: ["due", "due date", "target", "target date", "deadline"],
    status: ["status", "state", "progress"],
    closed: ["closed", "date closed", "completed", "completion date", "date completed"],
    notes: ["notes", "remarks", "follow up", "follow-up", "update"]
  };

  // Turns a sheet (array of rows) into deficiency rows. source: "tracker" | "bluebeam".
  function mapTable(table, opts) {
    opts = opts || {}; const fp = (opts.defaultProject || "").trim(); const source = opts.source || "tracker";
    const r = table.map(row => row.map(c => (c == null ? "" : c)));
    if (r.length < 2) return { rows: [], cols: {}, header: [] };
    let hi = 0, best = -1;
    r.slice(0, 15).forEach((row, i) => { const h = row.map(x => String(x).trim().toLowerCase()); const sc = Object.values(ALIAS).filter(a => h.some(x => a.includes(x))).length; if (sc > best) { best = sc; hi = i; } });
    const hdr = r[hi].map(h => String(h).trim().toLowerCase()), cols = {};
    const extra = {};
    if (source === "bluebeam") { ["page label", "space", "subject", "comments", "author", "layer"].forEach(n => { const j = hdr.indexOf(n); if (j >= 0) extra[n] = j; }); }
    for (const k in ALIAS) {
      let j = hdr.findIndex(h => ALIAS[k].includes(h));
      if (j < 0 && k !== "ext_ref") j = hdr.findIndex(h => h && ALIAS[k].some(a => a.length > 3 && h.includes(a)));
      if (j >= 0 && !Object.values(cols).includes(j)) cols[k] = j;
    }
    const rows = r.slice(hi + 1).map(x => {
      const g = k => cols[k] != null ? String(x[cols[k]] ?? "").trim() : "";
      const e = n => extra[n] != null ? String(x[extra[n]] ?? "").trim() : "";
      const st = normStatus(g("status"));
      let o;
      if (source === "bluebeam") {
        const loc = [e("space"), e("page label") ? "Dwg " + e("page label") : ""].filter(Boolean).join(" – ") || g("location");
        o = { ext_ref: "", project: g("project") || fp, location: loc, category: normCat(e("subject"), e("comments")),
          description: e("comments") || e("subject") || g("description"), contractor: g("contractor") || e("layer") || "Unassigned",
          priority: normPri(g("priority")), raised: normDate(cols.raised != null ? x[cols.raised] : "") || iso(today()), due: "",
          status: st, closed: st === "Closed" ? iso(today()) : "", notes: "" };
      } else {
        o = { ext_ref: g("ext_ref"), project: g("project") || fp, location: g("location"), category: normCat(g("category"), g("description")),
          description: g("description"), contractor: g("contractor") || "Unassigned", priority: normPri(g("priority")),
          raised: normDate(cols.raised != null ? x[cols.raised] : "") || iso(today()), due: normDate(cols.due != null ? x[cols.due] : ""),
          status: st, closed: st === "Closed" ? (normDate(cols.closed != null ? x[cols.closed] : "") || iso(today())) : "", notes: g("notes") };
      }
      o.key = keyOf(o); return o;
    }).filter(x => x.description || x.location);
    return { rows, cols, header: hdr };
  }

  const MERGE_FIELDS = ["status", "due", "contractor", "priority", "description", "location", "category", "closed", "notes", "project"];
  // Compares imported rows with existing items. Returns {add:[row], upd:[[item, changes]], same:n}.
  function planImport(rows, existing) {
    const byKey = new Map(existing.filter(x => !x.deleted_at).map(x => [x.key || keyOf(x), x]));
    const seen = new Set(); const plan = { add: [], upd: [], same: 0 };
    rows.forEach(r => {
      if (seen.has(r.key)) return; seen.add(r.key);
      const ex = byKey.get(r.key);
      if (!ex) { plan.add.push(r); return; }
      const ch = {};
      MERGE_FIELDS.forEach(f => {
        if (!r[f] || r[f] === (ex[f] || "")) return;
        if (f === "closed" && ex.closed) return;
        if (f === "notes") { if (!(ex.notes || "").includes(r.notes)) ch.notes = ex.notes ? ex.notes + " | " + r.notes : r.notes; return; }
        ch[f] = r[f];
      });
      if (ch.status && ch.status !== "Closed") ch.closed = "";
      if (Object.keys(ch).length) plan.upd.push([ex, ch]); else plan.same++;
    });
    return plan;
  }

  // Date written in a file name like "Tracker 2026-10-14.xlsx" or "tracker_oct_14_2026.xlsx".
  function dateFromName(name) {
    let m = /(\d{4})[-_. ](\d{1,2})[-_. ](\d{1,2})/.exec(name); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_. ]?(\d{1,2})(?:[-_., ]+(\d{4}))?/i.exec(name);
    if (m) { const y = m[3] || String(today().getFullYear()); return `${y}-${String(mon.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
    return "";
  }

  // Distance in metres between two GPS points.
  function metres(a, b) { const R = 6371000, t = Math.PI / 180; const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }

  // Suggests which item a photo belongs to: nearest item within 75 m, else an item raised the same day.
  function suggestItem(photo, items) {
    const open = items.filter(x => !x.deleted_at);
    if (photo.lat != null && photo.lng != null) {
      let best = null, bd = Infinity;
      open.forEach(x => { if (x.lat == null || x.lng == null) return; const d = metres(photo, x); if (d < bd) { bd = d; best = x; } });
      if (best && bd <= 75) return { item: best, reason: Math.round(bd) + " m away" };
    }
    if (photo.date) {
      const same = open.filter(x => x.raised === photo.date || x.first_seen === photo.date);
      if (same.length === 1) return { item: same[0], reason: "raised same day" };
      if (same.length > 1) return { item: null, reason: same.length + " items raised that day", candidates: same };
    }
    return { item: null, reason: "" };
  }

  // Plain-text weekly summary from the live list.
  function summaryText(items, project) {
    const sc = items.filter(x => !x.deleted_at && (!project || x.project === project)), t = today();
    const open = sc.filter(x => !isClosed(x)), late = open.filter(isLate);
    const closed7 = sc.filter(x => isClosed(x) && parseD(x.closed) && days(parseD(x.closed), t) <= 7);
    const nw = open.filter(isNew);
    const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    let s = `Deficiency update${project ? " – " + project : ""} – week of ${mon.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}\n\n`;
    s += `Open: ${open.length} (${late.length} overdue) | New: ${nw.length} | Closed last 7 days: ${closed7.length}\n`;
    s += `Open by type: ${TABS.slice(1, 6).map(([n, c]) => `${n} ${open.filter(x => x.category === c).length}`).join(" | ")} | Other ${open.filter(x => !MAIN.has(x.category)).length}\n\n`;
    const byC = {}; open.forEach(x => { const c = x.contractor || "Unassigned"; (byC[c] = byC[c] || []).push(x); });
    Object.keys(byC).sort((a, b) => byC[b].length - byC[a].length).forEach(c => {
      const l = byC[c].filter(isLate), old = byC[c].slice().sort((a, b) => ageOf(b) - ageOf(a))[0];
      s += `${c}: ${byC[c].length} open, ${l.length} overdue. Oldest ${ageOf(old)} d – ${old.location}\n`;
    });
    const cmb = open.filter(x => x.category === "CMB (mailbox)");
    if (cmb.length) { s += `\nCMB follow-up:\n`; cmb.forEach(x => s += `- ${x.project}, ${x.location}: ${x.status}${isLate(x) ? " (overdue)" : ""}${x.notes ? " – " + x.notes : ""}\n`); }
    const hi = open.filter(x => x.priority === "High" && x.category !== "CMB (mailbox)");
    if (hi.length) { s += `\nHigh priority:\n`; hi.slice(0, 5).forEach(x => s += `- ${x.ref} ${x.project}, ${x.location}: ${String(x.description).slice(0, 70)} (${x.contractor})\n`); }
    if (!open.length) s += "No open deficiencies.\n";
    return s;
  }

  // Plain-text version of a saved Monday report.
  function reportText(week, st) {
    const d = parseD(week);
    let s = `Deficiency update – week of ${d ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : week}\n\n`;
    s += `Open: ${st.open} (${st.overdue} overdue) | New: ${st.new} | Closed last 7 days: ${st.closed7} | Awaiting re-inspection: ${st.ready}\n`;
    const bt = Object.fromEntries((st.by_type || []).map(x => [x.category, x.open]));
    s += `Open by type: ${TABS.slice(1, 6).map(([n, c]) => `${n} ${bt[c] || 0}`).join(" | ")}\n\n`;
    (st.by_contractor || []).forEach(c => s += `${c.contractor}: ${c.open} open, ${c.overdue} overdue. Oldest ${c.oldest_days} d – ${c.oldest_location}\n`);
    if ((st.cmb || []).length) { s += `\nCMB follow-up:\n`; st.cmb.forEach(x => s += `- ${x.project}, ${x.location}: ${x.status}${x.overdue ? " (overdue)" : ""}${x.notes ? " – " + x.notes : ""}\n`); }
    if ((st.high || []).length) { s += `\nHigh priority:\n`; st.high.forEach(x => s += `- ${x.ref} ${x.project}, ${x.location}: ${String(x.description).slice(0, 70)} (${x.contractor})\n`); }
    if (!st.open) s += "No open deficiencies.\n";
    return s;
  }

  function punchText(items, contractor, tab) {
    const open = items.filter(x => !x.deleted_at && !isClosed(x) && x.contractor === contractor && inTab(x, tab || "All"));
    if (!open.length) return "No open items.";
    const byP = {}; open.forEach(x => (byP[x.project] = byP[x.project] || []).push(x));
    let t = `${contractor} – open deficiencies as of ${today().toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}\n`;
    Object.keys(byP).sort().forEach(p => {
      t += `\n${p}\n`;
      byP[p].sort((a, b) => (isLate(b) - isLate(a)) || ageOf(b) - ageOf(a)).forEach(x => {
        const sh = (CATS.find(k => k[0] === x.category) || [])[2];
        t += `- ${x.ref} | ${sh ? sh + " – " : ""}${x.location} | ${x.description}${x.priority === "High" ? " [HIGH]" : ""} | due ${dueOf(x) ? iso(dueOf(x)) : "—"}${isLate(x) ? " (OVERDUE)" : ""}\n`;
      });
    });
    return t + `\nPlease confirm completion dates for overdue items.`;
  }

  const Logic = { CATS, TABS, MAIN, STAT, PROJECTS, DEFAULT_DUE, today, parseD, iso, days, dueOf, isClosed, ageOf, isLate, daysLate, isNew,
    catShort, catColor, inTab, norm, keyOf, normDate, normStatus, normPri, normCat, mapTable, planImport, dateFromName, metres, suggestItem,
    summaryText, reportText, punchText, setToday: d => { todayOverride = d; } };
  if (typeof module !== "undefined" && module.exports) module.exports = Logic; else root.Logic = Logic;
})(typeof window !== "undefined" ? window : globalThis);
