// Iconos SVG en línea (24×24, trazo redondeado). Se tiñen con currentColor.
import { svg } from './dom.js';

const S = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

const P = {
  today: S('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>'),
  calendar: S('<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 2.8v3.4M16 2.8v3.4"/><path d="M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2"/>'),
  camera: S('<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-2h5.2l1.3 2h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.4" r="3.6"/>'),
  hours: S('<path d="M4 20V11M9.3 20V5M14.6 20v-7M20 20V8"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  chevronLeft: S('<path d="M15 5l-7 7 7 7"/>', 'stroke-width="2.4"'),
  chevronRight: S('<path d="M9 5l7 7-7 7"/>', 'stroke-width="2.4"'),
  chevronDown: S('<path d="M6 9l6 6 6-6"/>', 'stroke-width="2.2"'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2.4"'),
  plus: S('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.4"'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.6"'),
  share: S('<path d="M12 3.5v11M8 7l4-4 4 4"/><path d="M7.5 10.5H6.8A1.8 1.8 0 0 0 5 12.3v6.4a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8v-6.4a1.8 1.8 0 0 0-1.8-1.8h-.7"/>'),
  addSquare: S('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
  trash: S('<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>'),
  pencil: S('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  bell: S('<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  pin: S('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 1 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  note: S('<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h6M9 16h4"/>'),
  download: S('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>'),
  upload: S('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14"/>'),
  refresh: S('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4v5h-5"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  copy: S('<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  photos: S('<rect x="3.5" y="5" width="17" height="14" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M20.5 15.5l-4.5-4.5-8.5 8"/>'),
  sparkles: S('<path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  info: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'),
  warning: S('<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.3v.2"/>'),
  user: S('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  tag: S('<path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.3 6.3a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>'),
  phone: S('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  cloud: S('<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.6 1.5A3.8 3.8 0 0 1 17.5 18.5z"/>'),
  heart: S('<path d="M12 20s-7.5-4.5-7.5-10A4.2 4.2 0 0 1 12 7.4 4.2 4.2 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z"/>'),
  eye: S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: S('<path d="M3 3l18 18M10.6 6a9.6 9.6 0 0 1 1.4-.1C18 5.9 21.5 12 21.5 12a17 17 0 0 1-2.8 3.6M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1M9.9 10a3 3 0 0 0 4.1 4.1"/>'),
  more: S('<circle cx="12" cy="12" r="9"/><circle cx="7.8" cy="12" r="0.6" fill="currentColor"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/><circle cx="16.2" cy="12" r="0.6" fill="currentColor"/>', 'stroke-width="1.9"'),
  toggle: S('<rect x="2.5" y="6.5" width="19" height="11" rx="5.5" fill="#34C759" stroke="#34C759"/><circle cx="16" cy="12" r="4" fill="#fff" stroke="none"/>'),
  special: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/><path d="M19 3.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" fill="currentColor" stroke="none"/>'),
  help: S('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8v.4M12 16.8v.2"/>'),
};

export function icon(name, cls = 'icon') {
  return svg(P[name] || P.info, cls);
}

// Icono "Compartir" de iOS para las guías
export function shareIcon() {
  return icon('share', 'icon icon-inline ios-share');
}

// Botón «•••» de Safari (iOS 26) y el interruptor verde, para las guías
export function moreIcon() {
  return icon('more', 'icon icon-inline ios-more');
}

export function toggleIcon() {
  return icon('toggle', 'icon icon-inline ios-toggle');
}
