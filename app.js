import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** 고정 값 */
const SUPABASE_URL = "https://jvzcynpajbjdbtzbysxm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_h7DfY9lO57IP_N3-Yz_hmg_mep3kopP";

const BUCKET = "job_photos";
const SIGNED_URL_TTL_SEC = 60 * 30; // 30분

function ymdDots(dateStrOrDate) {
  const d = (dateStrOrDate instanceof Date) ? dateStrOrDate : new Date(dateStrOrDate);
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function setFoot(msg) {
  document.getElementById("footStatus").textContent = msg;
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

async function emailExists(email) {
  try {
    const e = normEmail(email);
    const { data, error } = await supabase.rpc("email_exists", { p_email: e });
    if (error) {
      // RPC가 없거나 권한이 막혀있으면 앱에서는 막지 않습니다.
      console.warn("email_exists RPC를 사용할 수 없습니다:", error);
      return null;
    }
    return !!data;
  } catch (e) {
    console.warn("email_exists 확인에 실패했습니다:", e);
    return null;
  }
}


function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.appendChild(c);
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
  return role;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  user: null,
  company: null, // {id,name}
  mode: null,    // density|scatter
  job: null,
  jobs: [],

  dates: [],
  activeDate: null,
  samplesByDate: new Map(),

  authTab: "login", // login|signup
  authMsg: "",
  addOpen: false,
  addLoc: "",
  addTime: "",

  pending: null, // 업로드 확인 모달 payload

  viewer: {
    open: false,
    items: [],
    index: 0,
    zoom: 1,
  },
};

// root + header
const root = document.getElementById("root");
const btnBack = document.getElementById("btnBack");
const btnGear = document.getElementById("btnGear");
const settingsMenu = document.getElementById("settingsMenu");
const menuChangeMode = document.getElementById("menuChangeMode");
const menuChangeCompany = document.getElementById("menuChangeCompany");
const menuSignOut = document.getElementById("menuSignOut");

function closeSettings() {
  settingsMenu.hidden = true;
}
function toggleSettings() {
  settingsMenu.hidden = !settingsMenu.hidden;
}

document.addEventListener("click", (ev) => {
  if (settingsMenu.hidden) return;
  const t = ev.target;
  if (t === btnGear || btnGear.contains(t)) return;
  if (settingsMenu.contains(t)) return;
  closeSettings();
});

function updateHeader() {
  const authed = !!state.user;
  btnGear.style.display = authed ? "" : "none";
  // 회사 선택 이후부터 뒤로가기 노출
  btnBack.style.display = (authed && !!state.company) ? "" : "none";

  menuChangeMode.disabled = !state.mode;
  menuChangeCompany.disabled = !state.company;
}

function goBack() {
  closeSettings();

  // 열려있는 모달 우선 닫기
  if (state.viewer?.open) {
    closeViewer();
    return;
  }
  if (!modal.hidden) {
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
  render();
});

// modal
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalPreview = document.getElementById("modalPreview");
const modalMeta = document.getElementById("modalMeta");
const modalClose = document.getElementById("modalClose");
const modalReject = document.getElementById("modalReject");
const modalAccept = document.getElementById("modalAccept");

// viewer modal
const viewerModal = document.getElementById("viewerModal");
const viewerTitle = document.getElementById("viewerTitle");
const viewerImg = document.getElementById("viewerImg");
const viewerLabel = document.getElementById("viewerLabel");
const viewerClose = document.getElementById("viewerClose");
const viewerPrev = document.getElementById("viewerPrev");
const viewerNext = document.getElementById("viewerNext");
const viewerZoom = document.getElementById("viewerZoom");

function openModal(pending) {
  state.pending = pending;
  modalTitle.textContent = `사진 확인 · ${pending.roleLabel}`;
  modalPreview.src = pending.objectUrl;
  modalMeta.textContent = `${pending.sourceLabel} · ${pending.file.name} · ${(pending.file.size / 1024 / 1024).toFixed(2)}MB`;
  modal.hidden = false;
}

function closeModal() {
  if (state.pending?.objectUrl) URL.revokeObjectURL(state.pending.objectUrl);
  state.pending = null;
  modal.hidden = true;
}


function viewerRoleOrder() {
  return (state.mode === "density") ? ["measurement"] : ["start", "end"];
}

function buildViewerItemsForDate(dateISO) {
  const samples = state.samplesByDate.get(dateISO) || [];
  const roles = viewerRoleOrder();
  const items = [];

  const sorted = [...samples].sort((a, b) => (a.p_index || 0) - (b.p_index || 0));
  for (const s of sorted) {
    const loc = (s.sample_location || "").trim() || "(미입력)";
    const label = `P${s.p_index} · ${loc}`;
    for (const role of roles) {
      const path = s._photoPath?.[role];
      if (!path) continue;
      items.push({
        sample_id: s.id,
        p_index: s.p_index,
        label,
        role,
        path,
        url: null,
        exp: 0,
      });
    }
  }
  return items;
}

async function ensureViewerUrl(item) {
  const now = Date.now();
  if (item.url && item.exp > now + 15_000) return item.url;
  const url = await getSignedUrl(item.path);
  item.url = url;
  item.exp = Date.now() + (SIGNED_URL_TTL_SEC * 1000);
  return url;
}

async function openViewer(dateISO, sampleId, role) {
  try {
    const items = buildViewerItemsForDate(dateISO);
    if (!items.length) return;

    let idx = items.findIndex(x => x.sample_id === sampleId && x.role === role);
    if (idx < 0) idx = 0;

    state.viewer.open = true;
    state.viewer.items = items;
    state.viewer.index = idx;
    state.viewer.zoom = 1;

    viewerModal.hidden = false;
    await renderViewer();
  } catch (e) {
    console.error(e);
    alert(e.message || String(e));
  }
}

function closeViewer() {
  state.viewer.open = false;
  state.viewer.items = [];
  state.viewer.index = 0;
  state.viewer.zoom = 1;
  viewerModal.hidden = true;
}

async function renderViewer() {
  if (!state.viewer.open) return;
  const items = state.viewer.items;
  const i = Math.max(0, Math.min(items.length - 1, state.viewer.index));
  state.viewer.index = i;

  const item = items[i];
  const url = await ensureViewerUrl(item);

  viewerTitle.textContent = roleLabel(item.role);
  viewerLabel.textContent = item.label;
  viewerImg.src = url;

  viewerPrev.disabled = (i <= 0);
  viewerNext.disabled = (i >= items.length - 1);

  viewerImg.classList.toggle("zoom2", state.viewer.zoom >= 2);
}

viewerClose?.addEventListener("click", closeViewer);
viewerPrev?.addEventListener("click", async () => {
  if (!state.viewer.open) return;
  if (state.viewer.index <= 0) return;
  state.viewer.index -= 1;
  state.viewer.zoom = 1;
  await renderViewer();
});
viewerNext?.addEventListener("click", async () => {
  if (!state.viewer.open) return;
  if (state.viewer.index >= state.viewer.items.length - 1) return;
  state.viewer.index += 1;
  state.viewer.zoom = 1;
  await renderViewer();
});
viewerZoom?.addEventListener("click", async () => {
  if (!state.viewer.open) return;
  state.viewer.zoom = (state.viewer.zoom >= 2) ? 1 : 2;
  await renderViewer();
});

// iOS에서 이미지 탭으로 줌 토글
viewerImg?.addEventListener("click", async () => {
  if (!state.viewer.open) return;
  state.viewer.zoom = (state.viewer.zoom >= 2) ? 1 : 2;
  await renderViewer();
});

// 키보드(PC) 좌우
document.addEventListener("keydown", async (ev) => {
  if (!state.viewer.open) return;
  if (ev.key === "Escape") { closeViewer(); return; }
  if (ev.key === "ArrowLeft") { if (state.viewer.index > 0) { state.viewer.index -= 1; state.viewer.zoom = 1; await renderViewer(); } }
  if (ev.key === "ArrowRight") { if (state.viewer.index < state.viewer.items.length - 1) { state.viewer.index += 1; state.viewer.zoom = 1; await renderViewer(); } }
});

modalClose.addEventListener("click", closeModal);
modalReject.addEventListener("click", closeModal);
modalAccept.addEventListener("click", async () => {
  const p = state.pending;
  if (!p) return;
  closeModal();
  await uploadAndBindPhoto(p.sample, p.role, p.file);
});

async function loadSession() {
  const { data } = await supabase.auth.getSession();
  state.user = data.session?.user || null;
  updateHeader();
}

async function signIn(email, password) {
  const e = normEmail(email);
  const { error } = await supabase.auth.signInWithPassword({ email: e, password });
  if (error) throw error;
  await loadSession();
}

async function signUp(email, password) {
  const e = normEmail(email);

  const exists = await emailExists(e);
  if (exists === true) {
    throw new Error("이미 가입된 이메일입니다. 다른 이메일을 사용해 주세요.");
  }
  // 보안/설정에 따라 이미 가입된 이메일이어도 성공처럼 응답할 수 있습니다.
  // 따라서 앱에서는 '가입 완료'가 아니라 '확인 메일 전송' 안내로 처리합니다.
  const { data, error } = await supabase.auth.signUp({
    email: e,
    password,
    options: {
      emailRedirectTo: location.origin,
    },
  });
  if (error) throw error;

  // 이메일 확인이 꺼져 있으면 session이 바로 내려옵니다.
  if (data?.session) {
    await loadSession();
  }
}

async function fetchCompanies() {
  const { data, error } = await supabase.from("companies").select("id,name").order("name");
  if (error) throw error;
  return data || [];
}

async function fetchJobs(companyId, mode) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, company_id, mode, project_name, status, created_at, last_upload_at")
    .eq("company_id", companyId)
    .eq("mode", mode)
    .order("last_upload_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return data || [];
}

async function fetchSamples(jobId) {
  const { data, error } = await supabase
    .from("job_samples")
    .select("id, job_id, measurement_date, sample_location, p_index, start_time, created_at")
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
    .from("sample_photos")
    .select("sample_id, role, storage_path, state, uploaded_at")
    .in("sample_id", sampleIds);
  if (error) throw error;
  return data || [];
}

async function createJob({ company_id, mode, project_name, address, contractor }) {
  const userId = state.user?.id || null;
  const { data, error } = await supabase
    .from("jobs")
    .insert([{ company_id, mode, project_name, address, contractor, status: "new", created_by: userId }])
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function createSampleRPC(jobId, dateISO, location) {
  const { data, error } = await supabase.rpc("create_sample", {
    p_job_id: jobId,
    p_date: dateISO,
    p_location: location ?? "",
  });
  if (error) throw error;
  return data;
}

async function updateSampleFields(sampleId, patch) {
  const { error } = await supabase.from("job_samples").update(patch).eq("id", sampleId);
  if (error) throw error;
}

async function getSignedUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error) throw error;
  return data.signedUrl;
}

function ensureThumbUrl(sample, role) {
  const path = sample._photoPath?.[role];
  if (!path) return;

  sample._thumbUrl = sample._thumbUrl || {};
  sample._thumbExp = sample._thumbExp || {};
  sample._thumbLoading = sample._thumbLoading || {};

  const now = Date.now();
  const exp = sample._thumbExp[role] || 0;
  if (sample._thumbUrl[role] && exp > now + 15_000) return;

  if (sample._thumbLoading[role]) return;
  sample._thumbLoading[role] = true;

  (async () => {
    try {
      const url = await getSignedUrl(path);
      sample._thumbUrl[role] = url;
      sample._thumbExp[role] = Date.now() + (SIGNED_URL_TTL_SEC * 1000);
    } catch (e) {
      console.error("Signed URL 생성에 실패했습니다:", e);
    } finally {
      sample._thumbLoading[role] = false;
      render();
    }
  })();
}

async function uploadAndBindPhoto(sample, role, file) {
  sample._photoState = sample._photoState || {};
  sample._photoPath = sample._photoPath || {};
  sample._photoState[role] = "uploading";
  render();

  try {
    const mode = state.mode;
    const companyId = state.company.id;
    const jobId = state.job.id;
    const dateFolder = ymdDots(sample.measurement_date);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${companyId}/${mode}/${jobId}/${dateFolder}/${sample.id}/${role}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
    if (upErr) throw upErr;

    const { data: row, error: rpcErr } = await supabase.rpc("upsert_sample_photo", {
      p_sample_id: sample.id,
      p_role: role,
      p_storage_path: path,
    });
    if (rpcErr) throw rpcErr;

    sample._photoState[role] = "done";
    sample._photoPath[role] = row.storage_path;

    ensureThumbUrl(sample, role);

    setFoot("업로드가 완료되었습니다.");
    render();
  } catch (e) {
    console.error(e);
    sample._photoState[role] = "failed";
    setFoot(`업로드에 실패했습니다: ${e.message || e}`);
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

/** 날짜별 P 재정렬: 생성순(created_at) 기준 */
async function renumberSamplesForDate(jobId, dateISO) {
  const { data, error } = await supabase
    .from("job_samples")
    .select("id, created_at")
    .eq("job_id", jobId)
    .eq("measurement_date", dateISO)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;

  const rows = data || [];
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id;
    const newIndex = i + 1;
    const { error: uErr } = await supabase.from("job_samples").update({ p_index: newIndex }).eq("id", id);
    if (uErr) throw uErr;
  }
}

/** 시료 삭제 + 재정렬 */
async function deleteSample(sample) {
  const msg = `P${sample.p_index} 시료를 삭제하시겠습니까?
첨부된 사진도 함께 삭제됩니다.`;
  if (!confirm(msg)) return;

  try {
    setFoot("삭제를 진행 중입니다...");

    // 서버 RPC로 삭제 + 재정렬(권장)
    const { error } = await supabase.rpc("delete_sample_and_renumber", {
      p_sample_id: sample.id,
    });
    if (error) throw error;

    setFoot("삭제가 완료되었습니다.");
    await loadJob(state.job);
  } catch (e) {
    console.error(e);
    setFoot(`삭제에 실패했습니다: ${e.message || e}`);
    alert(e.message || String(e));
  }
}

async function loadJob(job) {
  state.job = job;
  state.samplesByDate = new Map();
  state.dates = [];
  state.activeDate = null;
  state.addOpen = false;
  state.addLoc = "";
  state.addTime = "";

  setFoot("시료 목록을 불러오는 중입니다...");
  const samples = await fetchSamples(job.id);

  const dates = Array.from(new Set(samples.map(s => s.measurement_date))).sort();
  state.dates = dates;
  state.activeDate = dates[0] || new Date().toISOString().slice(0, 10);

  for (const d of dates) state.samplesByDate.set(d, []);
  for (const s of samples) {
    s._photoState = {};
    s._photoPath = {};
    s._thumbUrl = {};
    state.samplesByDate.get(s.measurement_date)?.push(s);
  }

  const photos = await fetchPhotosForSamples(samples.map(s => s.id));
  const byId = new Map(samples.map(s => [s.id, s]));
  for (const p of photos) {
    const s = byId.get(p.sample_id);
    if (!s) continue;
    s._photoState[p.role] = (p.state === "failed") ? "failed" : "done";
    s._photoPath[p.role] = p.storage_path;
  }

  setFoot("불러오기가 완료되었습니다.");
  render();
}

/* =========================
   Render
========================= */
function render() {
  closeSettings();
  updateHeader();
  root.innerHTML = "";

  if (!state.user) { renderAuth(); return; }
  if (!state.company) { renderCompanySelect(); return; }
  if (!state.mode) { renderModeSelect(); return; }
  if (!state.job) { renderJobSelect(); return; }
  renderJobWork();
}

/* ===== Auth ===== */
function renderAuth() {
  const email = el("input", { class: "input", type: "email", placeholder: "이메일" });
  const pw = el("input", { class: "input", type: "password", placeholder: "비밀번호" });
  const pw2 = el("input", { class: "input", type: "password", placeholder: "비밀번호 확인" });
  const msg = el("div", { style: "margin-top:10px; color:#666; font-size:13px;" });
  msg.textContent = state.authMsg || "";

  const tabs = el("div", { class: "authTabs" }, [
    el("button", {
      class: "tab" + (state.authTab === "login" ? " active" : ""),
      text: "로그인",
      onclick: () => { state.authTab = "login"; render(); }
    }),
    el("button", {
      class: "tab" + (state.authTab === "signup" ? " active" : ""),
      text: "회원가입",
      onclick: () => { state.authTab = "signup"; render(); }
    }),
  ]);

  const btn = el("button", {
    class: "btn primary",
    text: state.authTab === "login" ? "로그인" : "회원가입",
    onclick: async () => {
      try {
        state.authMsg = "";
        msg.textContent = "";
        if (!email.value.trim() || !pw.value) { msg.textContent = "이메일과 비밀번호를 입력해 주세요."; return; }

        if (state.authTab === "signup") {
          if (pw.value !== pw2.value) { msg.textContent = "비밀번호 확인이 일치하지 않습니다."; return; }
          setFoot("회원가입을 진행 중입니다...");
          await signUp(email.value, pw.value);
          if (state.user) {
            setFoot("회원가입이 완료되었습니다.");
          } else {
            state.authMsg = "가입 확인 이메일을 발송했습니다. 이메일 인증 후 로그인해 주세요. (이미 가입된 이메일이면 별도 안내가 없을 수 있습니다.)";
            state.authTab = "login";
            setFoot("가입 확인 이메일을 발송했습니다.");
          }
        } else {
          setFoot("로그인을 진행 중입니다...");
          await signIn(email.value, pw.value);
          setFoot("로그인이 완료되었습니다.");
        }
        render();
      } catch (e) {
        msg.textContent = e.message || String(e);
        setFoot("요청에 실패했습니다.");
      }
    }
  });

  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "label", text: "로그인 / 회원가입" }),
    tabs,
    el("div", { class: "col", style: "margin-top:10px;" }, [
      el("div", { class: "label", text: "이메일" }), email,
      el("div", { class: "label", text: "비밀번호" }), pw,
      ...(state.authTab === "signup" ? [el("div", { class: "label", text: "비밀번호 확인" }), pw2] : []),
      el("div", { class: "row", style: "margin-top:10px;" }, [btn]),
      msg,
    ])
  ]));
}

/* ===== Company ===== */
function renderCompanySelect() {
  const list = el("div", { class: "list", style: "margin-top:12px;" });
  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "label", text: "회사 선택" }),
    el("div", { style: "margin-top:6px; font-weight:800;", text: "접근 가능한 회사 목록" }),
    list
  ]));

  (async () => {
    try {
      setFoot("회사 목록을 불러오는 중입니다...");
      const companies = await fetchCompanies();
      setFoot("");
      list.innerHTML = "";

      if (!companies.length) {
        list.appendChild(el("div", { class: "item" }, [
          el("div", { class: "col" }, [
            el("div", { class: "item-title", text: "소속 회사가 없습니다." }),
            el("div", { class: "item-sub", text: "관리자에게 회사 권한 등록을 요청해 주세요." }),
          ])
        ]));
        return;
      }

      for (const c of companies) {
        list.appendChild(el("div", { class: "item" }, [
          el("div", { class: "col" }, [
            el("div", { class: "item-title", text: c.name }),
                      ]),
          el("button", {
            class: "btn primary small",
            text: "선택",
            onclick: () => {
              state.company = c;
              state.mode = null;
              state.job = null;
              render();
            }
          })
        ]));
      }
    } catch (e) {
      setFoot("회사 목록을 불러오지 못했습니다.");
      alert(e.message || String(e));
    }
  })();
}

/* ===== Mode ===== */
function renderModeSelect() {
  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "label", text: "업무 선택" }),
    el("div", { class: "row", style: "margin-top:10px;" }, [
      el("button", { class: "btn", text: "농도", onclick: () => { state.mode = "density"; state.job = null; render(); } }),
      el("button", { class: "btn", text: "비산", onclick: () => { state.mode = "scatter"; state.job = null; render(); } }),
    ])
  ]));
}

/* ===== Job ===== */
function renderJobSelect() {
  const modeLabel = (state.mode === "density") ? "농도" : "비산";
  const search = el("input", { class: "input", placeholder: "공사명 검색" });
  const list = el("div", { class: "list", style: "margin-top:12px;" });

  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", { class: "col", style: "flex:1; min-width:220px;" }, [
        el("div", { class: "label", text: `현장 선택 · ${modeLabel}` }),
        search
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn primary", text: "새 현장", onclick: () => renderJobCreate() }),
      ])
    ]),
    list
  ]));

  const refresh = async () => {
    setFoot("현장 목록을 불러오는 중입니다...");
    state.jobs = await fetchJobs(state.company.id, state.mode);
    setFoot("");

    const q = search.value.trim();
    const filtered = q ? state.jobs.filter(j => (j.project_name || "").includes(q)) : state.jobs;

    list.innerHTML = "";
    if (!filtered.length) {
      list.appendChild(el("div", { class: "item" }, [
        el("div", { class: "col" }, [
          el("div", { class: "item-title", text: "현장이 없습니다." }),
          el("div", { class: "item-sub", text: "새 현장을 생성해 주세요." }),
        ])
      ]));
      return;
    }

    for (const j of filtered) {
      const dateText = j.last_upload_at ? ymdDots(j.last_upload_at) : "날짜 정보 없음";
      list.appendChild(el("div", { class: "item" }, [
        el("div", { class: "col" }, [
          el("div", { class: "item-title", text: j.project_name }),
          el("div", { class: "item-sub", text: dateText }),
        ]),
        el("div", { class: "row", style: "align-items:center; gap:8px;" }, [
          (j.status === "new") ? el("span", { class: "badge-new", text: "NEW" }) : el("span", { style: "display:none;" }),
          el("button", {
            class: "btn primary small",
            text: "열기",
            onclick: async () => {
              try { await loadJob(j); } catch (e) { alert(e.message || String(e)); }
            }
          })
        ])
      ]));
    }
  };

  search.addEventListener("input", refresh);
  refresh().catch(e => alert(e.message || String(e)));
}

function renderJobCreate() {
  root.innerHTML = "";
  const modeLabel = (state.mode === "density") ? "농도" : "비산";

  const project = el("input", { class: "input", placeholder: "공사명" });
  const address = el("input", { class: "input", placeholder: "현장주소(선택)" });
  const contractor = el("input", { class: "input", placeholder: "해체업체(선택)" });
  const msg = el("div", { style: "margin-top:10px; color:#666; font-size:13px;" });
  msg.textContent = state.authMsg || "";

  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "label", text: `새 현장 생성 · ${modeLabel}` }),
    el("div", { class: "col", style: "margin-top:10px;" }, [
      el("div", { class: "label", text: "공사명(필수)" }), project,
      el("div", { class: "label", text: "현장주소(선택)" }), address,
      el("div", { class: "label", text: "해체업체(선택)" }), contractor,
      el("div", { class: "row", style: "margin-top:10px;" }, [
        el("button", { class: "btn ghost", text: "취소", onclick: () => render() }),
        el("button", {
          class: "btn primary",
          text: "생성",
          onclick: async () => {
            try {
              if (!project.value.trim()) { msg.textContent = "공사명을 입력해 주세요."; return; }
              const job = await createJob({
                company_id: state.company.id,
                mode: state.mode,
                project_name: project.value.trim(),
                address: address.value.trim(),
                contractor: contractor.value.trim(),
              });
              await loadJob(job);
            } catch (e) {
              msg.textContent = e.message || String(e);
            }
          }
        })
      ]),
      msg
    ])
  ]));
}

/* ===== Job work ===== */
function renderJobWork() {
  const modeLabel = (state.mode === "density") ? "농도" : "비산";

  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", { class: "col" }, [
        el("div", { class: "label", text: `현재 현장 · ${modeLabel}` }),
        el("div", { style: "font-weight:900; font-size:16px; margin-top:4px;", text: state.job.project_name }),
        el("div", { style: "font-size:12px; color:#666; margin-top:4px;", text: state.company.name }),
      ]),
      el("div", { class: "row" }, [
        el("button", {
          class: "btn small",
          text: "현장 변경",
          onclick: () => {
            if (!confirm("현장 선택 화면으로 이동하시겠습니까?")) return;
            state.job = null;
            state.addOpen = false;
            render();
          }
        })
      ])
    ])
  ]));

  // date tabs
  const addDate = el("input", { class: "input", type: "date", value: state.activeDate || new Date().toISOString().slice(0, 10) });
  const btnGoDate = el("button", {
    class: "btn small",
    text: "이 날짜로 이동",
    onclick: () => {
      const d = addDate.value;
      if (!d) return;
      if (!state.dates.includes(d)) {
        state.dates.push(d);
        state.dates.sort();
        state.samplesByDate.set(d, []);
      }
      state.activeDate = d;
      state.addOpen = false;
      render();
    }
  });

  const tabs = el("div", { class: "tabs", style: "margin-top:10px;" });
  for (const d of state.dates) {
    tabs.appendChild(el("button", {
      class: "tab" + (d === state.activeDate ? " active" : ""),
      text: ymdDots(d),
      onclick: () => { state.activeDate = d; state.addOpen = false; render(); }
    }));
  }

  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "label", text: "측정일" }),
    el("div", { class: "dateControls", style: "margin-top:10px;" }, [
      el("div", { class: "dateCol" }, [addDate]),
      btnGoDate,
    ]),
    tabs
  ]));

  const dateISO = state.activeDate || new Date().toISOString().slice(0, 10);
  const samples = state.samplesByDate.get(dateISO) || [];

  // add sample panel
  root.appendChild(el("section", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", { class: "col" }, [
        el("div", { class: "label", text: "시료" }),
        el("div", { style: "font-weight:800; margin-top:4px;", text: `${ymdDots(dateISO)} 시료 목록` }),
      ]),
      el("div", { class: "row" }, [
        el("button", {
          class: "btn primary",
          text: state.addOpen ? "닫기" : "+ 시료 추가",
          onclick: () => { state.addOpen = !state.addOpen; render(); }
        })
      ])
    ]),
    ...(state.addOpen ? [renderAddSamplePanel(dateISO)] : []),
  ]));

  // samples list
  if (!samples.length) {
    root.appendChild(el("section", { class: "card" }, [
      el("div", { class: "label", text: "안내" }),
      el("div", { style: "margin-top:8px; color:#666; font-size:13px;", text: "해당 날짜에 시료가 없습니다. 시료를 추가해 주세요." })
    ]));
    return;
  }

  const listWrap = el("section", { class: "card" }, [
    el("div", { class: "label", text: "시료 목록" }),
  ]);
  for (const s of samples) listWrap.appendChild(renderSampleRow(s));
  root.appendChild(listWrap);
}

function renderAddSamplePanel(dateISO) {
  const options = ["부지경계선", "작업장주변", "출입구", "하역장", "기타"];

  const locNode = (state.mode === "scatter")
    ? (() => {
      const sel = el("select", { class: "input" }, options.map(x => el("option", { value: x, text: x })));
      sel.value = state.addLoc || options[0];
      state.addLoc = sel.value; // 초기값 저장
      sel.addEventListener("change", () => { state.addLoc = sel.value; });
      return sel;
    })()
    : (() => {
      const inp = el("input", { class: "input", placeholder: "시료 위치(비워도 됨)", value: state.addLoc || "" });
      inp.addEventListener("input", () => { state.addLoc = inp.value; });
      return inp;
    })();

  const timeInp = el("input", { class: "timeInput", type: "time", value: state.addTime || "" });
  timeInp.addEventListener("input", () => { state.addTime = timeInp.value; });

  const btnCreate = el("button", {
    class: "btn primary",
    text: "생성",
    onclick: async () => {
      try {
        setFoot("시료를 생성 중입니다...");
        const s = await createSampleRPC(state.job.id, dateISO, (state.addLoc ?? "").trim());
        s._photoState = {};
        s._photoPath = {};
        s._thumbUrl = {};
        s.start_time = (state.addTime || null);

        if (!state.samplesByDate.has(dateISO)) state.samplesByDate.set(dateISO, []);
        state.samplesByDate.get(dateISO).push(s);
        if (!state.dates.includes(dateISO)) { state.dates.push(dateISO); state.dates.sort(); }

        if (state.addTime) await updateSampleFields(s.id, { start_time: state.addTime });

        state.addOpen = false;
        state.addLoc = "";
        state.addTime = "";

        setFoot("시료 생성이 완료되었습니다.");
        render();
      } catch (e) {
        console.error(e);
        alert(e.message || String(e));
        setFoot("시료 생성에 실패했습니다.");
      }
    }
  });

  return el("div", { class: "row", style: "margin-top:12px;" }, [
    el("div", { class: "col", style: "flex:1; min-width:220px;" }, [
      el("div", { class: "label", text: state.mode === "scatter" ? "시료 위치(비산)" : "시료 위치(농도)" }),
      locNode
    ]),
    el("div", { class: "col" }, [
      el("div", { class: "label", text: "측정 시작시간(선택)" }),
      timeInp
    ]),
    el("div", { class: "col" }, [
      el("div", { class: "label", text: "" }),
      btnCreate
    ]),
  ]);
}

function renderSampleRow(sample) {
  const loc = (sample.sample_location || "").trim() || "(미입력)";
  const title = `P${sample.p_index} · ${loc}`;
  const dateText = ymdDots(sample.measurement_date);

  const btnX = el("button", {
    class: "xBtn",
    text: "×",
    onclick: (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      deleteSample(sample);
    }
  });

  const t = el("input", { class: "timeInput", type: "time", value: sample.start_time || "" });
  let saveTimer = null;
  t.addEventListener("input", () => {
    const v = t.value || null;
    sample.start_time = v;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await updateSampleFields(sample.id, { start_time: v });
        setFoot("측정 시간이 저장되었습니다.");
      } catch (e) {
        console.error(e);
        setFoot("측정 시간 저장에 실패했습니다.");
      }
    }, 350);
  });

  const roles = (state.mode === "density") ? ["measurement"] : ["start", "end"];
  const right = el("div", { class: `sampleRight ${state.mode}` }, roles.map(role => renderMiniSlot(sample, role)));

  // ✅ 여기: 모드별 class 추가
  return el("div", { class: `sampleRow mode-${state.mode}` }, [
    btnX,
    el("div", { class: "sampleLeft" }, [
      el("div", { class: "sampleTitle", text: title }),
      el("div", { class: "sampleMeta" }, [
        el("div", { class: "metaLine" }, [
          el("span", { text: dateText }),
        ]),
        el("div", { class: "metaLine" }, [
          el("span", { text: "시작시간" }),
          t,
        ]),
      ])
    ]),
    right
  ]);
}

function renderMiniSlot(sample, role) {
  sample._photoState = sample._photoState || {};
  sample._photoPath = sample._photoPath || {};
  sample._thumbUrl = sample._thumbUrl || {};

  const status = sample._photoState[role] || (sample._photoPath[role] ? "done" : "empty");
  if (status === "done" && sample._photoPath[role]) ensureThumbUrl(sample, role);

  const head = el("div", { class: "slotHead" }, [
    el("div", { class: dotClass(status) }),
    el("span", { text: roleLabel(role) }),
  ]);

  const thumb = el("div", { class: "thumbMini" }, []);
  const url = sample._thumbUrl?.[role] || null;

  if (url) {
    const img = el("img", { src: url, alt: roleLabel(role) });
    thumb.appendChild(img);
    thumb.style.cursor = "pointer";
    thumb.title = "누르면 미리보기가 열립니다.";
    thumb.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const dateISO = state.activeDate || sample.measurement_date;
      openViewer(dateISO, sample.id, role);
    });
  } else {
    thumb.appendChild(el("div", { text: "사진 없음" }));
  }

  const btns = el("div", { class: "slotBtns" }, [
    el("button", { class: "btn small", text: "촬영", onclick: () => pickPhoto(sample, role, true) }),
    el("button", { class: "btn small", text: "앨범", onclick: () => pickPhoto(sample, role, false) }),
  ]);

  // ✅ 농도: "라벨(닷+측정사진) + 썸네일"을 한 줄로 만들고, 버튼은 아래
  if (state.mode === "density") {
    const inline = el("div", { class: "slotInline" }, [head, thumb]);
    return el("div", { class: "slotMini density" }, [inline, btns]);
  }

  // ✅ 비산: 기존(라벨 위, 썸네일 아래) + 버튼 아래 (2개가 나란히 보이게 CSS로 정렬)
  return el("div", { class: "slotMini scatter" }, [head, thumb, btns]);
}

/* ===== Boot ===== */
(async function main() {
  try {
    await loadSession();

    supabase.auth.onAuthStateChange(async (_event, session) => {
      state.user = session?.user || null;
      if (!state.user) {
        state.company = null;
        state.mode = null;
        state.job = null;
      }
      closeSettings();
      updateHeader();
      render();
    });

    render();
    setFoot("대기 중입니다.");
  } catch (e) {
    console.error(e);
    setFoot("초기화에 실패했습니다.");
    root.appendChild(el("div", { class: "card", text: e.message || String(e) }));
  }
})();
