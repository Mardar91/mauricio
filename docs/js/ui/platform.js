// Plataforma (iPhone/iPad, Android u ordenador) y los textos que cambian según ella (SPEC §12).
import { isIOS } from './dom.js';

export function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}

// iPad: su Safari se presenta como un Mac, pero con pantalla táctil
export function isIPad() {
  const ua = navigator.userAgent || '';
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// 'ios' | 'android' | 'desktop' (el iPad cuenta como 'ios')
export function platform() {
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  return 'desktop';
}

// «iPhone» o «iPad» (solo tiene sentido en iOS)
export function appleDevice() {
  return isIPad() ? 'iPad' : 'iPhone';
}

// «este iPhone» / «este iPad» / «este teléfono» / «este dispositivo»
export function deviceWord() {
  const p = platform();
  return p === 'ios' ? appleDevice() : p === 'android' ? 'teléfono' : 'dispositivo';
}

// Título de la sección del calendario: «Calendario del iPhone» (o del iPad) solo en iOS
export function calendarTitle() {
  return platform() === 'ios' ? `Calendario del ${appleDevice()}` : 'Calendario del teléfono';
}

// El mismo calendario dentro de una frase: «… en el Calendario del iPhone» (nombre de la app de
// Apple) o «… en el calendario del teléfono»
export function calendarPhrase() {
  return platform() === 'ios' ? `Calendario del ${appleDevice()}` : 'calendario del teléfono';
}

// Texto del botón para suscribirse al calendario
export function subscribeLabel() {
  return platform() === 'ios' ? `Suscribirme en el ${appleDevice()}` : 'Ver mis turnos en el calendario';
}

// Consejos (core): en un iPad dicen «iPad» en vez de «iPhone»
export function forDevice(list) {
  if (!isIPad()) return list;
  const fix = (t) => (typeof t === 'string' ? t.replace(/iPhone/g, 'iPad') : t);
  return list.map((a) => ({ ...a, title: fix(a.title), text: fix(a.text) }));
}
