// app.js (NAS Gateway + resize integrated)
// v20260109-nas

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** =========================
 *  Config
 *  ========================= */
const SUPABASE_URL = "https://jvzcynpajbjdbtzbysxm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_h7DfY9lO57IP_N3-Yz_hmg_mep3kopP";

// NAS Gateway (reverse proxy)
const NAS_GATEWAY_URL = "https://asbts.synology.me/asb";

// Image resize before upload
const RESIZE_MAX_SIDE = 2048;
const RESIZE_QUALITY = 0.82;

// App settings
const APP_TITLE = "현장 업로드";

// Storage backend for NEW uploads (old Supabase storage URLs can still render)
const STORAGE_BACKEND = "nas"; // "nas" | "supabase"

/** =========================
 *  DOM helpers
 *  ========================= */
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function fmtDateLike(v) {
  if (!v) return "";
  const s = String(v);
  // 2026-01-09T12:34:56 -> 2026-01-09
  if (s.includes("T")) return s.split("T", 1)[0];
  // 20260109 -> 2026-01-09
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

function safeIdShort(v) {
  if (!v) return "";
  const s = String(v);
  return s.length > 8 ? s.slice(0, 8) : s;
}

function setStatus(msg, kind = "") {
  const foot = $("#footStatus");
  if (!foot) return;
  foot.textContent = msg || "";
  foot.classList.toggle("blink", kind === "busy");
  foot.classList.toggle("danger", kind === "error");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** =========================
 *  Modal (confirm upload)
 *  ========================= */
const modal = {
  root: $("#modal"),
  title: $("#modalTitle"),
  preview: $("#modalPreview"),
  meta: $("#modalMeta"),
  btnClose: $("#modalClose"),
  btnReject: $("#modalReject"),
  btnAccept: $("#modalAccept"),
  current: null, // { file, onAccept, onReject }
};

function modalOpen({ title, imgUrl, metaHtml, onAccept, onReject }) {
  modal.title.textContent = title || "사진 확인";
  modal.preview.src = imgUrl || "";
  modal.meta.innerHTML = metaHtml || "";
  modal.current = { onAccept, onReject };
  modal.root.hidden = false;
}

function modalClose() {
  modal.root.hidden = true;
  modal.preview.src = "";
  modal.meta.innerHTML = "";
  modal.current = null;
}

modal.btnClose?.addEventListener("click", modalClose);
modal.btnReject?.addEventListener("click", () => {
  const cur = modal.current;
  modalClose();
  cur?.onReject?.();
});
modal.btnAccept?.addEventListener("click", async () => {
  const cur = modal.current;
  if (!cur?.onAccept) return modalClose();
  try {
    await cur.onAccept();
  } finally {
    modalClose();
  }
});

/** =========================
 *  Viewer (thumbnail click)
 *  ========================= */
const viewer = {
  root: $("#viewerModal"),
  img: $("#viewerImg"),
  title: $("#viewerTitle"),
  label: $("#viewerLabel"),
  btnPrev: $("#viewerPrev"),
  btnNext: $("#viewerNext"),
  btnZoom: $("#viewerZoom"),
  btnClose: $("#viewerClose"),
  items: [], // [{url,label}]
  idx: 0,
  zoomed: false,
};

function viewerRender() {
  const it = viewer.items[viewer.idx];
  if (!it) return;
  viewer.img.src = it.url;
  viewer.label.textContent = it.label || "";
  viewer.img.classList.toggle("zoom2", viewer.zoomed);
  viewer.btnPrev.disabled = viewer.idx <= 0;
  viewer.btnNext.disabled = viewer.idx >= viewer.items.length - 1;
}

function viewerOpen(items, idx = 0, title = "미리보기") {
  viewer.items = items || [];
  viewer.idx = Math.max(0, Math.min(idx, viewer.items.length - 1));
  viewer.title.textContent = title;
  viewer.zoomed = false;
  viewer.root.hidden = false;
  viewerRender();
}

function viewerClose() {
  viewer.root.hidden = true;
  viewer.items = [];
  viewer.idx = 0;
  viewer.img.src = "";
  viewer.zoomed = false;
}

viewer.btnClose?.addEventListener("click", viewerClose);
viewer.btnPrev?.addEventListener("click", () => { viewer.idx = Math.max(0, viewer.idx - 1); viewerRender(); });
viewer.btnNext?.addEventListener("click", () => { viewer.idx = Math.min(viewer.items.length - 1, viewer.idx + 1); viewerRender(); });
viewer.btnZoom?.addEventListener("click", () => { viewer.zoomed = !viewer.zoomed; viewerRender(); });

/** =========================
 *  Supabase
 *  ========================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** =========================
 *  Schema/table detection (best-effort)
 *  ========================= */
const db = {
  schema: null,          // null | "measurement"
  jobTable: null,        // "jobs" ...
  sampleTable: null,     // "samples" ...
  photoTable: null,      // "job_photos" ...
};

function sbFrom(schema, table) {
  if (schema && supabase.schema) return supabase.schema(schema).from(table);
  return supabase.from(table);
}

async function trySelect(schema, table) {
  try {
    const { data, error } = await sbFrom(schema, table).select("*").limit(2);
    if (error) return { ok: false, error, rows: 0, sample: null, keys: [] };
    const rows = Array.isArray(data) ? data.length : 0;
    const sample = rows ? data[0] : null;
    const keys = sample ? Object.keys(sample) : [];
    return { ok: true, data, rows, sample, keys };
  } catch (e) {
    return { ok: false, error: e, rows: 0, sample: null, keys: [] };
  }
}

async function detectDb() {
  // avoid re-detect
  if (db.jobTable && db.sampleTable && db.photoTable) return;

  const schemas = [null, "measurement"];
  const jobCandidates = ["jobs", "job_sites", "sites"];
  const sampleCandidates = ["samples", "air_samples", "air_sample"];
  const photoCandidates = ["job_photos", "photos", "sample_photos"];

  const jobKeyHints = ["site_name", "job_name", "project_name", "name", "work_date", "date", "created_at"];
  const sampleKeyHints = ["job_id", "site_id", "sample_no", "sample_num", "seq", "fiber", "flow", "volume", "count"];
  const photoKeyHints = ["storage_path", "path", "sample_id", "job_id", "role", "kind", "created_at"];

  const scoreKeys = (keys, hints) => {
    if (!Array.isArray(keys) || !keys.length) return 0;
    let s = 0;
    for (const h of hints) {
      if (keys.includes(h)) s += 1;
    }
    return s;
  };

  const pickBestTable = async (schema, candidates, hints) => {
    let best = null;
    for (const t of candidates) {
      const r = await trySelect(schema, t);
      if (!r.ok) continue;
      // Prefer tables that actually return rows for this user (avoid picking empty tables that merely exist)
      const score = (r.rows > 0 ? 100 : 0) + scoreKeys(r.keys, hints);
      const cand = { table: t, score, rows: r.rows, keys: r.keys };
      if (!best || cand.score > best.score) best = cand;
    }
    return best;
  };

  let bestSchema = null;
  let bestPack = null;
  let bestTotal = -1;

  for (const sc of schemas) {
    const bj = await pickBestTable(sc, jobCandidates, jobKeyHints);
    const bs = await pickBestTable(sc, sampleCandidates, sampleKeyHints);
    const bp = await pickBestTable(sc, photoCandidates, photoKeyHints);

    if (!bj || !bs || !bp) continue;
    const total = bj.score + bs.score + bp.score;

    if (total > bestTotal) {
      bestTotal = total;
      bestSchema = sc;
      bestPack = { bj, bs, bp };
    }
  }

  if (bestPack) {
    db.schema = bestSchema;
    db.jobTable = bestPack.bj.table;
    db.sampleTable = bestPack.bs.table;
    db.photoTable = bestPack.bp.table;
    return;
  }

  // fallback
  db.schema = null;
  db.jobTable = db.jobTable || "jobs";
  db.sampleTable = db.sampleTable || "samples";
  db.photoTable = db.photoTable || "job_photos";
}

/** =========================
 *  Auth + Settings
 *  ========================= */
const LS = {
  company: "asb_company",
  mode: "asb_mode",
};

const state = {
  session: null,
  user: null,
  view: "boot", // boot | login | jobs | samples
  company: localStorage.getItem(LS.company) || "대한",
  mode: localStorage.getItem(LS.mode) || "density", // density | scatter
  jobs: [],
  job: null,
  samples: [],
  photosBySample: new Map(), // sample_id -> { role: [photoRecord...] }
};

function saveSettings() {
  localStorage.setItem(LS.company, state.company);
  localStorage.setItem(LS.mode, state.mode);
}

function modeLabel(m) {
  return m === "scatter" ? "비산" : "농도";
}

function roleLabels(mode) {
  // 농도: start/end, 비산: before/after (CSS comment: scatter 2칸)
  return mode === "scatter"
    ? [{ key: "before", label: "작업 전" }, { key: "after", label: "작업 후" }]
    : [{ key: "start", label: "시작" }, { key: "end", label: "종료" }];
}

/** =========================
 *  Settings menu
 *  ========================= */
const btnBack = $("#btnBack");
const btnGear = $("#btnGear");
const menu = $("#settingsMenu");
const menuChangeMode = $("#menuChangeMode");
const menuChangeCompany = $("#menuChangeCompany");
const menuSignOut = $("#menuSignOut");

function menuHide() { if (menu) menu.hidden = true; }
function menuToggle() { if (!menu) return; menu.hidden = !menu.hidden; }

btnGear?.addEventListener("click", menuToggle);
document.addEventListener("click", (e) => {
  if (!menu || menu.hidden) return;
  if (e.target === btnGear) return;
  if (menu.contains(e.target)) return;
  menuHide();
});

menuChangeMode?.addEventListener("click", async () => {
  menuHide();
  state.mode = state.mode === "density" ? "scatter" : "density";
  saveSettings();
  if (state.view === "samples") await loadSamplesAndPhotos();
  else if (state.view === "jobs") await loadJobs();
});

menuChangeCompany?.addEventListener("click", async () => {
  menuHide();
  state.company = state.company === "대한" ? "일오" : "대한";
  saveSettings();
  if (state.view === "samples") await loadSamplesAndPhotos();
  else if (state.view === "jobs") await loadJobs();
});

menuSignOut?.addEventListener("click", async () => {
  menuHide();
  await supabase.auth.signOut();
  state.session = null;
  state.user = null;
  state.job = null;
  state.jobs = [];
  state.samples = [];
  state.photosBySample = new Map();
  go("login");
});

/** =========================
 *  Upload helpers (NAS)
 *  ========================= */
async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function resizeImageToJpeg(file, maxSide = RESIZE_MAX_SIDE, quality = RESIZE_QUALITY) {
  try {
    if (!file || !file.type || !file.type.startsWith("image/")) return file;

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return file;

    const w = bitmap.width;
    const h = bitmap.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, tw, th);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;

    const name = (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function getSignedUrl(storagePath, ttlSec = 1800) {
  if (!storagePath) return null;

  // NAS path (preferred)
  if (storagePath.startsWith("nas:") || STORAGE_BACKEND === "nas") {
    const token = await getAccessToken();
    if (!token) throw new Error("로그인이 필요함");

    const rel = storagePath.startsWith("nas:") ? storagePath.slice(4) : storagePath;
    const r = await fetch(`${NAS_GATEWAY_URL}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ path: rel, ttl_sec: ttlSec }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`NAS sign 실패: ${r.status} ${t}`);
    }
    const j = await r.json();
    return j?.url || null;
  }

  // fallback: if it's an http(s) URL already
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) return storagePath;

  // fallback: Supabase Storage signed URL (if used)
  // NOTE: only works if your old records store "path inside bucket"
  try {
    const bucket = "job_photos";
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, ttlSec);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

async function uploadPhotoToNas({ jobId, sampleId, role, file }) {
  const token = await getAccessToken();
  if (!token) throw new Error("로그인이 필요함");

  const resized = await resizeImageToJpeg(file);

  const form = new FormData();
  form.append("job_id", String(jobId));
  form.append("sample_id", String(sampleId));
  form.append("role", String(role));
  form.append("file", resized, resized.name);

  const r = await fetch(`${NAS_GATEWAY_URL}/upload`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`NAS upload 실패: ${r.status} ${t}`);
  }
  const j = await r.json();
  // gateway should return storage_path like "nas:...."
  return j?.storage_path || j?.path || null;
}

/** =========================
 *  Data access (best-effort)
 *  ========================= */
function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function normalizeCompany(v) {
  const s = String(v || "");
  if (!s) return "";
  if (s.includes("대한")) return "대한";
  if (s.includes("1호") || s.includes("일오") || s.includes("1호안경")) return "일오";
  return s;
}

function normalizeMode(v) {
  const s = String(v || "").toLowerCase();
  if (!s) return "";
  if (s.includes("scatter") || s.includes("비산")) return "scatter";
  if (s.includes("density") || s.includes("농도")) return "density";
  return s;
}

function jobDisplay(job) {
  const name = pick(job, ["site_name", "site", "name", "job_name", "project_name"], `현장 ${safeIdShort(job?.id)}`);
  const d = fmtDateLike(pick(job, ["work_date", "date", "created_at", "updated_at"], ""));
  const company = normalizeCompany(pick(job, ["company", "company_name", "company_id"], "")) || "";
  const mode = normalizeMode(pick(job, ["mode", "work_mode", "task", "kind"], "")) || "";
  return { name, date: d, company, mode };
}

function sampleDisplay(s) {
  const no = pick(s, ["sample_no", "sample_num", "no", "seq", "index"], "");
  const loc = pick(s, ["location", "sample_location", "place"], "");
  const start = pick(s, ["start_time", "time_start", "start"], "");
  const end = pick(s, ["end_time", "time_end", "end"], "");
  const title = no ? `시료 ${no}` : `시료 ${safeIdShort(s?.id)}`;
  return { title, loc, start, end };
}

async function loadJobs() {
  setStatus("현장 목록 불러오는 중...", "busy");
  await detectDb();

  // pull jobs
  const { data, error } = await sbFrom(db.schema, db.jobTable).select("*").limit(200);
  if (error) {
    setStatus(`현장 불러오기 실패: ${error.message}`, "error");
    state.jobs = [];
    render();
    return;
  }

  // client-side filter by company/mode when fields exist
  const filtered = (data || []).filter(j => {
    const d = jobDisplay(j);
    const okCompany = !d.company || d.company === state.company;
    const okMode = !d.mode || d.mode === state.mode;
    return okCompany && okMode;
  });

  // sort by created_at/date desc when available
  filtered.sort((a, b) => {
    const da = pick(a, ["work_date", "date", "created_at", "updated_at"], "");
    const dbb = pick(b, ["work_date", "date", "created_at", "updated_at"], "");
    return String(dbb).localeCompare(String(da));
  });

  state.jobs = filtered;
  setStatus(`현장 ${state.jobs.length}건 (${state.company}/${modeLabel(state.mode)})`);
  render();
}

async function loadSamplesAndPhotos() {
  if (!state.job) return;
  setStatus("시료/사진 불러오는 중...", "busy");
  await detectDb();

  const jobId = state.job.id;

  // samples
  let samples = [];
  {
    // try job_id filter first; if fails, fallback to no filter (limited) but show message
    let { data, error } = await sbFrom(db.schema, db.sampleTable).select("*").eq("job_id", jobId).limit(500);
    if (error) {
      // fallback: sometimes job key is site_id
      const r2 = await sbFrom(db.schema, db.sampleTable).select("*").eq("site_id", jobId).limit(500);
      if (!r2.error) { data = r2.data; error = null; }
    }
    if (error) {
      setStatus(`시료 불러오기 실패: ${error.message}`, "error");
      state.samples = [];
    } else {
      samples = data || [];
      // sort by sample_no/seq if present
      samples.sort((a, b) => String(pick(a, ["sample_no", "seq", "index"], "")).localeCompare(String(pick(b, ["sample_no", "seq", "index"], ""))));
      state.samples = samples;
    }
  }

  // photos
  state.photosBySample = new Map();
  {
    let { data, error } = await sbFrom(db.schema, db.photoTable).select("*").eq("job_id", jobId).limit(2000);
    if (error) {
      // fallback: sometimes site_id
      const r2 = await sbFrom(db.schema, db.photoTable).select("*").eq("site_id", jobId).limit(2000);
      if (!r2.error) { data = r2.data; error = null; }
    }
    if (!error) {
      for (const p of (data || [])) {
        const sid = pick(p, ["sample_id", "air_sample_id", "sample_uuid"], null);
        const role = pick(p, ["role", "photo_type", "kind"], "photo");
        const storagePath = pick(p, ["storage_path", "path", "photo_path", "url"], "");
        if (!sid) continue;
        if (!state.photosBySample.has(sid)) state.photosBySample.set(sid, {});
        const m = state.photosBySample.get(sid);
        if (!m[role]) m[role] = [];
        m[role].push({ ...p, storage_path: storagePath, role });
      }
    }
  }

  setStatus(`시료 ${state.samples.length}건`);
  render();
}

/** =========================
 *  UI rendering
 *  ========================= */
const root = $("#root");

function clearRoot() { root.innerHTML = ""; }

function showHeader(back, gear) {
  if (btnBack) btnBack.style.display = back ? "" : "none";
  if (btnGear) btnGear.style.display = gear ? "" : "none";
}

btnBack?.addEventListener("click", () => {
  if (state.view === "samples") {
    state.job = null;
    go("jobs");
  } else {
    go("jobs");
  }
});

function go(view) {
  state.view = view;
  render();
  if (view === "jobs") loadJobs();
}

function renderLogin() {
  showHeader(false, false);
  clearRoot();

  const email = el("input", { class: "input", type: "email", placeholder: "이메일", autocomplete: "username" });
  const pass = el("input", { class: "input", type: "password", placeholder: "비밀번호", autocomplete: "current-password" });

  const btnLogin = el("button", { class: "btn primary", type: "button", onclick: async () => {
    setStatus("로그인 중...", "busy");
    const e = email.value.trim();
    const p = pass.value;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: e, password: p });
      if (error) throw error;
      state.session = data.session;
      state.user = data.user;
      setStatus("로그인 완료");
      go("jobs");
    } catch (err) {
      setStatus(`로그인 실패: ${err?.message || err}`, "error");
    }
  }}, "로그인");

  const card = el("div", { class: "card" },
    el("div", { class: "item-title" }, APP_TITLE),
    el("div", { class: "row" },
      el("div", { class: "col" }, el("div", { class: "label" }, "이메일"), email),
      el("div", { class: "col" }, el("div", { class: "label" }, "비밀번호"), pass),
    ),
    el("div", { class: "row" }, btnLogin),
    el("div", { class: "small", style: "color:var(--muted)" }, "※ 계정은 관리자 승인 후 사용 가능합니다.")
  );

  root.appendChild(card);
}

function renderJobs() {
  showHeader(false, true);
  clearRoot();

  const header = el("div", { class: "card" },
    el("div", { class: "row space" },
      el("div", {},
        el("div", { class: "item-title" }, `현장 (${state.company} / ${modeLabel(state.mode)})`),
        el("div", { class: "small", style: "color:var(--muted)" }, `테이블: ${db.schema ? db.schema + "." : ""}${db.jobTable}`)
      ),
      el("div", { class: "badge-new" }, `${state.jobs.length}`)
    )
  );
  root.appendChild(header);

  if (!state.jobs.length) {
    root.appendChild(el("div", { class: "card" },
      el("div", { style: "color:var(--muted)" }, "현장이 없습니다. (필터/테이블 확인 필요)")
    ));
    return;
  }

  const list = el("div", { class: "list" });
  for (const job of state.jobs) {
    const d = jobDisplay(job);
    const item = el("button", {
      class: "item",
      type: "button",
      onclick: async () => {
        state.job = job;
        go("samples");
        await loadSamplesAndPhotos();
      }
    },
      el("div", {},
        el("div", { class: "item-title" }, d.name),
        el("div", { class: "item-sub" }, [d.date, d.company, d.mode ? modeLabel(d.mode) : ""].filter(Boolean).join(" · "))
      ),
      el("div", { class: "small", style: "color:var(--muted)" }, safeIdShort(job.id))
    );
    list.appendChild(item);
  }
  root.appendChild(list);
}

function makeFilePicker({ capture = true, accept = "image/*" }) {
  const input = el("input", {
    type: "file",
    accept,
    ...(capture ? { capture: "environment" } : {}),
    style: "display:none"
  });
  document.body.appendChild(input);
  return input;
}

async function renderSampleRow(sample) {
  const sid = sample.id;
  const disp = sampleDisplay(sample);
  const roles = roleLabels(state.mode);

  const left = el("div", { class: "sampleLeft" },
    el("div", { class: "sampleTitle" }, disp.title),
    el("div", { class: "metaLine" },
      disp.loc ? el("span", { class: "small", style: "color:var(--muted)" }, disp.loc) : null,
      disp.start ? el("span", { class: "small", style: "color:var(--muted)" }, `시작 ${disp.start}`) : null,
      disp.end ? el("span", { class: "small", style: "color:var(--muted)" }, `종료 ${disp.end}`) : null,
    )
  );

  const right = el("div", { class: `sampleRight ${state.mode}` });

  // current photos map
  const roleMap = state.photosBySample.get(sid) || {};

  for (const r of roles) {
    const slot = el("div", { class: "slot" });
    const thumb = el("div", { class: "thumbMini" });
    const btn = el("button", { class: "btn ghost", type: "button" }, r.label);

    const photos = roleMap[r.key] || [];
    let firstUrl = null;
    if (photos.length) {
      try {
        firstUrl = await getSignedUrl(photos[photos.length - 1].storage_path);
      } catch {
        firstUrl = null;
      }
    }

    if (firstUrl) {
      const img = el("img", { src: firstUrl, alt: r.label });
      thumb.appendChild(img);
      thumb.style.cursor = "pointer";
      thumb.addEventListener("click", async () => {
        // build viewer items for this sample across roles
        const items = [];
        for (const rr of roles) {
          const arr = roleMap[rr.key] || [];
          for (const pr of arr) {
            const u = await getSignedUrl(pr.storage_path).catch(() => null);
            if (u) items.push({ url: u, label: `${disp.title} · ${rr.label}` });
          }
        }
        if (items.length) viewerOpen(items, 0, disp.title);
      });
    } else {
      thumb.appendChild(el("div", { style: "color:var(--muted)" }, "—"));
    }

    btn.addEventListener("click", async () => {
      try {
        const picker = makeFilePicker({ capture: true });
        picker.onchange = async () => {
          const file = picker.files?.[0];
          picker.remove();
          if (!file) return;

          const localUrl = URL.createObjectURL(file);
          const metaHtml = `
            <div><b>${disp.title}</b></div>
            <div>${r.label}</div>
          `;

          modalOpen({
            title: "사진 확인",
            imgUrl: localUrl,
            metaHtml,
            onReject: () => URL.revokeObjectURL(localUrl),
            onAccept: async () => {
              setStatus("업로드 중...", "busy");
              try {
                const storage_path = await uploadPhotoToNas({
                  jobId: state.job.id,
                  sampleId: sid,
                  role: r.key,
                  file
                });

                // update local photo map (optimistic)
                if (!state.photosBySample.has(sid)) state.photosBySample.set(sid, {});
                const rm = state.photosBySample.get(sid);
                if (!rm[r.key]) rm[r.key] = [];
                rm[r.key].push({ storage_path, role: r.key, sample_id: sid, job_id: state.job.id });

                // re-render samples view (cheap: reload photos list from DB, but keeps consistent)
                await sleep(150);
                await loadSamplesAndPhotos();
                setStatus("업로드 완료");
              } catch (err) {
                setStatus(`업로드 실패: ${err?.message || err}`, "error");
              } finally {
                URL.revokeObjectURL(localUrl);
              }
            }
          });
        };
        picker.click();
      } catch (err) {
        setStatus(`사진 선택 실패: ${err?.message || err}`, "error");
      }
    });

    slot.appendChild(thumb);
    slot.appendChild(btn);
    right.appendChild(slot);
  }

  const row = el("div", { class: `sampleRow mode-${state.mode}` }, left, right);
  return row;
}

async function renderSamples() {
  showHeader(true, true);
  clearRoot();

  const job = state.job;
  const d = jobDisplay(job);

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "item-title" }, d.name),
    el("div", { class: "small", style: "color:var(--muted)" }, [d.date, state.company, modeLabel(state.mode)].filter(Boolean).join(" · ")),
    el("div", { class: "small", style: "color:var(--muted)" }, `샘플: ${db.schema ? db.schema + "." : ""}${db.sampleTable} / 사진: ${db.schema ? db.schema + "." : ""}${db.photoTable}`)
  ));

  if (!state.samples.length) {
    root.appendChild(el("div", { class: "card" },
      el("div", { style: "color:var(--muted)" }, "시료가 없습니다. (테이블/컬럼 확인 필요)")
    ));
    return;
  }

  // render progressively to avoid blocking
  const wrap = el("div", { class: "list" });
  root.appendChild(wrap);

  setStatus("시료 렌더링 중...", "busy");
  for (let i = 0; i < state.samples.length; i++) {
    const row = await renderSampleRow(state.samples[i]);
    wrap.appendChild(row);
    if (i % 10 === 0) await sleep(0);
  }
  setStatus(`시료 ${state.samples.length}건`);
}

function render() {
  menuHide();

  if (state.view === "login") return renderLogin();
  if (state.view === "jobs") return renderJobs();
  if (state.view === "samples") return renderSamples();

  // boot
  clearRoot();
  root.appendChild(el("div", { class: "card" },
    el("div", { style: "color:var(--muted)" }, "초기화 중...")
  ));
}

/** =========================
 *  Boot
 *  ========================= */
async function boot() {
  setStatus("초기화 중...", "busy");
  try {
    const { data: { session } } = await supabase.auth.getSession();
    state.session = session;
    state.user = session?.user || null;

    // show initial view
    if (state.session) {
      go("jobs");
    } else {
      go("login");
    }

    // auth state listener
    supabase.auth.onAuthStateChange((_event, session2) => {
      state.session = session2;
      state.user = session2?.user || null;
      if (!session2) go("login");
    });

    setStatus("준비되었습니다.");
  } catch (e) {
    setStatus(`초기화 실패: ${e?.message || e}`, "error");
    go("login");
  }
}

boot();
