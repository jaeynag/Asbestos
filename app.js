// app.js (GitHub Pages web uploader)
// - UI: index.html + styles.css classes are kept
// - Data: Supabase (Auth + PostgREST)
// - Heavy files: NAS 업로드(권장) / Supabase Storage(예비)
//
// NAS 설정(전사 공통)
//   - index.html의 window.APP_CONFIG 값을 사용합니다.
//   - 추가로, 개발/테스트 용도로 localStorage 값이 있으면(localStorage가 더 우선) 이를 사용합니다.
//
// NAS 업로드 API(권장 형태)
//   POST NAS_UPLOAD_URL (multipart/form-data)
//     - file: binary
//     - path: "companyId/mode/jobId/2026.01.01/<sampleId>/<role>.jpg"
//   응답(JSON) 예시
//     { "ok": true, "url": "https://.../files/...", "path": "..." }
//
// storage_path 저장 규칙
//   - Supabase Storage: "companyId/mode/jobId/.../role.jpg" (상대경로)
//   - NAS:             "https://.../files/.../role.jpg" (URL)

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** =========================
 *  Config
 *  ========================= */
const SUPABASE_URL = "https://jvzcynpajbjdbtzbysxm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_h7DfY9lO57IP_N3-Yz_hmg_mep3kopP";

// Supabase Storage bucket (fallback / thumbnail signed url)
const BUCKET = "job_photos";
const SIGNED_URL_TTL_SEC = 60 * 30; // 30분

// Tables
const T_COMPANIES = "companies";
const T_JOBS = "jobs";
const T_SAMPLES = "job_samples";
const T_PHOTOS = "sample_photos";

// RPC (있으면 사용, 없으면 가능한 범위에서 fallback)
const RPC_EMAIL_EXISTS = "email_exists";
const RPC_CREATE_SAMPLE = "create_sample";
const RPC_UPSERT_SAMPLE_PHOTO = "upsert_sample_photo";
const RPC_DELETE_SAMPLE_AND_RENUMBER = "delete_sample_and_renumber";

// NAS (preferred)
const APP_CONFIG = (typeof window !== "undefined" && window.APP_CONFIG && typeof window.APP_CONFIG === "object")
  ? window.APP_CONFIG
  : {};

function _trim(v) {
  return String(v ?? "").trim();
}
function _normBase(v) {
  return _trim(v).replace(/\/$/, "");
}
function _isGithubIoHost() {
  try {
    return /(^|\.)github\.io$/i.test(location.hostname);
  } catch {
    return false;
  }
}

// 우선순위: localStorage(개발/테스트) > window.APP_CONFIG(배포 설정) > 자동(커스텀 도메인에서는 현재 도메인)
const LS_GATEWAY = _trim(localStorage.getItem("NAS_GATEWAY_URL"));
const LS_UPLOAD = _trim(localStorage.getItem("NAS_UPLOAD_URL"));
const LS_FILE_BASE = _trim(localStorage.getItem("NAS_FILE_BASE"));
const LS_DELETE = _trim(localStorage.getItem("NAS_DELETE_URL"));
const LS_AUTH = _trim(localStorage.getItem("NAS_AUTH_TOKEN"));

const CFG_GATEWAY = _trim(APP_CONFIG.NAS_GATEWAY_URL);
const CFG_UPLOAD = _trim(APP_CONFIG.NAS_UPLOAD_URL);
const CFG_FILE_BASE = _trim(APP_CONFIG.NAS_FILE_BASE);
const CFG_DELETE = _trim(APP_CONFIG.NAS_DELETE_URL);
const CFG_AUTH = _trim(APP_CONFIG.NAS_AUTH_TOKEN);

const AUTO_GATEWAY = _isGithubIoHost() ? "" : _trim(location.origin);

const NAS_GATEWAY_URL = _normBase(LS_GATEWAY || CFG_GATEWAY || AUTO_GATEWAY);
const NAS_UPLOAD_URL = _trim(LS_UPLOAD || CFG_UPLOAD || (NAS_GATEWAY_URL ? `${NAS_GATEWAY_URL}/upload` : ""));
const NAS_FILE_BASE = _normBase(LS_FILE_BASE || CFG_FILE_BASE || (NAS_GATEWAY_URL ? `${NAS_GATEWAY_URL}/public` : ""));
const NAS_DELETE_URL = _trim(LS_DELETE || CFG_DELETE || "");


async function getNasAuthorization() {
  // 우선순위: localStorage > APP_CONFIG > Supabase 세션(access_token)
  const raw = _trim(LS_AUTH || CFG_AUTH);
  if (raw) {
    if (/^(Bearer|Basic)\s+/i.test(raw)) return raw;
    return `Bearer ${raw}`;
  }
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) return `Bearer ${token}`;
  } catch {
    // ignore
  }
  return "";
}

/** =========================
 *  Utils
 *  ========================= */
function ymdDots(dateStrOrDate) {
  const d = dateStrOrDate instanceof Date ? dateStrOrDate : new Date(dateStrOrDate);
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function iso10(dateStrOrDate) {
  if (!dateStrOrDate) return new Date().toISOString().slice(0, 10);
  if (dateStrOrDate instanceof Date) return dateStrOrDate.toISOString().slice(0, 10);
  const s = String(dateStrOrDate);
  return s.includes("T") ? s.split("T", 1)[0] : s.slice(0, 10);
}


function normalizeISODate(v) {
  // NAS Gateway는 Pydantic date라서 YYYY-MM-DD 형태가 필요함
  if (!v) return "";
  let s = iso10(v);
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(s)) s = s.replace(/\./g, "-");
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) s = s.replace(/\//g, "-");
  // 'YYYY-MM-DD' 길이 보정
  return s.slice(0, 10);
}

function formatFastApiDetail(detail) {
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.join(".") : (d?.loc || "");
        const msg = d?.msg || d?.message || "";
        return (loc ? `${loc}: ` : "") + (msg || JSON.stringify(d));
      })
      .join(" | ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return String(detail || "");
}

function setFoot(msg) {
  const el = document.getElementById("footStatus");
  if (el) el.textContent = msg;
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function safeText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === false || v === null || v === undefined) {
      // skip
    } else n.setAttribute(k, String(v));
  }
  for (const c of children || []) n.appendChild(c);
  return n;
}

function dotClass(status) {
  if (status === "uploading") return "dot blue blink";
  if (status === "done") return "dot green";
  if (status === "failed") return "dot red";
  return "dot";
}

function roleLabel(role) {
  if (role === "measurement") return "측정사진";
  if (role === "start") return "시작사진";
  if (role === "end") return "완료사진";
  return String(role || "");
}

function modeLabel(mode) {
  return mode === "scatter" ? "비산" : "농도";
}

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function joinUrl(base, path) {
  try {
    return new URL(path.replace(/^\//, ""), base.replace(/\/$/, "") + "/").toString();
  } catch {
    return base.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
  }
}

/** =========================
 *  Supabase
 *  ========================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** =========================
 *  State
 *  ========================= */
const state = {
  user: null,
  company: null, // {id,name}
  mode: null, // 'density'|'scatter'
  job: null,
  jobs: [],

  companies: [],

  dates: [],
  activeDate: null,
  samplesByDate: new Map(),

  authTab: "login", // login|signup
  authMsg: "",

  addOpen: false,
  addLoc: "",
  addTime: "",

  pending: null,

  viewer: {
    open: false,
    items: [],
    index: 0,
    zoom: 1,
    reqId: 0,
    objectUrl: null,
  },
};

/** =========================
 *  DOM refs
 *  ========================= */
const root = document.getElementById("root");
const btnBack = document.getElementById("btnBack");
const btnGear = document.getElementById("btnGear");
const appTitleEl = document.querySelector(".topbar .h1");
const settingsMenu = document.getElementById("settingsMenu");
const menuChangeMode = document.getElementById("menuChangeMode");
const menuChangeCompany = document.getElementById("menuChangeCompany");
const menuSignOut = document.getElementById("menuSignOut");

// modal
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalPreview = document.getElementById("modalPreview");
const modalMeta = document.getElementById("modalMeta");
const modalClose = document.getElementById("modalClose");
const modalReject = document.getElementById("modalReject");
const modalAccept = document.getElementById("modalAccept");

// viewer
const viewerModal = document.getElementById("viewerModal");
const viewerTitle = document.getElementById("viewerTitle");
const viewerImg = document.getElementById("viewerImg");
const viewerLabel = document.getElementById("viewerLabel");
const viewerClose = document.getElementById("viewerClose");
const viewerPrev = document.getElementById("viewerPrev");
const viewerNext = document.getElementById("viewerNext");
const viewerZoom = document.getElementById("viewerZoom");

/** =========================
 *  Header / menu
 *  ========================= */
function closeSettings() {
  if (settingsMenu) settingsMenu.hidden = true;
}
function toggleSettings() {
  if (settingsMenu) settingsMenu.hidden = !settingsMenu.hidden;
}

document.addEventListener("click", (ev) => {
  if (!settingsMenu || settingsMenu.hidden) return;
  const t = ev.target;
  if (t === btnGear || (btnGear && btnGear.contains(t))) return;
  if (settingsMenu.contains(t)) return;
  closeSettings();
});

function updateHeader() {
  const authed = !!state.user;
  if (btnGear) btnGear.style.display = authed ? "" : "none";
  if (btnBack) btnBack.style.display = authed && state.company ? "" : "none";

  if (menuChangeMode) menuChangeMode.disabled = !state.mode;
  if (menuChangeCompany) menuChangeCompany.disabled = !state.company;

  // Title
  const baseTitle = "Asbestos field photos";
  let title = baseTitle;
  if (state.user && state.company) title = safeText(state.company?.name, baseTitle);
  if (appTitleEl) appTitleEl.textContent = title;
  try { document.title = title; } catch {}

}

function goBack() {
  closeSettings();

  if (state.viewer.open) {
    closeViewer();
    return;
  }
  if (modal && !modal.hidden) {
    closeModal();
    return;
  }

  if (state.job) {
    state.job = null;
    state.addOpen = false;
    render();
    return;
  }
  if (state.mode) {
    state.mode = null;
    state.job = null;
    state.addOpen = false;
    render();
    return;
  }
  if (state.company) {
    state.company = null;
    state.mode = null;
    state.job = null;
    state.addOpen = false;
    render();
    return;
  }
}

btnBack?.addEventListener("click", goBack);
btnGear?.addEventListener("click", toggleSettings);

menuChangeMode?.addEventListener("click", () => {
  if (!state.user) return;
  closeSettings();
  if (!state.mode) return;
  if (!confirm("업무를 변경하시겠습니까?")) return;
  state.mode = null;
  state.job = null;
  state.addOpen = false;
  render();
});

menuChangeCompany?.addEventListener("click", () => {
  if (!state.user) return;
  closeSettings();
  if (!state.company) return;
  if (!confirm("회사를 변경하시겠습니까?")) return;
  state.company = null;
  state.mode = null;
  state.job = null;
  state.addOpen = false;
  render();
});

menuSignOut?.addEventListener("click", async () => {
  if (!state.user) return;
  closeSettings();
  await supabase.auth.signOut();
  state.user = null;
  state.company = null;
  state.mode = null;
  state.job = null;
  state.addOpen = false;
  setFoot("로그아웃되었습니다.");
  render();
});

/** =========================
 *  Modal
 *  ========================= */
function openModal(pending) {
  state.pending = pending;
  if (modalTitle) modalTitle.textContent = `사진 확인 · ${pending.roleLabel}`;
  if (modalPreview) modalPreview.src = pending.objectUrl;
  if (modalMeta) {
    const mb = (pending.file.size / 1024 / 1024).toFixed(2);
    modalMeta.textContent = `${pending.sourceLabel} · ${pending.file.name} · ${mb}MB`;
  }
  if (modal) modal.hidden = false;
}

function closeModal() {
  try {
    if (state.pending?.objectUrl) URL.revokeObjectURL(state.pending.objectUrl);
  } catch {
    // ignore
  }
  state.pending = null;
  if (modal) modal.hidden = true;
}

modalClose?.addEventListener("click", closeModal);
modalReject?.addEventListener("click", closeModal);
modalAccept?.addEventListener("click", async () => {
  if (!state.pending) return;
  const { sample, role, file } = state.pending;
  closeModal();
  await uploadAndBindPhoto(sample, role, file);
});

/** =========================
 *  Viewer
 *  ========================= */
function viewerRoleOrder(sample) {
  // 썸네일 role 값이 start/end/measurement/single 등으로 들어올 수 있어서
  // 모드별로 유연하게 처리한다.
  if (state.mode === "density") {
    // 농도는 사진 1장만: UI/뷰어에서는 항상 measurement 슬롯만 사용
    return ["measurement"];
  }
  // 비산은 전/후(시작/완료)만 사용
  return ["start", "end"];
}
function buildViewerItemsForDate(dateISO) {
  const samples = state.samplesByDate.get(dateISO) || [];
  const items = [];
  const sorted = [...samples].sort((a, b) => (a.p_index || 0) - (b.p_index || 0));

  for (const s of sorted) {
    const loc = safeText(s.sample_location, "미입력");
    const label = `P${s.p_index || "?"} · ${loc}`;
    for (const role of viewerRoleOrder(s)) {
      const path = s._photoPath?.[role];
      if (!path) continue;
      items.push({
        sample_id: s.id,
        p_index: s.p_index,
        label,
        role,
        storage_path: path,
      });
    }
  }
  return items;
}

async function resolvePhotoUrl(storagePath, sample, role) {
  if (!storagePath) return "";

  const sp = String(storagePath);

  // 1) full URL already
  if (isHttpUrl(sp)) {
    // NAS public URL 형태인데 권한이 필요한 경우가 있어, 가능하면 blob URL로 변환
    try {
      if (NAS_FILE_BASE && sp.startsWith(NAS_FILE_BASE) && NAS_GATEWAY_URL) {
        const rel = sp.slice(NAS_FILE_BASE.length).replace(/^\/+/, "");
        const auth = await getNasAuthorization();
        if (auth) {
          try {
            return await nasFetchBlobUrl(rel);
          } catch {
            // fallback to given URL
          }
        }
      }
    } catch {
      // ignore
    }
    return sp;
  }

  // 2) NAS relative: "nas:..."
  if (sp.startsWith("nas:")) {
    const rel = sp.slice(4).replace(/^\/+/, "");

    // public URL (가능하면)
    const publicUrl = NAS_FILE_BASE ? joinUrl(NAS_FILE_BASE, rel) : "";

    // 권한이 필요한 NAS면 blob URL로 변환 (img 태그는 헤더를 못 붙임)
    if (NAS_GATEWAY_URL) {
      const auth = await getNasAuthorization();
      if (auth) {
        try {
          return await nasFetchBlobUrl(rel);
        } catch {
          // blob 실패 시 public로 fallback
        }
      }
    }

    if (publicUrl) return publicUrl;
    throw new Error("NAS 파일 경로 설정이 되어 있지 않습니다. (NAS_FILE_BASE 또는 NAS_GATEWAY_URL)");
  }

  // 3) Supabase Storage path
  return await getSignedUrl(sp);
}

function openViewerAt(dateISO, targetSampleId, targetRole) {
  const items = buildViewerItemsForDate(dateISO);
  if (!items.length) return;

  let idx = 0;
  if (targetSampleId && targetRole) {
    const hit = items.findIndex((it) => it.sample_id === targetSampleId && it.role === targetRole);
    if (hit >= 0) idx = hit;
  }

  state.viewer.open = true;
  state.viewer.items = items;
  state.viewer.index = idx;
  state.viewer.zoom = 1;
  renderViewer();
}

function closeViewer() {
  state.viewer.open = false;
  state.viewer.items = [];
  state.viewer.index = 0;
  state.viewer.zoom = 1;
  if (state.viewer.objectUrl) { try { URL.revokeObjectURL(state.viewer.objectUrl); } catch {} state.viewer.objectUrl = null; }
  if (viewerModal) viewerModal.hidden = true;
}

async function renderViewer() {
  if (!viewerModal) return;
  if (!state.viewer.open) {
    viewerModal.hidden = true;
    return;
  }

  const item = state.viewer.items[state.viewer.index];
  if (!item) {
    closeViewer();
    return;
  }

  viewerModal.hidden = false;
  if (viewerTitle) viewerTitle.textContent = "미리보기";
  if (viewerLabel) viewerLabel.textContent = `${item.label} · ${roleLabel(item.role)}`;

  // resolve url (race-safe)
  const myReq = ++state.viewer.reqId;
  try {
    const url = await resolvePhotoUrl(item.storage_path, item.sample_id, item.role);
    if (!viewerImg) return;
    // 다른 사진으로 넘어간 뒤 늦게 응답이 오면 무시
    if (myReq !== state.viewer.reqId) return;

    // 이전 blob URL 정리(메모리 누수 방지)
    if (state.viewer.objectUrl) { try { URL.revokeObjectURL(state.viewer.objectUrl); } catch {} state.viewer.objectUrl = null; }

    // iOS/Safari에서 간헐적으로 갱신이 안 되는 케이스 방지
    viewerImg.removeAttribute("src");
    viewerImg.src = url;

    // blob URL이면 추적해서 close/전환 시 revoke
    if (typeof url === "string" && url.startsWith("blob:")) state.viewer.objectUrl = url;

    // 로딩 실패 시 사용자 피드백
    viewerImg.onerror = () => {
      if (myReq !== state.viewer.reqId) return;
      setFoot("미리보기 로딩 실패(네트워크/권한/CORS).");
    };
  } catch (e) {
    if (myReq !== state.viewer.reqId) return;
    setFoot(`미리보기 URL 생성 실패: ${e?.message || e}`);
  }

  if (viewerImg) viewerImg.style.transform = `scale(${state.viewer.zoom || 1})`;
}

viewerClose?.addEventListener("click", closeViewer);
viewerPrev?.addEventListener("click", () => {
  if (!state.viewer.items.length) return;
  state.viewer.index = (state.viewer.index - 1 + state.viewer.items.length) % state.viewer.items.length;
  renderViewer();
});
viewerNext?.addEventListener("click", () => {
  if (!state.viewer.items.length) return;
  state.viewer.index = (state.viewer.index + 1) % state.viewer.items.length;
  renderViewer();
});
viewerZoom?.addEventListener("click", () => {
  state.viewer.zoom = state.viewer.zoom === 1 ? 2 : 1;
  renderViewer();
});

/** =========================
 *  API
 *  ========================= */
async function emailExists(email) {
  try {
    const e = normEmail(email);
    const { data, error } = await supabase.rpc(RPC_EMAIL_EXISTS, { p_email: e });
    if (error) {
      console.warn("email_exists RPC를 사용할 수 없습니다:", error);
      return null;
    }
    return !!data;
  } catch (e) {
    console.warn("email_exists 확인 실패:", e);
    return null;
  }
}

async function fetchCompanies() {
  const { data, error } = await supabase.from(T_COMPANIES).select("id,name").order("name", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchJobs(companyId, mode) {
  const { data, error } = await supabase
    .from(T_JOBS)
    .select("id,company_id,mode,project_name,address,contractor,status,created_at,last_upload_at")
    .eq("company_id", companyId)
    .eq("mode", mode)
    .order("last_upload_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

async function fetchSamples(jobId) {
  const { data, error } = await supabase
    .from(T_SAMPLES)
    .select("id,job_id,measurement_date,sample_location,p_index,start_time,created_at")
    .eq("job_id", jobId)
    .order("measurement_date", { ascending: true })
    .order("p_index", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchPhotosForSamples(sampleIds) {
  if (!sampleIds.length) return [];
  const { data, error } = await supabase
    .from(T_PHOTOS)
    .select("sample_id,role,storage_path,state,uploaded_at")
    .in("sample_id", sampleIds);
  if (error) throw error;
  return data || [];
}

async function createJob({ company_id, mode, project_name, address, contractor }) {
  const userId = state.user?.id || null;
  const payload = {
    company_id,
    mode,
    project_name,
    address,
    contractor,
    status: "new",
    created_by: userId,
  };

  const { data, error } = await supabase.from(T_JOBS).insert([payload]).select().single();
  if (error) throw error;
  return data;
}

async function createSample(jobId, dateISO, location) {
  // try RPC first
  try {
    const { data, error } = await supabase.rpc(RPC_CREATE_SAMPLE, {
      p_job_id: jobId,
      p_date: dateISO,
      p_location: location || "",
    });
    if (!error && data) return data;
    if (error) throw error;
  } catch (e) {
    console.warn("create_sample RPC 실패 (fallback insert):", e);
  }

  // fallback insert
  const { data, error } = await supabase
    .from(T_SAMPLES)
    .insert([
      {
        job_id: jobId,
        measurement_date: dateISO,
        sample_location: location || "",
      },
    ])
    .select()
    .single();
  if (error) throw error;

  // best-effort renumber
  try {
    await renumberSamplesForDate(jobId, dateISO);
  } catch (e) {
    console.warn("renumber fallback 실패:", e);
  }

  return data;
}

async function updateSampleFields(sampleId, patch) {
  const { error } = await supabase.from(T_SAMPLES).update(patch).eq("id", sampleId);
  if (error) throw error;
}

async function getSignedUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error) throw error;
  return data.signedUrl;
}

async function upsertSamplePhoto(sampleId, role, storagePath) {
  // try RPC
  try {
    const { data, error } = await supabase.rpc(RPC_UPSERT_SAMPLE_PHOTO, {
      p_sample_id: sampleId,
      p_role: role,
      p_storage_path: storagePath,
    });
    if (!error && data) return data;
    if (error) throw error;
  } catch (e) {
    console.warn("upsert_sample_photo RPC 실패 (fallback upsert):", e);
  }

  // fallback: upsert table directly (requires 정책 허용)
  const { data, error } = await supabase
    .from(T_PHOTOS)
    .upsert(
      [{ sample_id: sampleId, role, storage_path: storagePath, state: "done", uploaded_at: new Date().toISOString() }],
      { onConflict: "sample_id,role" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** =========================
 *  NAS helpers
 *  ========================= */
function nasEnabled() {
  return !!NAS_UPLOAD_URL;
}

async function nasUpload(meta, file) {
  // NAS Upload Gateway
  // POST /upload (multipart/form-data)
  // required fields (per API validation): file, company_id, job_id, date_folder, sample_id, role
  if (!NAS_UPLOAD_URL) throw new Error("NAS 업로드 주소 설정이 되어 있지 않습니다. (NAS_UPLOAD_URL)");
  if (!NAS_FILE_BASE) throw new Error("NAS 파일 경로 설정이 되어 있지 않습니다. (NAS_FILE_BASE)");

  const company_id = meta?.company_id || meta?.company_uuid || meta?.companyId || meta?.company;
  const job_id = meta?.job_id || meta?.job_uuid || meta?.jobId || meta?.job;
  const sample_id = meta?.sample_id || meta?.sample_uuid || meta?.sampleId || meta?.sample;
  const role = meta?.role || meta?.kind; // measurement|start|end

  // date_folder: usually "YYYY.MM.DD" (folder name), but accept "YYYY-MM-DD" and normalize
  const rawDate = meta?.date_folder || meta?.measurement_date || meta?.date || "";
  let date_folder = String(rawDate || "");
  if (date_folder.includes("T")) date_folder = date_folder.split("T", 1)[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date_folder)) date_folder = date_folder.replace(/-/g, ".");
  // keep as-is if already YYYY.MM.DD
  if (!company_id || !job_id || !sample_id || !role || !date_folder) {
    throw new Error("NAS 업로드 메타데이터가 부족합니다. (company_id, job_id, date_folder, sample_id, role)");
  }

  const fd = new FormData();
  fd.append("file", file, file?.name || "upload.jpg");
  fd.append("company_id", String(company_id));
  fd.append("job_id", String(job_id));
  fd.append("date_folder", String(date_folder));
  fd.append("sample_id", String(sample_id));
  fd.append("role", String(role));

  // optional
  if (meta?.mode) fd.append("mode", String(meta.mode));

  const auth = await getNasAuthorization();
  const resp = await fetch(NAS_UPLOAD_URL, { method: "POST", headers: auth ? { Authorization: auth } : undefined, body: fd });

  const ct = resp.headers.get("content-type") || "";
  let js = null;
  let raw = "";
  try {
    if (ct.includes("application/json")) {
      js = await resp.json();
    } else {
      raw = await resp.text();
      try { js = JSON.parse(raw); } catch {}
    }
  } catch (e) {
    // ignore parse error; handle below
  }

  if (!resp.ok) {
    // FastAPI validation errors: {detail:[{loc:[...], msg:"...", type:"..."}]}
    const detail = js?.detail;
    if (Array.isArray(detail)) {
      const parts = detail.map(d => {
        const loc = Array.isArray(d?.loc) ? d.loc.join(".") : "body";
        const msg = d?.msg || JSON.stringify(d);
        return `${loc}: ${msg}`;
      });
      throw new Error(`NAS 업로드 실패 (${resp.status}): ${parts.join(" | ")}`);
    }
    const msg = (typeof js === "object" && js) ? (js.detail || js.message || JSON.stringify(js)) : (raw || "");
    throw new Error(`NAS 업로드 실패 (${resp.status}): ${msg}`);
  }

  const relPath = js?.rel_path || js?.relPath || js?.path || js?.key || js?.rel || "";
  if (!relPath) throw new Error("NAS 업로드 응답에 rel_path(또는 path)가 없습니다.");

  // NAS_FILE_BASE=/public 이면 public get으로 조합
  const url = isHttpUrl(js?.url) ? String(js.url) : joinUrl(NAS_FILE_BASE, String(relPath).replace(/^\//, ""));
  return { rel_path: String(relPath).replace(/^\//, ""), url };
}


async function nasDeleteByPathOrUrl(storagePath) {
  if (!NAS_DELETE_URL) return;
  if (!storagePath) return;

  // send either url or path
  const fd = new FormData();
  const target = String(storagePath || "").startsWith("nas:") ? String(storagePath).slice(4) : storagePath;
  fd.append("target", target);

  try {
    const auth = await getNasAuthorization();
    await fetch(NAS_DELETE_URL, { method: "POST", headers: auth ? { Authorization: auth } : undefined, body: fd });
  } catch {
    // ignore
  }
}


/**
 * NAS 인증 필요 환경에서도 썸네일을 보이게 하기 위해,
 * Authorization 헤더를 붙여 바이너리를 받아 blob URL로 변환합니다.
 * (img 태그는 헤더를 붙일 수 없기 때문에 필요)
 */
async function nasFetchBlobUrl(relPath) {
  if (!NAS_GATEWAY_URL) throw new Error("NAS_GATEWAY_URL이 설정되지 않았습니다.");
  const rel = String(relPath || "").replace(/^\/+/, "");
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  const url = joinUrl(NAS_GATEWAY_URL, `object/authenticated/${enc}`);

  const auth = await getNasAuthorization();
  const resp = await fetchWithTimeoutRetry(url, { method: "GET", headers: auth ? { Authorization: auth } : undefined }, 15000, 1);
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`NAS 파일 조회 실패 (${resp.status}): ${msg || "요청이 거부되었습니다."}`);
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

/** =========================
 *  Thumbnails
 *  ========================= */

const THUMB_MAX_CONCURRENCY = 4;
const THUMB_RENDER_DEBOUNCE_MS = 120;

let _renderTimer = null;
function scheduleRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    render();
  }, THUMB_RENDER_DEBOUNCE_MS);
}

function cleanupThumbBlobs(samples) {
  try {
    for (const s of samples || []) {
      const blobs = s?._thumbBlobUrl;
      if (!blobs) continue;
      for (const k of Object.keys(blobs)) {
        const u = blobs[k];
        if (typeof u === "string" && u.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(u);
          } catch {}
        }
      }
      s._thumbBlobUrl = {};
    }
  } catch {}
}

function _setThumbUrl(sample, role, url, expMs) {
  sample._thumbUrl ||= {};
  sample._thumbExp ||= {};
  sample._thumbBlobUrl ||= {};

  const prevBlob = sample._thumbBlobUrl[role];
  if (prevBlob && prevBlob !== url && typeof prevBlob === "string" && prevBlob.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(prevBlob);
    } catch {}
  }

  sample._thumbUrl[role] = url;
  if (typeof expMs === "number") sample._thumbExp[role] = expMs;

  if (typeof url === "string" && url.startsWith("blob:")) {
    sample._thumbBlobUrl[role] = url;
  } else {
    delete sample._thumbBlobUrl[role];
  }
}

// 네트워크 없는(저렴한) 썸네일 프리셋: http / nas public만 세팅
function primeThumbUrl(sample, role) {
  const path = sample._photoPath?.[role];
  if (!path) return;

  if (isHttpUrl(path)) {
    _setThumbUrl(sample, role, path, Date.now() + 365 * 24 * 3600 * 1000);
    return;
  }

  if (typeof path === "string" && path.startsWith("nas:") && NAS_FILE_BASE) {
    const rel = path.slice(4).replace(/^\//, "");
    _setThumbUrl(sample, role, joinUrl(NAS_FILE_BASE, rel), Date.now() + 365 * 24 * 3600 * 1000);
  }
}

function updateThumbInDom(sampleId, role, url) {
  try {
    const sel = `.thumbMini[data-sid="${sampleId}"][data-role="${role}"]`;
    const wrap = document.querySelector(sel);
    if (!wrap) return false;

    // placeholder -> img
    const existing = wrap.querySelector("img");
    if (existing) {
      existing.src = url;
      return true;
    }

    wrap.innerHTML = "";
    const dateISO = wrap.getAttribute("data-date") || state.activeDate;
    wrap.appendChild(
      el("img", {
        src: url,
        alt: roleLabel(role),
        onclick: () => openViewerAt(dateISO, sampleId, role),
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeoutRetry(url, init, timeoutMs = 15000, retries = 1) {
  let lastErr;
  const tries = Math.max(1, (retries ?? 0) + 1);

  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...(init || {}), signal: ctrl.signal });
      clearTimeout(t);
      return resp;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      // 타임아웃/네트워크 흔들림 대응: 짧게 텀
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

let _thumbQueue = [];
let _thumbRunning = 0;

function _getSampleById(id) {
  if (state.sampleById && typeof state.sampleById.get === "function") {
    const v = state.sampleById.get(id);
    if (v) return v;
  }
  // fallback
  for (const arr of state.samplesByDate?.values?.() || []) {
    for (const s of arr || []) if (s?.id === id) return s;
  }
  return null;
}

function queueThumb(sampleId, role, opts) {
  const s = _getSampleById(sampleId);
  if (!s) return;

  s._thumbQueued ||= {};
  if (s._thumbLoading?.[role] || s._thumbQueued[role]) return;
  s._thumbQueued[role] = true;

  _thumbQueue.push({ sampleId, role, opts: opts || {} });
  pumpThumbQueue();
}

function pumpThumbQueue() {
  while (_thumbRunning < THUMB_MAX_CONCURRENCY && _thumbQueue.length) {
    const task = _thumbQueue.shift();
    _thumbRunning += 1;

    (async () => {
      try {
        const s = _getSampleById(task.sampleId);
        if (s) await ensureThumbUrl(s, task.role, task.opts);
      } catch (e) {
        console.warn("썸네일 로딩 실패:", e);
      } finally {
        const s = _getSampleById(task.sampleId);
        if (s && s._thumbQueued) s._thumbQueued[task.role] = false;
        _thumbRunning -= 1;
        pumpThumbQueue();
      }
    })();
  }
}

let _thumbObserver = null;
function observeThumb(elm, sampleId, role) {
  try {
    if (typeof IntersectionObserver === "undefined") {
      queueThumb(sampleId, role);
      return;
    }
    if (!_thumbObserver) {
      _thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const ent of entries) {
            if (!ent.isIntersecting) continue;
            const el = ent.target;
            _thumbObserver.unobserve(el);

            const sid = el.getAttribute("data-sid");
            const r = el.getAttribute("data-role");
            if (sid && r) queueThumb(sid, r);
          }
        },
        { root: null, threshold: 0.05 }
      );
    }
    _thumbObserver.observe(elm);
  } catch {
    queueThumb(sampleId, role);
  }
}

async function ensureThumbUrl(sample, role, opts) {
  const path = sample._photoPath?.[role];
  if (!path) return;

  sample._thumbUrl ||= {};
  sample._thumbExp ||= {};
  sample._thumbLoading ||= {};

  const now = Date.now();
  const exp = sample._thumbExp[role] || 0;
  if (sample._thumbUrl[role] && exp > now + 15_000 && !opts?.force) return;

  if (sample._thumbLoading[role]) return;
  sample._thumbLoading[role] = true;

  try {
    // full URL이면 그대로
    if (isHttpUrl(path)) {
      _setThumbUrl(sample, role, path, Date.now() + 365 * 24 * 3600 * 1000);
      updateThumbInDom(sample.id, role, path);
      return;
    }

    // nas: 접두 (기본은 public URL만, 실패 시 onerror에서 force blob)
    if (typeof path === "string" && path.startsWith("nas:")) {
      const rel = path.slice(4).replace(/^\//, "");

      if (NAS_FILE_BASE) {
        const pub = joinUrl(NAS_FILE_BASE, rel);
        _setThumbUrl(sample, role, pub, Date.now() + 365 * 24 * 3600 * 1000);
        updateThumbInDom(sample.id, role, pub);
      }

      if (!opts?.nasForceBlob) return;

      const auth = await getNasAuthorization();
      if (auth) {
        const blobUrl = await nasFetchBlobUrl(rel);
        _setThumbUrl(sample, role, blobUrl, Date.now() + 365 * 24 * 3600 * 1000);
        if (!updateThumbInDom(sample.id, role, blobUrl)) scheduleRender();
      }
      return;
    }

    // Supabase Storage signed URL
    const url = await getSignedUrl(path);
    _setThumbUrl(sample, role, url, Date.now() + SIGNED_URL_TTL_SEC * 1000);
    if (!updateThumbInDom(sample.id, role, url)) scheduleRender();
  } catch (e) {
    console.error("썸네일 생성 실패:", e);
  } finally {
    sample._thumbLoading[role] = false;
  }
}

/** =========================
 *  Upload
 *  ========================= */
async function uploadAndBindPhoto(sample, role, file) {
  sample._photoState ||= {};
  sample._photoPath ||= {};
  sample._photoState[role] = "uploading";
  render();

  try {
    const mode = state.mode;
    const companyId = state.company.id;
    const jobId = state.job.id;
    const dateFolder = ymdDots(sample.measurement_date);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const relPath = `${companyId}/${mode}/${jobId}/${dateFolder}/${sample.id}/${role}.${ext}`;

    let storedPath = relPath;

    if (nasEnabled()) {
      // NAS upload -> store URL in DB
      const out = await nasUpload({
        company_uuid: companyId,
        mode,
        job_uuid: jobId,
        measurement_date: normalizeISODate(sample.measurement_date),
        sample_uuid: sample.id,
        kind: role,
      }, file);
      storedPath = `nas:${out.rel_path}`;
    } else {
      // Supabase Storage upload
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(relPath, file, {
        upsert: true,
        contentType: file.type || "image/jpeg",
      });
      if (upErr) throw upErr;
      storedPath = relPath;
    }

    const row = await upsertSamplePhoto(sample.id, role, storedPath);

    sample._photoState[role] = "done";
    sample._photoPath[role] = row?.storage_path || storedPath;

    ensureThumbUrl(sample, role);
    setFoot("업로드가 완료되었습니다.");
    render();
  } catch (e) {
    console.error(e);
    sample._photoState[role] = "failed";
    setFoot(`업로드에 실패했습니다: ${e?.message || e}`);
    render();
  }
}

function pickPhoto(sample, role, useCameraCapture) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = false;
  if (useCameraCapture) input.setAttribute("capture", "environment");

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    openModal({
      sample,
      role,
      roleLabel: roleLabel(role),
      file,
      objectUrl,
      sourceLabel: useCameraCapture ? "촬영" : "앨범",
    });
  });

  input.click();
}

/** =========================
 *  Delete / renumber
 *  ========================= */
async function renumberSamplesForDate(jobId, dateISO) {
  const { data, error } = await supabase
    .from(T_SAMPLES)
    .select("id,created_at")
    .eq("job_id", jobId)
    .eq("measurement_date", dateISO)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;

  const rows = data || [];
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    const newIndex = i + 1;
    const { error: uErr } = await supabase.from(T_SAMPLES).update({ p_index: newIndex }).eq("id", id);
    if (uErr) throw uErr;
  }
}

async function deleteSample(sample) {
  const msg = `P${sample.p_index} 시료를 삭제하시겠습니까?\n첨부된 사진도 함께 삭제됩니다.`;
  if (!confirm(msg)) return;

  try {
    setFoot("삭제를 진행 중입니다...");

    // server RPC (preferred)
    try {
      const { error } = await supabase.rpc(RPC_DELETE_SAMPLE_AND_RENUMBER, { p_sample_id: sample.id });
      if (error) throw error;
    } catch (e) {
      console.warn("delete_sample_and_renumber RPC 실패 (fallback):", e);

      // fallback: delete photo rows, sample row, then renumber
      const photos = await fetchPhotosForSamples([sample.id]);
      for (const p of photos) {
        if (isHttpUrl(p.storage_path) || String(p.storage_path || "").startsWith("nas:")) await nasDeleteByPathOrUrl(p.storage_path);
        // Supabase Storage remove best-effort (only if relative path)
        if (p.storage_path && !isHttpUrl(p.storage_path) && !String(p.storage_path).startsWith("nas:")) {
          await supabase.storage.from(BUCKET).remove([p.storage_path]).catch(() => null);
        }
      }
      await supabase.from(T_PHOTOS).delete().eq("sample_id", sample.id);
      await supabase.from(T_SAMPLES).delete().eq("id", sample.id);
      await renumberSamplesForDate(state.job.id, sample.measurement_date);
    }

    setFoot("삭제가 완료되었습니다.");
    await loadJob(state.job);
  } catch (e) {
    console.error(e);
    setFoot(`삭제에 실패했습니다: ${e?.message || e}`);
    alert(e?.message || String(e));
  }
}

async function deleteJobAndRelated(job) {
  const msg = `현장을 삭제하시겠습니까?\n\n- 현장: ${job.project_name}\n- 해당 현장의 시료/사진 데이터가 모두 삭제됩니다.`;
  if (!confirm(msg)) return;

  try {
    setFoot("현장 삭제를 진행 중입니다...");

    // 1) load samples
    const samples = await fetchSamples(job.id);

  state.sampleById = new Map((samples || []).map((s) => [s.id, s]));

  state.sampleById = new Map((samples || []).map((s) => [s.id, s]));
    const sampleIds = (samples || []).map((s) => s.id);

    // 2) photos
    if (sampleIds.length) {
      const photos = await fetchPhotosForSamples(sampleIds);

      // NAS delete best-effort
      for (const p of photos) {
        if (!p.storage_path) continue;
        if (isHttpUrl(p.storage_path) || String(p.storage_path || "").startsWith("nas:")) await nasDeleteByPathOrUrl(p.storage_path);
      }

      // Supabase Storage remove best-effort
      const sbPaths = (photos || [])
        .map((p) => p.storage_path)
        .filter((p) => p && !isHttpUrl(p) && !String(p).startsWith("nas:"));
      if (sbPaths.length) {
        const { error: rmErr } = await supabase.storage.from(BUCKET).remove(sbPaths);
        if (rmErr) console.warn("스토리지 사진 삭제 실패:", rmErr);
      }

      // delete rows
      const { error: delP } = await supabase.from(T_PHOTOS).delete().in("sample_id", sampleIds);
      if (delP) throw delP;

      const { error: delS } = await supabase.from(T_SAMPLES).delete().eq("job_id", job.id);
      if (delS) throw delS;
    }

    // 3) delete job
    const { error: delJ } = await supabase.from(T_JOBS).delete().eq("id", job.id);
    if (delJ) throw delJ;

    if (state.job?.id === job.id) state.job = null;

    setFoot("현장 삭제가 완료되었습니다.");
    await loadJobs();
    render();
  } catch (e) {
    console.error(e);
    setFoot(`현장 삭제에 실패했습니다: ${e?.message || e}`);
    alert(e?.message || String(e));
  }
}

/** =========================
 *  Loaders
 *  ========================= */
async function loadSession() {
  const { data } = await supabase.auth.getSession();
  state.user = data?.session?.user || null;
  if (state.user) {
    setFoot("로그인되었습니다.");
  }
}

async function loadCompanies() {
  setFoot("회사 목록을 불러오는 중입니다...");
  state.companies = await fetchCompanies();
  setFoot("준비되었습니다.");
}

async function loadJobs() {
  if (!state.company || !state.mode) return;
  setFoot("현장 목록을 불러오는 중입니다...");
  state.jobs = await fetchJobs(state.company.id, state.mode);
  setFoot("준비되었습니다.");
}

async function loadJob(job) {
  // 기존 현장 썸네일 blob 정리(메모리 누수 방지)
  cleanupThumbBlobs(Array.from(state.sampleById?.values?.() || []));

  state.job = job;
  state.samplesByDate = new Map();
  state.dates = [];
  state.activeDate = null;
  state.addOpen = false;
  state.addLoc = "";
  state.addTime = "";

  setFoot("시료 목록을 불러오는 중입니다...");
  const samples = await fetchSamples(job.id);

  const dates = Array.from(new Set(samples.map((s) => s.measurement_date))).sort();
  state.dates = dates;
  state.activeDate = dates[0] || new Date().toISOString().slice(0, 10);

  for (const d of dates) state.samplesByDate.set(d, []);
  for (const s of samples) {
    s._photoState = {};
    s._photoPath = {};
    s._thumbUrl = {};
    // JS에서 TypeScript의 non-null assertion(!) 문법은 파싱 에러를 내므로 안전하게 처리
    const bucket = state.samplesByDate.get(s.measurement_date);
    if (bucket) bucket.push(s);
    else state.samplesByDate.set(s.measurement_date, [s]);
  }

  const photos = await fetchPhotosForSamples(samples.map((s) => s.id));
  const byId = new Map(samples.map((s) => [s.id, s]));
  for (const p of photos) {
    const s = byId.get(p.sample_id);
    if (!s) continue;

    // 농도는 UI에서 사진 1장만 쓰므로, 과거 데이터의 role=single 은 measurement 로 정규화한다.
    const rawRole = p.role;
    const role = (state.mode === "density" && rawRole === "single") ? "measurement" : rawRole;

    // 이미 measurement 가 있으면 single 은 무시(중복 슬롯 방지)
    if (state.mode === "density" && rawRole === "single" && s._photoPath["measurement"]) continue;

    s._photoState[role] = p.state === "failed" ? "failed" : "done";
    s._photoPath[role] = p.storage_path;
    primeThumbUrl(s, role);
  }

  // 날짜가 없으면 오늘을 탭으로 만들어서 추가 UX
  if (!state.dates.includes(state.activeDate)) {
    state.dates.unshift(state.activeDate);
    state.samplesByDate.set(state.activeDate, []);
  }

  setFoot("불러오기가 완료되었습니다.");
  render();
}

/** =========================
 *  Render
 *  ========================= */
function render() {
  closeSettings();
  updateHeader();
  if (!root) return;
  root.innerHTML = "";

  if (!state.user) {
    renderAuth();
    return;
  }
  if (!state.company) {
    renderCompanySelect();
    return;
  }
  if (!state.mode) {
    renderModeSelect();
    return;
  }
  if (!state.job) {
    renderJobSelect();
    return;
  }
  renderJobWork();

  // viewer overlay
  if (state.viewer.open) renderViewer();
}

/** ===== Auth ===== */
function renderAuth() {
  const email = el("input", { class: "input", type: "email", placeholder: "이메일" });
  const name = el("input", { class: "input", type: "text", placeholder: "이름 (회원가입)" });
  const pw = el("input", { class: "input", type: "password", placeholder: "비밀번호" });
  const pw2 = el("input", { class: "input", type: "password", placeholder: "비밀번호 확인" });
  const msg = el("div", { style: "margin-top:10px; color:#666; font-size:13px;" });
  msg.textContent = state.authMsg || "";

  const tabs = el("div", { class: "authTabs" }, [
    el("button", {
      class: "tab" + (state.authTab === "login" ? " active" : ""),
      text: "로그인",
      onclick: () => {
        state.authTab = "login";
        state.authMsg = "";
        render();
      },
    }),
    el("button", {
      class: "tab" + (state.authTab === "signup" ? " active" : ""),
      text: "회원가입",
      onclick: () => {
        state.authTab = "signup";
        state.authMsg = "";
        render();
      },
    }),
  ]);

  const btn = el("button", {
    class: "btn primary",
    text: state.authTab === "login" ? "로그인" : "회원가입",
    onclick: async () => {
      try {
        state.authMsg = "";
        setFoot("처리 중입니다...");

        const e = normEmail(email.value);
        const p = pw.value || "";
        if (!e || !p) throw new Error("이메일과 비밀번호를 입력해 주세요.");

        if (state.authTab === "signup") {
          const n = safeText(name.value);
          if (!n) throw new Error("이름을 입력해 주세요.");
          if (p.length < 6) throw new Error("비밀번호는 6자 이상 권장");
          if ((pw2.value || "") !== p) throw new Error("비밀번호 확인이 일치하지 않습니다.");

          const exists = await emailExists(e);
          if (exists === true) throw new Error("이미 가입된 이메일입니다.");

          const { data, error } = await supabase.auth.signUp({
            email: e,
            password: p,
            options: {
              data: { name: n },
            },
          });
          if (error) throw error;

          if (data?.session) {
            await loadSession();
            await loadCompanies();
            render();
            return;
          }

          state.authMsg = "회원가입이 완료되었습니다. 이메일 인증을 사용 중이라면 메일 확인 후 로그인해 주세요.";
          setFoot("회원가입이 완료되었습니다.");
          render();
          return;
        }

        // login
        const { error } = await supabase.auth.signInWithPassword({ email: e, password: p });
        if (error) throw error;
        await loadSession();
        await loadCompanies();
        render();
      } catch (err) {
        console.error(err);
        const m = err?.message || String(err);
        state.authMsg = m;
        setFoot(m);
        render();
      }
    },
  });

  const card = el("div", { class: "card" }, [
    tabs,
    el("div", { class: "col", style: "gap:10px; margin-top:10px;" },
      state.authTab === "login" ? [email, pw] : [email, name, pw, pw2]
    ),
    el("div", { style: "margin-top:12px;" }, [btn]),
    msg,
    el(
      "div",
      { style: "margin-top:10px; font-size:12px; color:#888;" },
      [
        el("div", { text: nasEnabled() ? "사진 업로드: NAS 서버" : "사진 업로드: 클라우드 저장소" }),
      ]
    ),
  ]);

  root.appendChild(card);
}


/** ===== Swipe (left to delete) ===== */
function createSwipeRow({ content, onDelete, onOpen, deleteText = "삭제", ignoreInteractive = true }) {
  const wrap = el("div", { class: "swipeRow" });
  const actions = el("div", { class: "swipeActions" }, [
    el("button", {
      class: "swipeDeleteBtn",
      text: deleteText,
      onclick: (ev) => {
        ev.stopPropagation();
        if (typeof onDelete === "function") onDelete();
      },
      type: "button",
    }),
  ]);

  const contentWrap = el("div", { class: "swipeContent" }, [content]);

  wrap.appendChild(actions);
  wrap.appendChild(contentWrap);

  const OPEN_X = -92;
  const THRESH_OPEN = OPEN_X / 2; // -46
  let isOpen = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let lastX = 0;
  let justDragged = false;

  function applyX(x) {
    lastX = x;
    contentWrap.style.transform = `translateX(${x}px)`;
    contentWrap.dataset.x = String(x);
  }
  function setOpen(v) {
    isOpen = !!v;
    wrap.classList.toggle("open", isOpen);
    contentWrap.style.transition = "transform .15s ease";
    applyX(isOpen ? OPEN_X : 0);
    setTimeout(() => { contentWrap.style.transition = ""; }, 180);
  }

  // click behavior: open action -> close, else onOpen
  contentWrap.addEventListener("click", (ev) => {
    if (justDragged) return;
    if (isOpen) {
      ev.stopPropagation();
      setOpen(false);
      return;
    }
    if (typeof onOpen === "function") onOpen(ev);
  });

  contentWrap.addEventListener("pointerdown", (ev) => {
    if (ignoreInteractive) {
      const t = ev.target;
      if (t && t.closest && t.closest("button,input,select,textarea,a,label")) return;
    }
    startX = ev.clientX;
    startY = ev.clientY;
    baseX = isOpen ? OPEN_X : 0;
    dragging = false;
    justDragged = false;
    contentWrap.setPointerCapture(ev.pointerId);
  });

  contentWrap.addEventListener("pointermove", (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    if (!dragging) {
      if (Math.abs(dx) < 7) return;
      if (Math.abs(dx) <= Math.abs(dy) + 2) return; // keep scroll
      dragging = true;
      wrap.classList.add("dragging");
      contentWrap.style.transition = "none";
    }

    // dragging
    let x = baseX + dx;
    if (x > 0) x = 0;
    if (x < OPEN_X) x = OPEN_X;
    applyX(x);
    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove("dragging");
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);

    contentWrap.style.transition = "";
    setOpen(lastX < THRESH_OPEN);
  }

  contentWrap.addEventListener("pointerup", endDrag);
  contentWrap.addEventListener("pointercancel", endDrag);

  return wrap;
}


/** ===== Company ===== */
function renderCompanySelect() {
  const list = el("div", { class: "list" });

  if (!state.companies.length) {
    list.appendChild(el("div", { class: "card", text: "회사 목록이 비어 있습니다." }));
  } else {
    for (const c of state.companies) {
      const item = el("div", {
        class: "item clickable",
        onclick: async () => {
          state.company = c;
          state.mode = null;
          state.job = null;
          await loadJobs().catch(() => null);
          render();
        },
      }, [
        el("div", {}, [
          el("div", { class: "item-title", text: c.name }),
        ]),
        el("div", { class: "chev", text: "›" }),
      ]);

      list.appendChild(item);
    }
  }

  root.appendChild(el("div", { class: "card" }, [
    el("div", { class: "label sectionLabel", text: "회사 목록" }),
    list,
  ]));
}

/** ===== Mode ===== */
function renderModeSelect() {
  const wrap = el("div", { class: "card" }, [
    el("div", { class: "label", text: "업무 선택" }),
    el("div", { class: "choiceGrid" }, [
      el("button", {
        class: "choiceCard",
        type: "button",
        onclick: async () => {
          state.mode = "density";
          state.job = null;
          await loadJobs();
          render();
        },
      }, [
        el("div", { class: "choiceTitle", text: "농도" }),
      ]),
      el("button", {
        class: "choiceCard",
        type: "button",
        onclick: async () => {
          state.mode = "scatter";
          state.job = null;
          await loadJobs();
          render();
        },
      }, [
        el("div", { class: "choiceTitle", text: "비산" }),
      ]),
    ]),
  ]);

  root.appendChild(wrap);
}

/** ===== Jobs ===== */
function renderJobSelect() {
  const list = el("div", { class: "list" });

  // add job card
  const pj = el("input", { class: "input", placeholder: "현장명(프로젝트명)" });
  const addr = el("input", { class: "input", placeholder: "주소" });
  const cont = el("input", { class: "input", placeholder: "시공사" });

  const addBtn = el("button", {
    class: "btn primary",
    text: "현장 추가",
    onclick: async () => {
      try {
        const project_name = safeText(pj.value);
        if (!project_name) throw new Error("현장명을 입력해 주세요.");

        // 중복 현장명 방지(같은 회사 + 같은 업무 내에서만)
        const _normPj = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
        const _pjKey = _normPj(project_name);
        const _dup = (state.jobs || []).some((j) => {
          if (j?.mode && j.mode !== state.mode) return false;
          if (j?.company_id && String(j.company_id) !== String(state.company.id)) return false;
          return _normPj(j?.project_name) === _pjKey;
        });
        if (_dup) throw new Error('같은 현장명은 중복될 수 없습니다.');

        setFoot("현장을 생성 중입니다...");
        const job = await createJob({
          company_id: state.company.id,
          mode: state.mode,
          project_name,
          address: safeText(addr.value),
          contractor: safeText(cont.value),
        });
        setFoot("현장이 생성되었습니다.");
        await loadJobs();
        state.job = null;
        render();

        // 바로 진입
        await loadJob(job);
      } catch (e) {
        console.error(e);
        setFoot(e?.message || String(e));
        alert(e?.message || String(e));
      }
    },
  });

  const addCard = el("div", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", { class: "col" }, [
        el("div", { class: "label", text: `현장 목록 · ${state.company?.name || ""} / ${modeLabel(state.mode)}` }),
        el("div", { class: "label", text: "새 현장 추가" }),
      ]),
    ]),
    el("div", { class: "col", style: "gap:10px; margin-top:10px;" }, [pj, addr, cont]),
    el("div", { style: "margin-top:12px;" }, [addBtn]),
  ]);

  // jobs list
  if (!state.jobs.length) {
    list.appendChild(el("div", { class: "card", text: "현장이 없습니다. 위에서 추가해 주세요." }));
  } else {
    for (const j of state.jobs) {
      const sub = [safeText(j.address), safeText(j.contractor)].filter(Boolean).join(" · ");

      const content = el("div", { class: "item clickable" }, [
        el("div", {}, [
          el("div", { class: "item-title", text: safeText(j.project_name, "(이름없음)") }),
          el("div", { class: "item-sub", text: sub || `생성: ${String(j.created_at || "").slice(0, 10)}` }),
        ]),
        el("div", { class: "chev", text: "›" }),
      ]);

      list.appendChild(
        createSwipeRow({
          content,
          onOpen: () => loadJob(j),
          onDelete: () => deleteJobAndRelated(j),
          ignoreInteractive: false,
        })
      );
    }
  }

  root.appendChild(addCard);
  root.appendChild(list);
}

/** ===== Job work ===== */
function renderJobWork() {
  const job = state.job;

  // date tabs
  const tabs = el("div", { class: "tabs", style: "margin:10px 0;" });
  for (const d of state.dates) {
    tabs.appendChild(
      el("button", {
        class: "tab" + (state.activeDate === d ? " active" : ""),
        text: ymdDots(d),
        onclick: () => {
          state.activeDate = d;
          state.addOpen = false;
          render();
        },
      })
    );
  }

  const dateAdd = el("input", { class: "input", type: "date", value: iso10(state.activeDate) });
  const dateAddBtn = el("button", {
    class: "btn",
    text: "날짜 추가/이동",
    onclick: () => {
      const v = iso10(dateAdd.value);
      if (!state.dates.includes(v)) {
        state.dates.push(v);
        state.dates.sort();
        state.samplesByDate.set(v, []);
      }
      state.activeDate = v;
      render();
    },
  });

  // add sample
  const SCATTER_LOCATIONS = [
    "부지경계선",
    "작업장주변 실내",
    "작업장주변 실외",
    "위생설비",
    "음압기배출구",
    "폐기물반출구",
    "폐기물 보관지점",
  ];

  let locInput;
  if (state.mode === "scatter") {
    const sel = el("select", {
      class: "input",
      onchange: (ev) => {
        state.addLoc = ev.target.value;
      },
    });
    for (const name of SCATTER_LOCATIONS) {
      sel.appendChild(el("option", { value: name, text: name }));
    }
    sel.value = state.addLoc && SCATTER_LOCATIONS.includes(state.addLoc) ? state.addLoc : SCATTER_LOCATIONS[0];
    locInput = sel;
  } else {
    const inp = el("input", {
      class: "input",
      placeholder: "시료 위치(예: 거실, 주방...)",
      oninput: (ev) => {
        state.addLoc = ev.target.value;
      },
    });
    inp.value = state.addLoc || "";
    locInput = inp;
  }
  const timeInput = el("input", { class: "timeInput", placeholder: "시각(선택)", value: state.addTime || "" });

  const addSampleBtn = el("button", {
    class: "btn primary",
    text: "시료 추가",
    onclick: async () => {
      try {
        const loc = safeText(locInput.value);
        const dateISO = state.activeDate || new Date().toISOString().slice(0, 10);

        setFoot("시료를 생성 중입니다...");
        const newRow = await createSample(job.id, dateISO, loc);

        // reload to get correct p_index & date lists
        await loadJob(job);

        // time optional
        const t = safeText(timeInput.value);
        if (t) {
          await updateSampleFields(newRow.id || newRow?.[0]?.id, { start_time: t });
          await loadJob(job);
        }

        setFoot("시료가 추가되었습니다.");
      } catch (e) {
        console.error(e);
        setFoot(e?.message || String(e));
        alert(e?.message || String(e));
      }
    },
  });

  const head = el("div", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", { class: "col" }, [
        el("div", { class: "item-title", text: safeText(job.project_name, "(현장)") }),
        el("div", { class: "item-sub", text: [modeLabel(state.mode), safeText(job.address)].filter(Boolean).join(" · ") }),
      ]),
      el("div", { class: "row", style: "gap:8px;" }, [
        dateAdd,
        dateAddBtn,
      ]),
    ]),
    tabs,
    el("div", { class: "row", style: "margin-top:10px;" }, [
      el("div", { class: "col", style: "flex:1; min-width:240px;" }, [
        el("div", { class: "label", text: `시료 추가 · ${ymdDots(state.activeDate)}` }),
        locInput,
      ]),
      el("div", { class: "col" }, [
        el("div", { class: "label", text: "시각(선택)" }),
        timeInput,
      ]),
      el("div", { class: "col", style: "justify-content:flex-end;" }, [addSampleBtn]),
    ]),
  ]);

  root.appendChild(head);

  // samples list
  const dateISO = state.activeDate;
  const samples = state.samplesByDate.get(dateISO) || [];

  if (!samples.length) {
    root.appendChild(el("div", { class: "card", text: "이 날짜에 시료가 없습니다. 위에서 추가해 주세요." }));
    return;
  }

  for (const s of samples) {
  
    const left = el("div", { class: "sampleLeft" }, [
      el("div", { class: "sampleTitle", text: `P${s.p_index || "?"} · ${safeText(s.sample_location, "미입력")}` }),
      el("div", { class: "sampleMeta" }, [
        el("div", { class: "metaLine" }, [
          el("span", { class: "label", text: ymdDots(s.measurement_date) }),
        ]),
        el("div", { class: "metaLine" }, [
          el("span", { class: "label", text: "시각" }),
          el("input", {
            class: "timeInput",
            value: safeText(s.start_time),
            placeholder: "예: 10:30",
            onblur: async (ev) => {
              const v = safeText(ev.target.value);
              if (v === safeText(s.start_time)) return;
              try {
                await updateSampleFields(s.id, { start_time: v });
                s.start_time = v;
                setFoot("시각이 저장되었습니다.");
              } catch (e) {
                console.error(e);
                setFoot(`저장 실패: ${e?.message || e}`);
              }
            },
          }),        ]),
      ]),
    ]);

    const right = el("div", { class: `sampleRight ${state.mode}` });

    for (const role of viewerRoleOrder(s)) {
      const status = s._photoState?.[role] || "";
      const dot = el("div", { class: dotClass(status) });

      const thumb = el("div", {
        class: "thumbMini",
        title: roleLabel(role),
        "data-sid": s.id,
        "data-role": role,
        "data-date": dateISO,
      });

      const url = s._thumbUrl?.[role];
      if (url) {
        const img = el("img", {
          src: url,
          alt: roleLabel(role),
          onclick: () => openViewerAt(dateISO, s.id, role),
          onerror: () => {
            // NAS public이 막혀있을 때만 blob fallback
            const p = s._photoPath?.[role];
            if (typeof p === "string" && p.startsWith("nas:")) {
              queueThumb(s.id, role, { nasForceBlob: true, force: true });
            }
          },
        });
        thumb.appendChild(img);
      } else {
        thumb.appendChild(el("div", { text: roleLabel(role) }));
        // 화면에 들어온 썸네일부터만 로딩(요청 폭탄 방지)
        if (s._photoPath?.[role]) observeThumb(thumb, s.id, role);
      }

      const btns = el("div", { class: "slotBtns" }, [
        el("button", { class: "btn small", text: "촬영", onclick: () => pickPhoto(s, role, true) }),
        el("button", { class: "btn small", text: "앨범", onclick: () => pickPhoto(s, role, false) }),
      ]);

      right.appendChild(
        el("div", { class: "slotMini" }, [
          el("div", { class: "slotHead" }, [dot, el("span", { text: roleLabel(role) })]),
          thumb,
          btns,
        ])
      );
    }

    const content = el("div", { class: "sampleRow" }, [left, right]);
    root.appendChild(createSwipeRow({ content, onDelete: () => deleteSample(s), ignoreInteractive: true }));
  }
}

/** =========================
 *  Bootstrap
 *  ========================= */
(async function boot() {
  try {
    setFoot("초기화 중...");
    await loadSession();
    if (state.user) {
      await loadCompanies();
    }
    render();

    // auth state change
    supabase.auth.onAuthStateChange(async (_event, session) => {
      state.user = session?.user || null;
      if (state.user) {
        await loadCompanies().catch(() => null);
      } else {
        state.company = null;
        state.mode = null;
        state.job = null;
        state.jobs = [];
        state.companies = [];
      }
      render();
    });

    // initial companies if logged in
    if (state.user && !state.companies.length) {
      await loadCompanies();
      render();
    }

    // initial jobs if already have selection in memory (future)
  } catch (e) {
    console.error(e);
    setFoot(`초기화 실패: ${e?.message || e}`);
    render();
  }
})();
