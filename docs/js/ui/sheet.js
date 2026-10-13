// Hojas inferiores (estilo iOS) y diálogos de confirmación.
import { h, nextId } from './dom.js';
import { icon } from './icons.js';
import { onBack } from './back.js';

const stack = [];
const root = () => document.getElementById('overlays') || document.body;

function lockScroll() {
  document.documentElement.classList.toggle('locked', stack.length > 0);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(panel, e) {
  if (e.key !== 'Tab') return;
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// openSheet({ title, subtitle, body, footer, onClose, className, isDirty, dirtyText }) → { close, requestClose, el, body, setTitle }
// isDirty(): si devuelve true, cerrar tocando fuera, deslizando o con ✕ pide confirmación.
// close() (programático, p. ej. tras guardar) cierra siempre.
export function openSheet({
  title = '', subtitle = '', body, footer, onClose, className = '', closeLabel = 'Cerrar', isDirty = null,
  dirtyText = 'Los cambios que hiciste aquí no se guardarán.',
} = {}) {
  const prevFocus = document.activeElement;
  const titleId = nextId('sheet-title');
  const titleEl = h('h2', { class: 'sheet-title', id: titleId }, title);
  const subEl = h('p', { class: 'sheet-subtitle' }, subtitle);
  const closeBtn = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': closeLabel }, h('span', { class: 'sheet-close-disc' }, icon('close')));
  const header = h('header', { class: 'sheet-header' },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head-row' }, h('div', { class: 'sheet-titles' }, titleEl, subtitle ? subEl : null), closeBtn));
  const content = h('div', { class: 'sheet-body' }, body);
  const foot = footer ? h('footer', { class: 'sheet-footer' }, footer) : null;
  const panel = h('div', { class: ['sheet', className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    header, content, foot);
  const backdrop = h('div', { class: 'backdrop' });
  const wrap = h('div', { class: 'sheet-wrap' }, backdrop, panel);
  let closed = false;
  let asking = false;
  let offBack = null;

  const api = {
    el: panel, body: content,
    get closed() { return closed; },
    setTitle(t, s) {
      titleEl.textContent = t;
      if (s !== undefined) {
        subEl.textContent = s;
        if (s && !subEl.parentNode) titleEl.after(subEl);
      }
    },
    close(result) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      wrap.classList.remove('open');
      wrap.classList.add('closing');
      lockScroll();
      const done = () => wrap.remove();
      panel.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 380);
      document.removeEventListener('keydown', onKey, true);
      offBack?.();
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      onClose?.(result);
    },
    // Cierre pedido por el usuario (fuera, ✕, Escape, deslizar): pregunta si hay cambios sin guardar
    async requestClose() {
      if (closed || asking) return false;
      if (isDirty && isDirty()) {
        asking = true;
        const ok = await confirmDialog({
          title: '¿Salir sin guardar?', text: dirtyText, ok: 'Salir sin guardar', cancel: 'Seguir editando', danger: true,
        });
        asking = false;
        if (!ok) return false;
      }
      api.close();
      return true;
    },
  };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); api.requestClose(); }
    else trapFocus(panel, e);
  };
  closeBtn.addEventListener('click', () => api.requestClose());
  backdrop.addEventListener('click', () => api.requestClose());
  document.addEventListener('keydown', onKey, true);
  dragToClose(header, panel, () => api.requestClose());

  stack.push(api);
  offBack = onBack(() => api.requestClose());
  root().append(wrap);
  lockScroll();
  requestAnimationFrame(() => {
    if (closed) return; // se cerró antes del primer fotograma
    wrap.classList.add('open');
    panel.focus({ preventScroll: true });
  });
  return api;
}

// Arrastrar la cabecera hacia abajo cierra la hoja (si hay cambios, pregunta y vuelve a su sitio)
function dragToClose(handle, panel, requestClose) {
  let y0 = null, dy = 0;
  handle.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    y0 = e.touches[0].clientY; dy = 0;
    panel.style.transition = 'none';
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const end = () => {
    if (y0 === null) return;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 90) requestClose();
    y0 = null;
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);
}

// Cierra todas las hojas (sin preguntar: solo para cambios de pantalla hechos por la app)
export function closeAllSheets() {
  for (const s of [...stack].reverse()) s.close();
}

export function sheetsOpen() {
  return stack.length;
}

// Diálogo de confirmación centrado → Promise<boolean>
// onOk: se ejecuta dentro del mismo toque (p. ej. copiar al portapapeles en iOS)
// prefer: 'cancel' → lo recomendado es NO hacerlo: «cancelar» va primero y destacado (y «ok» discreto)
export function confirmDialog({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false, icon: emoji, onOk, className = '', prefer = 'ok' } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const titleId = nextId('dlg');
    const safe = prefer === 'cancel' && Boolean(cancel);
    const okBtn = h('button', { class: ['btn', safe ? 'btn-secondary' : danger ? 'btn-danger' : 'btn-primary'], type: 'button', 'data-role': 'ok' }, ok);
    const cancelBtn = cancel ? h('button', { class: ['btn', safe ? 'btn-primary' : 'btn-secondary'], type: 'button', 'data-role': 'cancel' }, cancel) : null;
    const box = h('div', { class: ['dialog', className, safe && 'dialog-safe'], role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      emoji ? h('div', { class: 'dialog-emoji', 'aria-hidden': 'true' }, emoji) : null,
      h('h2', { id: titleId, class: 'dialog-title' }, title),
      text ? (text instanceof Node ? h('div', { class: 'dialog-text' }, text) : h('p', { class: 'dialog-text' }, text)) : null,
      h('div', { class: 'dialog-actions' }, safe ? cancelBtn : okBtn, safe ? okBtn : cancelBtn));
    const wrap = h('div', { class: 'dialog-wrap' }, h('div', { class: 'backdrop' }), box);
    const api = { close: (v) => finish(v) };
    let done = false;
    let offBack = null;
    function finish(v) {
      if (done) return;
      done = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      offBack?.();
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.remove('open');
      lockScroll();
      setTimeout(() => wrap.remove(), 200);
      if (prevFocus?.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      resolve(v);
    }
    const onKey = (e) => {
      if (stack[stack.length - 1] !== api) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else trapFocus(box, e);
    };
    okBtn.addEventListener('click', () => {
      try { onOk?.(); } catch (e) { console.warn(e); }
      finish(true);
    });
    cancelBtn?.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKey, true);
    stack.push(api);
    offBack = onBack(() => finish(false));
    root().append(wrap);
    lockScroll();
    // Si se cerró antes del primer fotograma (respuesta muy rápida), no se vuelve a abrir
    requestAnimationFrame(() => { if (done) return; wrap.classList.add('open'); box.focus({ preventScroll: true }); });
  });
}

export function alertDialog(opts) {
  return confirmDialog({ ok: 'Entendido', cancel: null, ...opts });
}

// Aviso de espera que no se puede cerrar («Conectando…») → { setText, close }
export function busyDialog(text) {
  const label = h('p', { class: 'busy-text', 'aria-live': 'polite' }, text);
  const box = h('div', { class: 'dialog dialog-busy', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': text, tabindex: '-1' },
    h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }), label);
  const wrap = h('div', { class: 'dialog-wrap' }, h('div', { class: 'backdrop' }), box);
  const api = { close: () => {} };
  let done = false;
  stack.push(api);
  const offBack = onBack(() => {});
  root().append(wrap);
  lockScroll();
  requestAnimationFrame(() => { if (done) return; wrap.classList.add('open'); box.focus({ preventScroll: true }); });
  api.close = () => {
    if (done) return;
    done = true;
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    offBack();
    wrap.classList.remove('open');
    lockScroll();
    setTimeout(() => wrap.remove(), 200);
  };
  return { setText: (t) => { label.textContent = t; }, close: () => api.close() };
}
