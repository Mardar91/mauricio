# Turnos de Mauricio — especificación técnica

PWA (web app instalable) para que **Mauricio** (enfermero/cuidador, *Pflegekraft* en Unionhilfswerk Pflegedienst Neukölln, Berlín) registre sus turnos de trabajo **fotografiando el plan de turnos** (app "Dienstplan" de euregon, o la impresión mensual en el PC), reciba **recordatorios**, vea las **horas trabajadas por semana/mes** con **consejos**, y pueda **cambiar turnos a mano**.

- Usuario final: Mauricio, **iPhone** (Safari / app en pantalla de inicio), poco experto en tecnología → todo muy claro, botones grandes, cero jerga.
- Idioma de la interfaz: **español** (neutro, tuteo: "tú").
- Zona horaria: Europe/Berlin. Semanas de **lunes a domingo**.
- Sin servidor propio y sin cuentas nuevas: hosting estático en **GitHub Pages** (carpeta `docs/`), datos en el teléfono (`localStorage`), sincronización opcional con GitHub (token personal) y notificaciones opcionales con ntfy.sh.
- Sin paso de build, sin frameworks, sin CDNs en tiempo de ejecución: **HTML + CSS + JavaScript (módulos ES) puros**, todo servido desde `docs/`. Debe funcionar offline después de la primera carga.
- Comentarios en el código: breves, en español.

## 1. Estructura del repositorio

```
docs/                       ← lo que publica GitHub Pages (raíz de la app)
  index.html
  manifest.webmanifest
  sw.js                     ← service worker (offline + actualización)
  .nojekyll
  icons/                    ← icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png (180)
  css/app.css
  js/app.js                 ← entrada de la UI
  js/ui/*.js                ← vistas y componentes de UI
  js/core/*.js              ← lógica pura (sin DOM al importar), testeada con node --test
  js/recognize/index.js     ← reconocimiento de fotos: export async function recognize(input, options)
  vendor/tesseract/         ← tesseract.js 7.0.0 auto-alojado (OCR en el navegador)
    tesseract.min.js  worker.min.js  core/*.wasm.js  lang/best_int/eng.traineddata.gz  lang/legacy/eng.traineddata.gz
test/
  fotos/*.jpg               ← fotos reales de los planes (ver test/lab/ground-truth.json)
  lab/ground-truth.json     ← verdad de referencia por foto
  lab/eval.mjs              ← evalúa un reconocedor en Chromium: node test/lab/eval.mjs --impl <ruta>
  lab/harness.html
  lab/approaches/<nombre>/  ← prototipos de reconocedores
  unit/*.test.mjs           ← tests de js/core (node --test)
  e2e/                      ← tests de UI con Playwright (viewport iPhone)
  tools/serve.mjs           ← servidor estático (raíz del repo). npm run serve → http://localhost:8080/docs/
package.json                ← solo devDependencies (playwright). Chromium ya instalado en /opt/pw-browsers.
```

Comandos: `npm test` (unit), `npm run eval -- --impl docs/js/recognize/index.js`, `npm run e2e`, `npm run serve`.

## 2. Lo que se ve en las fotos (dominio)

App "Dienstplan" (lista vertical, cabecera naranja con "Dienstplan" y "<Monat> <Jahr>" en alemán, p. ej. "Oktober 2026"). Una fila por día: número de día (2 dígitos) encima de la abreviatura alemana del día (Mo Di Mi Do Fr Sa So); sábados/domingos con fondo gris y número rojo. A la derecha, 0-3 "insignias":

| Código | Aspecto | Significado | Horario (confirmado por el usuario) |
|---|---|---|---|
| F1 | círculo amarillo | Turno de mañana (Frühdienst) | 06:00–15:00 |
| F2, F3, F6, F8 | círculo amarillo | Mañana, variantes | desconocido → por defecto 06:00–15:00 **sin confirmar**, editable |
| S1 | círculo verde | Turno de tarde (Spätdienst) | 13:30–22:00 |
| N1 | círculo azul (texto blanco) | Turno de noche (Nachtdienst) | 22:00–06:00 (termina el día siguiente) |
| Z1 | círculo rosa claro | Turno intermedio (Zwischendienst) | 09:30–18:00 |
| F51, F52, F53, S51, S52, N51 | círculo magenta (2ª insignia) | **Lugar / ruta** donde trabaja ese día (no son horas extra) | – |
| S31 | círculo rojo | Otro lugar | – |
| TS | hexágono azul | Reunión de equipo (Teamsitzung) | sin horario por defecto, editable |
| W- | etiqueta/flecha rosa con texto "W-" | Libre deseado (Wunschfrei) | – |
| U | letra "U" roja, sin fondo | Vacaciones (Urlaub) | cuenta como horas acreditadas |
| - | guion rojo corto | Libre | – |
| (vacío) | fila sin nada | nada planificado | – |

La impresión del PC ("Dienstplan Juni 2026", tabla mensual de euregon): columnas = días (cabecera con día de semana + número), fila del empleado "Ducuara Mauricio" con 3 sub-líneas: guiones de libres, insignias de turno (+ W-/U), insignias de lugar. A la derecha "Soll" (horas objetivo del mes, p. ej. 154,00) e "Ist".

Contrato: **35 h/semana** → 7 h por día laborable (lun–vie). Soll mensual = días laborables (lun–vie, menos festivos de Berlín) × 7 h.

Pausa: el usuario no la confirmó → por defecto **30 min** en turnos de más de 6 h (editable por código).

## 3. Modelo de datos (localStorage, clave `turnos-mauricio:v1`)

```js
State = {
  schema: 1,
  settings: {
    name: 'Mauricio',
    weeklyHours: 35,
    workDaysPerWeek: 5,                 // Soll diario = weeklyHours / workDaysPerWeek
    holidaysReduceSoll: true,           // festivos de Berlín (lun–vie) reducen el Soll
    reminders: { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 60 },
    sync: { enabled: false, owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: '', lastPushAt: null, lastPushHash: null, lastError: null },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', scheduled: {} /* seqId -> {at, hash} */, lastRunAt: null, lastError: null },
    onboardingDone: false,
  },
  codes: { [code: string]: CodeDef },
  days: { ['YYYY-MM-DD']: DayEntry },
  scans: [ { at: ISO, layout, month, year, daysFound } ],          // últimos 30
  changes: [ { at: ISO, dayKey, before: string[], after: string[], source: 'scan'|'manual'|'import' } ], // últimos 300
}

CodeDef = {
  code: 'F1',
  kind: 'shift' | 'place' | 'event' | 'off' | 'wish' | 'vacation' | 'sick' | 'other',
  name: 'Mañana',                 // etiqueta en español
  start: '06:00' | null,          // HH:MM; si end <= start el turno termina al día siguiente
  end: '15:00' | null,
  breakMin: 30,                   // minutos de pausa no pagada
  countsHours: true,              // shift: true; place/off/wish: false; event: false salvo que tenga horario y el usuario lo active
  creditHours: null,              // vacation/sick: horas acreditadas por día (null → Soll diario)
  color: '#F2E500', textColor: '#1F1F1F',
  shape: 'circle' | 'hexagon' | 'tag' | 'text',   // como en la app original (U y - son 'text')
  place: '',                      // dirección/nombre del lugar (sobre todo kind 'place')
  confirmed: true,                // false → horario supuesto; la UI pide confirmarlo
  builtin: true,
}

DayEntry = { codes: string[], note: '', source: 'scan'|'manual'|'import', updatedAt: ISO }
```
- Día sin entrada = desconocido (no hay plan). `codes: []` = plan cargado pero vacío. `['-']` = libre.
- Orden de códigos en un día: turno(s), evento(s), lugar(es) — normalizar al guardar.
- Código desconocido encontrado al escanear (p. ej. "F4", "S2", "F54"): crear `CodeDef` automáticamente por analogía (letra F/S/N/Z + 1 dígito → turno con el horario de F1/S1/N1/Z1 y `confirmed:false`; letra + 2 dígitos → lugar), y la UI avisa "Código nuevo: confirma su horario".

## 4. API de `docs/js/core/` (módulos ES puros; sin DOM al importar; testeables en Node con `TZ=Europe/Berlin`)

Todas las funciones reciben el `state` explícitamente (sin estado global), salvo `store.js`.

**dates.js**
- `toKey(date) → 'YYYY-MM-DD'` (fecha local); `fromKey(key) → Date` (00:00 local); `addDays(key, n) → key`
- `weekStart(key) → key` (lunes); `isoWeek(key) → number`; `monthKeys(year, month1) → key[]`
- `weekdayShort(key) → 'lun'…`; `formatLong(key) → 'martes, 13 de octubre'`; `formatShort(key) → 'mar 13 oct'`
- `formatHours(minutes) → '36 h 30'` / `'8 h'` / `'0 h'` (negativos con '−')
- `parseHHMM('06:00') → 360`; `berlinHolidays(year) → Set<key>` (Neujahr, Frauentag 8/3, Karfreitag, Ostermontag, 1/5, Himmelfahrt, Pfingstmontag, 3/10, 25/12, 26/12)

**codes.js**
- `DEFAULT_CODES: Record<string, CodeDef>` (tabla del §2)
- `guessCode(code) → CodeDef` (para códigos nuevos, ver §3)
- `kindOf(state, code)`, `getCode(state, code) → CodeDef` (cae en guessCode si no existe)
- `shiftInterval(state, dayKey, code) → { start: Date, end: Date } | null` (maneja paso de medianoche y cambio de hora DST con fechas reales)
- `normalizeDayCodes(state, codes) → codes` (orden: turnos, eventos, otros, lugares; sin duplicados)

**store.js**
- `createDefaultState() → State`
- `loadState(storage = globalThis.localStorage) → State` (migra/rellena campos que falten; nunca lanza: si el JSON está corrupto guarda una copia en `turnos-mauricio:corrupt:<ts>` y empieza de cero)
- `saveState(state, storage)`
- Store con suscripción para la UI: `createStore(storage?) → { get(), set(mutatorFn), subscribe(fn) → unsubscribe }` (guarda automáticamente; el `mutatorFn(draft)` modifica una copia)
- Mutaciones puras (devuelven nuevo state): `setDay(state, key, codes, {note, source})`, `clearDay(state, key)`, `applyScan(state, scanResult, {acceptedKeys})`, `upsertCode(state, def)`, `deleteCode(state, code)`, `updateSettings(state, patch)` (merge profundo)
- `exportBackup(state) → string` (JSON **sin** el token de GitHub), `importBackup(state, json) → State` (valida; lanza Error con mensaje en español si no es válido)

**diff.js**
- `scanToDays(scanResult, {year, month}) → [{ key, codes, confidence }]`
- `diffScan(state, days) → [{ key, before: string[]|null, after: string[], type: 'new'|'changed'|'same' }]`
- `mergeScans(results[]) → result` (varias fotos del mismo mes: unión por día; si dos fotos discrepan gana la de mayor confianza y se marca `conflict: true`)

**hours.js**
- `dayMinutes(state, key) → { worked, credited, total, items: [{code, minutes}] }` (worked = turnos/eventos que cuentan: (end−start)−pausa; credited = vacaciones/enfermedad; la noche cuenta para el día en que empieza)
- `weekSummary(state, mondayKey) → { from, to, total, worked, credited, soll, diff, days: [...] }` (soll = weeklyHours − festivos lun–vie × Soll diario)
- `monthSummary(state, year, month1) → { total, soll, diff, nights, weekendsWorked, vacationDays, freeDays, shifts, weeks: [...] }`

**advice.js** — `getAdvice(state, now = new Date()) → [{ id, level: 'info'|'warn'|'alert', icon: emoji, title, text, key? }]` ordenados por importancia. Reglas mínimas (textos en español, cálidos y breves):
1. Descanso < 11 h entre el fin de un turno y el inicio del siguiente (ej. S1 → F1 al día siguiente = 8 h) → warn.
2. Solapamiento/imposible (ej. N1 que termina 06:00 y F1 que empieza 06:00 ese mismo día) → alert.
3. ≥ 6 días de trabajo seguidos → warn; ≥ 8 → alert.
4. Semana actual/próxima con total > weeklyHours + 4 h → "semana pesada"; con mucho menos (sin vacaciones) → info.
5. Balance del mes (planificado vs Soll) → info con +/− horas.
6. Bloque de noches próximo → consejos de sueño, hidratación, no conducir con sueño.
7. Turnos próximos con horario sin confirmar (`confirmed:false`) → warn "confirma el horario de F6".
8. Faltan datos: quedan ≤ 7 días con plan cargado → info "sube la foto del plan del próximo mes".
9. Días libres próximos (≥ 2 seguidos) → info positiva.
10. Recordatorios no activados (ni sync ni ntfy) → info con botón a Ajustes.

**reminders.js** — `upcomingReminders(state, now, horizonMs) → [{ id, at: Date, key, code, title, body }]` según `settings.reminders` (la víspera a `eveningTime` y `minutesBefore` antes del inicio). `id` estable: `${key}-${code}-eve` / `-pre`.

**ics.js** — `buildICS(state, { from?, to?, now? }) → string` RFC 5545: CRLF, plegado de líneas a 75 octetos, escape de `,;\\` y saltos, `VTIMEZONE` Europe/Berlin, `X-WR-CALNAME:Turnos de Mauricio`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H`, `X-PUBLISHED-TTL:PT1H`. Un `VEVENT` por turno/evento con horario (UID estable `${key}-${code}@turnos-mauricio`, SUMMARY tipo "🌅 F1 Mañana · F51", LOCATION con el lugar, DESCRIPTION con horario y pausa) con 2 `VALARM` (víspera a las 20:00 → TRIGGER relativo negativo calculado; y X min antes), y eventos de día completo para vacaciones (sin alarma). Rango por defecto: desde hace 60 días hasta todo el futuro.

**sync.js** (GitHub, opcional) — con `fetchImpl` inyectable. Usa la API REST de GitHub (CORS permitido) con el token fine-grained (permiso *Contents: read & write* solo en este repo).
- `testConnection(settings.sync)` → ok / mensaje de error en español (token inválido, sin permisos, repo inexistente…)
- `ensureBranch(sync)` → crea la rama `datos` desde la rama por defecto si no existe
- `pushData(state)` → escribe `turnos.ics` y `turnos.json` (backup sin token) en la rama `datos` (GET sha + PUT contents), solo si el hash del contenido cambió; devuelve `{ pushed: boolean, hash }`
- `pullBackup(sync) → json string` (para restaurar)
- `calendarUrls(sync) → { webcal, https }` = `webcal://raw.githubusercontent.com/<owner>/<repo>/<branch>/turnos.ics`
- `parseSetupLink(hash) → sync | null` y `buildSetupLink(baseUrl, sync) → url` con `#setup=<base64url(JSON)>` (para que el desarrollador configure el teléfono de Mauricio enviándole un enlace).

**ntfy.js** (opcional, sin cuenta) — notificaciones push reales vía la app gratuita "ntfy" (iOS/Android) suscrita a un topic secreto. ntfy.sh permite **entrega programada hasta 3 días** y **actualizar/cancelar mensajes programados por sequence ID** (ver https://docs.ntfy.sh/publish/ — leer la doc para los detalles exactos de cabeceras/JSON/DELETE).
- `randomTopic() → 'turnos-mauricio-xxxxxxxxxxxx'`
- `syncNtfy(state, now, fetchImpl) → { scheduled, cancelled, errors, nextScheduled }` programa los recordatorios de las próximas ~70 h (sequence ID estable por recordatorio = id de reminders.js saneado), reemplaza los que cambiaron y cancela los obsoletos; añade "Click" a la URL de la app. Si hay turnos más allá del horizonte y nada programado después de ~60 h, programa un aviso "Abre Turnos para mantener los recordatorios" a ~70 h.
- `testNtfy(settings.ntfy)` → envía una notificación de prueba inmediata.

## 5. Reconocimiento (`docs/js/recognize/index.js`)

```js
export async function recognize(input, options = {}) → Promise<RecognizeResult>
export async function dispose()   // termina workers de Tesseract
// input: Blob | File | ImageBitmap | HTMLImageElement | HTMLCanvasElement
// options: {
//   tesseract: { workerPath, corePath, langPath, langPathLegacy },  // URLs absolutas; por defecto derivadas de import.meta.url → ../../vendor/tesseract/
//   knownCodes?: string[],        // códigos conocidos para "ajustar" el OCR
//   employeeName?: 'Ducuara',     // para la tabla del PC con varias filas
//   onProgress?: (fraction, label) => void,
//   debug?: boolean               // si true, result.debug.overlay = dataURL PNG con las detecciones dibujadas
// }
RecognizeResult = {
  layout: 'phone-list' | 'pc-grid' | 'unknown',
  month: 1..12 | null, year: number | null,
  days: [ { day: 1..31, codes: string[], confidence: 0..1 } ],   // ordenado, sin días repetidos
  warnings: string[],               // en español, para mostrar al usuario si hace falta
  debug?: { overlay?: string, ... }
}
```
- `'-'` = libre, `'W-'`, `'U'`; fila visible vacía → `codes: []`. Filas cortadas en los bordes o tapadas (dedo) → omitir (mejor omitir que inventar).
- `globalThis.Tesseract` lo carga la página (`vendor/tesseract/tesseract.min.js`) antes de llamar a `recognize`.
- Debe funcionar en **Safari iOS 16.4+** (usar `<canvas>` normal o con fallback; reducir imágenes grandes — fotos de iPhone 12 MP — a ≤ 2000 px de lado mayor antes de procesar; ceder el hilo entre fases).
- Objetivo de rendimiento: ≤ 6 s por foto en el harness (Chromium de escritorio).
- Prioridad absoluta: **no devolver días equivocados** (la UI permite revisar, pero un error silencioso es peor que un hueco).

## 6. UI (español, iPhone primero)

Pestañas inferiores (estilo iOS): **Hoy · Calendario · [📷 Escanear, botón central destacado] · Horas · Ajustes**.

- **Hoy**: saludo "Hola, Mauricio 👋"; tarjeta grande "Próximo turno" (cuándo: "Mañana, martes 13 de octubre"; insignia con el color del código; nombre "Tarde"; "13:30 – 22:00"; lugar "📍 S51 …"; cuenta atrás "empieza en 5 h 20 min"; si está trabajando: "Trabajando ahora · termina a las 22:00"). Barra "Esta semana: 28 h 30 / 35 h". Próximos 7 días en lista compacta. 2-3 consejos de `getAdvice`. Si no hay datos: estado vacío amable con botón grande "📷 Escanear mi plan".
- **Calendario**: lista del mes como la app original (familiar para Mauricio): número + día, insignias con los mismos colores/formas, horas del día; separador por semana con total semanal; navegación ‹ mes ›; botón "Hoy". Tocar un día → hoja inferior de edición.
- **Editar día** (hoja inferior): chips actuales (quitar con ✕), paleta de códigos agrupada (Turnos / Lugares / Otros), "➕ Código nuevo" (nombre, inicio, fin, pausa, lugar, color), nota, "Borrar día". Guardar registra el cambio en `changes`.
- **Escanear**: botones grandes "📷 Hacer foto" (`<input type=file accept="image/*" capture="environment">`) y "🖼️ Elegir fotos" (`multiple`). Consejos: "foto recta, sin reflejos, que se vea el mes arriba; puedes hacer varias fotos del mismo mes". Progreso por foto. Pantalla de **revisión**: mes/año detectado (editable), lista de días con códigos (editables como en "Editar día"), marcas "Nuevo" / "Cambia: Z1 → S1" / "¿Seguro?" (confianza baja), avisos de códigos nuevos; "Guardar N días" / "Cancelar". Si no se pudo leer nada: mensaje amable + elegir mes a mano + editar.
- **Horas**: resumen del mes (planificado vs Soll, diferencia con color), semanas del mes con barras (total vs 35 h), noches, fines de semana trabajados, días de vacaciones; lista completa de consejos.
- **Ajustes**: Nombre; horas de contrato; Códigos y horarios (lista + editar/añadir/borrar; resaltar los sin confirmar); Recordatorios (víspera a las HH:MM, X min antes); **Calendario del iPhone** (sync GitHub: estado, token, botón "Suscribir en el iPhone" → webcal, guía paso a paso incl. desactivar "Eliminar alertas"); **Notificaciones ntfy** (opcional: topic, botón prueba, guía); Copia de seguridad (exportar/importar archivo; restaurar desde GitHub); "Añadir a pantalla de inicio" (guía iOS con icono Compartir); Acerca de / versión.
- Primer uso (onboarding, saltable): bienvenida → cómo instalar en pantalla de inicio (si `navigator.standalone` es false en iOS) → recordatorios.
- `#setup=...` en la URL → configura sync automáticamente (confirmación) y limpia la URL.
- Diseño: limpio, moderno, cálido. Acento naranja como la app Dienstplan (#EF8A17 aprox.), fondos claros (#F7F5F2) y modo oscuro (`prefers-color-scheme`); tarjetas con radio 16–20 px; tipografía del sistema (`-apple-system, system-ui`); objetivos táctiles ≥ 44 px; `env(safe-area-inset-*)`; transiciones suaves; iconos SVG inline o emoji; colores de insignias iguales a la app original (F amarillo #F2E500, S verde #8DC47E, N azul #3D63B8, Z rosa #F3B9BF, lugares magenta #E31CE0, S31 rojo #E0281E, TS hexágono azul, W- etiqueta rosa #F4B6BF, U texto rojo #D21F1F, '-' guion rojo).
- Formatos: fechas con `Intl` en 'es'; horas "8 h 30"; números con coma decimal.

## 7. PWA / iOS

- `manifest.webmanifest`: name "Turnos de Mauricio", short_name "Turnos", `display: standalone`, `start_url: "./"`, `scope: "./"`, colores, iconos (192, 512, maskable).
- iOS: `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style`, `viewport-fit=cover`. El almacenamiento de la app instalada es distinto del de Safari → instalar primero.
- `sw.js`: precache del "app shell" (html, css, js, iconos) con versión; `vendor/tesseract/*` con cache-first en tiempo de ejecución; aviso "Nueva versión disponible → Actualizar".
- `navigator.storage.persist()` al iniciar.
- Exportar `.ics` manual (respaldo, no fiable en iOS instalado): `navigator.share({files})` si `canShare`, si no `Blob` con tipo `text/calendar` y enlace.

## 8. Publicación

GitHub Pages → *Deploy from a branch* → carpeta `/docs`. El repo debe ser público (Pages gratis). Sin GitHub Actions propias.
