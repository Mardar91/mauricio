# Cambios en `docs/js/core` que la UI debe adoptar

Este documento describe la API final de la lógica (SPEC §9 y §10, más la decisión del dueño: **un solo dispositivo publica**). Todo se exporta desde `core/index.js`, que también reexporta `cipher.js`.

> **`docs/sw.js`:** ya precarga `js/core/cipher.js`. Esta ronda no añade módulos, pero cambió el código de `js/core/*`: hay que **subir `VERSION`** (y `APP_VERSION` en `js/app.js`) al publicar.

## Lo nuevo de esta ronda (resumen)

1. **Un solo dispositivo publica** en GitHub (`backup.json` y `turnos.ics`). Los demás solo leen y fusionan en local. Funciones nuevas: `becomePublisher` e `isReadOnlyDevice`. `syncNow` devuelve `readOnly` y `publisher` (§3).
2. `undoImport` **exige** `key` (la que devolvió `saveBeforeImport`). Sin ella devuelve `null` (§4).
3. Las secciones de los consejos usan `section: 'calendar'` (= `#set-calendar`), no `'calendario'` (§6).
4. `updateSettings` ya **puede borrar** con `null` los campos que por defecto son `null` (`lastError`, `lastPushAt`…). Antes `null` se ignoraba y un error de sincronización no se borraba nunca.
5. `importBackup` solo sella lo importado como «lo más nuevo» si el teléfono **ya está conectado** (§4).
6. `exportBackup` lanza `NEWER` si los datos son de una versión más nueva de la app (§4).
7. Los avisos (`reminders`) y `publishPlaces` se **comparten** entre dispositivos: gana el cambio más reciente (§1).
8. `upsertCode` sin cambios reales devuelve **el mismo** estado (§5).
9. Consejos nuevos o cambiados: `read-only`, y `sync-error` suave la primera vez (§6).

---

## 1. Estado (`State`): campos nuevos

| Campo | Qué es |
|---|---|
| `state.tombstones` | `{ 'YYYY-MM-DD': ISO }`. Días borrados. `clearDay` añade una entrada, `setDay` la quita. Se podan a los 120 días al guardar. |
| `state.codeTombstones` | `{ CODE: ISO }`. Códigos propios borrados con `deleteCode`. |
| `state.__newerSchema` | `true` si los datos vienen de una versión más nueva de la app. No se guarda (se recalcula al cargar). Se conservan los campos y los tipos de código desconocidos. La UI debe pedir **«Actualiza la app»** (también lo hace el consejo `newer-schema`). |
| `CodeDef.updatedAt` | ISO o `null`. Se rellena en `upsertCode` (solo si algo cambia) y en `deleteCode`. |
| `DayEntry.updatedAt` | Se rellena siempre al cambiar (también si solo cambia la nota). |
| `settings.calendarUpdatedAt` | ISO o `null`. Cambia cuando cambian `reminders` o `sync.publishPlaces`. El `.ics` lo usa para que su sello y su `SEQUENCE` nunca retrocedan. |
| `settings.remindersUpdatedAt` | ISO o `null`. Cuándo se cambiaron los avisos. Al fusionar dispositivos gana el cambio más reciente. |
| `settings.placesUpdatedAt` | ISO o `null`. Lo mismo para `sync.publishPlaces`. |

Los tres sellos los pone `updateSettings`. La UI no tiene que tocarlos.

### `settings.sync`

Valores por defecto:

```js
{ enabled:false, owner:'Mardar91', repo:'mauricio-datos', branch:'', token:'', key:'', deviceId:'',
  baseRev:0, lastPushAt:null, lastPushHash:null, lastIcsHash:null, lastPullAt:null,
  lastError:null, lastErrorCode:null, lastErrorDetail:null, lastErrorSince:null, publishPlaces:false,
  publisher:null, publisherSince:null, unpublished:0 }
```

- `branch: ''` significa la rama por defecto del repo.
- `repo` por defecto es `'mauricio-datos'`: un repo **solo de datos**, nunca el de la app.
- `key`: clave AES-GCM en base64url (43 caracteres). `deviceId`: identificador aleatorio de este dispositivo. `syncNow` genera los dos si faltan.
- `lastError` es el mensaje para Mauricio. `lastErrorCode` es el código (ver §3). `lastErrorDetail` es el detalle técnico, que solo debe verse en «Opciones avanzadas». `lastErrorSince` dice desde cuándo falla (se borra al ir bien).
- `publishPlaces`: el interruptor «Publicar lugares en el calendario». Desactivado = sin LOCATION y sin códigos de lugar en el `.ics`. **Se comparte** entre dispositivos (gana el cambio más reciente).
- `publisher` / `publisherSince`: qué dispositivo publica y desde cuándo, según la última lectura. `isReadOnlyDevice(sync)` es `true` si es otro dispositivo.
- `unpublished`: en un dispositivo que solo lee, cuántos cambios de aquí no están publicados y no llegan al calendario. Cuenta días, definiciones de códigos y 1 más si los avisos o `publishPlaces` difieren.

---

## 2. Store (`createStore`)

```js
const store = createStore(localStorage, { onError, target = window, now });
store.get(); store.set(fn) /* → state */; store.subscribe(fn) /* → unsubscribe */;
store.refresh()   // vuelve a leer localStorage; true si cambió (y notifica a los suscriptores)
store.onError(fn) // → unsubscribe. fn({ type:'save', code:'QUOTA'|'BLOCKED'|'NO_STORAGE', message, detail })
store.saveOk()    // false si la última escritura falló
store.lastSave()  // { ok, error, at }
store.destroy()   // quita el listener 'storage' (tests)
```

- **Varias pestañas.** El store escucha el evento `storage` de `window` y se recarga solo. Además, cada `set()` relee lo guardado antes de aplicar el cambio. La UI solo tiene que llamar a `store.refresh()` en `visibilitychange → visible` y en `pageshow`.
- **Guardado fallido.** Si falla (cuota llena, almacenamiento bloqueado), `set()` primero libera espacio (copias corruptas y copias de importación antiguas) y reintenta. Si sigue fallando, llama a `onError` (el de las opciones y los de `store.onError`). La UI debe:
  - mostrar un banner rojo persistente con `message` (`SAVE_ERROR`) y un botón «Exportar copia»;
  - comprobar `store.saveOk()` antes de mostrar «Guardado»; si es `false`, mostrar un error.
- **JSON corrupto.** Se guarda una sola copia por contenido en `turnos-mauricio:corrupt:<ts>`, con un máximo de 3.
- **Datos de una versión más nueva.** Hay una copia intacta en `turnos-mauricio:newer-schema`. Se renueva cada vez que la versión nueva guarda algo distinto, pero no con lo que reescribe esta versión.

---

## 3. Sincronización: un solo dispositivo publica

### La regla

- Solo **un** dispositivo escribe en GitHub: `backup.json` y `turnos.ics`. Es el que figura en `backup.json` → `meta.publisher` (con `meta.publisherSince`).
- **Cualquier otro** dispositivo, al sincronizar, lee, descifra y **fusiona en local** (así tiene los datos al día), pero **nunca escribe**. Da igual que tenga cambios más nuevos, que se pase `force` o `allowEmpty`.
- **Si no hay copia todavía**, el primer dispositivo que sincroniza pasa a publicar.
- **Para cambiar de dispositivo**: `becomePublisher`. Primero lee y fusiona; después publica con `publisher` = este dispositivo y `rev + 1`. Llamarlo **solo después de que Mauricio lo confirme**.
- Una pestaña vieja de Safari, o un móvil olvidado, no puede cambiar el calendario. Solo puede ponerse al día.
- Los cambios hechos en un dispositivo que solo lee **se quedan en ese dispositivo**. Llegan al calendario si ese dispositivo pasa a publicar (se fusionan por fecha).

### API

```js
const res = await syncNow(state, { fetchImpl?, now?, force?, allowEmpty? }); // lee + fusiona; publica SOLO si es el que publica
const res = await pullOnly(state, opts);          // lee y fusiona; NUNCA escribe (alias: restoreFromRemote)
const res = await becomePublisher(state, opts);   // «Usar este dispositivo»: lee + fusiona + publica con publisher = este
store.set((cur) => applySyncResult(cur, res));    // SIEMPRE así, también si res.ok es false
isReadOnlyDevice(store.get().settings.sync);      // true → otro dispositivo publica
```

`syncNow`, `pullOnly` y `becomePublisher` **nunca lanzan**. Devuelven:

```js
{
  ok,              // true si todo fue bien (también si solo leyó)
  readOnly,        // true → otro dispositivo publica: aquí solo se leyó (no se escribió nada)
  publisher,       // { deviceId, since } | null  (null: aún no hay copia → este publicaría)
  tookOver,        // true si becomePublisher cambió de dispositivo
  state,           // estado fusionado (el mismo objeto si no cambió nada)
  merged,          // true si se trajeron cambios del remoto
  pulled,          // true si se leyó y descifró el remoto
  pushed,          // true si se publicó backup.json (rev nueva)
  icsPushed,       // true si se escribió turnos.ics
  conflictCount,   // días cambiados en los dos lados desde la última sincronización
  pulledDays,      // ['YYYY-MM-DD', …] días que vinieron del remoto
  unpublishedDays,     // solo si readOnly: días de aquí distintos de lo publicado (no llegan al calendario)
  unpublishedCodes,    // solo si readOnly: códigos cuya definición (horario…) difiere de lo publicado
  unpublishedSettings, // solo si readOnly: true si los avisos o publishPlaces de aquí difieren
  rev,
  remote: { rev, days, savedAt, deviceId, publisher, legacy } | null,
  sync,            // PARCHE para settings.sync (deviceId, key, baseRev, lastPushHash, lastIcsHash, lastPushAt,
                   // lastPullAt, publisher, publisherSince, unpublished, lastError, lastErrorCode,
                   // lastErrorDetail, lastErrorSince)
  error: { code, message, detail, status, retry } | null,
  target: { owner, repo, branch, keyTag }
}
```

- **`applySyncResult(current, res, { now })`** fusiona `res.state` con el estado **actual** (lo editado mientras se sincronizaba no se pierde) y aplica `res.sync`. Hay tres casos en que no aplica algo:
  - si `owner`, `repo` o `branch` cambiaron entre medias, no hace nada;
  - un `deviceId` o una `key` nuevos de un resultado que **no** publicó no sustituyen a los ya guardados (carrera entre pestañas);
  - el error de una sincronización que empezó con otra clave se descarta.
- **Qué hace por dentro**, en este orden:
  1. Lee `backup.json`. Si existe, **siempre** lo descifra (así comprueba la clave) y fusiona por día y por código: gana el `updatedAt` más reciente, y los borrados cuentan como versión. Los avisos y `publishPlaces` también se fusionan (gana el cambio más reciente). El resto de ajustes es del dispositivo; uno vacío adopta además nombre y horas.
  2. Si otro dispositivo publica, termina aquí (`readOnly: true`).
  3. Si este publica: escribe `backup.json` solo si hay algo nuevo (datos o ajustes compartidos), con `rev + 1` y comprobando el `sha`. Si otro escribió entre medias, relee y vuelve a fusionar (hasta 3 intentos). Si al releer resulta que ya publica otro, pasa a solo leer.
  4. Lee `turnos.ics` publicado y lo reescribe **si es distinto**: así el que publica repara un calendario que dejó atrasado una pestaña congelada. Va sin notas, con lugares solo si `publishPlaces`. El rango empieza el día 1 del mes de hace 2 meses.
- **Nunca** publica 0 días encima de un remoto con días (`EMPTY_LOCAL`), salvo con `allowEmpty: true`. Úsalo solo tras una confirmación explícita del tipo «sí, vaciar el calendario».
- `force: true` vuelve a publicar aunque no haya cambios, para «Enviar ahora» en Opciones avanzadas. En un dispositivo que solo lee **no escribe nada**: mostrar el estado de solo lectura.
- **Repo vacío y ramas.** En un repo vacío, los archivos se crean en la rama por defecto. Si se indicó una rama que no existe, se crea desde la por defecto, salvo en `pullOnly` y `fetchRemoteBackup`, que no crean nada.
- **Formatos antiguos.**
  - Un `turnos.json` en claro se fusiona y se migra.
  - Un `backup.json` **v2** (sin `publisher`) se lee. Publica quien lo escribió por última vez (`meta.deviceId`), y al publicar se pasa a v3.
  - Una app vieja que solo entiende v2 ve `NEWER_REMOTE` («Actualiza la app») y no escribe.

### UI de «solo lectura» (Ajustes → Calendario del iPhone)

Si `isReadOnlyDevice(sync)` o `res.readOnly`:

- **Estado:** «Este dispositivo solo lee; el calendario lo actualiza tu otra app». Si `sync.unpublished > 0`, añadir: «Hay cambios aquí que no están en el calendario». Tras una sincronización, `res.unpublishedDays` da la lista de días.
- **Botón «Usar este dispositivo»** → confirmación. Texto sugerido:
  > «¿Actualizar el calendario desde este dispositivo? Tu otra app dejará de hacerlo. Primero se juntan los turnos de los dos.»

  Si Mauricio confirma:

  ```js
  const res = await becomePublisher(store.get());
  store.set((cur) => applySyncResult(cur, res));
  if (res.ok) toast('Listo: ahora el calendario se actualiza desde aquí');
  else showError(res.error.message);
  ```

- Las ediciones en un dispositivo que solo lee se guardan en local. Avisar con el consejo `read-only` (§6). Conviene un aviso discreto en el editor de días.

### Errores

Cada error trae `message` (humano, sin jerga y sin pedir tokens), `detail` (técnico, para quien ayuda) y `retry` (`true` si es pasajero).

| `code` | Cuándo | `retry` |
|---|---|---|
| `CONFIG` | falta `owner`, `repo` o `token`, o tienen caracteres no válidos | no |
| `NO_KEY` | hay copia cifrada y este dispositivo no tiene la clave (hace falta un enlace con clave) | no |
| `DECRYPT` | la clave no coincide, o los metadatos (incluido quién publica) se alteraron. **No se escribe nada** | no |
| `AUTH` | 401 (token caducado): «La conexión del calendario ha caducado…» | no |
| `FORBIDDEN` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `INVALID` | 422 | no |
| `UNKNOWN` | otro error | no |
| `RATE_LIMIT` | 403/429 por límite de peticiones | sí |
| `SERVER` | 5xx | sí |
| `NETWORK` | sin red | sí |
| `CONFLICT` | `sha` cambiado 3 veces seguidas, o dos pestañas en la primera sincronización (la que pierde no guarda su clave) | sí |
| `BAD_REMOTE` | `backup.json` dañado (o v3 sin `meta.publisher`) | no |
| `NEWER_REMOTE` | el remoto es de una versión más nueva de la app | no |
| `NEWER_LOCAL` | este estado tiene `__newerSchema` | no |
| `EMPTY_LOCAL` | ver arriba | no |
| `NO_REMOTE` | solo en `fetchRemoteBackup` y `pullBackup` | no |

Los textos están en `SYNC_MESSAGES`. `SyncError` tiene `.code`, `.detail`, `.status` y `.retry`.

- **Hoy:** el consejo `sync-error` ya avisa (ver §6).
- **Ajustes → Calendario del iPhone:** si `lastErrorCode` no es pasajero, mostrar `lastError` y el botón **«Tengo un enlace nuevo»** (`openPasteSetup`), aunque ya haya configuración.
- **Opciones avanzadas:** mostrar `lastErrorDetail`.

### Otras funciones de sync.js

- `fetchRemoteBackup(sync, fetch)` devuelve `{ rev, meta, data }`, con `data` = la copia en claro lista para `importBackup` (restaurar **reemplazando**). Lanza `SyncError`. No escribe.
- `pullBackup(sync, fetch)` devuelve un string JSON en claro. Se mantiene por compatibilidad.
- `pushData(state, opts)` es **obsoleto**. Envuelve `syncNow`, lanza `SyncError` y devuelve `{…res, hash, sync: settings.sync completos}`. **Sin clave lanza `NO_KEY` y no escribe nada**, porque quien la usa no guarda la clave generada. Tampoco pasa a publicar nunca. `background.js` debe pasar a `syncNow` + `applySyncResult`.
- `testConnection(sync, fetch)` devuelve `{ ok, message, detail, code?, status?, private?, defaultBranch?, warning? }`. `warning` aparece si el repo publica GitHub Pages: mostrarlo.
- `ensureBranch(sync, fetch)` devuelve `{ branch, created, empty, sha? }`.
- `calendarUrls(sync)`: con `branch: ''` usa `HEAD`. Los segmentos van codificados.
- `encryptBackup(state, { rev, now, deviceId, key, publisher?, publisherSince? })` y `decryptBackup(doc, key)` son de bajo nivel. `cipher.js` exporta `generateSyncKey()`, `isSyncKey(k)`, `randomId()`, `encryptText` y `decryptText`.

### Enlace de configuración (`#setup=`)

- `parseSetupLink(hash)` devuelve `{ enabled:true, owner, repo, branch, token, key, publishPlaces? }` o `null`. **Valida** todo:
  - `owner` y `repo` según las reglas de GitHub;
  - `branch` como nombre de rama de git;
  - `token` con prefijo `ghp_` o `github_pat_`;
  - `key` en base64url de 43 caracteres. Puede faltar: entonces `key: ''`.
- `normalizeSyncConfig(obj)` hace la misma validación para el formulario avanzado.
- `buildSetupLink(baseUrl, sync)` incluye `key` (y `publishPlaces` si está activado). **Antes de crear el enlace**, el dispositivo de quien ayuda debe tener clave: o sincroniza una vez (genera la clave si no hay copia, **y pasa a ser el que publica**), o guarda `generateSyncKey()` si no hay copia remota. Si hay copia remota y no tiene la clave, el enlace no sirve: mostrar el error.
- `syncConfigPatch(cfg)` devuelve el parche para aplicar una configuración nueva. Activa la sync y reinicia la contabilidad (`baseRev = 0`, `lastPushAt`, `publisher`… a `null`). Conserva la `key` del teléfono si el enlace no trae una.

### Flujos recomendados

**1. Abrir un enlace `#setup=`**

- En **iOS Safari sin instalar** (`isIOS() && !isStandalone()`): **no** configurar nada. Mostrar «Copia este enlace y pégalo dentro de la app Turnos (Ajustes → Tengo un enlace)» con un botón Copiar.
- En otro caso, hacer en este orden:
  1. Confirmar con Mauricio.
  2. `store.set(s => updateSettings(s, { sync: syncConfigPatch(cfg) }))`.
  3. `res = await pullOnly(store.get())`, luego `store.set(cur => applySyncResult(cur, res))`. Si devuelve `DECRYPT` o `NO_KEY`, mostrar el error y **no** seguir.
  4. Según el resultado:
     - Si `res.readOnly` (ya publica otro dispositivo, p. ej. el de quien ayuda): preguntar «¿Usar este iPhone para actualizar el calendario?».
       - **Sí** → `becomePublisher` + `applySyncResult`.
       - **No** → este dispositivo queda solo leyendo.
     - Si no: `syncNow` + `applySyncResult` (sin copia, este pasa a publicar).
  5. Ir al paso «Suscribirme en el iPhone».

**2. Sincronización de fondo** (`background.js`)

- `const res = await syncNow(store.get()); store.set(cur => applySyncResult(cur, res));`. Toast solo si se pidió a mano.
- **Cuándo:** al abrir la app; en `visibilitychange → visible` (después de `store.refresh()`); y tras cada cambio de datos, con un retardo corto.
- En `visibilitychange → hidden` y en `pagehide`, ejecutar lo pendiente (IOS-4).
- En un dispositivo que solo lee, `syncNow` solo lee: es seguro llamarlo igual.
- No sincronizar automáticamente en iOS Safari sin instalar.
- La clave de cambios (`dataKey`) puede incluir `s.sync.key` y `s.sync.publishPlaces`.

**3. «Restaurar desde GitHub»**

- Lo recomendado es `pullOnly` + `applySyncResult`: fusiona sin perder lo local más nuevo.
- Para **reemplazar**, usar el flujo de importación de §4 con `const { data } = await fetchRemoteBackup(sync)` como archivo.

---

## 4. Importar y exportar copias

- **`exportBackup(state, { now })`**:
  - No lleva token, clave, `settings.sync` ni `settings.ntfy`.
  - Trae los ajustes del usuario (con los sellos de avisos), `publishPlaces`, `onboardingDone`, `codes`, `days`, `tombstones`, `codeTombstones`, `scans` y `changes`.
  - Con `state.__newerSchema` **lanza** `Error` con `code: 'NEWER'` («Actualiza la app antes de exportar una copia»).
- **`importBackup(state, jsonOrObject, { now, force })`**:
  - **No toca** `settings.sync` (incluido `publishPlaces`), `settings.ntfy` ni un `onboardingDone: true` del teléfono. Los avisos sí vienen de la copia.
  - En un teléfono **ya conectado** (sync activa y ya leyó o publicó alguna vez), lo importado pasa a ser lo más nuevo: los días que cambian se sellan con `now` y los días locales que no están en la copia quedan borrados (tombstones). Así, al sincronizar, la restauración se propaga en lugar de deshacerse.
  - En un teléfono **sin conectar**, se conservan las fechas de la copia y no se crean borrados. Al conectarlo se fusiona por fechas reales y una copia vieja no pisa cambios posteriores.
  - Un borrado nunca retrocede: se queda la fecha más reciente.
  - Lanza `Error` en español con `e.code`:
    - `INVALID`;
    - `NEWER`: copia de una versión más nueva;
    - `ENCRYPTED`: es un `backup.json` cifrado. Hay que usar «Restaurar desde GitHub», o `decryptBackup` y luego `importBackup` con el objeto;
    - `EMPTY_BACKUP`: copia con 0 días y el teléfono tiene días. Solo con una confirmación expresa se puede reintentar con `{ force: true }`.
- **Copia de seguridad local**:
  - `saveBeforeImport(state, localStorage, { now })` devuelve la clave `turnos-mauricio:before-import:<ts>`, o **`null` si no se pudo guardar** (almacenamiento lleno). Se guardan 3 como mucho.
  - `listBeforeImport(localStorage)` devuelve `[{ key, at, days }]`, la más nueva primero.
  - `undoImport(localStorage, store.get(), { now, key })`: **`key` es obligatoria**, la de esa importación. Devuelve el estado anterior, o `null` si falta `key` o esa copia ya no existe (por ejemplo, un segundo toque en «Deshacer»). Conserva la sync y el ntfy actuales y borra esa copia. **Nunca** elige «la más nueva» por su cuenta.
- **Flujo de importación recomendado**:

  ```js
  const preview = importBackup(store.get(), text, { now });  // valida; puede lanzar EMPTY_BACKUP…
  if (!await confirmDialog({ … n días de la copia vs. m días del teléfono … })) return;
  const backupKey = saveBeforeImport(store.get(), localStorage, { now });
  if (!backupKey && !await confirmDialog({ text: 'No hay espacio para guardar una copia de lo actual: no se podrá deshacer. ¿Importar igualmente?' })) return;
  store.set((s) => importBackup(s, text, { now }));         // recalcular DENTRO de set (estado actual)
  if (backupKey) toast('Copia restaurada', { action: { label: 'Deshacer', run: () => {
    const prev = undoImport(localStorage, store.get(), { now: new Date(), key: backupKey });
    if (prev) store.set(() => prev);                         // null en un segundo toque: no hacer nada
  } } });
  ```

---

## 5. Mutaciones, códigos y calendario

- **Mutaciones:**
  - `clearDay(state, key, { now })` deja una tombstone. `setDay` la quita.
  - `upsertCode(state, def, { now })` y `deleteCode(state, code, { now })` tienen un tercer argumento opcional.
  - `deleteCode` de un código propio que se usa en algún día deja una definición supuesta (`confirmed: false`, sin horario) más la tombstone.
  - `updateSettings(state, patch, { now })`: mezcla profunda. `null` **borra** los campos que por defecto son `null` (`lastError`, `lastPushAt`, `publisher`, …). En los demás campos, `null` se ignora (nombre, horas, token…).
- **`upsertCode`:**
  - **Sin cambios reales devuelve el mismo objeto `state`**, sin sello nuevo. Así, una copia vieja que pulsa «Guardar» no gana después. La UI puede mostrar «Guardado» igual.
  - Lanza «Pon también la hora de inicio, o borra la de fin.» si hay fin sin inicio.
  - **Acepta solo inicio** (eventos, `other`, turnos).
  - Si cambian las horas, la duración queda en 6 h o menos y la pausa era la de por defecto (30), la pausa pasa a 0.
  - Códigos de más de 12 caracteres → error.
- **Lo importado o cargado se sanea:**
  - colores: solo `#RGB` o `#RRGGBB` (`safeColor`);
  - de los códigos solo se guardan los campos conocidos de `CodeDef` (en datos de una versión más nueva se conservan los desconocidos);
  - longitudes máximas: nombre del código 40, lugar 200, nota 1000, nombre 60;
  - `changes` y `scans` se validan;
  - se descartan las claves `__proto__`, `constructor` y `prototype`.
- **`guessCode`:**
  - letra + 1 dígito → `shift`. F, S, N y Z copian F1, S1, N1 y Z1; las demás letras quedan sin horario y `confirmed: false`;
  - letra + 2 dígitos → `place`;
  - el resto → `other`, sin horario y `confirmed: false`.
- **Códigos con hora:**
  - `isTimedCode(def)` es true para `shift`, `event` y `other` con hora de inicio, y para cualquier tipo con inicio y `countsHours`.
  - `dayTimedItems` incluye esos códigos; `startOnly: true` si no hay fin (dura 1 h; mostrar solo la hora de inicio).
  - `timedInterval(state, key, code)` devuelve `{start, end, startOnly}`.
  - `countsAsWork(def)`: un código de cualquier tipo (salvo vacaciones o baja) con inicio, fin y `countsHours: true` cuenta horas como un turno.
- **`buildICS(state, { from, to, now, notes = false, places = true })`:**
  - por defecto, **sin notas**;
  - el rango empieza en `defaultIcsFrom(now)`, el día 1 del mes de hace 2 meses;
  - `DTSTAMP` y `LAST-MODIFIED` son estables: el `updatedAt` más reciente del día, de sus códigos (también de los borrados) y de `calendarUpdatedAt`. Nunca «ahora». `SEQUENCE` nunca retrocede;
  - para el **archivo `.ics` manual** de Ajustes, usar `buildICS(state, { now })`: con lugares y sin notas.
- **Horas:** `monthSummary(...).freeDays` cuenta solo los días con `-`, `W-` o el plan vacío. `shifts` incluye los códigos que cuentan horas y no son eventos.
- **Escaneos** (`mergeScans`): una foto con mes leído pero sin año se excluye si su mes no coincide (`excluded`). Si ninguna foto trae año, `year` puede ser `null` aunque `month` exista.

---

## 6. Consejos (`getAdvice`)

`action.section` es **`'calendar'`** y corresponde al elemento `#set-calendar` de Ajustes («Calendario del iPhone»). La UI debe pasar `action.section` a `ctx.go`: `go(tab, { section })`. Después, Ajustes hace scroll a `document.getElementById('set-' + section)` y devuelve `true` en `onShow` para que no se reinicie el scroll.

| `id` | Nivel | Qué es |
|---|---|---|
| `sync-error` | `alert` si no es pasajero | «Tu calendario no se está actualizando». Va el primero en Hoy. |
| `sync-error` | `warn` si es pasajero | Solo si falla desde hace más de 24 h (`lastErrorSince`). |
| `sync-error` | `info` si es pasajero y nunca ha conectado | Texto suave: «Todavía no se ha podido conectar el calendario; se volverá a intentar cuando haya internet.» |
| `read-only` | `warn` | Otro dispositivo publica y aquí hay cambios sin publicar (`sync.unpublished > 0`, o ediciones después de la última lectura). «Estos cambios no llegan al calendario… en Ajustes elige «Usar este dispositivo».» |
| `reminders-off` | `info` | Sin sync ni ntfy. |
| `gaps-<fecha>` | `info` | «Faltan días en el plan» (huecos en los próximos 7 días). `action: { tab:'escanear' }`. |
| `newer-schema` | `alert` | «Actualiza la app». |
| `nights-…` | — | Antes de la primera noche dice «Se acerca un bloque de noches» o «Esta noche trabajas». |
| `free-…` | — | Solo cuenta `-`, `W-` y vacaciones. Un evento, un código desconocido o la **baja por enfermedad** no son «días libres a la vista». |

Las acciones de `sync-error`, `read-only` y `reminders-off`:

- `sync-error` y `read-only`: `{ tab:'ajustes', section:'calendar', label:'Ver en Ajustes' }`.
- `reminders-off`: `{ tab:'ajustes', section:'calendar', label:'Ver cómo' }`.

---

## 7. ntfy (opcional, desactivado por defecto)

- El aviso «mantener recordatorios» se titula «Abre la app Turnos». Dice que hay que abrirla **desde el icono** y **no lleva enlace**.
- En iPhone/iPad (`isAppleMobile()`), `syncNtfy` y `testNtfy` no añaden `click` por defecto. Para otro destino, pasar `{ appUrl }` explícito.

---

## 8. Tests e2e

Los mocks de GitHub del e2e deben simular lo siguiente:

- `backup.json`, con PUT con `sha`. El documento es **v3**, con `meta.publisher` y `meta.publisherSince`.
- `turnos.ics`, sin `?ref=` cuando `branch` es `''`. El que publica hace **GET de `turnos.ics` en cada sincronización** (y PUT solo si cambió).
- el campo `commit.sha` en las respuestas de PUT;
- `409`/`404` en `git/ref` para repos vacíos.

Además:

- Un dispositivo que solo lee **no hace ningún PUT**. Las pruebas de «otro dispositivo publica» necesitan `becomePublisher`.
- En `test/unit/helpers.mjs`, `fakeGitHub` es una referencia completa.

Cambios concretos en `test/e2e`:

- Los enlaces de prueba deben usar un token con formato real, por ejemplo `` `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}` ``. Con `github_pat_TEST`, `parseSetupLink` devuelve `null`.
- Las aserciones sobre `PUT …turnos.json` deben pasar a `backup.json`. Su contenido está cifrado: el token, las notas y los códigos no aparecen en claro.
