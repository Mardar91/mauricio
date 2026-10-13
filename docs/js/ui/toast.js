// Avisos breves dentro de la app (abajo), con acción opcional ("Deshacer", "Actualizar").
import { h } from './dom.js';

// toast(texto, { type: 'ok'|'error'|'info', action: {label, run}, duration, onClose })
// duration 0 = se queda hasta que se toque. onClose(reason): 'action' | 'dismiss' | 'timeout' | 'evicted'
export function toast(text, { type = 'info', action, duration, onClose } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return { close() {} };
  const ms = duration ?? (action ? 6000 : type === 'error' ? 5000 : 3200);
  const emoji = type === 'ok' ? '✅' : type === 'error' ? '⚠️' : null;
  let timer;
  let closed = false;
  const close = (reason = 'dismiss') => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('toast-leaving');
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
    try { onClose?.(reason); } catch (e) { console.error(e); }
  };
  const btn = action ? h('button', { class: 'toast-action', type: 'button', on: { click: () => { close('action'); action.run(); } } }, action.label) : null;
  const el = h('div', { class: ['toast', `toast-${type}`, ms === 0 && 'toast-sticky'], role: type === 'error' ? 'alert' : 'status' },
    emoji ? h('span', { class: 'toast-emoji', 'aria-hidden': 'true' }, emoji) : null,
    h('span', { class: 'toast-text' }, text),
    btn);
  el.__close = close;
  el.addEventListener('click', (e) => { if (!e.target.closest('.toast-action')) close('dismiss'); });
  // Máximo 3 a la vez: se van los más viejos, pero nunca los que esperan una acción (duración 0)
  const live = () => [...host.children].filter((c) => !c.classList.contains('toast-leaving'));
  while (live().length >= 3) {
    const old = live().find((c) => !c.classList.contains('toast-sticky')) || live()[0];
    if (old.__close) old.__close('evicted'); else old.remove();
  }
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (ms > 0) timer = setTimeout(() => close('timeout'), ms);
  return { close: () => close('dismiss'), el };
}
