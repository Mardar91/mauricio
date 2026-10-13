// Utilidades mínimas de DOM: creación de elementos, formato y pequeñas ayudas.

// h('div', {class, text, on: {click}, attrs, dataset, style}, ...hijos)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'value') value = v; // se asigna después de añadir los hijos (select)
      else if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // solo con contenido propio (iconos SVG)
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) {
          if (val === undefined || val === null) continue;
          if (p.startsWith('--')) el.style.setProperty(p, val);
          else el.style[p] = val;
        }
      } else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Fragmento SVG de confianza (iconos propios)
export function svg(markup, cls = 'icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = markup;
  return span;
}

// Reemplaza los hijos ignorando null/false (replaceChildren pintaría "null")
export function setChildren(el, ...children) {
  clear(el);
  return append(el, children);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Número con coma decimal ('38,5')
export function fmtNum(n, max = 2) {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: max }).format(n);
}

// '38,5' o '38.5' → 38.5
export function parseNum(s) {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

// Texto relativo corto: 'hace 5 min', 'hace 2 h', 'ayer', '3 oct'
export function ago(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const min = Math.round((now - d) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(d);
}

// Fecha y hora cortas: '13 oct, 10:02'
export function dateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

// Texto oscuro o claro según el color de fondo
export function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#1F1F1F';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#1F1F1F' : '#FFFFFF';
}

// Descarga un archivo (o lo comparte en iOS si se puede)
export async function shareOrDownload(filename, text, type) {
  const file = typeof File === 'function' ? new File([text], filename, { type }) : null;
  try {
    if (file && navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return 'downloaded';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

// 30 → '30 min antes', 60 → '1 h antes', 90 → '1 h 30 min antes'
export function minutesText(m) {
  m = Number(m) || 0;
  if (m < 60) return `${m} min antes`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min antes` : `${m / 60} h antes`;
}

let uid = 0;
export const nextId = (p = 'id') => `${p}-${++uid}`;
