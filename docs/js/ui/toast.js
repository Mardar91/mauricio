// Avisos breves dentro de la app (arriba), con acción opcional ("Deshacer", "Actualizar").
import { h } from './dom.js';

// toast(texto, { type: 'ok'|'error'|'info', action: {label, run}, duration })
export function toast(text, { type = 'info', action, duration } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return { close() {} };
  const ms = duration ?? (action ? 6000 : type === 'error' ? 5000 : 3200);
  const emoji = type === 'ok' ? '✅' : type === 'error' ? '⚠️' : null;
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  };
  const btn = action ? h('button', { class: 'toast-action', type: 'button', on: { click: () => { close(); action.run(); } } }, action.label) : null;
  const el = h('div', { class: ['toast', `toast-${type}`], role: type === 'error' ? 'alert' : 'status' },
    emoji ? h('span', { class: 'toast-emoji', 'aria-hidden': 'true' }, emoji) : null,
    h('span', { class: 'toast-text' }, text),
    btn);
  el.addEventListener('click', (e) => { if (!e.target.closest('.toast-action')) close(); });
  // Máximo 3 a la vez
  while (host.children.length >= 3) host.firstElementChild.remove();
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (ms > 0) timer = setTimeout(close, ms);
  return { close };
}
