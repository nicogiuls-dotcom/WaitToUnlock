import {
  timelockEncrypt,
  timelockDecrypt,
  HttpChainClient,
  HttpCachingChain,
  roundAt,
  roundTime,
  Buffer,
} from 'https://esm.sh/tlock-js@0.9.0';

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

const drandChain = new HttpCachingChain(QUICKNET_URL, QUICKNET_CHAIN_INFO);
const drandClient = new HttpChainClient(drandChain);

let pendingPin = null;
const revealTimers = new Map();

/* =========================
   Utilities
   ========================= */
function generatePin(length) {
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let pin = '';
  for (let i = 0; i < length; i++) {
    pin += (buf[i] % 10).toString();
  }
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
  } catch {
    return [];
  }
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
  if (d > 0) return `Faltan ${d}d ${h}h ${m}m`;
  if (h > 0) return `Faltan ${h}h ${m}m`;
  if (m > 0) return `Faltan ${m}m ${sec}s`;
  return `Faltan ${sec}s`;
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

/* =========================
   Status / toast / dialogs
   ========================= */
function setStatus(kind, msg) {
  const el = $('generate-status');
  el.className = `status ${kind}`;
  el.textContent = msg;
}

function clearStatus() {
  const el = $('generate-status');
  el.className = 'status';
  el.textContent = '';
}

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
    const onNo = (e) => { if (e) e.preventDefault?.(); cleanup(); dialog.close(); resolve(false); };

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    dialog.addEventListener('cancel', onNo);
    dialog.showModal();
  });
}

/* =========================
   Crypto wrappers
   ========================= */
function roundForUnlockTime(unlockMs) {
  return roundAt(unlockMs, QUICKNET_CHAIN_INFO) + 1;
}

async function tlockEncryptPin(pin, unlockMs) {
  const round = roundForUnlockTime(unlockMs);
  const ciphertext = await timelockEncrypt(round, Buffer.from(pin, 'utf-8'), drandClient);
  return { ciphertext, round };
}

async function tlockDecryptPin(ciphertext) {
  const buf = await timelockDecrypt(ciphertext, drandClient);
  return buf.toString('utf-8');
}

function describeDrandError(err) {
  const msg = (err && err.message) || String(err);
  if (/network|fetch|Failed to fetch|HTTP/i.test(msg)) {
    return 'No tengo internet. Conectate y volvé a intentar.';
  }
  if (/round|beacon|signature/i.test(msg)) {
    return 'Falta poquito para que se abra. Esperá unos segundos y reintentá.';
  }
  return 'Algo salió mal al abrir la caja. Probá de nuevo.';
}

/* =========================
   Render
   ========================= */
function renderPins() {
  const list = $('pin-list');
  const pins = loadPins().sort((a, b) => a.unlockAt - b.unlockAt);
  const now = Date.now();

  // Preserve which items are currently revealed so we don't wipe the value on tick re-render.
  const previouslyRevealed = new Map();
  list.querySelectorAll('.pin-item').forEach((node) => {
    const slot = node.querySelector('.pin-revealed');
    if (slot && !slot.hidden) {
      previouslyRevealed.set(node.dataset.id, node.querySelector('.pin-revealed-value').textContent);
    }
  });

  list.innerHTML = '';

  $('empty-state').hidden = pins.length > 0;
  $('export-btn').disabled = pins.length === 0;

  const badge = $('pin-count');
  badge.textContent = pins.length > 0 ? String(pins.length) : '';

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
      countdown.textContent = formatRemaining(p.unlockAt - now);
    }

    const revealBtn = node.querySelector('.action-reveal');
    const copyBtn = node.querySelector('.action-copy');
    revealBtn.disabled = !unlocked;
    copyBtn.disabled = !unlocked;

    // If this pin was being shown before re-render, restore it.
    if (previouslyRevealed.has(p.id)) {
      const slot = node.querySelector('.pin-revealed');
      slot.hidden = false;
      slot.querySelector('.pin-revealed-value').textContent = previouslyRevealed.get(p.id);
    }

    list.appendChild(node);
  }
}

/* =========================
   Export / Import
   ========================= */
function exportPins() {
  const pins = loadPins();
  if (pins.length === 0) {
    toast('No hay PINs para respaldar.');
    return;
  }
  const payload = {
    app: 'waittounlock',
    version: 2,
    exportedAt: Date.now(),
    pins,
  };
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
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { ok: false, error: 'El contenido no es un JSON válido.' };
  }

  let incoming;
  if (Array.isArray(parsed)) {
    incoming = parsed;
  } else if (parsed && Array.isArray(parsed.pins)) {
    incoming = parsed.pins;
  } else {
    return { ok: false, error: 'No encontré PINs en el archivo.' };
  }

  const valid = incoming.filter(
    (p) => p && typeof p.id === 'string' && typeof p.ciphertext === 'string' && Number.isFinite(p.unlockAt)
  );
  if (valid.length === 0) {
    return { ok: false, error: 'El archivo no tiene PINs con el formato correcto.' };
  }

  const existing = loadPins();
  const existingIds = new Set(existing.map((p) => p.id));

  let added = 0;
  let skipped = 0;
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

/* =========================
   Reveal lifecycle
   ========================= */
function scheduleAutoHide(itemEl, id) {
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

/* =========================
   Step indicator
   ========================= */
function setStep(n) {
  document.querySelectorAll('.stepper-item').forEach((el, i) => {
    el.classList.toggle('is-active', i === n - 1);
  });
}

/* =========================
   Preset chips
   ========================= */
function clearChipSelection() {
  document.querySelectorAll('.btn-chip').forEach((b) => b.classList.remove('is-selected'));
}

/* =========================
   Event handlers
   ========================= */
$('generate-btn').addEventListener('click', async () => {
  const length = parseInt($('pin-length').value, 10) || 4;
  const pin = generatePin(length);
  try {
    await copyToClipboard(pin);
  } catch {
    pendingPin = null;
    setStatus(
      'error',
      'No pude copiar al portapapeles. Probá de nuevo, o abrí la app desde una conexión segura (https).'
    );
    return;
  }
  pendingPin = { value: pin, length };
  setStatus(
    'success',
    `Listo. Tu PIN de ${length} dígitos está copiado y nadie lo vio (ni vos). Pegalo ahora en Tiempo en Pantalla.`
  );

  setStep(2);
  $('save-section').hidden = false;
  $('unlock-at').value = toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
  clearChipSelection();
  $('save-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.querySelectorAll('.btn-chip[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const ms = parseInt(btn.dataset.preset, 10);
    $('unlock-at').value = toLocalInput(new Date(Date.now() + ms));
    clearChipSelection();
    btn.classList.add('is-selected');
  });
});

$('unlock-at').addEventListener('input', clearChipSelection);

$('save-btn').addEventListener('click', async () => {
  if (!pendingPin) {
    setStatus('error', 'No hay un PIN pendiente. Creá uno primero.');
    return;
  }
  const unlockStr = $('unlock-at').value;
  if (!unlockStr) {
    toast('Elegí cuándo se abre la caja.');
    return;
  }
  const unlockAt = new Date(unlockStr).getTime();
  if (!Number.isFinite(unlockAt)) {
    toast('La fecha no es válida.');
    return;
  }
  if (unlockAt <= Date.now()) {
    toast('Elegí una fecha en el futuro.');
    return;
  }

  const saveBtn = $('save-btn');
  const originalText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Cerrando la caja...';

  let encrypted;
  try {
    encrypted = await tlockEncryptPin(pendingPin.value, unlockAt);
  } catch (err) {
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
    setStatus('error', describeDrandError(err));
    return;
  }

  const pins = loadPins();
  pins.push({
    id: newId(),
    label: $('pin-label').value.trim(),
    ciphertext: encrypted.ciphertext,
    round: encrypted.round,
    length: pendingPin.length,
    unlockAt,
    requireConfirm: $('require-confirm').checked,
    createdAt: Date.now(),
  });
  savePins(pins);

  pendingPin = null;
  $('save-section').hidden = true;
  $('pin-label').value = '';
  saveBtn.disabled = false;
  saveBtn.textContent = originalText;
  setStep(1);
  setStatus(
    'info',
    `Guardado. La caja se abre sola ${formatUnlockDate(unlockAt)}. Hasta entonces, ni vos podés mirar adentro. ` +
      `Asegurate de que ya pegaste el PIN en Tiempo en Pantalla.`
  );
  renderPins();
  toast('PIN guardado en la caja fuerte');
});

$('discard-btn').addEventListener('click', () => {
  pendingPin = null;
  $('save-section').hidden = true;
  $('pin-label').value = '';
  setStep(1);
  setStatus('info', 'Ok, no lo guardamos. Si ya lo pegaste en Tiempo en Pantalla, todo bien.');
});

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
    const ok = await confirmDialog('¿Borrar este PIN? No vas a poder recuperarlo después.');
    if (!ok) return;
    pins.splice(idx, 1);
    savePins(pins);
    clearAutoHide(id);
    renderPins();
    toast('PIN borrado');
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
    const originalText = btn.textContent;
    btn.textContent = 'Abriendo...';
    try {
      const pin = await tlockDecryptPin(p.ciphertext);
      slot.hidden = false;
      valueEl.textContent = pin;
      scheduleAutoHide(item, id);
    } catch (err) {
      toast(describeDrandError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    return;
  }

  if (btn.classList.contains('action-copy')) {
    if (p.requireConfirm) {
      const ok = await confirmDialog('Va a quedar copiado en el portapapeles. ¿Continuar?');
      if (!ok) return;
    }
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Abriendo...';
    try {
      const pin = await tlockDecryptPin(p.ciphertext);
      await copyToClipboard(pin);
      btn.textContent = 'Copiado';
      toast('PIN copiado al portapapeles');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1800);
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      toast(describeDrandError(err));
    }
  }
});

/* Export / Import */
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
  const extra = result.skipped > 0 ? ` Omitidos ${result.skipped} que ya tenías guardados.` : '';
  status.textContent = main + extra;
  renderPins();
  toast(main);
  setTimeout(() => $('import-dialog').close(), 1400);
});

$('import-cancel-btn').addEventListener('click', () => {
  $('import-dialog').close();
});

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

/* Initial render */
setInterval(renderPins, 1000);
renderPins();
