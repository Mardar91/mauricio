// Hojas inferiores (estilo iOS) y diálogos de confirmación.
import { h, nextId } from './dom.js';
import { icon } from './icons.js';

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

// openSheet({ title, subtitle, body: Node, footer: Node, onClose, className }) → { close, el, setTitle }
export function openSheet({ title = '', subtitle = '', body, footer, onClose, className = '', closeLabel = 'Cerrar' } = {}) {
  const prevFocus = document.activeElement;
  const titleId = nextId('sheet-title');
  const titleEl = h('h2', { class: 'sheet-title', id: titleId }, title);
  const subEl = h('p', { class: 'sheet-subtitle' }, subtitle);
  const closeBtn = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': closeLabel }, icon('close'));
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

  const api = {
    el: panel, body: content,
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
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      onClose?.(result);
    },
  };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
    else trapFocus(panel, e);
  };
  closeBtn.addEventListener('click', () => api.close());
  backdrop.addEventListener('click', () => api.close());
  document.addEventListener('keydown', onKey, true);
  dragToClose(header, panel, () => api.close());

  stack.push(api);
  root().append(wrap);
  lockScroll();
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    panel.focus({ preventScroll: true });
  });
  return api;
}

// Arrastrar la cabecera hacia abajo cierra la hoja
function dragToClose(handle, panel, close) {
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
    if (dy > 90) close();
    y0 = null;
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);
}

export function closeAllSheets() {
  for (const s of [...stack].reverse()) s.close();
}

export function sheetsOpen() {
  return stack.length;
}

// Diálogo de confirmación centrado → Promise<boolean>
export function confirmDialog({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false, icon: emoji } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const titleId = nextId('dlg');
    const okBtn = h('button', { class: ['btn', danger ? 'btn-danger' : 'btn-primary'], type: 'button' }, ok);
    const cancelBtn = cancel ? h('button', { class: 'btn btn-secondary', type: 'button' }, cancel) : null;
    const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      emoji ? h('div', { class: 'dialog-emoji', 'aria-hidden': 'true' }, emoji) : null,
      h('h2', { id: titleId, class: 'dialog-title' }, title),
      text ? (text instanceof Node ? h('div', { class: 'dialog-text' }, text) : h('p', { class: 'dialog-text' }, text)) : null,
      h('div', { class: 'dialog-actions' }, okBtn, cancelBtn));
    const wrap = h('div', { class: 'dialog-wrap' }, h('div', { class: 'backdrop' }), box);
    const api = { close: (v) => finish(v) };
    let done = false;
    function finish(v) {
      if (done) return;
      done = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
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
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn?.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKey, true);
    stack.push(api);
    root().append(wrap);
    lockScroll();
    requestAnimationFrame(() => { wrap.classList.add('open'); box.focus({ preventScroll: true }); });
  });
}

export function alertDialog(opts) {
  return confirmDialog({ ok: 'Entendido', cancel: null, ...opts });
}
