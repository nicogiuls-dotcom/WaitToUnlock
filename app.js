(() => {
  'use strict';

  const STORE_KEY = 'wtu.pins.v1';
  const $ = (id) => document.getElementById(id);

  let pendingPin = null;

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
    if (!ok) throw new Error('execCommand copy falló');
  }

  function obfuscate(plain) {
    const reversed = plain.split('').reverse().join('');
    return btoa(unescape(encodeURIComponent(reversed)));
  }

  function deobfuscate(enc) {
    const reversed = decodeURIComponent(escape(atob(enc)));
    return reversed.split('').reverse().join('');
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
    if (ms <= 0) return 'disponible';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `faltan ${d}d ${h}h ${m}m`;
    if (h > 0) return `faltan ${h}h ${m}m ${sec}s`;
    if (m > 0) return `faltan ${m}m ${sec}s`;
    return `faltan ${sec}s`;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString('es', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function setStatus(kind, msg) {
    const el = $('generate-status');
    el.className = `status ${kind}`;
    el.textContent = msg;
  }

  function renderPins() {
    const list = $('pin-list');
    const pins = loadPins().sort((a, b) => a.unlockAt - b.unlockAt);
    list.innerHTML = '';
    $('empty-state').hidden = pins.length > 0;
    $('bulk-actions').hidden = pins.length === 0;

    const tpl = $('pin-item-template');
    const now = Date.now();

    for (const p of pins) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = p.id;
      node.querySelector('.pin-label').textContent = p.label || 'Sin etiqueta';
      node.querySelector('.pin-length').textContent = `${p.length || 4} dígitos`;
      node.querySelector('.pin-unlock-at').textContent = `desbloqueo: ${formatDate(p.unlockAt)}`;

      const unlocked = now >= p.unlockAt;
      const statusEl = node.querySelector('.pin-status');
      if (unlocked) {
        statusEl.className = 'pin-status unlocked';
        statusEl.textContent = 'Disponible';
      } else {
        statusEl.className = 'pin-status locked';
        statusEl.textContent = `Bloqueado · ${formatRemaining(p.unlockAt - now)}`;
      }

      const revealBtn = node.querySelector('.action-reveal');
      const copyBtn = node.querySelector('.action-copy');
      revealBtn.disabled = !unlocked;
      copyBtn.disabled = !unlocked;

      list.appendChild(node);
    }
  }

  $('generate-btn').addEventListener('click', async () => {
    const length = parseInt($('pin-length').value, 10) || 4;
    const pin = generatePin(length);
    try {
      await copyToClipboard(pin);
    } catch (e) {
      pendingPin = null;
      setStatus('error', 'No pude copiar al portapapeles. Verificá los permisos del navegador o servila por HTTPS.');
      return;
    }
    pendingPin = { value: pin, length };
    setStatus(
      'success',
      `PIN de ${length} dígitos en el portapapeles. Pegalo en Configuración → Tiempo en Pantalla → Cambiar código. ` +
        `Si querés recuperarlo más tarde, guardalo bloqueado abajo. Si no, descartalo.`
    );

    $('save-section').hidden = false;
    $('unlock-at').value = toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
    $('save-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('.btn-chip[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ms = parseInt(btn.dataset.preset, 10);
      $('unlock-at').value = toLocalInput(new Date(Date.now() + ms));
    });
  });

  $('save-btn').addEventListener('click', () => {
    if (!pendingPin) {
      setStatus('error', 'No hay un PIN pendiente. Generá uno primero.');
      return;
    }
    const unlockStr = $('unlock-at').value;
    if (!unlockStr) {
      alert('Elegí cuándo se desbloquea (usá un atajo o la fecha exacta).');
      return;
    }
    const unlockAt = new Date(unlockStr).getTime();
    if (!Number.isFinite(unlockAt)) {
      alert('La fecha no es válida.');
      return;
    }
    if (unlockAt <= Date.now()) {
      alert('La fecha tiene que ser en el futuro.');
      return;
    }

    const pins = loadPins();
    pins.push({
      id: newId(),
      label: $('pin-label').value.trim(),
      enc: obfuscate(pendingPin.value),
      length: pendingPin.length,
      unlockAt,
      requireConfirm: $('require-confirm').checked,
      createdAt: Date.now(),
    });
    savePins(pins);

    pendingPin = null;
    $('save-section').hidden = true;
    $('pin-label').value = '';
    setStatus(
      'info',
      'PIN guardado bloqueado. Asegurate de haberlo pegado YA en Screen Time: este es tu único momento para usarlo antes del desbloqueo.'
    );
    renderPins();
  });

  $('discard-btn').addEventListener('click', () => {
    pendingPin = null;
    $('save-section').hidden = true;
    $('pin-label').value = '';
    setStatus('info', 'PIN descartado de esta sesión. Si ya lo pegaste en Screen Time, todo bien.');
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
      if (!confirm('¿Eliminar este PIN guardado? No vas a poder recuperarlo desde acá.')) return;
      pins.splice(idx, 1);
      savePins(pins);
      renderPins();
      return;
    }

    if (Date.now() < p.unlockAt) return;

    if (btn.classList.contains('action-reveal')) {
      if (p.requireConfirm && !confirm('Esto va a mostrar el PIN en pantalla. ¿Seguro?')) return;
      const slot = item.querySelector('.pin-revealed');
      slot.hidden = false;
      slot.textContent = deobfuscate(p.enc);
      return;
    }

    if (btn.classList.contains('action-copy')) {
      if (p.requireConfirm && !confirm('Esto va a copiar el PIN al portapapeles. ¿Seguro?')) return;
      try {
        await copyToClipboard(deobfuscate(p.enc));
        const original = btn.textContent;
        btn.textContent = 'Copiado';
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 1800);
      } catch {
        alert('No se pudo copiar al portapapeles.');
      }
    }
  });

  $('clear-clipboard-btn').addEventListener('click', async () => {
    try {
      await copyToClipboard(' ');
      setStatus('info', 'Portapapeles sobrescrito con un espacio en blanco.');
    } catch {
      setStatus('error', 'No se pudo limpiar el portapapeles.');
    }
  });

  setInterval(renderPins, 1000);
  renderPins();
})();
