# Cambios en `docs/js/core` que la UI debe adoptar

Este documento acompaña la revisión de seguridad de datos y la nueva sincronización (SPEC §9 y §10). Todo se exporta desde `core/index.js`, que ahora también reexporta `cipher.js`.

> **Obligatorio en `docs/sw.js`:** hay un módulo nuevo, `js/core/cipher.js` (lo importa `index.js`). Hay que añadirlo a la lista de precache (APP_SHELL) y subir la versión. Si no, la app no carga sin conexión.

Lo que la UI importa hoy sigue existiendo y la app arranca sin cambios. Aun así, `pushData` está **obsoleto**: sin el código nuevo de la UI, el dispositivo no guarda la clave ni los datos fusionados, así que la sincronización falla (sin borrar nada) hasta que se adopte `syncNow` y `applySyncResult`.

---

## 1. Estado (`State`): campos nuevos

| Campo | Qué es |
|---|---|
| `state.tombstones` | `{ 'YYYY-MM-DD': ISO }`. Días borrados. `clearDay` añade una entrada, `setDay` la quita. Se podan a los 120 días al guardar. |
| `state.codeTombstones` | `{ CODE: ISO }`. Códigos propios borrados con `deleteCode`. |
| `state.__newerSchema` | `true` si los datos vienen de una versión más nueva de la app. No se guarda (se recalcula al cargar); los campos desconocidos se conservan. La UI debe pedir **«Actualiza la app»** (también lo hace el consejo `newer-schema`). |
| `CodeDef.updatedAt` | ISO o `null`. Se rellena en `upsertCode` y `deleteCode`. |
| `DayEntry.updatedAt` | Se rellena siempre al cambiar (también si solo cambia la nota). |
| `settings.calendarUpdatedAt` | ISO o `null`. Lo pone `updateSettings` cuando cambian `reminders` o `sync.publishPlaces`. Sirve para que el `.ics` marque el cambio. |

### `settings.sync`

Valores por defecto:

```js
{ enabled:false, owner:'Mardar91', repo:'mauricio-datos', branch:'', token:'', key:'', deviceId:'',
  baseRev:0, lastPushAt:null, lastPushHash:null, lastIcsHash:null, lastPullAt:null,
  lastError:null, lastErrorCode:null, lastErrorDetail:null, publishPlaces:false }
```

- `branch: ''` significa la rama por defecto del repo. Antes era `'datos'`.
- `repo` por defecto es `'mauricio-datos'`: un repo **solo de datos**, nunca el de la app.
- `key`: clave AES-GCM en base64url (43 caracteres). `deviceId`: identificador aleatorio de este dispositivo. `syncNow` los genera si faltan.
- `lastError` es el mensaje humano para Mauricio. `lastErrorCode` es el código (ver §3). `lastErrorDetail` es el detalle técnico, que solo debe verse en «Opciones avanzadas».
- `publishPlaces`: el interruptor «Publicar lugares en el calendario». Desactivado = sin LOCATION y sin códigos de lugar en el `.ics`.

---

## 2. Store (`createStore`)

```js
const store = createStore(localStorage, { onError, target = window, now });
store.get(); store.set(fn) /* → state, igual que antes */; store.subscribe(fn) /* → unsubscribe */;
store.refresh()   // vuelve a leer localStorage; true si cambió (y notifica a los suscriptores)
store.onError(fn) // → unsubscribe. fn({ type:'save', code:'QUOTA'|'BLOCKED'|'NO_STORAGE', message, detail })
store.saveOk()    // false si la última escritura falló
store.lastSave()  // { ok, error, at }
store.destroy()   // quita el listener 'storage' (tests)
```

- **Varias pestañas.** El store escucha el evento `storage` de `window` y se recarga solo. Además, cada `set()` relee lo guardado antes de aplicar el cambio. La UI solo tiene que llamar a `store.refresh()` en `visibilitychange → visible` y en `pageshow`.
- **Guardado fallido.** Si el guardado falla (cuota llena, almacenamiento bloqueado), `set()` primero libera espacio (borra las copias corruptas y las copias de importación antiguas) y vuelve a intentarlo. Si sigue fallando, llama a `onError`. La UI debe:
  - mostrar un banner rojo persistente con `message` (`SAVE_ERROR`) y un botón «Exportar copia»;
  - comprobar `store.saveOk()` antes de mostrar «Guardado», y si es `false`, mostrar un toast de error en su lugar.
- **JSON corrupto.** Se guarda una sola copia por contenido en `turnos-mauricio:corrupt:<ts>`, con un máximo de 3.
- **Datos de una versión más nueva.** Se guarda una copia intacta en `turnos-mauricio:newer-schema` (solo la primera vez).

---

## 3. Sincronización segura (sustituye a `pushData`)

### API

```js
const res = await syncNow(state, { fetchImpl?, now?, force?, allowEmpty? });
const res = await pullOnly(state, opts);        // lee y fusiona; NUNCA escribe (alias: restoreFromRemote)
store.set((cur) => applySyncResult(cur, res));  // SIEMPRE así: fusiona sobre el estado ACTUAL y guarda res.sync
```

`syncNow` **nunca lanza**. Devuelve:

```js
{
  ok,              // true si todo fue bien
  state,           // estado fusionado (el mismo objeto si no cambió nada)
  merged,          // true si se trajeron cambios del remoto
  pulled,          // true si se leyó y descifró el remoto
  pushed,          // true si se publicó backup.json (rev nueva)
  icsPushed,       // true si cambió turnos.ics
  conflictCount,   // días cambiados en los dos lados desde la última sincronización
  pulledDays,      // ['YYYY-MM-DD', …] días que vinieron del remoto
  rev,
  remote: { rev, days, savedAt, deviceId, legacy } | null,
  sync,            // PARCHE para settings.sync (deviceId, key, baseRev, lastPushHash, lastIcsHash,
                   // lastPushAt, lastPullAt, lastError, lastErrorCode, lastErrorDetail)
  error: { code, message, detail, status, retry } | null,
  target: { owner, repo, branch }
}
```

- **Aplicar el resultado.** `applySyncResult(current, res)` vuelve a fusionar `res.state` con `current`, así que lo que Mauricio editó mientras se sincronizaba no se pierde. Después aplica `res.sync` con `updateSettings`. Si `owner`, `repo` o `branch` cambiaron entre medias, no hace nada. Aplícalo **también cuando `res.ok` es false**: el parche trae `lastError*`, y puede haber datos fusionados aunque la publicación fallara.
- **Qué hace por dentro**, en este orden:
  1. Lee `backup.json`.
  2. Si `meta.rev !== baseRev`, descifra y fusiona por día y por código: gana el `updatedAt` más reciente, y las tombstones cuentan como versión.
  3. Solo publica si hay algo nuevo, con `rev = remota + 1` y comprobando el `sha`. Si otro dispositivo escribió entre medias, relee y vuelve a fusionar (hasta 3 intentos).
  4. Publica `turnos.ics` sin notas, con `places: publishPlaces`. El rango empieza el día 1 del mes de hace 2 meses.
- **Nunca** publica 0 días encima de un remoto con días (código `EMPTY_LOCAL`), salvo con `allowEmpty: true`. Úsalo solo tras una confirmación explícita del tipo «sí, vaciar el calendario».
- `force: true` vuelve a publicar aunque no haya cambios. Es para el botón «Enviar ahora» de Opciones avanzadas.
- **Repo vacío y ramas.** En un repo vacío, los archivos se crean en la rama por defecto. Si se indicó una rama que no existe, se crea desde la por defecto.
- **Formato antiguo.** Si el remoto tiene un `turnos.json` antiguo en claro, se fusiona y se migra a `backup.json`.

### Errores

Cada error trae tres campos:

- `message`: humano, sin jerga y sin pedirle a Mauricio que cree tokens;
- `detail`: técnico, para quien ayuda;
- `retry`: `true` si es pasajero.

| `code` | Cuándo | `retry` |
|---|---|---|
| `CONFIG` | falta `owner`, `repo` o `token`, o tienen caracteres no válidos | no |
| `NO_KEY` | hay copia cifrada y este dispositivo no tiene la clave (hace falta un enlace con clave) | no |
| `DECRYPT` | la clave no coincide, o los metadatos fueron manipulados. **No se publica nada** | no |
| `AUTH` | 401 (token caducado): «La conexión del calendario ha caducado…» | no |
| `FORBIDDEN` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `INVALID` | 422 | no |
| `UNKNOWN` | otro error | no |
| `RATE_LIMIT` | 403/429 por límite de peticiones | sí |
| `SERVER` | 5xx | sí |
| `NETWORK` | sin red | sí |
| `CONFLICT` | `sha` cambiado 3 veces seguidas | sí |
| `BAD_REMOTE` | `backup.json` dañado | no |
| `NEWER_REMOTE` | el remoto es de una versión más nueva de la app | no |
| `NEWER_LOCAL` | este estado tiene `__newerSchema` | no |
| `EMPTY_LOCAL` | ver arriba | no |
| `NO_REMOTE` | solo en `fetchRemoteBackup` y `pullBackup` | no |

Los textos están en `SYNC_MESSAGES`. `SyncError` tiene `.code`, `.detail`, `.status` y `.retry`.

- **Hoy:** el consejo `sync-error` ya avisa (ver §6).
- **Ajustes → Calendario del iPhone:** si `lastErrorCode` no es pasajero, mostrar `lastError` y el botón **«Tengo un enlace nuevo»** (`openPasteSetup`), aunque ya haya configuración.
- **Opciones avanzadas:** mostrar `lastErrorDetail`.

### Otras funciones de sync.js

- `fetchRemoteBackup(sync, fetch)` devuelve `{ rev, meta, data }`, donde `data` es la copia en claro, lista para `importBackup` (restaurar **reemplazando**). Lanza `SyncError`.
- `pullBackup(sync, fetch)` devuelve un string JSON en claro. Se mantiene por compatibilidad: `importBackup(state, await pullBackup(sync))` sigue funcionando.
- `pushData(state, opts)` es **obsoleto**: envuelve `syncNow`, lanza `SyncError` y devuelve `{…res, hash, sync: settings.sync completos}`.
- `testConnection(sync, fetch)` devuelve `{ ok, message, detail, code?, status?, private?, defaultBranch?, warning? }`. `warning` aparece si el repo publica GitHub Pages (el token podría cambiar la app): mostrarlo.
- `ensureBranch(sync, fetch)` devuelve `{ branch, created, empty, sha? }`. Antes devolvía `{created, sha}`.
- `calendarUrls(sync)`: con `branch: ''` usa `HEAD` (`raw.githubusercontent.com/<owner>/<repo>/HEAD/turnos.ics`). Los segmentos van codificados.
- `encryptBackup` y `decryptBackup` son de bajo nivel. `cipher.js` exporta `generateSyncKey()`, `isSyncKey(k)`, `randomId()`, `encryptText` y `decryptText`.

### Enlace de configuración (`#setup=`)

- `parseSetupLink(hash)` devuelve `{ enabled:true, owner, repo, branch, token, key, publishPlaces? }` o `null`. Ahora **valida** todo:
  - `owner` y `repo` según las reglas de GitHub;
  - `branch` como nombre de rama de git (sin `..`, `//`, etc.);
  - `token` con prefijo `ghp_` o `github_pat_`;
  - `key` en base64url de 43 caracteres. Puede faltar: entonces `key: ''`.
- `normalizeSyncConfig(obj)` hace la misma validación para el formulario avanzado.
- `buildSetupLink(baseUrl, sync)` incluye `key` (y `publishPlaces` si está activado). **Antes de crear el enlace**, el dispositivo de quien ayuda debe tener clave. Hay dos opciones:
  - sincronizar una vez (`syncNow` genera `key` si no hay copia remota);
  - si `!isSyncKey(sync.key)` y no hay copia remota, guardar `generateSyncKey()`.

  Si hay copia remota y no tiene la clave, el enlace no sirve: mostrar el error.
- `syncConfigPatch(cfg)` devuelve el parche para aplicar una configuración nueva. Activa la sync y pone `baseRev = 0` (para leer y fusionar primero). Conserva la `key` del teléfono si el enlace no trae una.

### Flujos recomendados (SPEC §9)

**1. Abrir un enlace `#setup=`**
- En **iOS Safari sin instalar** (`isIOS() && !isStandalone()`): **no** configurar nada. Mostrar «Copia este enlace y pégalo dentro de la app Turnos (Ajustes → Tengo un enlace)» con un botón Copiar.
- En otro caso, hacer en este orden:
  1. Confirmar con Mauricio.
  2. `store.set(s => updateSettings(s, { sync: syncConfigPatch(cfg) }))`.
  3. `res = await pullOnly(store.get())`, luego `store.set(cur => applySyncResult(cur, res))`.
  4. `syncNow` y `applySyncResult`.
  5. Ir al paso «Suscribirme en el iPhone».

  Si `pullOnly` devuelve `DECRYPT` o `NO_KEY`, mostrar el error y **no** seguir.

**2. Sincronización de fondo** (`background.js`)
- Llamar a `syncNow(store.get())` y después `store.set(cur => applySyncResult(cur, res))`. Mostrar un toast solo si se pidió a mano.
- **Cuándo:**
  - al abrir la app (spec: leer el remoto al abrir);
  - en `visibilitychange → visible`, después de `store.refresh()`;
  - tras cada cambio de datos, con un retardo corto.
- En `visibilitychange → hidden` y en `pagehide`, ejecutar lo que esté pendiente (IOS-4).
- No sincronizar automáticamente en iOS Safari sin instalar.
- La clave de cambios (`dataKey`) puede seguir igual. Conviene incluir `s.sync.key` y `s.sync.publishPlaces`.

**3. «Restaurar desde GitHub»**
- Lo recomendado es `pullOnly` + `applySyncResult`: fusiona sin perder lo local más nuevo.
- Para **reemplazar**:
  1. `saveBeforeImport(store.get())`;
  2. `const { data } = await fetchRemoteBackup(sync)`;
  3. `store.set(s => importBackup(s, data, { now }))`;
  4. toast con «Deshacer» (ver §4).

---

## 4. Importar y exportar copias

- `exportBackup(state, { now })`: el archivo **ya no lleva** `settings.sync` ni `settings.ntfy`. Nunca lleva token ni clave. Trae los ajustes del usuario, `onboardingDone`, `codes`, `days`, `tombstones`, `codeTombstones`, `scans` y `changes`.
- `importBackup(state, jsonOrObject, { now, force })`:
  - **No toca** `settings.sync`, `settings.ntfy` ni un `onboardingDone: true` del teléfono.
  - Lo importado pasa a ser la versión más nueva: los días que cambian se sellan con `now` (`source: 'import'`), y los días locales que no están en la copia quedan como tombstones. Así la sincronización propaga la restauración en lugar de deshacerla.
  - Los códigos que la copia no trae se quedan como estaban.
  - Lanza `Error` en español con `e.code`:
    - `INVALID`;
    - `NEWER` (copia de una versión más nueva);
    - `ENCRYPTED`: es un `backup.json` cifrado. Hay que usar «Restaurar desde GitHub», o `decryptBackup` y luego `importBackup` con el objeto;
    - `EMPTY_BACKUP`: copia con 0 días y el teléfono tiene días. Mostrar el mensaje; solo con una confirmación expresa se puede reintentar con `{ force: true }`.
- **Copia de seguridad local** antes de importar o restaurar:
  - `saveBeforeImport(state, localStorage, { now })` devuelve la clave `turnos-mauricio:before-import:<ts>` (se guardan 3 como mucho).
  - `listBeforeImport(localStorage)` devuelve `[{ key, at, days }]`, la más nueva primero.
  - `undoImport(localStorage, store.get(), { now, key? })` devuelve el estado anterior, o `null`. Se aplica como una importación nueva (gana al sincronizar), conserva la sync y el ntfy actuales, y borra esa copia.
- Flujo de importación recomendado (corrige además la carrera de SEC-6):

  ```js
  const preview = importBackup(store.get(), text, { now });  // valida; puede lanzar EMPTY_BACKUP…
  if (!await confirmDialog({ … n días de la copia vs. m días del teléfono … })) return;
  saveBeforeImport(store.get(), localStorage, { now });
  store.set((s) => importBackup(s, text, { now }));         // recalcular DENTRO de set (estado actual)
  toast('Copia restaurada', { action: { label: 'Deshacer', run: () => {
    const prev = undoImport(localStorage, store.get(), { now: new Date() });
    if (prev) store.set(() => prev);
  } } });
  ```

---

## 5. Mutaciones, códigos y calendario

- **Mutaciones:**
  - `clearDay(state, key, { now })` deja una tombstone. `setDay` la quita.
  - `upsertCode(state, def, { now })` y `deleteCode(state, code, { now })` tienen un tercer argumento opcional.
  - `deleteCode` de un código propio que se usa en algún día deja una definición supuesta (`confirmed: false`, sin horario) más la tombstone.
  - `updateSettings(state, patch, { now })` tiene un tercer argumento opcional.
- **`upsertCode`:**
  - Lanza «Pon también la hora de inicio, o borra la de fin.» si hay fin sin inicio.
  - **Acepta solo inicio** (eventos, `other`, turnos). El editor puede permitirlo para eventos.
  - Si cambian las horas, la duración queda en 6 h o menos y la pausa era la de por defecto (30), la pausa pasa a 0 (C12).
  - Códigos de más de 12 caracteres → error.
- **Lo importado o cargado se sanea:**
  - colores: solo `#RGB` o `#RRGGBB` (`safeColor`);
  - longitudes máximas: nombre del código 40, lugar 200, nota 1000, nombre 60;
  - `changes` y `scans` se validan;
  - se descartan las claves `__proto__`, `constructor` y `prototype`.
- **`guessCode`:**
  - letra + 1 dígito → `shift`. F, S, N y Z copian F1, S1, N1 y Z1; las demás letras quedan sin horario, `confirmed: false` y nombre «Turno X9».
  - letra + 2 dígitos → `place`.
  - el resto → `other`, sin horario y `confirmed: false`.
- **Códigos con hora** (C3/C4):
  - `isTimedCode(def)` es true para `shift`, `event` y `other` con hora de inicio, y para cualquier tipo con inicio y `countsHours`.
  - `dayTimedItems` incluye esos códigos. Cada item lleva `startOnly: true` si no hay fin: dura 1 h. En ese caso, mostrar solo la hora de inicio (`badge.timeRange` devuelve `''` porque `hasTime` exige las dos horas).
  - `timedInterval(state, key, code)` devuelve `{start, end, startOnly}`.
  - `countsAsWork(def)`: un código de cualquier tipo (salvo vacaciones o baja) con inicio y fin y `countsHours: true` cuenta horas como un turno.
- **`buildICS(state, { from, to, now, notes = false, places = true })`:**
  - Por defecto, **sin notas**.
  - El rango por defecto empieza en `defaultIcsFrom(now)`: el día 1 del mes de hace 2 meses.
  - `DTSTAMP` y `LAST-MODIFIED` son estables: el `updatedAt` más reciente del día, de sus códigos y de `calendarUpdatedAt`. Nunca «ahora».
  - `SEQUENCE` es monótona y sube cuando cambian el horario, el código o los avisos.
  - Para el **archivo `.ics` manual** de Ajustes, usar `buildICS(state, { now })`: con lugares y sin notas.
- **Horas:** `monthSummary(...).freeDays` cuenta solo los días con `-`, `W-` o el plan vacío. Una reunión o un código desconocido ya no cuenta como libre. `shifts` incluye los códigos que cuentan horas y no son eventos.
- **Escaneos** (`mergeScans`, C1): una foto con mes leído pero sin año se excluye si su mes no coincide (`excluded`, aviso «La foto N es de noviembre: escanéala aparte.»). Si ninguna foto trae año, `year` puede ser `null` aunque `month` exista: la revisión ya cae en el año actual o el selector.

---

## 6. Consejos (`getAdvice`)

| `id` | Nivel | Qué es |
|---|---|---|
| `sync-error` | `alert` (o `warn` si es pasajero y dura más de 24 h) | «Tu calendario no se está actualizando». `action: { tab:'ajustes', section:'calendario', label:'Ver en Ajustes' }`. Va el primero en Hoy. |
| `reminders-off` | — | Texto nuevo, sin «2 minutos». `action: { tab:'ajustes', section:'calendario', label:'Ver cómo' }`. |
| `gaps-<fecha>` | `info` | «Faltan días en el plan» (huecos en los próximos 7 días). `action: { tab:'escanear' }`. |
| `newer-schema` | `alert` | «Actualiza la app». |
| `nights-…` | — | Antes de la primera noche dice «Se acerca un bloque de noches» o «Esta noche trabajas». |
| `free-…` | — | Ya no salen días con eventos o códigos desconocidos. Las rachas cuentan los días con turno o con algo con hora. |

La UI debe pasar `action.section` a `ctx.go`: `go(tab, { section })`. Después, Ajustes debe hacer scroll a esa sección (`calendario` = «Calendario del iPhone») y devolver `true` en `onShow` para que no se reinicie el scroll.

---

## 7. ntfy (opcional, desactivado por defecto)

- El aviso «mantener recordatorios» se titula ahora «Abre la app Turnos». Dice que hay que abrirla **desde el icono** y no desde el aviso, y **no lleva enlace**.
- En iPhone/iPad (`isAppleMobile()`), `syncNtfy` y `testNtfy` ya no añaden `click` por defecto, porque abriría Safari con otros datos. Para otro destino, pasar `{ appUrl }` explícito.

---

## 8. Tests e2e

Los mocks de GitHub del e2e deben simular lo siguiente:

- `backup.json`, con PUT con `sha`;
- `turnos.ics`, sin `?ref=` cuando `branch` es `''`;
- el campo `commit.sha` en las respuestas de PUT;
- `409`/`404` en `git/ref` para repos vacíos.

En `test/unit/sync.test.mjs`, el helper `fakeGitHub` es una referencia completa.

Cambios concretos en `test/e2e`:

- Los enlaces de prueba deben usar un token con formato real, por ejemplo `` `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}` ``. Con `github_pat_TEST`, `parseSetupLink` devuelve `null`.
- Las aserciones sobre `PUT …turnos.json` deben pasar a `backup.json`. Su contenido está cifrado: el token, las notas y los códigos no aparecen en claro.
