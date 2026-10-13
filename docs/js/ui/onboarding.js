// Bienvenida del primer uso (se puede saltar): bienvenida → instalar en iOS → recordatorios.
import { updateSettings } from '../core/index.js';
import { h, isIOS, isStandalone, minutesText, setChildren } from './dom.js';
import { icon, shareIcon } from './icons.js';

export function showOnboarding(ctx, { again = false } = {}) {
  if (document.querySelector('.onboarding')) return;
  const { store } = ctx;
  const steps = ['welcome'];
  if (isIOS() && !isStandalone()) steps.push('install');
  steps.push('reminders');
  let i = 0;
  const prevFocus = document.activeElement;

  const content = h('div', { class: 'ob-content', 'aria-live': 'polite' });
  const dots = h('div', { class: 'ob-dots', 'aria-hidden': 'true' });
  const nextBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: () => next() } });
  const skipBtn = h('button', { class: 'btn btn-plain ob-skip', type: 'button', on: { click: () => finish(false) } }, 'Saltar');
  const root = h('div', { class: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bienvenida', tabindex: '-1' },
    h('div', { class: 'ob-top' }, skipBtn),
    content,
    h('div', { class: 'ob-bottom' }, dots, nextBtn));

  function renderStep() {
    const step = steps[i];
    setChildren(dots, ...steps.map((_, j) => h('span', { class: ['ob-dot', j === i && 'on'] })));
    nextBtn.textContent = i === steps.length - 1 ? 'Empezar' : 'Siguiente';
    let body;
    if (step === 'welcome') {
      const name = store.get().settings.name || 'Mauricio';
      body = [
        h('div', { class: 'ob-art ob-art-icon', 'aria-hidden': 'true' }, h('img', { src: 'icons/icon.svg', alt: '', width: '112', height: '112' })),
        h('h1', { class: 'ob-title' }, `¡Hola, ${name}! 👋`),
        h('p', { class: 'ob-text' }, 'Esta app guarda tus turnos de trabajo para que no tengas que acordarte de todo.'),
        h('ul', { class: 'ob-list' },
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '📷'), h('span', {}, h('b', {}, 'Haz una foto'), ' de tu plan y la app lo lee.')),
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '🔔'), h('span', {}, h('b', {}, 'Te avisa'), ' la víspera y antes de cada turno.')),
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '⏱️'), h('span', {}, h('b', {}, 'Cuenta tus horas'), ' de la semana y del mes.'))),
      ];
    } else if (step === 'install') {
      body = [
        h('div', { class: 'ob-art', 'aria-hidden': 'true' }, '📲'),
        h('h1', { class: 'ob-title' }, 'Ponla en tu pantalla de inicio'),
        h('p', { class: 'ob-text' }, 'Así se abre como una app normal y tus datos quedan guardados.'),
        h('ol', { class: 'steps ob-steps' },
          h('li', {}, 'Toca el botón ', h('b', {}, 'Compartir'), ' ', shareIcon(), ' abajo en Safari.'),
          h('li', {}, 'Toca ', h('b', {}, '«Añadir a pantalla de inicio»'), ' ', icon('addSquare', 'icon icon-inline')),
          h('li', {}, 'Toca ', h('b', {}, '«Añadir»'), ' y abre la app desde el icono naranja.')),
        h('p', { class: 'ob-note' }, 'Hazlo antes de escanear: Safari y la app instalada guardan los datos por separado.'),
      ];
    } else {
      const r = store.get().settings.reminders;
      const eve = h('input', { type: 'checkbox', class: 'switch', checked: r.eveningBefore, 'aria-label': 'Aviso la víspera', on: { change: (e) => store.set((s) => updateSettings(s, { reminders: { eveningBefore: e.target.checked } })) } });
      const pre = h('input', { type: 'checkbox', class: 'switch', checked: r.beforeStart, 'aria-label': 'Aviso antes del turno', on: { change: (e) => store.set((s) => updateSettings(s, { reminders: { beforeStart: e.target.checked } })) } });
      body = [
        h('div', { class: 'ob-art', 'aria-hidden': 'true' }, '⏰'),
        h('h1', { class: 'ob-title' }, '¿Te aviso antes de trabajar?'),
        h('p', { class: 'ob-text' }, 'Elige cuándo quieres los avisos. Se pueden cambiar cuando quieras en Ajustes.'),
        h('div', { class: 'card set-card ob-card' },
          h('label', { class: 'set-row' }, h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, 'La víspera'), h('span', { class: 'set-sub' }, `A las ${r.eveningTime}`)), eve),
          h('label', { class: 'set-row' }, h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, 'Antes del turno'), h('span', { class: 'set-sub' }, minutesText(r.minutesBefore))), pre)),
        h('p', { class: 'ob-note' }, 'Para que los avisos lleguen al iPhone, conecta el Calendario del iPhone o ntfy en Ajustes (alguien te puede ayudar).'),
      ];
    }
    setChildren(content, h('div', { class: 'ob-step', dataset: { step } }, body));
    content.scrollTop = 0;
  }

  function next() {
    if (i < steps.length - 1) { i++; renderStep(); }
    else finish(true);
  }

  function finish(completed) {
    if (!store.get().settings.onboardingDone) store.set((s) => updateSettings(s, { onboardingDone: true }));
    root.classList.remove('open');
    document.documentElement.classList.remove('ob-open');
    setTimeout(() => root.remove(), 280);
    if (prevFocus?.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    if (completed && !again && !Object.keys(store.get().days).length) ctx.go('escanear');
  }

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
  renderStep();
  document.getElementById('overlays').append(root);
  document.documentElement.classList.add('ob-open');
  requestAnimationFrame(() => { root.classList.add('open'); root.focus({ preventScroll: true }); });
}
