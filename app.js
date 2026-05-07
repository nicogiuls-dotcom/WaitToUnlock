/* =========================================================
   Constants
   ========================================================= */
const STORE_KEY = 'wtu.pins.v2';
const REVEAL_TIMEOUT_MS = 30_000;
const $ = (id) => document.getElementById(id);

const QUICKNET_CHAIN_INFO = {
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};
const QUICKNET_URL =
  'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';

/* CDN fallback list for the tlock-js bundle. We try jsdelivr first
   (most-cached and CORS-friendly), then esm.sh, then unpkg. As long
   as one resolves we are fine. */
const TLOCK_CDNS = [
  'https://cdn.jsdelivr.net/npm/tlock-js@0.9.0/+esm',
  'https://esm.sh/tlock-js@0.9.0',
  'https://unpkg.com/tlock-js@0.9.0?module',
];
const QRCODE_CDNS = [
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm',
  'https://esm.sh/qrcode@1.5.3',
];

async function tryImport(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      return mod;
    } catch (err) {
      console.warn('[wtu] CDN failed:', url, err && err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('No CDN responded');
}

let _tlockPromise = null;
function loadTlock() {
  if (!_tlockPromise) {
    _tlockPromise = (async () => {
      const mod = await tryImport(TLOCK_CDNS);
      if (!mod || typeof mod.HttpChainClient !== 'function') {
        throw new Error('tlock module missing expected exports');
      }
      const client = new mod.HttpChainClient(
        new mod.HttpCachingChain(QUICKNET_URL, QUICKNET_CHAIN_INFO)
      );
      return { mod, client };
    })().catch((err) => {
      // Reset so a retry click can try again
      _tlockPromise = null;
      throw err;
    });
  }
  return _tlockPromise;
}

let _qrPromise = null;
function loadQrLib() {
  if (!_qrPromise) {
    _qrPromise = tryImport(QRCODE_CDNS).then((m) => m.default || m).catch((err) => {
      _qrPromise = null;
      throw err;
    });
  }
  return _qrPromise;
}

/* =========================================================
   State
   ========================================================= */
const state = {
  selectedLength: 4,
  selectedPresetMs: 60 * 60 * 1000,
  customUnlockMs: null,
  successData: null,
  successCountdownTimer: null,
};

const revealTimers = new Map();

/* =========================================================
   Crypto / utilities
   ========================================================= */
function generatePin(length) {
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let pin = '';
  for (let i = 0; i < length; i++) pin += (buf[i] % 10).toString();
  return pin;
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('clipboard fallback failed');
}

function loadPins() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function savePins(pins) {
  localStorage.setItem(STORE_KEY, JSON.stringify(pins));
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRemaining(ms) {
  if (ms <= 0) return 'ya está disponible';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatUnlockDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Hoy a las ${time}`;
  if (isTomorrow) return `Mañana a las ${time}`;
  return d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

async function tlockEncryptPin(pin, unlockMs) {
  const { mod, client } = await loadTlock();
  const round = mod.roundAt(unlockMs, QUICKNET_CHAIN_INFO) + 1;
  const ciphertext = await mod.timelockEncrypt(round, mod.Buffer.from(pin, 'utf-8'), client);
  return { ciphertext, round };
}

async function tlockDecryptPin(ciphertext) {
  const { mod, client } = await loadTlock();
  const buf = await mod.timelockDecrypt(ciphertext, client);
  return buf.toString('utf-8');
}

function describeDrandError(err) {
  const msg = (err && err.message) || String(err);
  if (/round|beacon|signature/i.test(msg)) {
    return 'Falta poquito para que se abra. Esperá unos segundos y reintentá.';
  }
  if (/network|fetch|Failed to fetch|HTTP|module|import|CDN/i.test(msg)) {
    return 'No pude descargar la librería de cifrado. Probá de nuevo en un minuto, o reintentá desde otra red.';
  }
  return `Algo salió mal: ${msg.slice(0, 100)}`;
}

/* =========================================================
   Toast / dialogs
   ========================================================= */
let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2400);
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = $('confirm-dialog');
    $('confirm-message').textContent = message;
    const yesBtn = $('confirm-yes-btn');
    const noBtn = $('confirm-no-btn');

    const cleanup = () => {
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onNo);
    };
    const onYes = () => { cleanup(); dialog.close(); resolve(true); };
    const onNo = (e) => { e?.preventDefault?.(); cleanup(); dialog.close(); resolve(false); };

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    dialog.addEventListener('cancel', onNo);
    dialog.showModal();
  });
}

/* =========================================================
   Routing (simple two-view)
   ========================================================= */
function showView(name) {
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${name}`;
  });
  $('nav-vault').classList.toggle('is-active', name === 'vault');
  if (name === 'vault') renderVault();
  if (name === 'create') resetCreateForm();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* =========================================================
   Create view
   ========================================================= */
function getSelectedUnlockMs() {
  const customStr = $('unlock-at').value;
  if (customStr) {
    const t = new Date(customStr).getTime();
    if (Number.isFinite(t) && t > Date.now()) return t;
  }
  return Date.now() + state.selectedPresetMs;
}

function resetCreateForm() {
  $('create-form').hidden = false;
  $('create-success').hidden = true;
  if (state.successCountdownTimer) {
    clearInterval(state.successCountdownTimer);
    state.successCountdownTimer = null;
  }
  state.successData = null;
}

function selectLength(length) {
  state.selectedLength = length;
  document.querySelectorAll('.segment-btn').forEach((b) => {
    const isMatch = parseInt(b.dataset.length, 10) === length;
    b.classList.toggle('is-selected', isMatch);
    b.setAttribute('aria-checked', isMatch ? 'true' : 'false');
  });
}

function selectPreset(ms) {
  state.selectedPresetMs = ms;
  state.customUnlockMs = null;
  $('unlock-at').value = '';
  document.querySelectorAll('.btn-chip[data-preset]').forEach((b) => {
    const isMatch = parseInt(b.dataset.preset, 10) === ms;
    b.classList.toggle('is-selected', isMatch);
    b.setAttribute('aria-checked', isMatch ? 'true' : 'false');
  });
}

function clearPresetSelection() {
  state.selectedPresetMs = null;
  document.querySelectorAll('.btn-chip[data-preset]').forEach((b) => {
    b.classList.remove('is-selected');
    b.setAttribute('aria-checked', 'false');
  });
}

async function handleCreate() {
  const unlockAt = getSelectedUnlockMs();
  if (!Number.isFinite(unlockAt) || unlockAt <= Date.now()) {
    toast('Elegí cuándo poder abrirlo.');
    return;
  }

  const length = state.selectedLength;
  const pin = generatePin(length);

  const btn = $('create-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creando…';

  try {
    await copyToClipboard(pin);
  } catch {
    btn.disabled = false;
    btn.textContent = originalText;
    toast('No pude copiar al portapapeles. Probá desde HTTPS.');
    return;
  }

  let encrypted;
  try {
    encrypted = await tlockEncryptPin(pin, unlockAt);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    toast(describeDrandError(err));
    return;
  }

  const pins = loadPins();
  pins.push({
    id: newId(),
    label: $('pin-label').value.trim(),
    ciphertext: encrypted.ciphertext,
    round: encrypted.round,
    length,
    unlockAt,
    requireConfirm: $('require-confirm').checked,
    createdAt: Date.now(),
  });
  savePins(pins);

  btn.disabled = false;
  btn.textContent = originalText;

  showSuccess({ length, unlockAt });
  updateVaultBadge();
  $('pin-label').value = '';
}

function showSuccess({ unlockAt }) {
  state.successData = { unlockAt };
  $('create-form').hidden = true;
  $('create-success').hidden = false;
  $('success-when').textContent = formatUnlockDate(unlockAt);

  if (state.successCountdownTimer) clearInterval(state.successCountdownTimer);
  const tick = () => {
    const remaining = unlockAt - Date.now();
    $('success-countdown').textContent = remaining > 0 ? formatRemaining(remaining) : 'Disponible';
    if (remaining <= 0 && state.successCountdownTimer) {
      clearInterval(state.successCountdownTimer);
      state.successCountdownTimer = null;
    }
  };
  tick();
  state.successCountdownTimer = setInterval(tick, 1000);
}

/* =========================================================
   Vault view
   ========================================================= */
function updateVaultBadge() {
  const count = loadPins().length;
  const badge = $('vault-count');
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.textContent = '';
    badge.hidden = true;
  }
}

function renderVault() {
  const list = $('pin-list');
  const pins = loadPins().sort((a, b) => a.unlockAt - b.unlockAt);
  const now = Date.now();

  // Preserve revealed values
  const previouslyRevealed = new Map();
  list.querySelectorAll('.pin-item').forEach((node) => {
    const slot = node.querySelector('.pin-revealed');
    if (slot && !slot.hidden) {
      previouslyRevealed.set(node.dataset.id, node.querySelector('.pin-revealed-value').textContent);
    }
  });

  list.innerHTML = '';
  $('empty-state').hidden = pins.length > 0;

  const tpl = $('pin-item-template');
  for (const p of pins) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = p.id;
    node.querySelector('.pin-label').textContent = p.label || 'Sin nombre';
    node.querySelector('.pin-length').textContent = `${p.length || 4} dígitos`;
    node.querySelector('.pin-unlock-at').textContent = `se abre ${formatUnlockDate(p.unlockAt)}`;

    const unlocked = now >= p.unlockAt;
    const pill = node.querySelector('.pin-status-pill');
    const countdown = node.querySelector('.pin-countdown');
    if (unlocked) {
      pill.className = 'pin-status-pill unlocked';
      pill.textContent = 'Lista para abrir';
      countdown.textContent = '';
    } else {
      pill.className = 'pin-status-pill locked';
      pill.textContent = 'Bloqueado';
      countdown.textContent = `Faltan ${formatRemaining(p.unlockAt - now)}`;
    }

    node.querySelector('.action-reveal').disabled = !unlocked;
    node.querySelector('.action-copy').disabled = !unlocked;

    if (previouslyRevealed.has(p.id)) {
      const slot = node.querySelector('.pin-revealed');
      slot.hidden = false;
      slot.querySelector('.pin-revealed-value').textContent = previouslyRevealed.get(p.id);
    }

    list.appendChild(node);
  }
}

/* =========================================================
   Reveal lifecycle
   ========================================================= */
function scheduleAutoHide(id) {
  clearAutoHide(id);
  const timer = setTimeout(() => {
    const node = document.querySelector(`.pin-item[data-id="${id}"]`);
    if (!node) return;
    const slot = node.querySelector('.pin-revealed');
    if (slot) {
      slot.hidden = true;
      slot.querySelector('.pin-revealed-value').textContent = '';
    }
    revealTimers.delete(id);
  }, REVEAL_TIMEOUT_MS);
  revealTimers.set(id, timer);
}

function clearAutoHide(id) {
  if (revealTimers.has(id)) {
    clearTimeout(revealTimers.get(id));
    revealTimers.delete(id);
  }
}

/* =========================================================
   Export / Import (file)
   ========================================================= */
function exportPins() {
  const pins = loadPins();
  if (pins.length === 0) {
    toast('No hay PINs para respaldar.');
    return;
  }
  const payload = { app: 'waittounlock', version: 2, exportedAt: Date.now(), pins };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `waittounlock-respaldo-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  copyToClipboard(json)
    .then(() => toast(`Respaldo descargado y copiado (${pins.length} PIN${pins.length !== 1 ? 's' : ''}).`))
    .catch(() => toast(`Respaldo descargado (${pins.length} PIN${pins.length !== 1 ? 's' : ''}).`));
}

function importPinsFromJson(jsonStr) {
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch {
    return { ok: false, error: 'El contenido no es un JSON válido.' };
  }
  let incoming;
  if (Array.isArray(parsed)) incoming = parsed;
  else if (parsed && Array.isArray(parsed.pins)) incoming = parsed.pins;
  else if (parsed && typeof parsed.id === 'string') incoming = [parsed];
  else return { ok: false, error: 'No encontré PINs en el archivo.' };

  const valid = incoming.filter(
    (p) => p && typeof p.id === 'string' && typeof p.ciphertext === 'string' && Number.isFinite(p.unlockAt)
  );
  if (valid.length === 0) return { ok: false, error: 'El archivo no tiene PINs con el formato correcto.' };

  const existing = loadPins();
  const existingIds = new Set(existing.map((p) => p.id));
  let added = 0, skipped = 0;
  for (const p of valid) {
    if (existingIds.has(p.id)) { skipped++; continue; }
    existing.push({
      id: p.id,
      label: typeof p.label === 'string' ? p.label : '',
      ciphertext: p.ciphertext,
      round: Number.isFinite(p.round) ? p.round : 0,
      length: Number.isFinite(p.length) ? p.length : 4,
      unlockAt: p.unlockAt,
      requireConfirm: p.requireConfirm !== false,
      createdAt: Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
    });
    added++;
  }
  savePins(existing);
  return { ok: true, added, skipped };
}

/* =========================================================
   QR transfer
   ========================================================= */
function buildShareUrl(pin) {
  const minimal = {
    id: pin.id,
    label: pin.label,
    ciphertext: pin.ciphertext,
    round: pin.round,
    length: pin.length,
    unlockAt: pin.unlockAt,
    requireConfirm: pin.requireConfirm,
    createdAt: pin.createdAt,
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(minimal))));
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#i=${encoded}`;
}

async function openShareDialog(pinId) {
  const pin = loadPins().find((p) => p.id === pinId);
  if (!pin) return;
  const url = buildShareUrl(pin);
  $('qr-canvas').innerHTML = '';
  $('qr-loading').hidden = false;
  $('qr-dialog').showModal();

  try {
    const QR = await loadQrLib();
    const svg = await QR.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'L',
      margin: 0,
      color: { dark: '#0e1218', light: '#ffffff' },
    });
    $('qr-canvas').innerHTML = svg;
    $('qr-loading').hidden = true;
  } catch (err) {
    $('qr-canvas').innerHTML = '';
    $('qr-loading').textContent = 'No pude generar el QR.';
  }

  $('qr-copy-link-btn').onclick = async () => {
    try {
      await copyToClipboard(url);
      toast('Enlace copiado');
    } catch {
      toast('No se pudo copiar');
    }
  };
}

/* =========================================================
   Deep-link import (hash fragment)
   ========================================================= */
async function handleDeepLinkImport() {
  const hash = window.location.hash;
  if (!hash.startsWith('#i=')) return;
  let payload;
  try {
    payload = decodeURIComponent(escape(atob(hash.slice(3))));
  } catch {
    history.replaceState(null, '', window.location.pathname);
    return;
  }
  // Clear hash so refresh doesn't re-prompt
  history.replaceState(null, '', window.location.pathname);

  const ok = await confirmDialog(
    '¿Querés agregar este PIN compartido a tu caja fuerte? (No se puede abrir hasta su fecha.)'
  );
  if (!ok) return;

  const result = importPinsFromJson(payload);
  if (!result.ok) {
    toast(result.error);
    return;
  }
  if (result.added > 0) {
    toast(`PIN agregado a tu caja fuerte`);
    updateVaultBadge();
    showView('vault');
  } else if (result.skipped > 0) {
    toast('Ya tenías ese PIN guardado.');
  }
}

/* =========================================================
   Event binding
   ========================================================= */
// Length segment
document.querySelectorAll('.segment-btn').forEach((b) => {
  b.addEventListener('click', () => selectLength(parseInt(b.dataset.length, 10)));
});

// Presets
document.querySelectorAll('.btn-chip[data-preset]').forEach((b) => {
  b.addEventListener('click', () => selectPreset(parseInt(b.dataset.preset, 10)));
});

$('unlock-at').addEventListener('input', (e) => {
  if (e.target.value) clearPresetSelection();
});

// Default custom-date value when expanded
document.querySelector('.custom-date').addEventListener('toggle', (e) => {
  if (e.target.open && !$('unlock-at').value) {
    $('unlock-at').value = toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
  }
});

// Create CTA
$('create-btn').addEventListener('click', handleCreate);
$('create-another-btn').addEventListener('click', () => resetCreateForm());

// iOS help links
$('ios-help-btn').addEventListener('click', () => $('ios-dialog').showModal());
$('success-ios-help').addEventListener('click', () => $('ios-dialog').showModal());

// How it works links
$('nav-how').addEventListener('click', () => $('how-dialog').showModal());
$('footnote-how').addEventListener('click', () => $('how-dialog').showModal());

// Navigation
$('nav-vault').addEventListener('click', () => showView('vault'));
$('home-link').addEventListener('click', () => showView('create'));
$('back-to-create').addEventListener('click', () => showView('create'));
$('empty-create-btn').addEventListener('click', () => showView('create'));

// Pin list actions
$('pin-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const item = e.target.closest('.pin-item');
  if (!item) return;
  const id = item.dataset.id;

  const pins = loadPins();
  const idx = pins.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const p = pins[idx];

  if (btn.classList.contains('action-delete')) {
    const ok = await confirmDialog('¿Borrar este PIN? No vas a poder recuperarlo.');
    if (!ok) return;
    pins.splice(idx, 1);
    savePins(pins);
    clearAutoHide(id);
    renderVault();
    updateVaultBadge();
    toast('PIN borrado');
    return;
  }

  if (btn.classList.contains('action-share')) {
    openShareDialog(id);
    return;
  }

  if (btn.classList.contains('action-hide')) {
    const slot = item.querySelector('.pin-revealed');
    slot.hidden = true;
    slot.querySelector('.pin-revealed-value').textContent = '';
    clearAutoHide(id);
    return;
  }

  if (Date.now() < p.unlockAt) return;

  if (btn.classList.contains('action-reveal')) {
    if (p.requireConfirm) {
      const ok = await confirmDialog('Va a aparecer en pantalla. ¿Querés verlo igual?');
      if (!ok) return;
    }
    const slot = item.querySelector('.pin-revealed');
    const valueEl = slot.querySelector('.pin-revealed-value');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Abriendo…';
    try {
      const pin = await tlockDecryptPin(p.ciphertext);
      slot.hidden = false;
      valueEl.textContent = pin;
      scheduleAutoHide(id);
    } catch (err) {
      toast(describeDrandError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  if (btn.classList.contains('action-copy')) {
    if (p.requireConfirm) {
      const ok = await confirmDialog('Va a quedar copiado en el portapapeles. ¿Continuar?');
      if (!ok) return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Abriendo…';
    try {
      const pin = await tlockDecryptPin(p.ciphertext);
      await copyToClipboard(pin);
      btn.textContent = 'Copiado';
      toast('PIN copiado al portapapeles');
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
    } catch (err) {
      btn.textContent = original;
      btn.disabled = false;
      toast(describeDrandError(err));
    }
  }
});

// Export / import
$('export-btn').addEventListener('click', exportPins);

$('import-btn').addEventListener('click', () => {
  $('import-text').value = '';
  $('import-file').value = '';
  const status = $('import-status');
  status.className = 'status';
  status.textContent = '';
  $('import-dialog').showModal();
});

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    $('import-text').value = text;
  } catch {
    const status = $('import-status');
    status.className = 'status error';
    status.textContent = 'No pude leer el archivo.';
  }
});

$('import-confirm-btn').addEventListener('click', () => {
  const json = $('import-text').value.trim();
  const status = $('import-status');
  if (!json) {
    status.className = 'status error';
    status.textContent = 'Subí un archivo o pegá el contenido del respaldo.';
    return;
  }
  const result = importPinsFromJson(json);
  if (!result.ok) {
    status.className = 'status error';
    status.textContent = result.error;
    return;
  }
  status.className = 'status success';
  const main = `Restaurados ${result.added} PIN${result.added !== 1 ? 's' : ''}.`;
  const extra = result.skipped > 0 ? ` Omitidos ${result.skipped} que ya tenías.` : '';
  status.textContent = main + extra;
  renderVault();
  updateVaultBadge();
  toast(main);
  setTimeout(() => $('import-dialog').close(), 1400);
});

// Generic close-dialog handlers
document.querySelectorAll('[data-close-dialog]').forEach((el) => {
  el.addEventListener('click', () => {
    const id = el.getAttribute('data-close-dialog');
    $(id)?.close();
  });
});

$('clear-clipboard-btn').addEventListener('click', async () => {
  try {
    await copyToClipboard(' ');
    toast('Portapapeles limpio');
  } catch {
    toast('No se pudo limpiar el portapapeles');
  }
});

/* =========================================================
   Init
   ========================================================= */
selectLength(4);
selectPreset(60 * 60 * 1000);
updateVaultBadge();

// If pins exist, allow user to land directly on vault via #vault hash
if (window.location.hash === '#vault') {
  showView('vault');
} else {
  showView('create');
}

// Re-render vault every second for countdowns
setInterval(() => {
  if (!$('view-vault').hidden) renderVault();
}, 1000);

// Handle deep-link import
handleDeepLinkImport();
