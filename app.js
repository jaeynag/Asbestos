// ===== NAS + Resize 패치 (app.js에 추가/교체) =====
//
// 1) 상단 설정값 근처에 추가
// const NAS_GATEWAY_URL = "https://nas.example.com/asb"; // 끝에 / 붙이지 말기
// const STORAGE_BACKEND = "nas"; // "nas" | "supabase"
//
// const RESIZE_MAX_SIDE = 2048;
// const RESIZE_QUALITY = 0.82;
//
// 2) 아래 함수 3개를 app.js에 넣고,
//    기존 getSignedUrl(), uploadAndBindPhoto()는 이걸로 "교체"하면 됨.

async function resizeImageToJpeg(file, maxSide = RESIZE_MAX_SIDE, quality = RESIZE_QUALITY) {
  // 실패하면 원본 반환(HEIC 등)
  try {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;

    const blob = file;
    let img;

    // createImageBitmap 우선
    if (window.createImageBitmap) {
      img = await createImageBitmap(blob);
    } else {
      // fallback
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = URL.createObjectURL(blob);
      });
    }

    const w = img.width;
    const h = img.height;
    if (!w || !h) return file;

    const scale = Math.min(1, maxSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    // 크기 줄일 필요 없으면 JPG로만 변환하지 않고 원본 유지(트래픽/CPU 절약)
    // 단, 확실히 줄이고 싶으면 조건을 지워도 됨.
    if (scale === 1 && (file.type === 'image/jpeg' || file.type === 'image/jpg')) {
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(img, 0, 0, tw, th);

    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!outBlob) return file;

    return new File([outBlob], (file.name?.replace(/\.[^.]+$/, '') || 'photo') + '.jpg', { type: 'image/jpeg' });
  } catch (e) {
    console.warn('resize 실패(원본 업로드로 fallback):', e);
    return file;
  }
}

async function getSignedUrl(path) {
  if (path && typeof path === 'string' && path.startsWith('nas:')) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('세션이 없습니다.');

    const rel = path.slice(4).replace(/^\/+/, '');
    const res = await fetch(`${NAS_GATEWAY_URL}/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SEC, paths: [rel] }),
    });
    const js = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(js?.detail || 'NAS sign 실패');

    const signed = js?.signedURLs?.[0]?.signedURL;
    if (!signed) throw new Error('NAS signedURL 응답이 없습니다.');
    return signed;
  }

  // 기존 Supabase Storage
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC);
  if (error) throw error;
  return data.signedUrl;
}

async function uploadAndBindPhoto(sample, role, file) {
  sample._photoState = sample._photoState || {};
  sample._photoPath = sample._photoPath || {};
  sample._photoState[role] = 'uploading';
  render();

  try {
    const mode = state.mode;
    const companyId = state.company.id;
    const jobId = state.job.id;
    const dateFolder = ymdDots(sample.measurement_date);

    // 1) 업로드 전 리사이즈
    const resized = await resizeImageToJpeg(file);
    const ext = 'jpg';

    // 2) 저장 경로 (슬래시 포함)
    const relPath = `${companyId}/${mode}/${jobId}/${dateFolder}/${sample.id}/${role}.${ext}`;

    if (STORAGE_BACKEND === 'nas') {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error('세션이 없습니다.');

      const fd = new FormData();
      fd.append('file', resized, `${role}.jpg`);
      fd.append('company_id', companyId);
      fd.append('mode', mode);
      fd.append('job_id', jobId);
      fd.append('date_folder', dateFolder);
      fd.append('sample_id', sample.id);
      fd.append('role', role);

      const res = await fetch(`${NAS_GATEWAY_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: fd,
      });
      const js = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(js?.detail || 'NAS 업로드 실패');

      // 게이트웨이가 DB까지 기록하고 storage_path를 돌려줌
      const stored = js?.storage_path || (`nas:${relPath}`);
      sample._photoState[role] = 'done';
      sample._photoPath[role] = stored;

      ensureThumbUrl(sample, role);
      setFoot('업로드가 완료되었습니다.');
      render();
      return;
    }

    // 3) (기존) Supabase Storage 업로드
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(relPath, resized, { upsert: true, contentType: resized.type || 'image/jpeg' });
    if (upErr) throw upErr;

    const { data: row, error: rpcErr } = await supabase.rpc('upsert_sample_photo', {
      p_sample_id: sample.id,
      p_role: role,
      p_storage_path: relPath,
    });
    if (rpcErr) throw rpcErr;

    sample._photoState[role] = 'done';
    sample._photoPath[role] = row.storage_path;

    ensureThumbUrl(sample, role);

    setFoot('업로드가 완료되었습니다.');
    render();
  } catch (e) {
    console.error(e);
    sample._photoState[role] = 'failed';
    setFoot(`업로드에 실패했습니다: ${e?.message || e}`);
    render();
  }
}
