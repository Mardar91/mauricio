// Enlace de configuración (#setup=…): confirmar y aplicar, o pegarlo a mano en la app instalada.
import { parseSetupLink, updateSettings } from '../core/index.js';
import { h, isIOS, isStandalone } from './dom.js';
import { icon } from './icons.js';
import { alertDialog, confirmDialog, openSheet } from './sheet.js';

// Pide confirmación y guarda la configuración de sincronización → true si se aplicó
export async function confirmAndApplySetup(ctx, sync) {
  const ok = await confirmDialog({
    icon: '🔗',
    title: 'Conectar el calendario del iPhone',
    text: `Este enlace conecta la app con GitHub (${sync.owner}/${sync.repo}) para que tus turnos aparezcan en el Calendario del iPhone con avisos. ¿Lo configuro?`,
    ok: 'Sí, configurar',
    cancel: 'Ahora no',
  });
  if (!ok) return false;
  ctx.store.set((s) => updateSettings(s, { sync: { ...sync, enabled: true, lastError: null, lastPushHash: null } }));
  ctx.toast('Calendario conectado. Enviando tus turnos…', { type: 'ok' });
  ctx.background?.syncNow({ manual: true });
  // En Safari (sin instalar) los datos no pasan a la app de la pantalla de inicio
  if (isIOS() && !isStandalone()) {
    await alertDialog({
      icon: '📲',
      title: 'Un detalle importante',
      text: 'Esto queda guardado en Safari. Si usas la app desde la pantalla de inicio, ábrela, ve a Ajustes → Calendario del iPhone → «Tengo un enlace de configuración» y pega allí el mismo enlace.',
    });
  }
  return true;
}

// Hoja para pegar el enlace (la app instalada en iOS no puede abrir enlaces directamente)
export function openPasteSetup(ctx) {
  const area = h('textarea', {
    class: 'input textarea input-mono', rows: '4', placeholder: 'https://…#setup=…', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': 'Enlace de configuración', 'data-testid': 'setup-paste',
  });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const pasteBtn = navigator.clipboard?.readText ? h('button', {
    class: 'btn btn-tinted btn-block', type: 'button',
    on: { click: async () => {
      try { area.value = (await navigator.clipboard.readText()).trim(); } catch { area.focus(); }
    } },
  }, icon('copy'), 'Pegar') : null;

  async function apply() {
    const sync = parseSetupLink(area.value.trim());
    if (!sync) {
      err.textContent = 'Ese enlace no sirve. Copia el enlace completo que te enviaron (empieza por https:// y lleva «#setup=»).';
      err.hidden = false;
      return;
    }
    sheet.close();
    await confirmAndApplySetup(ctx, sync);
  }

  const sheet = openSheet({
    title: 'Enlace de configuración',
    subtitle: 'Te lo envía quien te ayuda a configurar la app',
    body: h('div', { class: 'paste-setup' },
      h('ol', { class: 'steps' },
        h('li', {}, 'En el mensaje, mantén el dedo sobre el enlace y toca ', h('b', {}, '«Copiar»'), '.'),
        h('li', {}, 'Vuelve aquí y toca ', h('b', {}, '«Pegar»'), ' (o pégalo en el recuadro).'),
        h('li', {}, 'Toca ', h('b', {}, '«Configurar»'), '.')),
      pasteBtn, area, err),
    footer: h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: apply } }, 'Configurar'),
  });
  return sheet;
}
