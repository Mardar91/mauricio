// Bienvenida del primer uso (se puede saltar): bienvenida → tu nombre → instalar (iPhone en Safari o
// Android en Chrome) → avisos. «Atrás» (Android) vuelve un paso; en el primero, cierra.
import { cleanPersonName, suggestPlanName, updateSettings } from '../core/index.js';
import { h, isStandalone, minutesText, nextId, setChildren } from './dom.js';
import { androidInstallSteps, installButton, installSteps, onInstallChange } from './install.js';
import { onBack } from './back.js';
import { appleDevice, calendarTitle, platform } from './platform.js';

export function showOnboarding(ctx, { again = false } = {}) {
  if (document.querySelector('.onboarding')) return;
  const { store } = ctx;
  const plat = platform();
  const inSafari = plat === 'ios' && !isStandalone();
  const inChrome = plat === 'android' && !isStandalone();
  const steps = ['welcome', 'name'];
  if (inSafari || inChrome) steps.push('install');
  steps.push('reminders');
  let i = 0;
  const prevFocus = document.activeElement;

  // Nombre y nombre del plan: se guardan al seguir (o al saltar)
  const st0 = store.get().settings;
  const fid = nextId('ob');
  const nameInput = h('input', {
    class: 'input', id: `${fid}-name`, value: st0.name || '', maxlength: '60', autocomplete: 'given-name', autocapitalize: 'words',
    placeholder: 'Ej.: Ana', 'data-testid': 'ob-name', enterkeyhint: 'next',
  });
  const planInput = h('input', {
    class: 'input', id: `${fid}-plan`, value: st0.planName || '', maxlength: '60', autocomplete: 'off', autocapitalize: 'words',
    spellcheck: 'false', 'data-testid': 'ob-plan-name', enterkeyhint: 'done',
  });
  const planHint = h('p', { class: 'hint' });
  const updatePlanHint = () => {
    const sug = suggestPlanName({ settings: { name: nameInput.value, planName: '' } });
    planInput.placeholder = sug ? `Ej.: ${sug}` : 'Ej.: Ducuara Ana';
    planHint.textContent = 'Tal como aparece en la hoja del PC (apellido y nombre). Si no lo sabes, déjalo vacío.';
  };
  nameInput.addEventListener('input', updatePlanHint);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); planInput.focus(); } });
  planInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
  updatePlanHint();
  let namesTouched = false;
  nameInput.addEventListener('input', () => { namesTouched = true; });
  planInput.addEventListener('input', () => { namesTouched = true; });

  function saveNames() {
    if (!namesTouched) return;
    const name = cleanPersonName(nameInput.value);
    const planName = cleanPersonName(planInput.value);
    const s = store.get().settings;
    if (name !== (s.name || '') || planName !== (s.planName || '')) store.set((st) => updateSettings(st, { name, planName }));
  }

  const content = h('div', { class: 'ob-content', 'aria-live': 'polite' });
  const dots = h('div', { class: 'ob-dots', 'aria-hidden': 'true' });
  const nextBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'ob-next', on: { click: () => next() } });
  const skipBtn = h('button', { class: 'btn btn-plain ob-skip', type: 'button', on: { click: () => finish(false) } }, 'Saltar');
  const root = h('div', { class: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bienvenida', tabindex: '-1' },
    h('div', { class: 'ob-top' }, skipBtn),
    content,
    h('div', { class: 'ob-bottom' }, dots, nextBtn));

  function renderStep() {
    const step = steps[i];
    setChildren(dots, ...steps.map((_, j) => h('span', { class: ['ob-dot', j === i && 'on'] })));
    nextBtn.textContent = i === steps.length - 1 ? 'Empezar' : 'Siguiente';
    nextBtn.className = 'btn btn-primary btn-lg btn-block';
    let body;
    if (step === 'welcome') {
      const name = cleanPersonName(store.get().settings.name).split(' ')[0];
      body = [
        h('div', { class: 'ob-art ob-art-icon', 'aria-hidden': 'true' }, h('img', { src: 'icons/icon.svg', alt: '', width: '112', height: '112' })),
        h('h1', { class: 'ob-title' }, name ? `¡Hola, ${name}! 👋` : '¡Hola! 👋'),
        h('p', { class: 'ob-text' }, 'Esta app guarda tus turnos de trabajo para que no tengas que acordarte de todo.'),
        h('ul', { class: 'ob-list' },
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '📷'), h('span', {}, h('b', {}, 'Toma una foto'), ' de tu plan y la app lo lee.')),
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '🔔'), h('span', {}, h('b', {}, 'Te avisa'), ' la noche antes y antes de cada turno.')),
          h('li', {}, h('span', { 'aria-hidden': 'true' }, '⏱️'), h('span', {}, h('b', {}, 'Cuenta tus horas'), ' de la semana y del mes.'))),
      ];
    } else if (step === 'name') {
      body = [
        h('div', { class: 'ob-art', 'aria-hidden': 'true' }, '🙂'),
        h('h1', { class: 'ob-title' }, '¿Cómo te llamas?'),
        h('p', { class: 'ob-text' }, 'Para saludarte y encontrar tus turnos en el plan.'),
        h('div', { class: 'card ob-form' },
          h('div', { class: 'field' }, h('label', { class: 'label', for: nameInput.id }, 'Tu nombre'), nameInput),
          h('div', { class: 'field' }, h('label', { class: 'label', for: planInput.id }, '¿Cómo sale tu nombre en el plan?'), planInput, planHint)),
        h('p', { class: 'ob-note' }, 'Puedes dejarlo para después: se cambia en Ajustes → «Tu nombre».'),
      ];
    } else if (step === 'install' && inSafari) {
      body = [
        h('div', { class: 'ob-art', 'aria-hidden': 'true' }, '📲'),
        h('h1', { class: 'ob-title' }, 'Ponla en tu pantalla de inicio'),
        h('p', { class: 'ob-text' }, 'Así se abre como una app normal y tus datos no se borran.'),
        h('div', { class: 'ob-steps' }, installSteps({ compact: true })),
        h('p', { class: 'ob-note' }, 'Hazlo antes de escanear: Safari y la app instalada guardan los datos por separado.'),
      ];
    } else if (step === 'install') {
      // Con el aviso de Chrome, «Instalar la app» es la acción principal y «Siguiente» pasa a «Ahora no»
      const btn = installButton({ cls: 'btn-primary btn-lg btn-block', onDone: (ok) => { if (ok) next(); } });
      if (btn) {
        nextBtn.textContent = 'Ahora no';
        nextBtn.className = 'btn btn-secondary btn-lg btn-block';
      }
      body = [
        h('div', { class: 'ob-art ob-art-sm', 'aria-hidden': 'true' }, '📲'),
        h('h1', { class: 'ob-title' }, 'Ponla en tu pantalla de inicio'),
        h('p', { class: 'ob-text' }, 'Así la abres con un toque, como cualquier app. Tus turnos son los mismos en Chrome y en la app.'),
        btn,
        h('div', { class: 'ob-steps' }, btn ? h('p', { class: 'hint ob-steps-intro' }, 'O desde el menú de Chrome:') : null, androidInstallSteps({ compact: true })),
      ];
    } else {
      const r = store.get().settings.reminders;
      const title = calendarTitle();
      body = [
        h('div', { class: 'ob-art', 'aria-hidden': 'true' }, '⏰'),
        h('h1', { class: 'ob-title' }, 'Avisos antes de trabajar'),
        h('p', { class: 'ob-text' }, plat === 'ios' ? `Los avisos llegan por la app Calendario del ${appleDevice()}:` : 'Los avisos llegan por el calendario del teléfono:'),
        h('div', { class: 'card ob-card' },
          h('div', { class: 'ob-fact' }, h('span', { 'aria-hidden': 'true' }, '🌙'), h('span', {}, h('b', {}, 'La noche antes'), ` · a las ${r.eveningTime}`)),
          h('div', { class: 'ob-fact' }, h('span', { 'aria-hidden': 'true' }, '⏰'), h('span', {}, h('b', {}, 'Antes del turno'), ` · ${minutesText(r.minutesBefore)}`)),
          r.planUpload !== false ? h('div', { class: 'ob-fact' }, h('span', { 'aria-hidden': 'true' }, '📷'), h('span', {}, h('b', {}, 'Subir el plan'), ' · el día 20, si falta el del mes siguiente')) : null),
        h('p', { class: 'ob-note' }, `Para activarlos, quien te ayuda te enviará un enlace. Cuando lo tengas: Ajustes → ${title} → «Tengo un enlace».`),
      ];
    }
    setChildren(content, h('div', { class: 'ob-step', dataset: { step } }, body));
    content.scrollTop = 0;
  }

  function next() {
    if (steps[i] === 'name') saveNames();
    if (i < steps.length - 1) { i++; renderStep(); }
    else finish(true);
  }

  // «Atrás»: un paso atrás; en el primero, cerrar (como «Saltar»)
  function back() {
    if (i > 0) { if (steps[i] === 'name') saveNames(); i--; renderStep(); }
    else finish(false);
  }
  const offBack = onBack(back);
  const unsubInstall = onInstallChange(() => { if (steps[i] === 'install') renderStep(); });

  let finished = false;
  function finish(completed) {
    if (finished) return;
    finished = true;
    saveNames();
    offBack();
    unsubInstall();
    if (!store.get().settings.onboardingDone) store.set((s) => updateSettings(s, { onboardingDone: true }));
    root.classList.remove('open');
    document.documentElement.classList.remove('ob-open');
    setTimeout(() => root.remove(), 280);
    if (prevFocus?.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    ctx.repaint?.(); // el saludo de Hoy con el nombre nuevo
    // En Safari (sin instalar) no se lleva a escanear: lo escaneado se quedaría en Safari
    if (completed && !again && !inSafari && !Object.keys(store.get().days).length) ctx.go('escanear');
  }

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
  renderStep();
  document.getElementById('overlays').append(root);
  document.documentElement.classList.add('ob-open');
  requestAnimationFrame(() => { root.classList.add('open'); root.focus({ preventScroll: true }); });
}
