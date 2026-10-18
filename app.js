/* Caivan Deficiency Log — app screens, data and sync. Pure rules live in logic.js. */
(function () {
"use strict";
const L = window.Logic;
const CFG = window.APP_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = s => { const d = L.parseD(s); return d ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : "—"; };
const todayISO = () => L.iso(L.today());

let sb = null, session = null, role = null, meName = "", meEmail = "";
let items = [], photos = [], members = [], latestReport = null;
let tab = "All", sort = { k: "age", dir: "desc" }, showTrash = false;
let editingId = null, draftPhotos = [], keptPhotos = [], removedPhotos = [], editGeo = null;
let importMode = "tracker", importPlan = null, importBook = null, matchRows = [];
const urlCache = new Map();
const pendingPhotoURLs = new Map(); // photo id -> object URL for photos waiting to upload

const canEdit = () => role === "admin" || role === "editor";
const isAdmin = () => role === "admin";

function toast(t, ms) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, ms || 2600); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch (e) { toast("Select the text and copy it manually"); } }
function show(id) { ["screenLogin", "screenNoAccess", "screenSetup", "screenApp"].forEach(s => $(s).hidden = s !== id); }
const isNetErr = e => !navigator.onLine || /fetch|network|load failed|timeout/i.test(String((e && (e.message || e.error_description)) || e));
const cacheSet = (k, v) => { try { localStorage.setItem("dl_" + k, JSON.stringify(v)); } catch (e) { } };
const cacheGet = k => { try { return JSON.parse(localStorage.getItem("dl_" + k) || "null"); } catch (e) { return null; } };

/* ---------------- offline queue (IndexedDB) ---------------- */
const Q = {
  db: null,
  open() { if (this.db) return Promise.resolve(this.db); return new Promise((res, rej) => { const r = indexedDB.open("caivan-queue", 1); r.onupgradeneeded = () => r.result.createObjectStore("ops", { keyPath: "qid", autoIncrement: true }); r.onsuccess = () => { this.db = r.result; res(r.result); }; r.onerror = () => rej(r.error); }); },
  async run(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("ops", mode); const req = fn(t.objectStore("ops")); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); }); },
  add(op) { return this.run("readwrite", s => s.add(op)); },
  all() { return this.run("readonly", s => s.getAll()); },
  del(k) { return this.run("readwrite", s => s.delete(k)); }
};
let flushing = false;
async function queueCount() { try { return (await Q.all()).length; } catch (e) { return 0; } }
async function updateSyncBadge() { const n = await queueCount(); $("syncBadge").hidden = !n; $("syncBadge").textContent = n + " waiting to sync"; }

async function execOp(op) {
  if (op.kind === "insert") { const { error } = await sb.from("deficiencies").insert(op.row); if (error && error.code !== "23505") throw error; }
  else if (op.kind === "update") { const { error } = await sb.from("deficiencies").update(op.row).eq("id", op.id); if (error) throw error; }
  else if (op.kind === "activity") { const { error } = await sb.from("activity").insert(op.row); if (error) throw error; }
  else if (op.kind === "photo") {
    const st = sb.storage.from("photos");
    let r = await st.upload(op.path, op.full, { contentType: "image/jpeg", upsert: true }); if (r.error) throw r.error;
    r = await st.upload(op.thumb_path, op.thumb, { contentType: "image/jpeg", upsert: true }); if (r.error) throw r.error;
    const { error } = await sb.from("photos").insert({ id: op.id, deficiency_id: op.deficiency_id, path: op.path, thumb_path: op.thumb_path, taken_at: op.taken_at, lat: op.lat, lng: op.lng, uploaded_by: meName });
    if (error && error.code !== "23505") throw error;
  }
  else if (op.kind === "photoDelete") {
    await sb.storage.from("photos").remove([op.path, op.thumb_path]);
    const { error } = await sb.from("photos").delete().eq("id", op.id); if (error) throw error;
  }
}
async function runOrQueue(op) {
  const waiting = await queueCount();
  if (navigator.onLine && !waiting) {
    try { await execOp(op); return true; } catch (e) { if (!isNetErr(e)) throw e; }
  }
  await Q.add(op); updateSyncBadge(); return false;
}
async function flush() {
  if (flushing || !navigator.onLine || !sb) return; flushing = true;
  try {
    const ops = await Q.all();
    for (const op of ops) {
      try { await execOp(op); await Q.del(op.qid); if (op.kind === "photo") { const u = pendingPhotoURLs.get(op.id); if (u) { URL.revokeObjectURL(u); pendingPhotoURLs.delete(op.id); } } }
      catch (e) { if (isNetErr(e)) break; await Q.del(op.qid); toast("A queued change couldn't be saved: " + (e.message || "unknown error"), 5000); }
    }
  } finally { flushing = false; updateSyncBadge(); scheduleReload(); }
}

/* ---------------- auth ---------------- */
async function boot() {
  if (!CFG.supabaseUrl || /YOUR_/.test(CFG.supabaseUrl) || !window.supabase) { show("screenSetup"); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_OUT") { session = null; show("screenLogin"); } });
  if (session) afterLogin(); else show("screenLogin");
}
$("loginEmail").addEventListener("submit", async e => {
  e.preventDefault(); const email = $("lEmail").value.trim().toLowerCase(); const b = $("btnSendCode"); b.disabled = true; $("loginMsg").textContent = "";
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  b.disabled = false;
  if (error) { $("loginMsg").textContent = /email rate limit/i.test(error.message) ? "The sign-in email limit was reached (the built-in sender allows only a few emails per hour). Wait up to an hour and press the button once, or set up your own email sender in Supabase."
    : /rate|seconds/i.test(error.message) ? "Too many codes requested. Wait a minute and try again." : "Couldn't send the code: " + error.message; return; }
  $("loginEmail").hidden = true; $("loginCode").hidden = false; $("lCode").focus();
  $("loginMsg").textContent = "Code sent to " + email + ". Check your inbox (and junk folder).";
});
$("loginCode").addEventListener("submit", async e => {
  e.preventDefault(); const b = $("btnVerify"); b.disabled = true;
  const { data, error } = await sb.auth.verifyOtp({ email: $("lEmail").value.trim().toLowerCase(), token: $("lCode").value.trim(), type: "email" });
  b.disabled = false;
  if (error) { $("loginMsg").textContent = "That code didn't work. Check it, or send a new one."; return; }
  session = data.session; afterLogin();
});
$("btnBackEmail").onclick = () => { $("loginEmail").hidden = false; $("loginCode").hidden = true; $("loginMsg").textContent = ""; };
async function signOut() { await sb.auth.signOut(); try { localStorage.removeItem("dl_role"); localStorage.removeItem("dl_items"); localStorage.removeItem("dl_photos"); } catch (e) { } location.reload(); }
$("btnSignOut2").onclick = signOut;

async function afterLogin() {
  meEmail = (session.user.email || "").toLowerCase();
  try { const { data, error } = await sb.rpc("my_role"); if (error) throw error; role = data; cacheSet("role", { email: meEmail, role }); }
  catch (e) { const c = cacheGet("role"); role = c && c.email === meEmail ? c.role : null; if (!role && !isNetErr(e)) role = null; }
  if (!role) { $("naEmail").textContent = meEmail; show("screenNoAccess"); return; }
  meName = meEmail;
  show("screenApp"); applyRoleUI();
  const cached = cacheGet("items"); if (cached) { items = cached; photos = cacheGet("photos") || []; render(); }
  await loadMembers();
  await load();
  loadLatestReport();
  sb.channel("changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "deficiencies" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, scheduleReload)
    .subscribe();
  flush();
}
function applyRoleUI() {
  const ed = canEdit();
  ["btnAdd", "btnPhotos"].forEach(id => $(id).hidden = !ed);
  $("roBadge").hidden = ed;
  document.querySelectorAll("#moreMenu [data-cmd]").forEach(b => {
    const c = b.dataset.cmd;
    b.hidden = (["import", "bluebeam", "history"].includes(c) && !ed) || (["team", "trash"].includes(c) && !isAdmin());
  });
  $("btnRebuild").hidden = !isAdmin();
}

/* ---------------- data ---------------- */
async function fetchAll(table) {
  let out = [], from = 0; const size = 1000;
  for (;;) { const { data, error } = await sb.from(table).select("*").range(from, from + size - 1); if (error) throw error; out = out.concat(data); if (data.length < size) break; from += size; }
  return out;
}
async function load() {
  try {
    const [d, p] = await Promise.all([fetchAll("deficiencies"), fetchAll("photos")]);
    items = d; photos = p; cacheSet("items", items); cacheSet("photos", photos);
  } catch (e) { if (!isNetErr(e)) toast("Couldn't load the log: " + (e.message || e), 5000); }
  await overlayQueue();
  await ensureUrls(photos.map(p => p.thumb_path));
  render();
}
let reloadT = null;
function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(load, 600); }
async function overlayQueue() {
  let ops = []; try { ops = await Q.all(); } catch (e) { }
  ops.forEach(op => {
    if (op.kind === "insert" && !items.some(x => x.id === op.row.id)) items.push(Object.assign({ ref: "…" }, op.row, { _pending: true }));
    if (op.kind === "update") { const it = items.find(x => x.id === op.id); if (it) Object.assign(it, op.row, { _pending: true }); }
    if (op.kind === "photo" && !photos.some(p => p.id === op.id)) {
      if (!pendingPhotoURLs.has(op.id)) pendingPhotoURLs.set(op.id, URL.createObjectURL(op.thumb));
      photos.push({ id: op.id, deficiency_id: op.deficiency_id, path: op.path, thumb_path: op.thumb_path, _pending: true });
    }
    if (op.kind === "photoDelete") photos = photos.filter(p => p.id !== op.id);
  });
  updateSyncBadge();
}
async function ensureUrls(paths) {
  const now = Date.now(); const need = [...new Set(paths)].filter(p => p && !(urlCache.get(p) && urlCache.get(p).exp > now + 60000));
  for (let i = 0; i < need.length; i += 100) {
    try { const { data } = await sb.storage.from("photos").createSignedUrls(need.slice(i, i + 100), 21600); (data || []).forEach(x => { if (x.signedUrl) urlCache.set(x.path, { url: x.signedUrl, exp: now + 21600000 }); }); } catch (e) { }
  }
}
const photoURL = p => pendingPhotoURLs.get(p.id) || (urlCache.get(p.thumb_path) || {}).url || "";
async function fullURL(p) {
  if (pendingPhotoURLs.get(p.id)) return pendingPhotoURLs.get(p.id);
  const c = urlCache.get(p.path); if (c && c.exp > Date.now()) return c.url;
  const { data } = await sb.storage.from("photos").createSignedUrl(p.path, 21600);
  if (data) urlCache.set(p.path, { url: data.signedUrl, exp: Date.now() + 21600000 });
  return data ? data.signedUrl : photoURL(p);
}
const photosOf = it => photos.filter(p => p.deficiency_id === it.id);
const live = () => items.filter(x => !x.deleted_at);

function cleanRow(o) {
  const r = {}; ["ref", "ext_ref", "project", "location", "category", "description", "contractor", "priority", "raised", "due", "status", "closed", "notes", "first_seen", "key", "lat", "lng", "deleted_at"].forEach(k => { if (k in o) r[k] = o[k]; });
  ["due", "closed", "ext_ref"].forEach(k => { if (k in r && !r[k]) r[k] = null; });
  delete r.ref; return r;
}
async function saveItem(id, data, what) {
  const row = cleanRow(data); row.updated_by = meName;
  let did = id;
  if (!id) { did = crypto.randomUUID(); row.id = did; row.created_by = meName; items.push(Object.assign({ ref: "…", _pending: true }, row)); }
  else { const it = items.find(x => x.id === id); if (it) Object.assign(it, row); }
  render();
  const ok = await runOrQueue(id ? { kind: "update", id, row } : { kind: "insert", row });
  await runOrQueue({ kind: "activity", row: { deficiency_id: did, who: meName, what } });
  if (ok) scheduleReload();
  return { id: did, queued: !ok };
}

/* ---------------- photos: compress + queue ---------------- */
function compress(file, max, q) {
  return new Promise(res => {
    if (!/^image\//.test(file.type) || file.type === "image/svg+xml") { res(file); return; }
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const sc = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas");
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); c.toBlob(b => res(b || file), "image/jpeg", q); };
    img.onerror = () => { URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}
async function readMeta(file) {
  const m = { lat: null, lng: null, date: "", taken_at: null };
  try { const g = await window.exifr.gps(file); if (g && isFinite(g.latitude)) { m.lat = g.latitude; m.lng = g.longitude; } } catch (e) { }
  try { const x = await window.exifr.parse(file, ["DateTimeOriginal", "CreateDate"]); const d = x && (x.DateTimeOriginal || x.CreateDate); if (d instanceof Date && !isNaN(d)) { m.date = L.iso(d); m.taken_at = d.toISOString(); } } catch (e) { }
  if (!m.date && file.lastModified) { const d = new Date(file.lastModified); m.date = L.iso(d); m.taken_at = d.toISOString(); }
  return m;
}
async function addPhoto(defId, file, meta) {
  const id = crypto.randomUUID();
  const [full, thumb] = await Promise.all([compress(file, 1600, 0.82), compress(file, 360, 0.75)]);
  const op = { kind: "photo", id, deficiency_id: defId, path: `${defId}/${id}.jpg`, thumb_path: `${defId}/${id}_t.jpg`, full, thumb,
    taken_at: meta && meta.taken_at || new Date().toISOString(), lat: meta ? meta.lat : null, lng: meta ? meta.lng : null };
  pendingPhotoURLs.set(id, URL.createObjectURL(thumb));
  photos.push({ id, deficiency_id: defId, path: op.path, thumb_path: op.thumb_path, _pending: true });
  const ok = await runOrQueue(op);
  if (ok) { URL.revokeObjectURL(pendingPhotoURLs.get(id)); pendingPhotoURLs.delete(id); await ensureUrls([op.thumb_path]); }
  return ok;
}

/* ---------------- render ---------------- */
const uniq = k => [...new Set(live().map(x => x[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function fillSelect(el, vals, allLabel) { const cur = el.value; el.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : "") + vals.map(v => `<option>${esc(v)}</option>`).join(""); if ([...el.options].some(o => o.value === cur)) el.value = cur; }
function filtered() {
  const q = $("fSearch").value.trim().toLowerCase(), p = $("fProject").value, c = $("fContractor").value, s = $("fStatus").value, pr = $("fPriority").value;
  const base = showTrash ? items.filter(x => x.deleted_at) : live();
  return base.filter(it => {
    if (!showTrash && !L.inTab(it, tab)) return false;
    if (p && it.project !== p) return false; if (c && it.contractor !== c) return false; if (pr && it.priority !== pr) return false;
    if (!showTrash) {
      if (s === "active" && L.isClosed(it)) return false; if (s === "late" && !L.isLate(it)) return false; if (s === "new" && !L.isNew(it)) return false;
      if (s === "nophoto" && (L.isClosed(it) || photosOf(it).length)) return false;
      if (s && !["active", "late", "new", "nophoto"].includes(s) && it.status !== s) return false;
    }
    if (q && !`${it.ref} ${it.ext_ref || ""} ${it.location} ${it.description} ${it.category} ${it.notes}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
function sorted(list) {
  const { k, dir } = sort, m = dir === "asc" ? 1 : -1, pri = { High: 0, Medium: 1, Low: 2 }, st = { Open: 0, "In progress": 1, "Ready for re-inspection": 2, Closed: 3 };
  const v = it => k === "age" ? L.ageOf(it) : k === "due" ? (L.dueOf(it) || new Date(8e15)).getTime() : k === "priority" ? pri[it.priority] ?? 3 : k === "status" ? st[it.status] ?? 4 : String(it[k] || "").toLowerCase();
  return list.slice().sort((a, b) => { const x = v(a), y = v(b); return x < y ? -m : x > y ? m : 0; });
}
function thumbHTML(it, big) {
  const ph = photosOf(it);
  if (ph.length) return `<button type="button" class="thumbbtn" data-act="photo" aria-label="View photos"><img class="thumb" src="${esc(photoURL(ph[0]))}" alt="" loading="lazy">${ph.length > 1 ? `<span class="more">+${ph.length - 1}</span>` : ""}</button>`;
  return `<button type="button" class="nophoto" data-act="edit" aria-label="${canEdit() ? "Add photo" : "View item"}">${canEdit() ? "+" : "–"}</button>`;
}
function statusSel(it) {
  const stc = "s-" + (it.status || "Open").replace(/ /g, "-");
  return `<select class="status ${stc}" data-act="status" aria-label="Status for ${esc(it.ref)}"${canEdit() && !showTrash ? "" : " disabled"}>${L.STAT.map(s => `<option${s === it.status ? " selected" : ""}>${s}</option>`).join("")}</select>`;
}
function tags(it) {
  return `${it.example ? '<span class="tag">EX</span>' : ""}${L.isNew(it) && !L.isClosed(it) ? '<span class="tag new">NEW</span>' : ""}${it._pending ? '<span class="tag sync">SYNC</span>' : ""}`;
}
function render() {
  if ($("screenApp").hidden) return;
  fillSelect($("fProject"), uniq("project"), "All projects");
  fillSelect($("fContractor"), uniq("contractor"), "All contractors");
  fillSelect($("sProject"), uniq("project"), "All projects");
  $("projList").innerHTML = uniq("project").concat(L.PROJECTS).filter((v, i, a) => a.indexOf(v) === i).map(v => `<option value="${esc(v)}">`).join("");
  $("conList").innerHTML = uniq("contractor").map(v => `<option value="${esc(v)}">`).join("");
  $("noticeExamples").hidden = !live().some(x => x.example) || !isAdmin();
  $("noticeOffline").hidden = navigator.onLine;

  const proj = $("fProject").value, pScope = live().filter(x => !proj || x.project === proj), scope = pScope.filter(x => L.inTab(x, tab));
  $("tabs").innerHTML = L.TABS.map(([n, c]) => {
    const cnt = pScope.filter(x => !L.isClosed(x) && L.inTab(x, n)).length;
    const col = c && c !== "__other" ? `<i style="background:var(${L.catColor(c)})"></i>` : "";
    return `<button type="button" class="tab" data-tab="${n}" aria-pressed="${!showTrash && tab === n}">${col}${n}<span class="c">${cnt}</span></button>`;
  }).join("");

  const open = scope.filter(x => !L.isClosed(x)), late = open.filter(L.isLate), t = L.today();
  $("kOpen").textContent = open.length; $("kOpenS").textContent = open.filter(x => x.priority === "High").length + " high priority";
  $("kLate").textContent = late.length; $("kLateS").textContent = late.length ? "oldest " + Math.max(...late.map(L.daysLate)) + " d past due" : "nothing past due";
  $("kNew").textContent = open.filter(L.isNew).length;
  $("kClosed").textContent = scope.filter(x => L.isClosed(x) && L.parseD(x.closed) && L.days(L.parseD(x.closed), t) <= 7).length;
  $("kClosedS").textContent = open.filter(x => x.status === "Ready for re-inspection").length + " awaiting re-inspection";
  $("kPhoto").textContent = open.filter(x => !photosOf(x).length).length;

  const byC = {}; open.forEach(x => { const c = x.contractor || "Unassigned"; (byC[c] = byC[c] || []).push(x); });
  const cons = Object.keys(byC).sort((a, b) => byC[b].length - byC[a].length), maxN = Math.max(1, ...cons.map(c => byC[c].length));
  $("ageing").innerHTML = cons.length ? cons.map(c => {
    const b = [0, 0, 0, 0]; byC[c].forEach(x => { const a = L.ageOf(x); b[a <= 7 ? 0 : a <= 14 ? 1 : a <= 30 ? 2 : 3]++; });
    const l = byC[c].filter(L.isLate).length, w = byC[c].length / maxN * 100;
    return `<div class="crow"><span class="name" title="${esc(c)}">${esc(c)}</span>
      <div class="bar" role="img" aria-label="${esc(c)}: ${b[0]} up to 7 days, ${b[1]} 8 to 14, ${b[2]} 15 to 30, ${b[3]} over 30"><div style="display:flex;width:${w}%">${b.map((n, i) => n ? `<span style="flex:${n};background:var(--age${i + 1})"></span>` : "").join("")}</div></div>
      <span class="cnt">${byC[c].length}${l ? ` · <b>${l}</b>` : ""}</span></div>`;
  }).join("") : `<div class="empty" style="padding:16px">No open items here.</div>`;

  const openCons = [...new Set(live().filter(x => !L.isClosed(x) && L.inTab(x, tab)).map(x => x.contractor).filter(Boolean))].sort();
  fillSelect($("plContractor"), openCons.length ? openCons : ["No open items"]);
  $("plOut").textContent = L.punchText(live(), $("plContractor").value, tab);

  const list = sorted(filtered());
  $("logTitle").textContent = showTrash ? "Trash" : "Log";
  $("countLabel").innerHTML = showTrash ? `${list.length} in Trash · <button class="btn link" type="button" id="btnExitTrash">Back to log</button>` : `${list.length} of ${live().length} items`;
  document.querySelectorAll("th[data-k]").forEach(th => th.setAttribute("aria-sort", th.dataset.k === sort.k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"));
  const editLbl = canEdit() ? "Edit" : "View";
  $("rows").innerHTML = list.map(it => {
    const lt = L.isLate(it);
    return `<tr class="p-${esc(it.priority)}" data-id="${esc(it.id)}">
      <td>${thumbHTML(it)}</td>
      <td class="num">${esc(it.ref || "")}${tags(it)}${it.ext_ref ? `<div class="muted">${esc(it.ext_ref)}</div>` : ""}</td>
      <td>${esc(it.project)}</td><td>${esc(it.location)}</td>
      <td><span class="cat"><i style="background:var(${L.catColor(it.category)})"></i>${esc(it.category || "Other")}</span></td>
      <td class="desc">${esc(it.description)}${it.notes ? `<div class="muted" style="font-size:13px">${esc(it.notes)}</div>` : ""}</td>
      <td>${esc(it.contractor)}</td><td>${esc((it.priority || "").slice(0, 3))}</td>
      <td class="num">${fmt(it.raised)}</td>
      <td class="num ${lt ? "late" : ""}">${it.due ? fmt(it.due) : '<span class="muted">' + (L.dueOf(it) ? fmt(L.iso(L.dueOf(it))) : "—") + "</span>"}${lt ? " · " + L.daysLate(it) + " d late" : ""}</td>
      <td class="num">${L.ageOf(it)} d</td><td>${statusSel(it)}</td>
      <td><button class="btn small" type="button" data-act="edit">${editLbl}</button></td></tr>`;
  }).join("");
  $("cards").innerHTML = list.map(it => {
    const lt = L.isLate(it);
    return `<article class="card p-${esc(it.priority)}" data-id="${esc(it.id)}">${thumbHTML(it)}
      <div style="min-width:0;display:flex;flex-direction:column;gap:3px">
        <div class="meta"><span class="mono">${esc(it.ref || "")}</span><span class="cat"><i style="background:var(${L.catColor(it.category)})"></i>${esc(L.catShort(it.category))}</span><span>${esc(it.project)}</span>${tags(it)}</div>
        <div class="loc">${esc(it.location)}</div><div>${esc(it.description)}</div>
        <div class="meta"><span>${esc(it.contractor)}</span><span class="${lt ? "late" : ""}">${lt ? L.daysLate(it) + " d overdue" : "due " + (L.dueOf(it) ? fmt(L.iso(L.dueOf(it))) : "—")}</span><span>${L.ageOf(it)} d old</span></div>
      </div>
      <div class="row">${statusSel(it)}<button class="btn small" type="button" data-act="edit">${editLbl}</button></div></article>`;
  }).join("");
  const emp = $("empty");
  if (!live().length && !showTrash) { emp.hidden = false; emp.innerHTML = canEdit() ? `The log is empty. Use <b>More → Import weekly tracker</b> to bring in your team's list, or <b>Add deficiency</b> from site.` : "No deficiencies logged yet."; }
  else if (!list.length) { emp.hidden = false; emp.textContent = showTrash ? "Trash is empty." : "No items match these filters."; }
  else emp.hidden = true;
  const ex = $("btnExitTrash"); if (ex) ex.onclick = () => { showTrash = false; render(); };
}

/* ---------------- edit drawer ---------------- */
function renderEditPhotos() {
  const ed = canEdit() && !showTrash;
  $("ePhotos").innerHTML = keptPhotos.map((p, i) => `<div class="ph"><img src="${esc(photoURL(p))}" alt="Photo ${i + 1}" data-view="k${i}">${ed ? `<button type="button" class="x" data-rmk="${i}">Remove</button>` : ""}</div>`).join("")
    + draftPhotos.map((p, i) => `<div class="ph"><img src="${p.preview}" alt="New photo ${i + 1}" data-view="d${i}">${ed ? `<button type="button" class="x" data-rmd="${i}">Remove</button>` : ""}</div>`).join("")
    + (ed ? `<label class="addph">Add photos<input type="file" id="ePhotoIn" accept="image/*" multiple></label>` : "")
    + (!ed && !keptPhotos.length ? `<div class="hint">No photos.</div>` : "");
}
$("ePhotos").addEventListener("change", async e => {
  if (e.target.id !== "ePhotoIn") return;
  for (const f of [...e.target.files]) { const meta = await readMeta(f); draftPhotos.push({ file: f, meta, preview: URL.createObjectURL(f) }); }
  renderEditPhotos();
});
$("ePhotos").addEventListener("click", async e => {
  const k = e.target.closest("[data-rmk]"); if (k) { removedPhotos.push(keptPhotos.splice(+k.dataset.rmk, 1)[0]); renderEditPhotos(); return; }
  const d = e.target.closest("[data-rmd]"); if (d) { URL.revokeObjectURL(draftPhotos[+d.dataset.rmd].preview); draftPhotos.splice(+d.dataset.rmd, 1); renderEditPhotos(); return; }
  const v = e.target.closest("[data-view]"); if (!v) return;
  const key = v.dataset.view; openLightbox(key[0] === "k" ? await fullURL(keptPhotos[+key.slice(1)]) : draftPhotos[+key.slice(1)].preview);
});
function openLightbox(src) { $("lbImg").src = src; $("lightbox").hidden = false; }
$("lbClose").onclick = () => $("lightbox").hidden = true;
$("lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") $("lightbox").hidden = true; });

async function openEdit(id) {
  editingId = id || null; const it = id ? items.find(x => x.id === id) : null;
  const ro = !canEdit() || showTrash;
  $("editTitle").textContent = it ? (ro ? it.ref : "Edit " + (it.ref || "")) : "Add deficiency";
  $("eCategory").innerHTML = L.CATS.map(c => `<option>${c[0]}</option>`).join("");
  const defCat = tab !== "All" && tab !== "Other" ? L.TABS.find(t => t[0] === tab)[1] : "CB (catch basin)";
  const v = (k, d = "") => it ? (it[k] ?? d) : d;
  $("eProject").value = v("project", $("fProject").value); $("eContractor").value = v("contractor", $("fContractor").value);
  $("eLocation").value = v("location"); $("eCategory").value = v("category", defCat);
  $("ePriority").value = v("priority", "Medium"); $("eDescription").value = v("description");
  $("eRaised").value = v("raised", todayISO()); $("eDue").value = v("due") || ""; $("eStatus").value = v("status", "Open");
  $("eClosed").value = v("closed") || ""; $("eNotes").value = v("notes");
  draftPhotos = []; removedPhotos = []; keptPhotos = it ? photosOf(it) : []; renderEditPhotos();
  $("editForm").querySelectorAll(".form input,.form select,.form textarea").forEach(f => f.disabled = ro);
  $("btnSave").hidden = ro; $("btnDelete").hidden = !it || !isAdmin() || showTrash; $("btnDeleteConfirm").hidden = true;
  $("btnRestore").hidden = !(showTrash && isAdmin());
  editGeo = it && it.lat != null ? { lat: it.lat, lng: it.lng } : null;
  $("eGeo").textContent = editGeo ? "Location saved for photo matching." : "";
  if (!it && !ro && navigator.geolocation) {
    $("eGeo").textContent = "Getting your location for photo matching…";
    navigator.geolocation.getCurrentPosition(p => { editGeo = { lat: p.coords.latitude, lng: p.coords.longitude }; $("eGeo").textContent = `Location saved (±${Math.round(p.coords.accuracy)} m) for photo matching.`; },
      () => { $("eGeo").textContent = ""; }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  }
  const h = $("eHistory"); h.hidden = true;
  $("ovEdit").hidden = false;
  if (it && navigator.onLine && !it._pending) {
    const { data } = await sb.from("activity").select("who,what,at").eq("deficiency_id", it.id).order("at", { ascending: false }).limit(30);
    if (data && data.length && editingId === it.id) {
      h.innerHTML = `<div class="lbl">History</div>` + data.map(x => `<div><time>${esc(new Date(x.at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</time><span>${esc(x.who || "Someone")}: ${esc(x.what)}</span></div>`).join("");
      h.hidden = false;
    }
  }
}
$("eStatus").addEventListener("change", () => { if ($("eStatus").value === "Closed" && !$("eClosed").value) $("eClosed").value = todayISO(); });
$("editForm").addEventListener("submit", async e => {
  e.preventDefault();
  const it = editingId ? items.find(x => x.id === editingId) : null, st = $("eStatus").value;
  const data = { project: $("eProject").value.trim(), contractor: $("eContractor").value.trim(), location: $("eLocation").value.trim(),
    category: $("eCategory").value, priority: $("ePriority").value, description: $("eDescription").value.trim(), raised: $("eRaised").value,
    due: $("eDue").value, status: st, closed: st === "Closed" ? ($("eClosed").value || todayISO()) : "", notes: $("eNotes").value.trim(),
    ext_ref: it ? it.ext_ref : null };
  const gpsPhoto = draftPhotos.find(p => p.meta.lat != null);
  const geo = editGeo || (gpsPhoto ? { lat: gpsPhoto.meta.lat, lng: gpsPhoto.meta.lng } : null);
  if (geo && (!it || it.lat == null)) { data.lat = geo.lat; data.lng = geo.lng; }
  if (!it) data.first_seen = todayISO();
  data.key = L.keyOf(data);
  const nAdd = draftPhotos.length, nRm = removedPhotos.length;
  let what = !it ? "Added" : (it.status !== st ? `Status → ${st}` : "Edited");
  if (nAdd) what += `, ${nAdd} photo${nAdd > 1 ? "s" : ""} added`; if (nRm) what += `, ${nRm} photo${nRm > 1 ? "s" : ""} removed`;
  const b = $("btnSave"); b.disabled = true; b.textContent = nAdd ? "Saving photos…" : "Saving…";
  try {
    const r = await saveItem(editingId, data, what);
    let queued = r.queued;
    for (const p of draftPhotos) { if (!(await addPhoto(r.id, p.file, p.meta))) queued = true; URL.revokeObjectURL(p.preview); }
    for (const p of removedPhotos) { photos = photos.filter(x => x.id !== p.id); if (!(await runOrQueue({ kind: "photoDelete", id: p.id, path: p.path, thumb_path: p.thumb_path }))) queued = true; }
    draftPhotos = []; removedPhotos = [];
    $("ovEdit").hidden = true; render();
    toast(queued ? "Saved on this device. It will upload when you're back online." : (it ? "Saved" : "Added"));
  } catch (err) { toast("Couldn't save: " + (err.message || err), 5000); }
  b.disabled = false; b.textContent = "Save";
});
$("btnDelete").onclick = () => { $("btnDelete").hidden = true; $("btnDeleteConfirm").hidden = false; };
$("btnDeleteConfirm").onclick = async () => {
  const it = items.find(x => x.id === editingId); if (!it) return;
  try { await saveItem(it.id, Object.assign({}, it, { deleted_at: new Date().toISOString() }), "Moved to Trash"); $("ovEdit").hidden = true; toast("Moved to Trash. Restore it from More → Trash."); }
  catch (e) { toast("Couldn't move to Trash: " + e.message); }
};
$("btnRestore").onclick = async () => {
  const it = items.find(x => x.id === editingId); if (!it) return;
  try { await saveItem(it.id, Object.assign({}, it, { deleted_at: null }), "Restored from Trash"); $("ovEdit").hidden = true; toast("Restored"); }
  catch (e) { toast("Couldn't restore: " + e.message); }
};

/* ---------------- list interactions ---------------- */
async function rowClick(e) {
  const el = e.target.closest("[data-id]"); if (!el) return; const it = items.find(x => x.id === el.dataset.id); if (!it) return;
  if (e.target.closest("[data-act=edit]")) openEdit(it.id);
  else if (e.target.closest("[data-act=photo]")) { const ph = photosOf(it); if (ph.length > 1) openEdit(it.id); else if (ph[0]) openLightbox(await fullURL(ph[0])); }
}
async function statusChange(e) {
  const s = e.target.closest("[data-act=status]"); if (!s || !canEdit()) return;
  const it = items.find(x => x.id === s.closest("[data-id]").dataset.id); if (!it) return;
  const data = Object.assign({}, it, { status: s.value, closed: s.value === "Closed" ? (it.closed || todayISO()) : "" });
  try { const r = await saveItem(it.id, data, "Status → " + s.value); toast(`${it.ref} → ${s.value}${r.queued ? " (will sync)" : ""}`); }
  catch (err) { toast("Couldn't change status: " + err.message); load(); }
}
["rows", "cards"].forEach(id => { $(id).addEventListener("click", rowClick); $(id).addEventListener("change", statusChange); });
$("tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; showTrash = false; render(); } });
document.querySelectorAll("th[data-k]").forEach(th => th.addEventListener("click", () => { const k = th.dataset.k; sort = sort.k === k ? { k, dir: sort.dir === "asc" ? "desc" : "asc" } : { k, dir: k === "age" ? "desc" : "asc" }; render(); }));
["fSearch", "fProject", "fContractor", "fStatus", "fPriority"].forEach(id => $(id).addEventListener("input", render));
$("plContractor").addEventListener("change", () => $("plOut").textContent = L.punchText(live(), $("plContractor").value, tab));
$("btnCopyPL").onclick = () => copy($("plOut").textContent);
$("btnAdd").onclick = () => openEdit(null);
$("btnClearEx").onclick = async () => {
  const b = $("btnClearEx"); if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Confirm: remove examples"; return; }
  b.disabled = true; const { error } = await sb.from("deficiencies").delete().eq("example", true); b.disabled = false; delete b.dataset.armed; b.textContent = "Clear examples";
  if (error) toast("Couldn't remove examples: " + error.message); else { toast("Examples removed"); load(); }
};

/* ---------------- import: weekly tracker, Bluebeam, past trackers ---------------- */
const IMPORT_TEXT = {
  tracker: ["Import weekly tracker", "Upload your team's weekly tracker as it is (Excel or CSV). New items are added, existing ones are updated (status, due date, contractor), and photos and notes stay. Do this every week.", "Tracker file"],
  bluebeam: ["Import Bluebeam markups", "In Bluebeam Revu: Markups list → Summary → CSV, with columns Subject, Page Label, Comments, Date, Status (Space if you use spaces). Each markup becomes a deficiency, with the drawing page in the location. Re-importing the same markups won't create duplicates.", "Markups summary (CSV or Excel)"],
  history: ["Import past trackers", "Select all your old weekly trackers at once. They're processed oldest first (by the date in the file name, or the file date), so ageing and days-to-close are accurate from day one.", "Old tracker files (select several)"]
};
function openImport(mode) {
  if (!navigator.onLine) { toast("Imports need an internet connection."); return; }
  importMode = mode; importPlan = null; importBook = null;
  const [title, hint, lbl] = IMPORT_TEXT[mode];
  $("impTitle").textContent = title; $("impHint").textContent = hint; $("iFileLabel").textContent = lbl;
  $("iFile").value = ""; $("iFile").multiple = mode === "history";
  $("iResult").hidden = true; $("iSheetWrap").hidden = true; $("iLog").hidden = true; $("iMsg").textContent = ""; $("btnDoImport").disabled = true;
  $("ovImport").hidden = false;
}
function readTable(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onerror = () => rej(new Error("Couldn't read " + file.name));
    rd.onload = () => { try { const wb = XLSX.read(rd.result, { type: "array", cellDates: true }); res(wb); } catch (e) { rej(new Error(file.name + " couldn't be opened. Check it opens in Excel.")); } };
    rd.readAsArrayBuffer(file);
  });
}
const sheetRows = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name || wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
function showPlan(plan, cols, extraNote) {
  $("iResult").hidden = false; $("rNew").textContent = plan.add.length; $("rUpd").textContent = plan.upd.length; $("rSame").textContent = plan.same;
  const found = Object.keys(cols || {}); const miss = importMode === "bluebeam" ? [] : ["description", "location", "contractor"].filter(k => !found.includes(k));
  $("iCols").innerHTML = (found.length ? `Matched columns: ${found.join(", ")}.` : "") + (miss.length ? ` <span class="late">Not found: ${miss.join(", ")}.</span>` : "")
    + (plan.add.some(x => !x.project) ? ' <span class="late">Some rows have no project. Fill in the project field above.</span>' : "") + (extraNote || "");
  $("btnDoImport").disabled = !(plan.add.length || plan.upd.length);
}
async function planSingle() {
  const m = L.mapTable(sheetRows(importBook, $("iSheet").value), { source: importMode, defaultProject: $("iProject").value });
  importPlan = [{ name: "", date: todayISO(), plan: L.planImport(m.rows, live()) }];
  showPlan(importPlan[0].plan, m.cols, importMode === "tracker" && !("ext_ref" in m.cols) ? " No item-number column, so items are matched by project, location and description." : "");
  $("iMsg").textContent = m.rows.length ? "" : "No rows found. Check that the sheet has a header row with column names.";
}
async function planHistory(files) {
  const books = [];
  for (const f of files) { const wb = await readTable(f); books.push({ name: f.name, date: L.dateFromName(f.name) || L.iso(new Date(f.lastModified)), wb }); }
  books.sort((a, b) => a.date.localeCompare(b.date));
  let working = live().map(x => Object.assign({}, x)); const plans = []; const total = { add: [], upd: [], same: 0 };
  for (const b of books) {
    const m = L.mapTable(sheetRows(b.wb), { source: "tracker", defaultProject: $("iProject").value });
    const plan = L.planImport(m.rows, working);
    plan.add.forEach(r => { r.id = crypto.randomUUID(); working.push(Object.assign({ first_seen: b.date }, r)); }); // id now, so a newer file's update reaches it
    plan.upd.forEach(([ex, ch]) => Object.assign(ex, ch));
    plans.push({ name: b.name, date: b.date, plan });
    total.add.push(...plan.add); total.upd.push(...plan.upd); total.same += plan.same;
  }
  importPlan = plans;
  $("iLog").hidden = false; $("iLog").textContent = plans.map(p => `${p.date}  ${p.name}: ${p.plan.add.length} new, ${p.plan.upd.length} updated`).join("\n");
  showPlan(total, null, "");
}
$("iFile").addEventListener("change", async e => {
  const files = [...e.target.files]; if (!files.length) return; $("iMsg").textContent = "Reading…";
  try {
    if (importMode === "history") await planHistory(files);
    else { importBook = await readTable(files[0]); $("iSheet").innerHTML = importBook.SheetNames.map(n => `<option>${esc(n)}</option>`).join(""); $("iSheetWrap").hidden = importBook.SheetNames.length < 2; await planSingle(); }
    if ($("iMsg").textContent === "Reading…") $("iMsg").textContent = "";
  } catch (err) { $("iMsg").textContent = err.message; }
});
$("iSheet").addEventListener("change", () => importBook && planSingle());
$("iProject").addEventListener("change", () => { if (importMode === "history" && $("iFile").files.length) planHistory([...$("iFile").files]); else if (importBook) planSingle(); });
$("btnDoImport").onclick = async () => {
  if (!importPlan) return; const b = $("btnDoImport"); b.disabled = true; b.textContent = "Importing…";
  const src = { tracker: "weekly tracker", bluebeam: "Bluebeam markups", history: "past tracker" }[importMode];
  let n = 0, u = 0;
  try {
    for (const p of importPlan) {
      const rows = p.plan.add.map(r => Object.assign(cleanRow(r), { id: r.id || crypto.randomUUID(), first_seen: importMode === "history" ? p.date : todayISO(), created_by: meName, updated_by: meName }));
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await sb.from("deficiencies").insert(chunk); if (error) throw error;
        await sb.from("activity").insert(chunk.map(r => ({ deficiency_id: r.id, who: meName, what: `Imported from ${src}${p.name ? " (" + p.name + ")" : ""}` })));
        n += chunk.length; b.textContent = `Importing… ${n}`;
      }
      for (const [ex, ch] of p.plan.upd) {
        const row = cleanRow(ch); row.updated_by = meName;
        const { error } = await sb.from("deficiencies").update(row).eq("id", ex.id); if (error) throw error;
        await sb.from("activity").insert({ deficiency_id: ex.id, who: meName, what: `Updated from ${src}: ${Object.keys(ch).join(", ")}` });
        u++;
      }
    }
    $("ovImport").hidden = true; toast(`Import done: ${n} new, ${u} updated`, 4000);
    if (n && importMode !== "history") $("fStatus").value = "new";
  } catch (err) { toast(`Import stopped after ${n} new, ${u} updated: ${err.message}`, 6000); }
  b.textContent = "Apply import"; load();
};

/* ---------------- match photos (batch) ---------------- */
$("btnPhotos").onclick = () => { matchRows.forEach(r => URL.revokeObjectURL(r.preview)); matchRows = []; $("mList").innerHTML = ""; $("mMsg").textContent = ""; $("btnAttach").hidden = true; $("mFiles").value = ""; $("ovPhotos").hidden = false; };
$("mFiles").addEventListener("change", async e => {
  const files = [...e.target.files].slice(0, 60); if (!files.length) return;
  $("mMsg").textContent = `Reading ${files.length} photos…`;
  const open = live().filter(x => !L.isClosed(x));
  matchRows = [];
  for (const f of files) { const meta = await readMeta(f); const s = L.suggestItem(meta, open); matchRows.push({ file: f, meta, preview: URL.createObjectURL(f), sug: s }); }
  const label = x => `${x.ref} · ${L.catShort(x.category)} · ${x.project}, ${x.location}`.slice(0, 90);
  const byRecent = open.slice().sort((a, b) => String(b.raised).localeCompare(String(a.raised)));
  $("mList").innerHTML = matchRows.map((r, i) => {
    const firsts = r.sug.item ? [r.sug.item] : (r.sug.candidates || []);
    const opts = firsts.concat(byRecent.filter(x => !firsts.includes(x)));
    return `<div class="match"><img src="${r.preview}" alt="">
      <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
        <div class="hint">${esc(r.meta.date || "No date")}${r.meta.lat != null ? " · has location" : ""}${r.sug.reason ? " · " + esc(r.sug.reason) : ""}</div>
        <select data-m="${i}" aria-label="Item for photo ${i + 1}"><option value="">Skip this photo</option>${opts.map(x => `<option value="${esc(x.id)}"${r.sug.item === x ? " selected" : ""}>${esc(label(x))}</option>`).join("")}</select>
      </div></div>`;
  }).join("");
  const matched = matchRows.filter(r => r.sug.item).length, withGps = matchRows.filter(r => r.meta.lat != null).length;
  $("mMsg").textContent = `${matched} of ${matchRows.length} matched automatically. Pick the item for the rest, or leave them on Skip.` + (withGps ? "" : " None of these photos carried location data (phones often remove it when picking photos in a browser), so matching used the photo date.");
  $("btnAttach").hidden = false;
});
$("btnAttach").onclick = async () => {
  const picks = [...document.querySelectorAll("[data-m]")].map(s => ({ r: matchRows[+s.dataset.m], id: s.value })).filter(x => x.id);
  if (!picks.length) { toast("No photos selected"); return; }
  const b = $("btnAttach"); b.disabled = true; let done = 0, queued = 0; const counts = {};
  for (const p of picks) {
    b.textContent = `Attaching ${done + 1} of ${picks.length}…`;
    if (!(await addPhoto(p.id, p.r.file, p.r.meta))) queued++;
    counts[p.id] = (counts[p.id] || 0) + 1; done++;
    const it = items.find(x => x.id === p.id);
    if (it && it.lat == null && p.r.meta.lat != null) { it.lat = p.r.meta.lat; it.lng = p.r.meta.lng; await runOrQueue({ kind: "update", id: it.id, row: { lat: it.lat, lng: it.lng, updated_by: meName } }); }
  }
  for (const id in counts) await runOrQueue({ kind: "activity", row: { deficiency_id: id, who: meName, what: `${counts[id]} photo${counts[id] > 1 ? "s" : ""} added (photo matching)` } });
  b.disabled = false; b.textContent = "Attach photos"; $("ovPhotos").hidden = true; render();
  toast(queued ? `${done} photos saved; ${queued} will upload when you're online.` : `${done} photos attached`, 4000);
};

/* ---------------- contractor PDF with photos ---------------- */
async function imageData(url, maxPx) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, maxPx / Math.max(bmp.width, bmp.height)); const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return { data: c.toDataURL("image/jpeg", 0.8), w: c.width, h: c.height };
}
$("btnPDF").onclick = async () => {
  const contractor = $("plContractor").value;
  const open = live().filter(x => !L.isClosed(x) && x.contractor === contractor && L.inTab(x, tab));
  if (!open.length) { toast("No open items for this contractor"); return; }
  if (!window.jspdf) { toast("The PDF tool didn't load. Reload the page and try again."); return; }
  const b = $("btnPDF"); b.disabled = true; b.textContent = "Building PDF…";
  try {
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: "mm", format: "letter" });
    const W = 215.9, H = 279.4, M = 14, PW = 56, PH = 42; let y = M;
    const late = open.filter(L.isLate).length;
    const header = () => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text("Caivan Communities – Deficiency Punch List", M, y + 5); y += 12;
      doc.setFontSize(11); doc.text(contractor, M, y); doc.setFont("helvetica", "normal");
      doc.text(L.today().toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }), W - M, y, { align: "right" }); y += 6;
      doc.setFontSize(10); doc.setTextColor(90); doc.text(`${open.length} open item${open.length > 1 ? "s" : ""}, ${late} overdue${tab !== "All" ? " · " + tab + " only" : ""}`, M, y); doc.setTextColor(0); y += 4;
      doc.setDrawColor(180); doc.line(M, y, W - M, y); y += 6;
    };
    header();
    const byP = {}; open.forEach(x => (byP[x.project] = byP[x.project] || []).push(x));
    // Projects with overdue items first (most overdue at the top), then the rest A–Z.
    const lateIn = p => byP[p].filter(L.isLate).length;
    for (const proj of Object.keys(byP).sort((a, b) => lateIn(b) - lateIn(a) || a.localeCompare(b))) {
      if (y > H - 75) { doc.addPage(); y = M; } // keep the project name with its first item
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text(proj || "No project", M, y); y += 6;
      const list = byP[proj].sort((a, b) => (L.isLate(b) - L.isLate(a)) || L.ageOf(b) - L.ageOf(a));
      for (const it of list) {
        const ph = photosOf(it).slice(0, 2);
        const textW = W - 2 * M - (ph.length ? PW + 4 : 0);
        doc.setFontSize(10); doc.setFont("helvetica", "normal");
        const desc = doc.splitTextToSize(it.description || "", textW);
        const blockH = Math.max(14 + desc.length * 4.5, ph.length ? ph.length * (PH + 3) : 0) + 4;
        if (y + blockH > H - 16) { doc.addPage(); y = M; }
        const top = y;
        doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
        doc.text(`${it.ref}   ${L.catShort(it.category)} – ${it.location}`.slice(0, 95), M, y + 4);
        if (L.isLate(it)) { doc.setTextColor(179, 54, 44); doc.text(`OVERDUE ${L.daysLate(it)} d`, M + textW, y + 4, { align: "right" }); doc.setTextColor(0); }
        y += 9; doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text(desc, M, y); y += desc.length * 4.5 + 1;
        doc.setTextColor(90); doc.setFontSize(9);
        doc.text(`Raised ${it.raised || "—"}   Due ${L.dueOf(it) ? L.iso(L.dueOf(it)) : "—"}   ${it.status}   Priority ${it.priority}`, M, y); doc.setTextColor(0); y += 4;
        let py = top;
        for (const p of ph) {
          try { const img = await imageData(await fullURL(p), 900); const sc = Math.min(PW / img.w, PH / img.h); doc.addImage(img.data, "JPEG", W - M - PW + (PW - img.w * sc) / 2, py, img.w * sc, img.h * sc); }
          catch (e) { doc.setFontSize(8); doc.text("(photo unavailable)", W - M - PW, py + 5); }
          py += PH + 3;
        }
        y = Math.max(y, py) + 3; doc.setDrawColor(225); doc.line(M, y, W - M, y); y += 5;
      }
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(9); doc.setTextColor(90); doc.text("Please confirm completion dates for overdue items.", M, H - 8); doc.text(`Page ${i} of ${pages}`, W - M, H - 8, { align: "right" }); }
    doc.save(`Punch list - ${contractor} - ${todayISO()}.pdf`);
  } catch (err) { toast("Couldn't build the PDF: " + (err.message || err), 5000); }
  b.disabled = false; b.textContent = "PDF with photos";
};

/* ---------------- reports ---------------- */
function mondayOf(d) { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return L.iso(m); }
async function loadLatestReport() {
  try { const { data } = await sb.from("weekly_reports").select("*").order("week_start", { ascending: false }).limit(1); latestReport = data && data[0] || null; } catch (e) { }
  const thisWeek = mondayOf(L.today());
  let seen = null; try { seen = localStorage.getItem("dl_reportSeen"); } catch (e) { }
  $("noticeReport").hidden = !(latestReport && latestReport.week_start === thisWeek && seen !== thisWeek);
  if (latestReport) $("noticeReportText").textContent = `Monday report for the week of ${fmt(latestReport.week_start)} is ready.`;
}
function renderReport() {
  const kind = $("rKind").value; $("sProject").disabled = kind === "monday";
  let text = "";
  if (kind === "monday") {
    text = latestReport ? L.reportText(latestReport.week_start, latestReport.stats) : "No Monday report yet. It's built automatically every Monday at 7:00 a.m.";
    $("sumHint").textContent = latestReport ? `Built ${new Date(latestReport.created_at).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Rebuilt automatically every Monday at 7:00 a.m.` : "";
  } else { text = L.summaryText(live(), $("sProject").value); $("sumHint").textContent = "Built from the log right now."; }
  $("sumOut").textContent = text;
  $("btnMailSum").href = "mailto:?subject=" + encodeURIComponent(text.split("\n")[0]) + "&body=" + encodeURIComponent(text.length > 1800 ? text.slice(0, 1800) + "\n…" : text);
}
function openReports() { renderReport(); $("ovReports").hidden = false; if (latestReport) { try { localStorage.setItem("dl_reportSeen", latestReport.week_start); } catch (e) { } $("noticeReport").hidden = true; } }
$("btnReports").onclick = openReports; $("btnOpenReport").onclick = () => { $("rKind").value = "monday"; openReports(); };
$("rKind").addEventListener("change", renderReport); $("sProject").addEventListener("change", renderReport);
$("btnCopySum").onclick = () => copy($("sumOut").textContent);
$("btnRebuild").onclick = async () => {
  const b = $("btnRebuild"); b.disabled = true; const { error } = await sb.rpc("refresh_weekly_report"); b.disabled = false;
  if (error) { toast("Couldn't rebuild: " + error.message); return; } await loadLatestReport(); $("rKind").value = "monday"; renderReport(); toast("Report rebuilt");
};

/* ---------------- team ---------------- */
async function loadMembers() {
  try { const { data } = await sb.from("members").select("*").order("name"); members = data || []; const me = members.find(m => m.email === meEmail); meName = (me && me.name) || meEmail; } catch (e) { meName = meName || meEmail; }
}
function renderTeam() {
  $("teamList").innerHTML = members.map(m => `<div class="member"><div style="min-width:0"><b>${esc(m.name || m.email)}</b><div class="hint" style="overflow-wrap:anywhere">${esc(m.email)}</div></div>
    <select data-role="${esc(m.email)}" aria-label="Role for ${esc(m.email)}"${m.email === meEmail ? " disabled" : ""}>${["admin", "editor", "viewer"].map(r => `<option value="${r}"${m.role === r ? " selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}</select>
    ${m.email === meEmail ? '<span class="hint">You</span>' : `<button class="btn small danger" type="button" data-rm="${esc(m.email)}">Remove</button>`}</div>`).join("");
}
$("teamList").addEventListener("change", async e => { const s = e.target.closest("[data-role]"); if (!s) return; const { error } = await sb.from("members").update({ role: s.value }).eq("email", s.dataset.role); if (error) toast("Couldn't change role: " + error.message); else { toast("Role updated"); await loadMembers(); renderTeam(); } });
$("teamList").addEventListener("click", async e => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Confirm"; return; }
  const { error } = await sb.from("members").delete().eq("email", b.dataset.rm); if (error) toast("Couldn't remove: " + error.message); else { await loadMembers(); renderTeam(); toast("Removed"); }
});
$("teamForm").addEventListener("submit", async e => {
  e.preventDefault(); const email = $("tEmail").value.trim().toLowerCase();
  const { error } = await sb.from("members").upsert({ email, name: $("tName").value.trim(), role: $("tRole").value });
  if (error) { toast("Couldn't add: " + error.message); return; }
  $("teamForm").reset(); await loadMembers(); renderTeam(); toast(`Added ${email}. They can now sign in with their email.`, 4000);
});

/* ---------------- export ---------------- */
function exportExcel() {
  const k = ["ref", "ext_ref", "project", "location", "category", "description", "contractor", "priority", "raised", "due", "status", "closed", "notes"];
  const head = ["ID", "Item #", "Project", "Location", "Type", "Description", "Contractor", "Priority", "Raised", "Due", "Status", "Closed", "Notes", "Photos", "Age (days)", "Overdue"];
  const rows = sorted(filtered()).map(it => k.map(x => it[x] ?? "").concat([photosOf(it).length, L.ageOf(it), L.isLate(it) ? "Yes" : ""]));
  const ws = XLSX.utils.aoa_to_sheet([head].concat(rows)); ws["!cols"] = head.map((h, i) => ({ wch: [8, 8, 14, 26, 22, 44, 14, 8, 11, 11, 20, 11, 30, 7, 9, 8][i] }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Deficiencies");
  XLSX.writeFile(wb, `Deficiency log ${todayISO()}.xlsx`);
}

/* ---------------- menus, overlays, connectivity ---------------- */
$("btnMore").onclick = e => { e.stopPropagation(); const m = $("moreMenu"); m.hidden = !m.hidden; $("btnMore").setAttribute("aria-expanded", String(!m.hidden)); };
document.addEventListener("click", e => { if (!e.target.closest(".menu")) $("moreMenu").hidden = true; });
$("moreMenu").addEventListener("click", e => {
  const c = e.target.closest("[data-cmd]"); if (!c) return; $("moreMenu").hidden = true;
  ({ import: () => openImport("tracker"), bluebeam: () => openImport("bluebeam"), history: () => openImport("history"), export: exportExcel,
    team: async () => { await loadMembers(); renderTeam(); $("ovTeam").hidden = false; }, trash: () => { showTrash = true; render(); }, signout: signOut })[c.dataset.cmd]();
});
document.querySelectorAll(".overlay").forEach(ov => ov.addEventListener("click", e => { if (e.target === ov || e.target.closest("[data-close]")) ov.hidden = true; }));
document.addEventListener("keydown", e => { if (e.key === "Escape") { $("lightbox").hidden = true; document.querySelectorAll(".overlay").forEach(o => o.hidden = true); $("moreMenu").hidden = true; } });
window.addEventListener("online", () => { render(); flush(); });
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden && session && role) { flush(); scheduleReload(); } });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
boot().catch(e => { console.error(e); toast("Startup failed: " + (e.message || e), 6000); });
})();
