// Botón o gesto «Atrás» (Android, navegador): cierra la hoja o el diálogo de arriba en lugar de salir
// de la app. Mientras haya algo abierto hay una entrada propia en el historial (history.pushState);
// al cerrarlo todo desde la app se quita (history.back), y al pulsar «Atrás» se cierra lo de arriba.
const handlers = [];
let guarded = false; // hay una entrada nuestra encima de la página
let ignorePops = 0;  // popstate provocados por nuestro history.back()
let releaseTimer = null;

function ensureGuard() {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  if (guarded) return;
  try {
    history.pushState({ ...(history.state || {}), turnosBack: true }, '');
    guarded = true;
  } catch { /* sin historial (iframe raro): no pasa nada */ }
}

// Al quedar todo cerrado: quitar la entrada (con un pequeño margen por si se abre otra cosa enseguida)
function scheduleRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (handlers.length || !guarded) return;
    guarded = false;
    if (history.state?.turnosBack) {
      ignorePops++;
      history.back();
    }
  }, 40);
}

// Registra lo que hace «Atrás» con esto abierto → función para quitarlo (al cerrarse)
export function onBack(fn) {
  const entry = { fn };
  handlers.push(entry);
  ensureGuard();
  return () => {
    const i = handlers.indexOf(entry);
    if (i < 0) return;
    handlers.splice(i, 1);
    if (!handlers.length) scheduleRelease();
  };
}

window.addEventListener('popstate', () => {
  if (ignorePops) { ignorePops--; return; }
  if (!guarded) return; // navegación normal: nada abierto
  guarded = false;      // «Atrás» ya consumió nuestra entrada
  const top = handlers[handlers.length - 1];
  try { top?.fn(); } catch (e) { console.error(e); }
  // Si sigue habiendo algo abierto (no se pudo cerrar, o pregunta «¿Salir sin guardar?»), otra entrada
  setTimeout(() => { if (handlers.length) ensureGuard(); }, 0);
});
