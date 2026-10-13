# API de `docs/js/core` para la UI

API final de la lógica (SPEC §9–§13). Todo se importa desde `docs/js/core/index.js`, que también reexporta `cipher.js`. Este archivo está en la raíz del repo y no dentro de `docs/`, porque `docs/` se publica en GitHub Pages.

## Lo nuevo de esta ronda (SPEC §11 y §13)

> **`docs/sw.js`:** no hay módulos nuevos (suplementos y saldos están en `hours.js`), pero cambió el código de `js/core/*`: al publicar hay que **subir `VERSION`** en `sw.js` y `APP_VERSION` en `js/app.js`.

1. **Varias personas (§11).** Cada persona tiene su **carpeta** en el mismo repo de datos: `settings.sync.dir` (`''` = raíz = Mauricio, sin cambios; si no, slug `[a-z0-9-]{1,32}`, p. ej. `ana`). Archivos: `<dir>/backup.json` y `<dir>/turnos.ics`. Cada carpeta tiene **su clave** y **su dispositivo que publica**. El enlace `#setup=` lleva `dir` (y `name`). Funciones nuevas: `listCalendars`, `buildPersonLink`, `slugify`, `uniqueDir`, `isValidDir`, `publicName`, `cleanPersonName`, `icsEventCount` (§3.6).
   - **Otro destino (otra carpeta, otro repo u otra rama) nunca hereda la clave guardada** (antes, un formulario sin clave reutilizaba la del dispositivo aunque fuera para otro repo): sin clave en el enlace o formulario se crea una nueva (o `NO_KEY` si allí ya hay copia), y la anterior no queda en `prevKey`. Y los turnos tampoco pasan: §3.7.
   - Un formulario **sin** `dir` conserva la carpeta del dispositivo; un enlace sin `dir` (antiguo) es la raíz.
2. **Nombre (§11).** `settings.name` es `''` en instalaciones nuevas (las guardadas conservan el suyo, p. ej. `'Mauricio'`). `settings.planName` = nombre tal como sale en el Dienstplan («Ducuara Ana»); `suggestPlanName(state)` sugiere «Ducuara <nombre>». El calendario se llama «Turnos de <nombre de pila>» o «Mis turnos» (`calendarName`); `PRODID:-//Turnos//ES`. ntfy: título «Turnos», sin «iPhone».
3. **«📷 Sube el plan de <mes>» (§13.1)** en el `.ics` si el mes siguiente está vacío: `planUploadReminder(state, now)`, `settings.reminders.planUpload` (por defecto `true`) (§6.3).
4. **Tiempo de viaje (§13.2):** `CodeDef.travelMin` (0–180). El aviso «antes» se adelanta el viaje con «Sal a las 13:05 hacia F51 (25 min de viaje)» en recordatorios, `.ics` y ntfy. `dayTravel`, `travelText`, `mapsUrl` (§6.2).
5. **Suplementos (§13.3):** `settings.supplements`, `monthSummary(...).supplements`, `daySupplements`, `monthSupplements` (§6.4, en `hours.js`).
6. **Saldos (§13.4):** `settings.balances`, `overtimeBalance`, `vacationSummary` (§6.5, en `hours.js`).
7. **Enfermedad (§13.5):** código de fábrica `K` (`kind: 'sick'`, «Enfermedad», texto rojo, forma `'text'`): se acredita como las vacaciones (§6).
8. **Android (§12):** `calendarUrls(sync)` trae también `webcals` y `android` (enlace `intent://` que abre ICSx⁵ o su página de Google Play). `getAdvice(state, now, { platform })` dice «Calendario del iPhone» solo en iOS (sin `platform`: «calendario del teléfono»).

### Correcciones tras la revisión (esta ronda)

- **Cambio de calendario (§3.7, seguimiento 3): los turnos de una persona nunca van a otro calendario.** Un *destino* es owner + repo + carpeta + **rama** (`syncTargetId`). Un dispositivo que leyó o publicó en un destino tiene sus datos «de» ese destino (`sync.boundTarget`, aunque esté desconectado). Llevarlo a otro destino (enlace, formulario avanzado o `applySyncConfig`) da `OTHER_PERSON` (otra carpeta u otro nombre) u **`OTHER_TARGET`** (nuevo: otro owner, repo o rama) y no cambia nada; solo `{ switchPerson: true }` (tras confirmarlo) cambia, desde un estado limpio y con la clave de ese calendario (o una nueva). Si la configuración cambia por debajo (`updateSettings`/`syncConfigPatch`), `syncNow`, `pullOnly` y `becomePublisher` dan `OTHER_TARGET` **sin conectarse**. Antes se escapaban: desconectado + otro enlace, otra rama (conservaba días y clave) y «Deshacer» tras cambiar (`undoImport` importaba los turnos anteriores en el calendario nuevo).
- **Enlace de otra persona (§3.2):** `trySetupConfig` (y `q.setup`) devuelve `{ ok:false, error.code: 'OTHER_PERSON', otherPerson }` si el enlace es del calendario de otra persona: el dispositivo ya funciona con otra carpeta (otro owner, repo o `dir`), o aún no está conectado pero tiene turnos y un nombre distinto del calendario del enlace (`meta.name` de la copia o, sin ella, el `name` del enlace). No cambia nada. Tras confirmarlo, `q.setup(cfg, { switchPerson: true })` pasa el dispositivo a ese calendario **desde un estado limpio** (`personSwitchState`): nada de la persona anterior se fusiona ni se publica allí.
- **Dispositivo vacío al fusionar:** solo adopta del remoto lo que aquí está **vacío o de fábrica**, y nunca un texto vacío. El nombre escrito en el primer uso se queda (antes lo pisaba el de quien ayuda, o `''`). `planName` solo si el nombre de pila coincide (o aquí no hay).
- **«Sube el plan» (§6.3):** pasado el 20, el aviso es **hoy** a las 19:00 si aún no ha llegado; si no, mañana. Antes siempre iba a mañana y, como se republica cada mañana, nunca sonaba.
- **Números como texto:** `updateSettings` e `importBackup` aceptan «18,75», «1,5» o «30» también cuando ya había un número guardado (antes solo la primera vez).
- **UID de una carpeta:** `turnos-dir-<dir>` (antes `turnos-<dir>`, que en una carpeta `mauricio` coincidía con la raíz). Aún no se había publicado ningún calendario de carpeta.
- **Importar:** «Este archivo no es una copia de Turnos.» (sin «de Mauricio»).
- **Tabla del PC (reconocedor, `recognize/pc/`):** con una sola fila (la impresión filtrada de euregon), si se lee el apellido pero falta el nombre de pila del plan («Ducuara Ana» en la hoja de Mauricio), los días se devuelven con `confidence` ≤ 0,4 (la revisión no los marca) y el aviso «Esta hoja parece de otra persona: no veo «Ana» en el nombre. Revisa antes de guardar.» (empieza por `OTHER_SHEET_WARNING`, exportado en `recognize/pc/calendar.js`). Con varias filas y solo el apellido (`employeeName` de una palabra, p. ej. `FAMILY_NAME`) no se elige ninguna fila: «… Pon tu nombre como sale en el plan (Ajustes → Tu nombre).». Los nombres de ≤ 4 letras («Ana») tienen que leerse tal cual: «Juana», «Diana» o restos de OCR («A» + «na») ya no valen.

### Pendiente en la UI

- **Cambio de calendario** (`setup.js`, `runSetup`, también desde el formulario avanzado): `OTHER_PERSON` **y** `OTHER_TARGET` se tratan igual, con el contrato exacto de §3.7 (preguntar → `saveBeforeImport` → `syncQueue.setup(cfg, { switchPerson: true })` → «Deshacer» con `undoImport`). Un `lastErrorCode === 'OTHER_TARGET'` (configuración cambiada por debajo) se arregla igual, con la configuración guardada como `cfg`. En el dispositivo de quien ayuda, lo normal es «Cancelar».
- **«Crear enlace para <nombre>»** (`settings.js`): poner el nombre también en el enlace de la raíz, para que el diálogo diga «para Mauricio» y el guardián tenga el nombre: `buildSetupLink(location.href, { ...sync, name: publicName(settings.name) })` (ya lo admite).
- **Primer uso en el ordenador** (`onboarding.js`): no preguntar «¿Cómo te llamas?» si `platform() === 'desktop'` (lo usa quien ayuda; su nombre acabaría en el calendario publicado), o preguntar «¿De quién son estos turnos?».
- **Escanear** (`scan.js`): un aviso que empieza por `OTHER_SHEET_WARNING` («Esta hoja parece de otra persona») va como `notice-warn`, no `notice-info`.
- **`sw.js` / `app.js`:** subir `VERSION` y `APP_VERSION` (no hay archivos nuevos que precachear).
- **Primer uso / Ajustes:** pedir `name` (nombre de pila) y `planName` (como en el Dienstplan), saltables. Si `planName` está vacío, proponer `suggestPlanName(state)` (instalación antigua de Mauricio → «Ducuara Mauricio»). Saludo: `name` vacío → «Hola 👋» (ya no caer en `'Mauricio'`, p. ej. `onboarding.js`).
- **Escanear:** `employeeName: state.settings.planName || suggestPlanName(state) || 'Ducuara'` (hoy es una constante). Con solo el apellido, una hoja de varias filas no da ninguna (avisa «Pon tu nombre como sale en el plan»).
- **Calendario en Android:** botón «Ver mis turnos en el calendario» → `calendarUrls(sync).android`; siempre también «Copiar enlace» con `calendarUrls(sync).https` (Google Calendar «Desde URL» se configura desde un ordenador). En iOS sigue `webcal`.
- **Editor de códigos:** campo «Tiempo de viaje (min)» (`travelMin`, 0–180), sobre todo en lugares. En Hoy/editor del día: «Sal a las …» con `travelText(item)` y «Abrir en Mapas» con `mapsUrl(def, platform)` si el lugar tiene dirección.
- **Paleta:** `K` (Enfermedad) en «Otros».
- **Recordatorios:** interruptor «Recordarme subir el plan del mes siguiente» (`reminders.planUpload`).
- **Horas:** suplementos del mes (`monthSummary(...).supplements`, con `SUPPLEMENT_NOTE` «comprueba tu contrato»), saldo de horas (`overtimeBalance`) y vacaciones del año (`vacationSummary`); en Ajustes, sus valores (`supplements`, `balances`).
- **Ajustes → «Calendarios de la familia»:** `listCalendars(sync)`; cada uno con «Ver sus turnos en mi calendario» (`c.urls`). **Opciones avanzadas → «Crear enlace para otra persona»:** pedir el nombre → `buildPersonLink(location.href, sync, { name, existingDirs })` (§3.6).
- **Consejos:** pasar `{ platform }` a `getAdvice` (Hoy y Horas).

### Rondas anteriores (resumen)

- **Horario especial de un día:** `DayEntry.times` (§6.1), con `setDay(..., { times })`, `effectiveTimes` y `getDayCode`; todo lo que calcula horarios lo usa.
- **Sin `backup.json`:** solo el dispositivo que escribió el `turnos.ics` publicado lo vuelve a crear; los demás quedan en solo lectura con `publisher: '?'` (`UNKNOWN_PUBLISHER`) hasta «Usar este dispositivo» (§3.1). `syncNow` en un dispositivo vacío que nunca publicó da `ok` + `readOnly`.
- Borrar a propósito los últimos días sí se publica; con la identidad sin guardar la cola no escribe (`RETRY`); los lugares de un enlace no cambian `calendarUpdatedAt`; un resultado que publicó una `rev` más nueva no se descarta.
- La identidad (`deviceId` y clave) se crea **antes** de la primera petición de red (`ensureSyncIdentity`); si `syncNow` tiene que crearla, devuelve `RETRY` sin escribir y la cola repite sola.
- Los enlaces se comprueban antes de guardarlos (`trySetupConfig`); una clave buena sustituida queda en `sync.prevKey`.
- Quien dejó de publicar no pisa el calendario: antes de escribir `turnos.ics` se comprueba que `backup.json` sigue igual (si no, `CONFLICT`).
- Cada resultado lleva `startedAt`; **todas** las llamadas de sincronización pasan por **una sola cola** (`createSyncQueue`). `pushData` está obsoleto.

---

## 1. Estado (`State`)

| Campo | Qué es |
|---|---|
| `state.tombstones` | `{ 'YYYY-MM-DD': ISO }`. Días borrados. `clearDay` añade uno y `setDay` lo quita. Se podan a los 120 días al guardar. |
| `state.codeTombstones` | `{ CODE: ISO }`. Códigos propios borrados con `deleteCode`. |
| `state.__newerSchema` | `true` si los datos son de una versión más nueva de la app. No se guarda. La UI pide **«Actualiza la app»** (y también lo hace el consejo `newer-schema`). |
| `CodeDef.updatedAt` / `DayEntry.updatedAt` | ISO. Se rellenan al cambiar (para fusionar). |
| `DayEntry.times` | Opcional: horario especial de ese día, `{ CODE: { start: 'HH:MM', end: 'HH:MM', breakMin?: 0..240 } }`, solo de códigos de ese día (§6.1). Si no hay, el campo no existe. Viaja con el día (copia, importación, fusión). |
| `settings.calendarUpdatedAt` | Cambia cuando cambian `reminders` o `sync.publishPlaces`. Hace que el sello y la `SEQUENCE` del `.ics` nunca retrocedan. |
| `settings.remindersUpdatedAt` / `settings.placesUpdatedAt` | Cuándo se cambiaron los avisos o `publishPlaces`. Al fusionar dispositivos gana el cambio más reciente. `LINK_PLACES_AT` (`1970-01-01T00:00:00.001Z`) es una sugerencia de un enlace: pierde ante cualquier decisión real. |
| `settings.name` | Nombre de pila (saludo). `''` en instalaciones nuevas; se recorta (máx. 60). Públicamente (calendario y `meta.name`) solo va la **primera palabra**. |
| `settings.planName` | Nombre como en el Dienstplan («Ducuara Ana»), para `employeeName` del reconocedor. `''` por defecto; `suggestPlanName(state)` propone uno. |
| `settings.reminders` | `{ eveningBefore, eveningTime, beforeStart, minutesBefore, planUpload }`. `planUpload` (nuevo, `true`): evento «Sube el plan» (§6.3). |
| `settings.supplements` | `{ night: { from, to, pct }, saturday: { from, to, pct }, sunday: { pct }, holiday: { pct }, hourlyWage }` (§6.4). Se sanea siempre (`sanitizeSupplements`). |
| `settings.balances` | `{ overtimeStartMin, overtimeStartMonth, vacationDaysPerYear, vacationCarryOver }` (§6.5). Se sanea siempre (`sanitizeBalances`). |
| `CodeDef.travelMin` | Minutos de viaje (entero 0–180, por defecto 0), sobre todo en lugares (§6.2). Viaja con el código (copia, fusión, importación). |

`name`, `planName`, `supplements` y `balances` son **ajustes del usuario**: viajan en la copia de seguridad y en `backup.json` (`USER_SETTINGS`). Un dispositivo vacío (sin días) los adopta al fusionar **solo si aquí están vacíos o de fábrica** (nunca un texto vacío; `planName` solo si el nombre de pila coincide o aquí no hay); si no, cada dispositivo conserva los suyos (como `weeklyHours`).

Estos sellos los pone `updateSettings`. Si el parche trae `remindersUpdatedAt` o `placesUpdatedAt` explícitos, se respetan. La UI no tiene que tocarlos.

### `settings.sync`

```js
{ enabled:false, owner:'Mardar91', repo:'mauricio-datos', branch:'', dir:'', token:'', key:'', deviceId:'',
  baseRev:0, lastPushAt:null, lastPushHash:null, lastIcsHash:null, lastPullAt:null,
  lastError:null, lastErrorCode:null, lastErrorDetail:null, lastErrorSince:null, publishPlaces:false,
  publisher:null, publisherSince:null, unpublished:0, prevKey:'', lastSyncStartedAt:null, boundTarget:'' }
```

- `branch: ''` es la rama por defecto del repo. `repo` es un repo **solo de datos**, nunca el de la app.
- `dir`: carpeta de esta persona en el repo de datos (`''` = raíz). Se guarda en minúsculas; una carpeta no válida **no** se cambia por `''` (sería la de otra persona): la sincronización da `CONFIG` sin conectarse.
- `key`: clave AES-GCM en base64url (43 caracteres). `deviceId`: identificador de este dispositivo. Se crean con `ensureSyncIdentity` al configurar (§4.2).
- `lastError` es el mensaje para Mauricio y `lastErrorCode` su código (§3.4). `lastErrorDetail` es técnico (solo en «Opciones avanzadas»). `lastErrorSince` dice desde cuándo falla.
- `publishPlaces`: interruptor «Publicar lugares en el calendario». Se comparte entre dispositivos (gana el cambio más reciente).
- `publisher` / `publisherSince`: qué dispositivo publica, según la última lectura. Si `backup.json` desaparece, sirve para que este dispositivo siga solo leyendo. `'?'` (`UNKNOWN_PUBLISHER`) = no se sabe: no hay `backup.json` y el `turnos.ics` publicado lo escribió otro (§3.1).
- `lastIcsHash`: huella del último `turnos.ics` que publicó este dispositivo. Se conserva al aplicar un enlace del mismo repositorio y rama.
- `unpublished`: en un dispositivo que solo lee, cuántos cambios de aquí no están publicados (días + códigos + 1 si difieren los avisos o los lugares).
- `prevKey`: la clave anterior a un cambio de clave. Se borra en cuanto la clave actual descifra o publica. No se muestra nunca.
- `lastSyncStartedAt`: inicio de la última sincronización aplicada (para descartar resultados viejos).
- `boundTarget`: el destino del que son los datos de aquí, `'owner/repo/carpeta:rama'` (owner y repo en minúsculas; `syncTargetId(sync)`). Lo pone cada lectura o publicación; `personSwitchState` lo deja en `''`; aplicar una configuración no lo cambia. Si no coincide con el destino configurado, la sincronización no lee ni escribe (`OTHER_TARGET`). La UI no lo toca (§3.7).

---

## 2. Store (`createStore`)

```js
const store = createStore(localStorage, { onError, target = window, now });
store.get(); store.set(fn) /* → state */; store.subscribe(fn) /* → unsubscribe */;
store.refresh()   // relee localStorage; true si cambió (y avisa a los suscriptores)
store.onError(fn) // → unsubscribe. fn({ type:'save', code:'QUOTA'|'BLOCKED'|'NO_STORAGE', message, detail })
store.saveOk()    // false si la última escritura falló
store.lastSave()  // { ok, error, at }
store.destroy()   // quita el listener 'storage' (tests)
```

- **Varias pestañas:** el store escucha `storage` y, además, cada `set()` relee lo guardado antes de aplicar el cambio. La UI llama a `store.refresh()` en `visibilitychange → visible` y en `pageshow`.
- **Guardado fallido** (cuota, almacenamiento bloqueado): `set()` libera espacio y reintenta. Si sigue fallando, llama a `onError`. La UI muestra un banner rojo persistente con `message` (`SAVE_ERROR`) y el botón «Exportar copia», y comprueba `store.saveOk()` antes de decir «Guardado».
- **JSON corrupto:** se guarda una copia por contenido en `turnos-mauricio:corrupt:<ts>` (máximo 3).
- **Datos de una versión más nueva:** hay una copia intacta en `turnos-mauricio:newer-schema`.

---

## 3. Sincronización

### 3.1 La regla: un solo dispositivo publica

- Solo **un** dispositivo escribe en GitHub (`backup.json` y `turnos.ics`): el de `backup.json` → `meta.publisher`.
- Cualquier otro lee, descifra y **fusiona en local**, pero **nunca escribe**, ni con `force` ni con `allowEmpty` (`readOnly: true`). Sus cambios se quedan en ese dispositivo hasta que pase a publicar.
- **Sin `backup.json`:**
  - si tampoco hay `turnos.ics` (repo nuevo, o se borraron los dos), publica el primer dispositivo que sincroniza;
  - si hay `turnos.ics`, solo vuelve a crear `backup.json` **el dispositivo que escribió ese `turnos.ics`** (`sync.lastIcsHash`). Cualquier otro queda en solo lectura con `publisher: '?'` (`UNKNOWN_PUBLISHER`): `syncNow`, `pullOnly` y `trySetupConfig` dan `readOnly: true`, y la UI pregunta «¿Usar este iPhone?» (`becomePublisher`);
  - **no** publica uno que recuerde a otro como `publisher` (sigue solo leyendo hasta «Usar este dispositivo»);
  - y **nunca** uno con 0 días si `turnos.ics` tiene eventos (`EMPTY_LOCAL`, también con `becomePublisher`).
- **Cambiar de dispositivo:** `becomePublisher` (lee + fusiona + publica `rev + 1` con este como `publisher`). Solo tras confirmarlo Mauricio.

### 3.2 Funciones

```js
// Configurar (puros, para usar dentro de store.set)
ensureSyncIdentity(state, { deviceId?, key?, getRandomValues? })  // → state (el mismo si no falta nada); key:false = no crear clave
applySyncConfig(state, cfg, { now?, deviceId?, key?, switchPerson? }) // → state: configuración + lugares del enlace + identidad (lanza OTHER_PERSON/OTHER_TARGET, §3.7)
syncConfigPatch(cfg, state?)                                       // → parche de settings.sync (bajo nivel; sin publishPlaces)
// Comprobar un enlace o formulario antes de guardarlo (lee; no escribe)
await trySetupConfig(state, cfg, { fetchImpl?, now?, switchPerson? })   // → { ok:true, res, readOnly, publisher, error, switched, apply(state) } | { ok:false, error, res, otherPerson? }
// Sincronizar (nunca lanzan; devuelven el resultado de §3.3)
await syncNow(state, { fetchImpl?, now?, force?, allowEmpty? })  // lee + fusiona; publica SOLO si es el que publica
await pullOnly(state, opts)                                      // lee + fusiona; NUNCA escribe (alias: restoreFromRemote)
await becomePublisher(state, opts)                               // «Usar este dispositivo»
applySyncResult(current, res, { now })                           // → state: SIEMPRE con store.set, también si res.ok es false
// La cola única que usa la UI (§4.0): hace las llamadas de arriba y aplica cada resultado
const q = createSyncQueue(store, { fetchImpl?, clock? });
q.sync(opts?)  q.pull(opts?)  q.becomePublisher(opts?)  q.setup(cfg, { switchPerson? }?)  q.idle()
personSwitchState(state)                                         // (store.js) estado limpio para otra persona: solo deviceId, ntfy y onboardingDone
syncTargetId(sync)   dataTargetOf(sync)                          // (store.js) destino configurado / destino de los datos de aquí ('' = ninguno)
isReadOnlyDevice(sync)                                           // true → otro dispositivo publica
```

- `cfg` es lo que devuelve `parseSetupLink(hash)`, o `normalizeSyncConfig(form)` en el formulario avanzado. Con `dir` va a esa carpeta; **sin** `dir` (formulario que no lo tiene) se queda en la del dispositivo.
- **Otro destino** (otro owner, repo, `dir` **o rama**) = otro calendario: la clave guardada **no** se reutiliza. Sin clave en `cfg`, `trySetupConfig` prueba sin clave (`NO_KEY` si allí hay copia cifrada; si no, `apply` crea una nueva) y la anterior no queda en `prevKey`. En el mismo destino, sin clave en el formulario se sigue usando la del dispositivo (como antes). Un enlace de otro destino que trae **la misma clave** que el de este dispositivo, sin copia allí que la use, da `CONFIG` («Este enlace lleva la misma clave que el calendario de este dispositivo…»).
- Un `cfg.name` (enlace de «Crear enlace para otra persona») se guarda en `settings.name` **solo** si el dispositivo no tiene nombre.
- **`trySetupConfig`** prueba la configuración nueva con una **copia** del estado:
  - Responde `{ ok:false, error }` (y no se guarda nada) si:
    - la clave no descifra la copia (`DECRYPT`);
    - hay copia y no hay clave (`NO_KEY`);
    - el token o el repo fallan (`AUTH`, `FORBIDDEN`, `NOT_FOUND`…);
    - no hay red (`NETWORK`…) y el dispositivo ya tenía una configuración que funcionaba;
    - el enlace es del calendario de **otra persona** (`OTHER_PERSON`) o los datos de aquí son de **otro destino** (`OTHER_TARGET`), §3.7. Un error al leer va antes (salvo uno pasajero en un dispositivo que no funcionaba: el guardián no necesita la red).
  - Sin red en un dispositivo **sin configurar**, responde `ok:true` con `error` pasajero: se guarda y se reintentará solo.
  - `apply(state)` guarda la configuración, la identidad probada (o una clave nueva si no había copia remota) y lo leído (`applySyncResult`).
  - Con el mismo destino, recuerda quién publicaba. Con otro, empieza de cero.
- **Otra persona u otro destino (`OTHER_PERSON` / `OTHER_TARGET`):** ver §3.7.
- **`syncNow` sin identidad:** si tiene que crear el `deviceId` o la clave, no escribe nada y devuelve `error.code === 'RETRY'` con la identidad en `res.sync`. Al aplicarla, la siguiente llamada publica. La cola lo hace sola. Un dispositivo que solo lee sí termina bien en esa misma llamada (no escribe).
- **Identidad sin guardar:** si al aplicar un resultado o un enlace (`q.setup`) la identidad nueva no se pudo guardar (`store.saveOk() === false`), la cola no repite y, mientras siga sin guardarse, `q.sync()` y `q.becomePublisher()` devuelven `RETRY` **sin conectarse** (antes intentan guardar otra vez). `q.pull()` sí lee. La UI ya muestra el banner `SAVE_ERROR`; el `RETRY` es pasajero y la sincronización de fondo reintenta sola.

### 3.3 Resultado de `syncNow` / `pullOnly` / `becomePublisher`

```js
{
  ok,              // true si todo fue bien (también si solo leyó)
  readOnly,        // true → otro dispositivo publica: aquí solo se leyó
  publisher,       // { deviceId, since } | null  (null: no hay copia y nadie publicaba → este publicaría)
  tookOver,        // true si becomePublisher cambió de dispositivo
  keyRestored,     // true si la clave nueva no descifraba y se recuperó la anterior (prevKey)
  state,           // estado fusionado (el mismo objeto si no cambió nada)
  merged, pulled, pushed, icsPushed,
  conflictCount,   // días cambiados en los dos lados desde la última sincronización
  pulledDays,      // ['YYYY-MM-DD', …] que vinieron del remoto
  unpublishedDays, unpublishedCodes, unpublishedSettings, // solo si readOnly: lo de aquí que no está publicado
  rev, remote: { rev, days, savedAt, deviceId, publisher, legacy, name } | null,   // name: meta.name o null
  startedAt,       // ISO: cuándo empezó (para descartar resultados viejos)
  sync,            // PARCHE para settings.sync (aplicar con applySyncResult)
  error: { code, message, detail, status, retry } | null,
  target: { owner, repo, branch, dir, keyTag }
}
```

**`applySyncResult(current, res, { now })`** fusiona `res.state` con el estado **actual**, sin perder lo editado mientras se sincronizaba, y aplica `res.sync` con estas excepciones:

- `owner`, `repo`, `branch` o `dir` cambiaron entre medias → no aplica nada (un resultado sin `target.dir`, de antes de esta versión, es de la raíz);
- **resultado viejo** (`res.startedAt` anterior a `sync.lastSyncStartedAt`) → solo fusiona los datos. No toca `publisher`, `baseRev`, `unpublished`, `lastPull/PushAt`, hashes, errores ni `prevKey`. Una marca en el futuro (reloj adelantado) no cuenta;
- **no es viejo** uno que empezó antes pero **publicó** (`pushed` o `tookOver`) una `rev` mayor que la `baseRev` guardada (p. ej. «Usar este dispositivo» mientras otra pestaña leía la copia anterior). Se aplica entero, pero `lastSyncStartedAt` no va hacia atrás;
- un `deviceId` o una `key` del resultado solo **rellenan** los que falten. La excepción es la clave anterior recuperada (`keyRestored`), si la sincronización empezó con la clave que sigue guardada;
- los errores y el `prevKey` de una sincronización que empezó con otra clave se descartan.

**Qué hace `syncNow` por dentro:**

0. Si `sync.boundTarget` es de otro destino que el configurado → `OTHER_TARGET`, sin ninguna petición (§3.7).
1. Lee `backup.json`. Si existe, **siempre** lo descifra y fusiona por día y por código (gana el `updatedAt` más reciente; los borrados cuentan; avisos y lugares también). Si la clave no vale pero `prevKey` sí, recupera `prevKey`.
2. Si otro dispositivo publica (según la copia; si no la hay, según lo recordado o, sin nada recordado, según quién escribió el `turnos.ics` publicado), termina aquí con `readOnly: true`.
3. Si publica este, escribe `backup.json` solo si hay algo nuevo, con `rev + 1` y comprobando el `sha` (hasta 3 intentos si otro escribe a la vez). Si la escritura que cambia quién publica falla sin respuesta (red), el parche no trae `publisher`: lo dirá la siguiente lectura.
4. Lee `turnos.ics` y, **si es distinto**, comprueba que `backup.json` no ha cambiado desde el paso 3 y lo reescribe. Va sin notas y con lugares solo si `publishPlaces`.

`force: true` vuelve a publicar aunque no haya cambios (para «Enviar ahora»; en un dispositivo que solo lee no escribe). `allowEmpty: true` permite publicar 0 días: úsalo solo tras una confirmación expresa del tipo «sí, vaciar el calendario».

**Repo vacío y ramas:** en un repo vacío los archivos se crean en la rama por defecto. Una rama indicada que no existe la crea desde la por defecto **solo quien puede publicar**: nunca `pullOnly`, `fetchRemoteBackup` ni un dispositivo que recuerda a otro como `publisher`.

**Formatos antiguos:**
- un `turnos.json` en claro se fusiona y se migra;
- un `backup.json` v2 lo publica quien lo escribió (`meta.deviceId`) y pasa a v3;
- una app que solo entiende v2 ve `NEWER_REMOTE`.

### 3.4 Errores

Cada error trae `message` (humano, sin jerga), `detail` (técnico) y `retry` (`true` si es pasajero). Los textos están en `SYNC_MESSAGES`.

| `code` | Cuándo | `retry` |
|---|---|---|
| `RETRY` | `syncNow`/`becomePublisher` tuvo que crear el `deviceId` o la clave: no escribió nada. **No se anota como error**: aplicar y repetir (la cola lo hace sola). También lo devuelve la cola sin conectarse si la identidad no se pudo guardar (§3.2) | sí |
| `CONFIG` | falta `owner`, `repo` o `token`, tienen caracteres no válidos, o la configuración del enlace o el formulario no vale (también: enlace de otro calendario con la clave de este, §3.7) | no |
| `NO_KEY` | hay copia cifrada y este dispositivo no tiene la clave | no |
| `DECRYPT` | la clave no coincide, o se alteraron los metadatos (también quién publica). No se escribe nada | no |
| `AUTH` / `FORBIDDEN` / `NOT_FOUND` / `INVALID` / `UNKNOWN` | 401 / 403 / 404 / 422 / otro | no |
| `RATE_LIMIT` / `SERVER` / `NETWORK` | límite de peticiones / 5xx / sin red | sí |
| `CONFLICT` | `sha` cambiado 3 veces, o `backup.json` cambió antes de escribir `turnos.ics` (otro pasó a publicar) | sí |
| `BAD_REMOTE` / `NEWER_REMOTE` / `NEWER_LOCAL` | copia dañada / de una versión más nueva / estado de una versión más nueva | no |
| `EMPTY_LOCAL` | publicar dejaría 0 días encima de una copia con días (salvo que cada día de la copia tenga aquí un borrado más nuevo: eso es borrar a propósito y sí se publica), o (sin `backup.json`) encima de un `turnos.ics` con eventos | no |
| `NO_REMOTE` | solo en `fetchRemoteBackup` y `pullBackup` | no |
| `OTHER_PERSON` | `trySetupConfig` / `q.setup` / `applySyncConfig`: el enlace es del calendario de otra persona (otra carpeta, u otro nombre), §3.7. No se guardó nada | no |
| `OTHER_TARGET` | `trySetupConfig` / `q.setup` / `applySyncConfig`: los datos de aquí son de otro destino (otro owner, repo o rama). Y en `syncNow` / `pullOnly` / `becomePublisher` si la configuración cambió por debajo: no se conecta (§3.7) | no |

- **Hoy:** el consejo `sync-error` ya avisa (§7).
- **Ajustes → Calendario del iPhone:** si `lastErrorCode` no es pasajero, mostrar `lastError` y el botón **«Tengo un enlace nuevo»**.
- **Opciones avanzadas:** mostrar `lastErrorDetail`.

### 3.5 Otras funciones de `sync.js`

- `fetchRemoteBackup(sync, fetch)` devuelve `{ rev, meta, data }`, con `data` en claro, listo para `importBackup` (restaurar **reemplazando**). No escribe.
- `pullBackup(sync, fetch)` devuelve un string JSON en claro (compatibilidad).
- `pushData` está **obsoleto**: lanza `NO_KEY` sin clave y `CONFIG` sin `deviceId`, y no pasa a publicar nunca. Usar la cola.
- `testConnection(sync, fetch)` devuelve `{ ok, message, detail, code?, private?, defaultBranch?, warning? }`. `warning` aparece si el repo publica GitHub Pages: mostrarlo.
- `ensureBranch`, `encryptBackup`, `decryptBackup`, `UNKNOWN_PUBLISHER` (`'?'`) y, en `cipher.js`, `generateSyncKey`, `isSyncKey`, `randomId`.
- `calendarUrls(sync)` (`branch ''` → `HEAD`; con la carpeta) → `{ webcal, https, webcals, android }`:
  - `webcal`: iPhone («Suscribirme»);
  - `https`: para «Copiar enlace» (Google Calendar «Desde URL», o pegarlo en ICSx⁵);
  - `android`: `intent://raw.githubusercontent.com/…/turnos.ics#Intent;scheme=webcals;package=at.bitfire.icsdroid;S.browser_fallback_url=<Google Play>;end`. En Chrome abre ICSx⁵ en su pantalla de suscripción (que guarda las alarmas del `.ics`); sin la app, su página de Google Play. No usar el enlace `https` para tocar: raw.githubusercontent.com lo sirve como `text/plain` y Chrome solo muestra el texto. `ICSX5_PACKAGE` y `ICSX5_PLAY_URL` están exportados.
- `parseSetupLink(hash)` devuelve `{ enabled:true, owner, repo, branch, dir, token, key, publishPlaces?, name? }` o `null` (sin `dir` en el enlace → `''`, la raíz). Valida cada campo: `owner` y `repo` con las reglas de GitHub; `branch` como rama de git; `dir` `''` o `[a-z0-9-]{1,32}` (se pasa a minúsculas); `token` con `ghp_` o `github_pat_`; `key` en base64url de 43 caracteres, o vacía; `name` se ignora si no es texto. `normalizeSyncConfig(obj)` hace lo mismo para el formulario, pero **sin** `dir` en la entrada tampoco lo pone en la salida (se conserva la carpeta del dispositivo).
- `buildSetupLink(baseUrl, sync)` incluye `key` (y `publishPlaces` si está activado, `dir` si no es la raíz y `name` si `sync.name` existe). El enlace de la raíz es igual que antes.
- `backup.json` lleva `meta.name` (nombre de pila en claro, solo la primera palabra, solo si hay nombre). **No** va en los datos autenticados: las versiones anteriores siguen leyendo la copia (sigue siendo v3).
- `icsEventCount(text)`: turnos de un `.ics` (sin el aviso «Sube el plan»). La protección «no vaciar un calendario con eventos» (§3.1) ya no cuenta ese aviso.

### 3.6 Varias personas: carpetas, «Calendarios de la familia» y «Crear enlace para otra persona»

```js
const cals = await listCalendars(sync, { fetchImpl? });
// → [{ dir: '' | 'ana', name: 'Mauricio' | null, urls: calendarUrls(...), updatedAt: ISO | null,
//      mine: boolean (es la carpeta de este dispositivo), hasBackup, hasCalendar }]   (la raíz primero)
const p = buildPersonLink(location.href, sync, { name: 'Ana', existingDirs: cals.map((c) => c.dir) });
// → { link, dir: 'ana', key, name: 'Ana', urls }
```

- **`listCalendars`** solo lee (necesita el token; API *contents*): la raíz y las carpetas de primer nivel con nombre válido que tienen `backup.json` o `turnos.ics`. `name` sale de `meta.name` de `backup.json`; si no lo hay (copias de antes de esta versión), de `X-WR-CALNAME` del `.ics` («Turnos de Mauricio» → `'Mauricio'`; «Mis turnos» → `null`). Repo vacío o rama inexistente → `[]`. Errores de GitHub: lanza `SyncError` (`AUTH`, `NETWORK`…; `error.message` para la persona). Para mostrar un calendario sin nombre: «Calendario principal» (raíz) o el `dir`.
- **`buildPersonLink`** (síncrono): carpeta = `uniqueDir(slugify(name), ['', sync.dir, ...existingDirs])` (`'ana'`, `'ana-2'`…), clave **nueva** (`generateSyncKey`), mismo owner/repo/rama/token. No cambia nada en este dispositivo. Lanza `Error` con `code: 'NAME'` («Escribe el nombre de la persona.») y `SyncError` `CONFIG` si este dispositivo no tiene la conexión completa. **Llamar antes a `listCalendars`** para no repetir una carpeta.
- En el teléfono de la otra persona el enlace se abre como cualquier otro (§4.2): la carpeta está vacía, así que su dispositivo pasa a publicar en `<dir>/`. Su nombre se guarda si no tenía.
- **`slugify(text)`**: sin acentos (`'José María'` → `'jose-maria'`, `ß` → `ss`), minúsculas, `[a-z0-9-]`, máx. 32. `uniqueDir(base, taken)`, `isValidDir(dir)`, `cleanPersonName(text)` (espacios normales, máx. 60) y `publicName(text)` (primera palabra).
- Los UID del `.ics` de una carpeta llevan su dominio (`…@turnos-dir-ana`; la raíz sigue con `@turnos-mauricio`, y una carpeta `mauricio` es `@turnos-dir-mauricio`): dos calendarios suscritos en el mismo teléfono no chocan.

### 3.7 Cambiar de calendario: `OTHER_PERSON`, `OTHER_TARGET` y `switchPerson`

Regla: **los turnos (y la clave) de un calendario nunca llegan a otro**. Un calendario es un *destino*: owner + repo + carpeta + rama (`syncTargetId(sync)` → `'mardar91/mauricio-datos/ana:'`; owner y repo sin mayúsculas). Los datos de un dispositivo son «de» un destino en cuanto leyó o publicó allí (`dataTargetOf(sync)`: `sync.boundTarget`, o en datos de antes el configurado si ya leyó o publicó), **aunque luego se desconecte**. Uno que nunca leyó ni publicó tiene turnos «suyos» (Ana escanea antes de tener su enlace) y no se bloquea, salvo por el nombre.

**Cuándo se niega** (`trySetupConfig` / `q.setup`, y `applySyncConfig` sin leer):

| `otherPerson.reason` | `error.code` | Cuándo |
|---|---|---|
| `'folder'` | `OTHER_PERSON` | los datos de aquí son de otra carpeta (`dir`) |
| `'name'` | `OTHER_PERSON` | el calendario nuevo es de otro nombre (`meta.name` de su copia o, sin ella, el `name` del enlace; primera palabra, sin mayúsculas ni acentos) y aquí hay datos de un destino, o turnos y un nombre (solo `trySetupConfig`) |
| `'target'` | `OTHER_TARGET` | los datos de aquí son de otro destino en la misma carpeta: otro owner, repo o rama (p. ej. el formulario avanzado con otro repositorio) |

El mismo destino (otra clave, otro token, otras mayúsculas) nunca se bloquea. Respuesta: `{ ok:false, error: { code, message, detail, retry:false }, res, otherPerson }` con

```js
otherPerson = { reason, name /* del calendario nuevo | null */, dir /* carpeta nueva */,
  current: { name /* de este dispositivo | null */, dir }, working /* sync activa que leyó o publicó */,
  bound /* los datos de aquí son de un destino */, from /* 'Mardar91/mauricio-datos' | null */,
  to /* 'Mardar91/sorella-datos', 'Mardar91/mauricio-datos, carpeta ana' o '…, rama datos' */ }
```

`message` (siempre termina en «No se cambió nada.»):
- `OTHER_PERSON`: «Este enlace es del calendario de Ana y este dispositivo usa el de Mauricio.» · sin nombre aquí: «Este enlace es del calendario de Ana, no del que usa este dispositivo.» · sin datos de un destino (motivo `'name'`): «… y en este dispositivo hay turnos de Mauricio.» · mismo nombre en los dos: «Este enlace es de otro calendario, no del que usa este dispositivo.» · sin nombre del calendario nuevo: `SYNC_MESSAGES.OTHER_PERSON` («Este enlace es del calendario de otra persona.»).
- `OTHER_TARGET`: «Este dispositivo ya tiene el calendario de Mauricio (Mardar91/mauricio-datos). Esta conexión es a otro calendario (Mardar91/sorella-datos).» (sin nombre: «ya tiene otro calendario (…)»).

**Contrato para la UI** (enlace, «Tengo un enlace», formulario avanzado y «Cambiar al calendario conectado»):

```js
let t = await syncQueue.setup(cfg);
if (!t.ok && (t.error.code === 'OTHER_PERSON' || t.error.code === 'OTHER_TARGET')) {
  const ok = await confirmDialog({
    title: t.otherPerson.name ? `¿Cambiar al calendario de ${t.otherPerson.name}?` : '¿Cambiar de calendario?',
    text: `${t.error.message.replace(/\s*No se cambió nada\.$/, '')} ¿Cambiar este dispositivo a ese calendario? Los turnos de ahora no pasan a ese calendario: se guardan como copia y puedes deshacerlo.`,
    ok: 'Sí, cambiar', cancel: 'Cancelar',
  });
  if (!ok) return false;                                     // nada cambió
  const undoKey = saveBeforeImport(store.get(), localStorage); // null: avisar «no se podrá deshacer»
  t = await syncQueue.setup(cfg, { switchPerson: true });      // t.switched === true
  if (!t.ok) { /* borrar la copia undoKey */ alertDialog({ text: t.error.message }); return false; } // nada cambió
}
if (!t.ok) { alertDialog({ title: 'No se pudo conectar', text: t.error.message }); return false; }
// seguir con §4.2 paso 5 (t.readOnly → «¿Usar este…?»; si no, syncQueue.sync()) y el paso «Suscribirme»:
// con otra carpeta, repo o rama la dirección del calendario cambia
// «Deshacer»: const prev = undoImport(localStorage, store.get(), { key: undoKey }); if (prev) store.set(() => prev);
```

- **`switchPerson: true`** solo tras confirmarlo. Parte de `personSwitchState(estado)`: sin días, borrados, códigos, escaneos, cambios, nombre, `planName`, horas, avisos, suplementos ni saldos; se quedan `deviceId`, ntfy y `onboardingDone`. Clave: la del enlace (es la de ese calendario) o **una nueva**; nunca la anterior (`prevKey: ''`). Después adopta lo del calendario nuevo (sus turnos y ajustes, o el `name` del enlace). Sin motivo, `switchPerson` se ignora.
- **Hace falta poder leer el calendario nuevo**: con `switchPerson`, cualquier error al leerlo (también sin red, `NETWORK`) devuelve `ok:false` y no se borra nada. El guardián en sí no necesita la red: sin internet, un dispositivo con datos de otro destino recibe igualmente `OTHER_PERSON`/`OTHER_TARGET`.
- **Después** (sincronizar, «Usar este dispositivo», «Actualizar ahora»): solo se publica lo del calendario nuevo. Un resultado del anterior que llegue tarde no se aplica (`applySyncResult` mira el destino). El calendario anterior queda como estaba (su `backup.json` sigue diciendo que publica este dispositivo hasta que otro haga «Usar este dispositivo»).
- **«Deshacer»:** `undoImport` con la copia de antes de cambiar vuelve al estado anterior **entero** (su conexión, su clave y sus turnos; ntfy y `onboardingDone` los de ahora), nunca importa sus turnos en el calendario nuevo. Con una copia del mismo calendario sigue como siempre (§4.5).
- **`applySyncConfig` directo** lanza `SyncError` con `code` `OTHER_PERSON`/`OTHER_TARGET` y `e.otherPerson` (no mira nombres: no lee); `applySyncConfig(s, cfg, { switchPerson: true })` cambia desde cero. `syncConfigPatch` es de bajo nivel y no comprueba nada, pero conserva `boundTarget`: si la configuración cambia por debajo (`syncConfigPatch` o `updateSettings` con otro owner, repo, rama o carpeta), `syncNow`, `pullOnly` y `becomePublisher` dan `OTHER_TARGET` sin ninguna petición (`lastError` = `SYNC_MESSAGES.OTHER_TARGET`). Para salir: el flujo de arriba con la configuración guardada (`normalizeSyncConfig({ ...sync })`): `OTHER_TARGET` → confirmar → `switchPerson`. Volver a aplicar el destino de los datos (`boundTarget`) lo arregla sin borrar nada.
- `q.setup`: si el estado cambió mientras se comprobaba (otra pestaña conectó otro calendario), devuelve `{ ok:false, error OTHER_PERSON|OTHER_TARGET, otherPerson }` y no guarda nada.
- **Ramas:** una rama nueva se crea desde la rama por defecto y git copia sus archivos (también el `backup.json` de la raíz): para otra persona, otra carpeta (`buildPersonLink`), no otra rama.

**Enlace de la raíz con nombre:** `buildSetupLink(location.href, { ...sync, name: publicName(settings.name) })`. Sin nombre el enlace es el de siempre. Con nombre, el guardián tiene con qué comparar aunque la raíz aún no tenga `meta.name` (el teléfono de Ana con sus turnos → `OTHER_PERSON` «Este enlace es del calendario de Mauricio y en este dispositivo hay turnos de Ana.»), y el teléfono sin nombre lo toma (al publicar, «Turnos de Mauricio»).

---

## 4. Flujos recomendados de la UI

### 4.0 Una sola cola por pestaña

```js
// app.js
const store = createStore(localStorage, { onError });
const syncQueue = createSyncQueue(store);   // fetchImpl = fetch; clock = () => new Date()
// La pasan background.js, setup.js y settings.js (ctx.syncQueue). Nadie llama a syncNow,
// pullOnly, becomePublisher ni trySetupConfig por su cuenta.
```

- La cola ejecuta las llamadas de una en una, en el orden en que se piden, y aplica cada resultado al store en cuanto llega (`applySyncResult`).
- Un `RETRY` se repite solo, una vez guardada la identidad.
- Dos `q.sync()` seguidos sin opciones, mientras el primero aún no ha empezado, se juntan en uno.
- Cada llamada devuelve una promesa con el resultado (§3.3). `q.setup` devuelve el de `trySetupConfig`.
- Entre pestañas, `applySyncResult` descarta los resultados viejos.

### 4.1 Primer uso

- **Sin sincronización** (lo normal al principio): no hay nada que hacer. `sync.enabled` es `false` y la cola no se usa. El onboarding no crea identidad.
- **El dispositivo de quien ayuda** (para crear el enlace):
  1. Configura a mano en «Opciones avanzadas» (owner, repo, token; la clave puede ir vacía) con `normalizeSyncConfig(form)` → `syncQueue.setup(cfg)` (igual que §4.2, pasos 4–6).
  2. Si no hay copia remota, `trySetupConfig` acepta y `apply` crea la clave **antes** de publicar. Después, `syncQueue.sync()` publica y **este dispositivo pasa a publicar**.
  3. Si ya hay copia y no tiene la clave → `NO_KEY`: el enlace se crea desde el teléfono que publica.
  4. Cambiar después de repositorio o de rama en el formulario (con datos de este) da `OTHER_TARGET`: el dispositivo pasa al otro calendario solo tras confirmarlo, sin llevarse nada (§3.7).
- **Crear el enlace:** `buildSetupLink(location.href, store.get().settings.sync)`, en «Opciones avanzadas → Crear enlace de configuración». Solo si `isSyncKey(sync.key)`.
- **Enlace para otra persona** (la hermana): «Opciones avanzadas → Crear enlace para otra persona» → `buildPersonLink` (§3.6). No hace falta otro repo ni otro token.

### 4.2 Abrir un enlace `#setup=`

Al arrancar (`app.js`): `const cfg = parseSetupLink(location.hash)`. Después, limpiar la URL con `history.replaceState`. Si `cfg` es `null`, avisar con «Ese enlace no sirve…».

1. **Safari de iOS sin instalar** (`isIOS() && !isStandalone()`): **no configurar nada**. Mostrar «Copia este enlace y pégalo dentro de la app Turnos (Ajustes → Tengo un enlace)» con el botón **Copiar** (el enlace completo). Fin.
2. **App instalada u otro navegador:** pedir confirmación con `confirmDialog`: «Este enlace conecta la app con GitHub (owner/repo) para que tus turnos aparezcan en el Calendario del iPhone. ¿Lo configuro?».
3. «Ajustes → **Tengo un enlace**» (hoja para pegar) y el formulario avanzado siguen este mismo flujo desde aquí.
4. Comprobar y guardar:

   ```js
   const t = await syncQueue.setup(cfg);      // lee y descifra con una copia; si va bien, guarda (t.apply)
   if (!t.ok) { alertDialog({ title: 'No se pudo conectar', text: t.error.message }); return; } // nada cambió
   ```

   Errores típicos: `DECRYPT` (el enlace trae otra clave: «pide un enlace nuevo»), `NO_KEY`, `AUTH` (token caducado), y `NETWORK` si ya estaba conectado («inténtalo con internet»). `OTHER_PERSON` / `OTHER_TARGET`: el enlace o el formulario es de otro calendario → preguntar y, si dice que sí, `syncQueue.setup(cfg, { switchPerson: true })` (contrato exacto en §3.7).
5. Según quién publica:
   - `t.readOnly` (ya publica otro, p. ej. el navegador de quien ayuda) → `confirmDialog`: «¿Usar este iPhone para actualizar el calendario? El otro dispositivo (por ejemplo, el de quien te ayuda) dejará de hacerlo. Primero se juntan los turnos de los dos.» (Recomendado si este es tu iPhone.)
     - **Sí:** `const r = await syncQueue.becomePublisher()`. Si `!r.ok`, mostrar `r.error.message`.
     - **No:** este dispositivo solo lee (§4.4).
   - si no: `await syncQueue.sync()`. Si no hay copia ni calendario, este pasa a publicar y crea `backup.json` y `turnos.ics`. Si devuelve `EMPTY_LOCAL`, mostrar su mensaje.
   - Sin `backup.json` pero con un `turnos.ics` de otro, `t.readOnly` es `true` (`t.publisher.deviceId === '?'`): se pregunta igual.
6. Ir al paso «Suscribirme en el iPhone» (`calendarUrls(sync).webcal`).

`publishPlaces` del enlace: lo aplica `t.apply` solo si este dispositivo nunca eligió, y con el sello mínimo. Un enlace viejo nunca vuelve a activar los lugares que Mauricio desactivó.

**Cambiar la clave** (lo hace quien ayuda, en este orden):

1. Borrar `backup.json` en GitHub (no `turnos.ics`).
2. En el dispositivo que publica (el que escribió el `turnos.ics` actual), aplicar el enlace con la clave nueva (`syncQueue.setup`). Al no haber copia, se acepta, y como es el mismo repositorio recuerda que ese calendario es suyo.
3. `syncQueue.sync()` vuelve a crear `backup.json` con la clave nueva.
4. Enviar el enlace nuevo a los demás dispositivos. Hasta entonces dan `DECRYPT` y no escriben nada.

- Mientras no hay `backup.json`, cualquier otro dispositivo que sincronice queda en solo lectura (`publisher: '?'`) y no pisa el calendario.
- Un enlace con clave nueva: `buildSetupLink(location.href, { ...sync, key: generateSyncKey() })` (hoy la UI no tiene esa acción: ver «Pendiente en la UI»).
- Si se aplica la clave nueva **antes** de borrar la copia, la sincronización recupera la anterior (`prevKey`) y no cambia nada.

### 4.3 Sincronización de fondo (`ui/background.js`)

```js
async function runSync({ manual = false, force = false } = {}) {
  const s = store.get().settings.sync;
  if (!s.enabled) return null;
  if (isIOS() && !isStandalone() && !manual) return null;   // Safari sin instalar: nunca automático
  const res = await syncQueue.sync(force ? { force: true } : undefined);
  if (manual) toast(res.ok ? (res.readOnly ? 'Datos al día (este dispositivo solo lee).' : 'Calendario actualizado.') : res.error.message);
  if (res.keyRestored) toast('La clave nueva no servía para tus turnos guardados: se sigue usando la anterior.');
  if (!res.ok && res.error.retry) scheduleRetry();           // 1 min, 5 min, 30 min…
  return res;
}
```

- `res.keyRestored` solo ocurre si alguien cambió la clave sin `trySetupConfig` (código viejo o a mano) y la nueva no descifra la copia. Conviene avisarlo, porque quien ayuda puede creer que la clave cambió.

- **Cuándo:** al abrir la app; en `visibilitychange → visible` (después de `store.refresh()`); en `online`; cada 30 min con la app visible; y tras cada cambio de datos con un retardo de unos 4 s.
- **Clave de cambios (`dataKey`):** `days`, `tombstones`, `codes`, `codeTombstones`, `reminders`, y de `sync`: `enabled`, `owner`, `repo`, `branch`, `token`, `key` y `publishPlaces`.
- En `visibilitychange → hidden` y `pagehide`, lanzar ya lo pendiente (iOS puede congelar la app).
- En un dispositivo que solo lee, `syncNow` solo lee: es seguro llamarlo igual.
- «Enviar ahora» (Opciones avanzadas): `runSync({ manual: true, force: true })`.

### 4.4 Solo lectura: banner y «Usar este dispositivo»

Si `isReadOnlyDevice(store.get().settings.sync)`, en Ajustes → Calendario del iPhone:

- **Estado:** «Este dispositivo solo lee; el calendario lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda).» Si `sync.unpublished > 0`, añadir «Hay cambios aquí que no están en el calendario.»
- **Botón «Usar este dispositivo»** →

  ```js
  const ok = await confirmDialog({
    title: '¿Actualizar el calendario desde este dispositivo?',
    text: 'El otro dispositivo dejará de hacerlo. Primero se juntan los turnos de los dos.',
    ok: 'Sí, usar este', cancel: 'Ahora no',
  });
  if (!ok) return;
  const r = await syncQueue.becomePublisher();
  if (r.ok) toast('Listo: ahora el calendario se actualiza desde aquí');
  else alertDialog({ text: r.error.message });   // EMPTY_LOCAL: este dispositivo no tiene turnos
  ```

- **Hoy:** el consejo `read-only` (§7) avisa si se edita aquí. Conviene también un aviso discreto en el editor de días.
- Un resultado viejo no vuelve a mostrar el banner después de «Usar este dispositivo», porque `applySyncResult` lo descarta.

### 4.5 Importar una copia y deshacer

```js
const preview = importBackup(store.get(), text, { now });   // valida; puede lanzar INVALID, NEWER, ENCRYPTED, EMPTY_BACKUP
if (!await confirmDialog({ /* n días de la copia vs. m días del teléfono */ })) return;
const backupKey = saveBeforeImport(store.get(), localStorage, { now });
if (!backupKey && !await confirmDialog({ text: 'No hay espacio para guardar una copia de lo actual: no se podrá deshacer. ¿Importar igualmente?' })) return;
store.set((s) => importBackup(s, text, { now }));           // recalcular DENTRO de set
if (backupKey) toast('Copia restaurada', { action: { label: 'Deshacer', run: () => {
  const prev = undoImport(localStorage, store.get(), { now: new Date(), key: backupKey });
  if (prev) store.set(() => prev);                           // null en un segundo toque: no hacer nada
} } });
```

- Después, la sincronización de fondo publica lo importado si este dispositivo publica. Si solo lee, el consejo `read-only` lo dice.
- `EMPTY_BACKUP`: solo con una confirmación expresa se reintenta con `{ force: true }`.
- `ENCRYPTED`: un `backup.json` se restaura con §4.6.

### 4.6 Restaurar desde GitHub

- **Fusionar** (recomendado): `await syncQueue.pull()`. No pierde lo local más nuevo.
- **Reemplazar:** `const { data } = await fetchRemoteBackup(sync)` y después el flujo de §4.5 con `data` como archivo.

---

## 5. Importar y exportar

- **`exportBackup(state, { now })`:**
  - No lleva token, clave, `settings.sync` ni `settings.ntfy`.
  - Lleva los ajustes del usuario (`name`, `planName`, horas, `reminders` con `planUpload`, `supplements`, `balances`…), `publishPlaces`, `onboardingDone`, `codes` (con `travelMin`), `days` (con sus `times`), `tombstones`, `codeTombstones`, `scans` y `changes`.
  - Con `__newerSchema` lanza un `Error` con `code: 'NEWER'`.
- **`importBackup(state, jsonOrObject, { now, force })`:**
  - No toca `settings.sync` (incluidos `publishPlaces`, la carpeta y la clave), `settings.ntfy` ni un `onboardingDone: true`.
  - En un teléfono **ya conectado** (sync activa que ya leyó o publicó), lo importado pasa a ser lo más nuevo: se sella con `now` y los días que faltan quedan como borrados. Un día cuenta como igual solo si coinciden códigos, nota y horario especial.
  - En uno **sin conectar** se conservan las fechas de la copia.
  - Un borrado nunca retrocede.
  - Lanza `INVALID` (p. ej. «Este archivo no es una copia de Turnos.»), `NEWER`, `ENCRYPTED` o `EMPTY_BACKUP`.
- **`saveBeforeImport` / `listBeforeImport` / `undoImport`:**
  - `saveBeforeImport` guarda como mucho 3 copias y devuelve `null` si no pudo guardar.
  - `undoImport` **exige** la `key` de esa importación; devuelve `null` si falta o si la copia ya no existe.
  - Si la copia es de otro calendario que el de ahora (se guardó antes de `switchPerson`), `undoImport` devuelve el estado anterior entero, con su conexión y su clave (§3.7).

---

## 6. Mutaciones, códigos y calendario

- `setDay(state, key, codes, { note, source, times, now })`: ver §6.1 para `times`. Devuelve **el mismo** `state` si no cambia nada.
- `clearDay(state, key, { now })` deja una tombstone (y se lleva el horario especial); `setDay` la quita.
- `upsertCode(state, def, { now })`:
  - sin cambios reales devuelve **el mismo** `state`;
  - si cambia el tipo del código, reordena (sin sellar) los días que lo usan;
  - lanza error si hay fin sin inicio, y acepta solo inicio;
  - si cambian las horas y el turno queda en 6 h o menos, una pausa de 30 pasa a 0.
- `deleteCode(state, code, { now })`: uno de fábrica vuelve a su definición original; uno propio deja una tombstone (y una definición supuesta si algún día lo usa). También reordena los días.
- `updateSettings(state, patch, { now })`:
  - es una mezcla profunda; `null` borra los campos que por defecto son `null`;
  - un número escrito como texto («18,75», «1,5», «30») vale para un campo numérico (también si ya tenía un número); un texto que no es un número se ignora. Igual al importar una copia;
  - los sellos de avisos y lugares se ponen solos, salvo que vengan explícitos;
  - si una clave buena se sustituye, la anterior queda en `prevKey`, salvo que el parche diga qué hacer con `prevKey`.
- `mergeStates(local, remote, { now, since, adoptSettings })`: por día y por código gana el `updatedAt` más reciente (el día entero, con su nota y su horario especial, es la unidad). Al final deja el orden canónico de los días, con los tipos ya fusionados. Con `adoptSettings` toma del remoto nombre, `planName`, horas, suplementos y saldos solo donde aquí están vacíos o de fábrica (§1).
- **Saneado de lo importado o cargado:**
  - colores solo `#RGB` o `#RRGGBB`;
  - de los códigos solo los campos conocidos;
  - longitudes máximas;
  - sin las claves `__proto__`, `constructor` ni `prototype`.
- **Códigos de fábrica:** los del SPEC §2 y **`K`** (Enfermedad: `kind 'sick'`, texto rojo `#D21F1F`, forma `'text'`, sin horario). Como las vacaciones, acredita el objetivo del día en días con objetivo (`dayMinutes` → `credited`), va al `.ics` como evento de día completo sin alarma y no es día libre en los consejos. Borrarlo lo restablece. Un `K` guardado antes por el usuario (p. ej. como código supuesto) se conserva tal cual. Ojo: `Object.keys(state.codes)` (los `knownCodes` del escaneo) ahora incluye `K`.
- **`guessCode`:**
  - letra + 1 dígito → `shift` (F, S, N y Z copian F1, S1, N1 y Z1);
  - letra + 2 dígitos → `place`;
  - el resto → `other`, sin horario y sin confirmar.
- **Códigos con hora:** `isTimedCode`, `dayTimedItems` (`startOnly` si no hay fin; `special` si el día tiene horario especial), `timedInterval` y `countsAsWork`. `shiftInterval`, `timedInterval`, `dayTimedItems` y `dayMinutes` ya usan el horario especial del día.
- **`buildICS(state, { from, to, now, notes = false, places = true })`:**
  - sin notas por defecto;
  - el rango empieza en `defaultIcsFrom(now)`, el día 1 del mes de hace 2 meses;
  - `DTSTAMP` y `LAST-MODIFIED` son estables y `SEQUENCE` nunca retrocede (un horario especial cambia el `updatedAt` del día: sube la `SEQUENCE` solo de ese día);
  - con horario especial, el evento va a esa hora, las alarmas se calculan desde ella y la descripción dice «Horario especial de este día»;
  - `X-WR-CALNAME`: `calendarName(state)` = «Turnos de <primera palabra de name>» o «Mis turnos»; `PRODID:-//Turnos//ES`; UID con `uidDomain(state)` (`turnos-mauricio` en la raíz, `turnos-dir-<dir>` en otra carpeta);
  - con viaje, la alarma «antes» se adelanta (§6.2) y la descripción dice «Viaje: sal a las …»;
  - incluye el aviso «Sube el plan» (§6.3) si toca;
  - para el `.ics` manual de Ajustes, usar `buildICS(state, { now })`.

### 6.1 Horario especial de un día (`DayEntry.times`)

```js
// Guardar (el código S1 no cambia: solo ese día)
store.set((s) => setDay(s, key, codes, { note, times: { S1: { start: '15:00', end: '20:00', breakMin: 0 } } }));
// Leer el horario que vale ese día
effectiveTimes(state, key, 'S1')   // → { start:'15:00', end:'20:00', breakMin:0, special:true }
                                   //   sin horario especial: el del código y special:false
getDayCode(state, key, 'S1')       // → CodeDef de ese día (start/end/breakMin del día, confirmed:true, special:true)
allowsSpecialTimes(def)            // false para lugares, libres, «W-», vacaciones y baja
```

- **`setDay(..., { times })`:**
  - `times` = `{ CODE: { start, end, breakMin? } }`. Lanza `Error` en español si una hora no es `HH:MM`, si inicio y fin son iguales o si la pausa no está entre 0 y 240.
  - Solo guarda los de códigos que están en el día y que admiten horario (`allowsSpecialTimes`); los demás se ignoran.
  - Uno igual al horario normal del código (inicio, fin y pausa) no se guarda (no es especial).
  - `times` sin indicar (`undefined`) = se conservan los que había. `null` o `{}` = se quitan todos.
  - Quitar un código del día quita su horario especial (y volver a ponerlo no lo recupera).
  - Cambiar solo el horario especial sella el día (`updatedAt`): se publica y se fusiona como cualquier cambio del día.
- **Pausa:** la indicada; si no se indica, la del código, salvo que el día dure 6 h o menos y el código tenga la de 30 min → 0 (como `upsertCode`).
- **Fin antes que el inicio** = termina al día siguiente (como los códigos). La noche cuenta para el día en que empieza.
- **Un código sin horario** (p. ej. `TS`) con horario especial pasa a tener hora ese día: aviso y evento con hora (cuenta horas solo si el código tiene `countsHours`).
- **Qué lo usa:** `shiftInterval`, `timedInterval`, `dayTimedItems`, `dayMinutes`, `weekSummary`, `monthSummary` (horas y noches), `getAdvice` (descanso, solapes, noches, rachas; un turno sin confirmar con horario especial ese día no pide confirmar), `upcomingReminders`, `syncNtfy` (mismo `sequence_id`: se reprograma) y `buildICS`.
- **Saneado al cargar o importar:** se descartan los de códigos que no están en el día, las horas inválidas o iguales, y las pausas fuera de rango.

### 6.2 Tiempo de viaje y mapas (SPEC §13.2)

```js
upsertCode(state, { code: 'F51', place: 'Karl-Marx-Str. 1', travelMin: 25 })   // 0..180 (se recorta)
dayTravel(state, '2026-10-13')   // → { minutes: 25, code: 'F51', def, to: CodeDef del lugar | null }
dayTimedItems(state, key)        // cada item lleva travelMin, leaveAt (Date | null), travelTo ('F51' | null)
travelText(item)                 // → 'Sal a las 13:05 hacia F51 (25 min de viaje)'  ('' sin viaje)
travelText(item, { places: false })   // → 'Sal a las 13:05 (25 min de viaje)'
mapsUrl(def | 'dirección', platform)   // iOS → https://maps.apple.com/?q=…; resto → Google Maps; null sin dirección
```

- **Viaje del día** = el mayor `travelMin` de sus códigos (lugar o turno). El destino («hacia F51») es ese código si es un lugar; si no, el primer lugar del día.
- Se aplica **solo al primer turno o evento con hora del día** (el que empieza antes): es el viaje de ida. Los demás del mismo día llevan `travelMin: 0`.
- **Aviso «antes»:** a la hora `inicio − viaje − minutesBefore` (con `minutesBefore: 0`, a la hora de salir):
  - `upcomingReminders` (y ntfy): `title` «Sal a las 13:05 hacia F51 (25 min de viaje)», `body` «… · empieza a las 13:30 · 📍 F51», etiqueta `walking`. El aviso de la víspera no cambia de hora y añade «· Sal a las 13:05».
  - `.ics`: `TRIGGER` = viaje + `minutesBefore`; texto «Sal a las 13:05 hacia F51 (25 min de viaje) · S1 Tarde a las 13:30». **Sin** `publishPlaces` no dice adónde (ni el código del lugar ni la dirección).
- El `id` del recordatorio no cambia (`…-pre`): al cambiar el viaje, ntfy lo reprograma.

### 6.3 Aviso «📷 Sube el plan de <mes>» (SPEC §13.1)

```js
planUploadReminder(state, now)
// → null | { id: 'plan-2026-11', year: 2026, month: 11, key: '2026-10-20', start, end, moved, stamp,
//            title: '📷 Sube el plan de noviembre', body }
```

- Solo si `reminders.planUpload !== false` y el mes siguiente **no tiene ningún día cargado** (los borrados no cuentan como cargados).
- El día 20 del mes actual a las 19:00, 15 min. Si eso ya pasó: **hoy** a las 19:00 si aún no ha llegado; si no, **mañana** a las 19:00, si mañana sigue siendo este mes (`moved: true`). Así la sincronización de cada mañana deja un aviso que suena ese mismo día, también el último del mes (pasadas sus 19:00, nada).
- En el `.ics`: `UID:plan-YYYY-MM@<dominio>` (estable por mes), `TRANSP:TRANSPARENT`, una alarma al inicio (`-PT0M`). Del 1 al 20 (hasta las 19:00) el contenido es estable; después cambia una vez al día, a las 19:00, cuando el aviso pasa al día siguiente (`stamp` = las 19:00 del día anterior al aviso: sube la `SEQUENCE` y nunca es futuro). Desaparece al cargar ese mes.
- No cuenta como turno para la protección «no vaciar el calendario» (`icsEventCount`). No se manda por ntfy.

### 6.4 Suplementos (SPEC §13.3)

```js
monthSummary(state, 2026, 10).supplements   // = monthSupplements(state, 2026, 10)
// → { night: { minutes, pct, from, to, euros }, saturday: { minutes, pct, from, to, euros },
//     sunday: { minutes, pct, euros }, holiday: { minutes, pct, euros },
//     hourlyWage: number | null, euros: number | null }      // euros: null sin salario por hora
daySupplements(state, key)      // → { night, saturday, sunday, holiday } (minutos enteros)
supplementSettings(state)       // ajustes completos (con los valores por defecto)
SUPPLEMENT_DEFAULTS, SUPPLEMENT_NOTE, sanitizeSupplements(obj), intervalSupplementMs(start, end, cfg)
updateSettings(s, { supplements: { night: { pct: 25 }, hourlyWage: 18.5 } })   // null borra el salario
```

- **Por defecto** (orientativos; mostrar `SUPPLEMENT_NOTE`: «Valores orientativos (promedio de Berlín en el sector de los cuidados). Comprueba tu contrato.»): noche 23:00–06:00 **26 %**, sábado 13:00–21:00 **0 %**, domingo **33 %**, festivo **40 %**, sin salario. Son los promedios de Berlín de los suplementos típicos de los cuidados (lista de las cajas de cuidados según el §82c SGB XI, a 30/09/2026): noche como mínimo de 23 a 6 h; festivo con día libre a cambio (sin él, 134 %). El sábado no es obligatorio.
- **Qué cuenta:** los turnos que cuentan horas (`countsAsWork`, con su horario especial). Cada minuto según su hora real y su **día de calendario**: una noche de domingo a lunes es domingo hasta las 24:00; un festivo que cae en sábado o domingo cuenta solo como festivo; la noche se suma aparte (se combina con las demás). Festivos de Berlín (`isHoliday`).
- **Pausa** descontada en proporción: minutos × (trabajo / duración). Ej.: N1 de domingo (22–6 h, pausa 30): domingo 120 × 450/480 = 113, noche 420 × 450/480 = 394.
- **Cambio de hora:** se mide tiempo real (la noche del 25 oct dura 9 h; la del 29 mar, 7 h).
- El mes suma los turnos que **empiezan** ese mes y redondea al final (puede diferir en 1 min de sumar los días redondeados).
- **€** = horas × salario × % (al céntimo). `pct` admite un decimal (0–300); `hourlyWage` hasta 500 (admite «18,75»). Las franjas aceptan `HH:MM`; si `to <= from` cruza la medianoche; `from === to` = sin franja.

### 6.5 Saldos (SPEC §13.4)

```js
overtimeBalance(state, { now, through? })
// → { startMonth: 'YYYY-MM' | null, auto, startMin, through: 'YYYY-MM-DD', balance (minutos),
//     months: [{ month, year, month1, from, to, days, daysKnown, complete, current, total, soll, diff, cumulative }] }
vacationSummary(state, year, { now })
// → { year, entitlement, carryOver, total, used, planned, remaining, usedDays: [key], plannedDays: [key] }
updateSettings(s, { balances: { overtimeStartMin: 90, overtimeStartMonth: '2026-09', vacationDaysPerYear: 30, vacationCarryOver: 2.5 } })
BALANCE_DEFAULTS, sanitizeBalances(obj), balanceSettings(state), isMonthKey('2026-10'), nextMonthKey('2026-12')
```

- **Saldo de horas:** empieza con `overtimeStartMin` (puede ser negativo) en `overtimeStartMonth` (sin él: el primer mes con plan, `auto: true`) y suma mes a mes `total − objetivo` hasta **hoy incluido** (`through`). Solo cuentan los **días con plan**: un día sin cargar no suma horas ni resta su objetivo (no se inventan horas); `complete: false` lo indica. El mes en curso va hasta hoy (`current: true`). Un mes inicial en el futuro → `months: []` y `balance = overtimeStartMin`.
- **Vacaciones:** usadas = días con un código de vacaciones (`kind 'vacation'`, p. ej. `U`) que tienen objetivo (laborable y no festivo), hasta hoy incluido; planificadas = después de hoy. `remaining = vacationDaysPerYear + vacationCarryOver − usadas − planificadas`. La enfermedad (`K`) no gasta vacaciones. El arrastre se suma al año que se consulta (la UI muestra el año en curso).
- Valores: `vacationDaysPerYear` y `vacationCarryOver` 0–366 en medios días (admiten «1,5»); `overtimeStartMin` entero (±100 000 h).

---

## 7. Consejos (`getAdvice`)

`getAdvice(state, now, { platform })`: con `platform: 'ios'` los textos dicen «Calendario del iPhone» / «el iPhone»; con `'android'`, `'desktop'` o sin indicar, «calendario del teléfono» / «el teléfono». Pasar la plataforma que detecta la UI.

`action.section` es `'calendar'` (= `#set-calendar`). La UI llama a `go(tab, { section })`; Ajustes hace scroll a `#set-<section>`.

| `id` | Nivel | Qué es |
|---|---|---|
| `sync-error` | `alert` si no es pasajero | «Tu calendario no se está actualizando». Va el primero en Hoy. |
| `sync-error` | `warn` si es pasajero | Solo si falla desde hace más de 24 h. `RETRY` cuenta como pasajero, aunque nunca se anota como error. |
| `sync-error` | `info` si es pasajero y nunca conectó | «Todavía no se pudo conectar el calendario…» |
| `read-only` | `warn` | Otro dispositivo publica y aquí hay cambios sin publicar (también si solo cambió un horario especial). |
| `month-YYYY-MM` | `info` | Balance del mes. Con el mes completo: «Tienes justo las horas de tu objetivo (154 h).» si la diferencia es menor de 15 min; si no, «Tienes 157 h 30 planificadas: +3 h 30 sobre tu objetivo (154 h).» o «…: 5 h menos que tu objetivo (154 h).». Con días sin cargar no da diferencia: «Por ahora tienes X planificadas de tu objetivo de Y, pero faltan N días por cargar.» |
| `reminders-off` | `info` | Sin sync ni ntfy. |
| `gaps-<fecha>` | `info` | «Faltan días en el plan». |
| `newer-schema` | `alert` | «Actualiza la app». |

---

## 8. ntfy (opcional)

- El aviso «mantener recordatorios» se titula «Abre la app Turnos» y no lleva enlace.
- `testNtfy`: título «Turnos» y «Mira tu teléfono» (lo usan las dos personas). `randomTopic()` sigue dando `turnos-mauricio-xxxxxxxxxxxx`.
- Con viaje, el aviso «antes» sale antes y dice «Sal a las …» (§6.2).
- En iPhone/iPad, `syncNtfy` y `testNtfy` no añaden `click` salvo que se pase `{ appUrl }`.

---

## 9. Tests e2e

Los mocks de GitHub deben simular:

- `backup.json` **v3** (`meta.publisher`, `meta.publisherSince`), con PUT que exige el `sha`;
- `turnos.ics` sin `?ref=` cuando `branch` es `''`. El que publica hace GET de `turnos.ics` en cada sincronización. Si difiere, hace **otro GET de `backup.json`** y después el PUT;
- `commit.sha` y `content.sha` en las respuestas de PUT;
- `409`/`404` en `git/ref` para repos vacíos;
- con carpeta (`dir`), las mismas rutas con el prefijo (`contents/ana/backup.json`, `contents/ana/turnos.ics`), y para `listCalendars` el listado de carpetas (`GET contents` y `GET contents/<dir>` → `[{ type: 'file'|'dir', name }]`; `404` en un repo vacío).

Además:

- un dispositivo que solo lee no hace ningún PUT ni POST;
- la primera sincronización de un estado sin `deviceId` o sin clave no escribe nada (`RETRY`) si no se usa `ensureSyncIdentity` o la cola;
- los enlaces de prueba usan un token con formato real (`` `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}` ``).

`test/unit/helpers.mjs` (`fakeGitHub`, con listado de carpetas; `multiRepo` para varios repositorios) es una referencia completa. Los escenarios de esta ronda: varias personas en `test/unit/people.test.mjs` y `person-switch.test.mjs` (enlace de otra persona, adopción de ajustes), cambio de destino en `target-switch.test.mjs` (`OTHER_TARGET`, `switchPerson`, «Deshacer», enlace de la raíz con nombre, «nunca, por ningún camino»), la tabla del PC con la foto real y `employeeName` en `recognize-pc-photo.test.mjs` (Chromium; se salta sin Playwright), suplementos en `supplements.test.mjs`, saldos en `balances.test.mjs`, viaje y «Sube el plan» en `travel-plan.test.mjs`. Los de rondas anteriores: `sync-recheck3.test.mjs`, `sync-recovery.test.mjs` y `day-times.test.mjs` (horario especial).

Un `.ics` puede llevar ahora el evento «Sube el plan» (`UID:plan-…`): al contar turnos en un test, no contarlo (`icsEventCount`).
