# API de `docs/js/core` para la UI

API final de la lógica (SPEC §9, §9.1 y §10). Todo se importa desde `docs/js/core/index.js`, que también reexporta `cipher.js`. Este archivo está en la raíz del repo y no dentro de `docs/`, porque `docs/` se publica en GitHub Pages.

> **`docs/sw.js`:** esta ronda no añade módulos (`store.js` ahora importa `cipher.js`, que ya se precarga), pero cambió el código de `js/core/*`. Al publicar hay que **subir `VERSION`** en `sw.js` y `APP_VERSION` en `js/app.js`.

## Lo nuevo de esta ronda

1. **La identidad se crea antes de la primera petición de red.** `ensureSyncIdentity(state)` (puro) crea el `deviceId` y la clave dentro de `store.set`. Si `syncNow` todavía tiene que crearlos, no escribe nada en esa llamada y devuelve el error `RETRY`. La cola (`createSyncQueue`) guarda la identidad y repite sola.
2. **Los enlaces de configuración se comprueban antes de guardarlos.** `trySetupConfig(state, cfg)` lee y descifra el remoto con una copia del estado. Si la clave no descifra, falta la clave o el token no vale, no se guarda nada. Además, `updateSettings` guarda la clave anterior en `sync.prevKey` cuando se cambia una clave buena: si la nueva no descifra, la sincronización recupera la anterior.
3. **Los lugares (`publishPlaces`) de un enlace** solo se aplican en un dispositivo que nunca eligió, y con el sello mínimo `LINK_PLACES_AT`: cualquier decisión publicada les gana. `syncConfigPatch` ya **no** incluye `publishPlaces`; los aplica `applySyncConfig`.
4. **Si `backup.json` desaparece:**
   - un dispositivo que vio publicar a otro sigue solo leyendo;
   - un dispositivo vacío no publica encima de un `turnos.ics` con eventos (`EMPTY_LOCAL`);
   - un dispositivo que solo lee no vuelve a crear una rama borrada.
5. **Quien dejó de publicar ya no pisa el calendario.** Antes de escribir `turnos.ics`, se comprueba que `backup.json` sigue siendo el que esta sincronización leyó o escribió. Si cambió, el resultado es `CONFLICT` (pasajero).
6. **Orden de los códigos de un día:** `mergeStates`, `upsertCode` y `deleteCode` lo dejan en el orden canónico cuando cambia el tipo de un código. Así se acaba la «rev nueva en cada sincronización».
7. **Resultados viejos:** cada resultado lleva `startedAt`. `applySyncResult` no deja que uno que empezó antes que el último aplicado (`sync.lastSyncStartedAt`) cambie quién publica, `baseRev`, `unpublished` ni los errores. **Todas** las llamadas de sincronización pasan por **una sola cola**: `createSyncQueue`.
8. `pushData` (obsoleto) ahora exige clave **y** `deviceId`.

### Pendiente en la UI

- `ui/background.js` todavía usa `pushData`, que no guarda la identidad. Con esta ronda, un teléfono configurado por `ui/setup.js` (que no crea `deviceId`) recibe `CONFIG`. Hay que pasar a `createSyncQueue` (§4.3).
- `ui/setup.js` guarda la configuración del enlace sin comprobarla (`updateSettings(s, { sync: { ...sync, enabled: true } })`). Hay que pasar a `syncQueue.setup(cfg)` (§4.2), y en Safari de iOS sin instalar no configurar nada.
- Ajustes debe mostrar el estado de solo lectura y el botón «Usar este dispositivo» (§4.4).

---

## 1. Estado (`State`)

| Campo | Qué es |
|---|---|
| `state.tombstones` | `{ 'YYYY-MM-DD': ISO }`. Días borrados. `clearDay` añade uno y `setDay` lo quita. Se podan a los 120 días al guardar. |
| `state.codeTombstones` | `{ CODE: ISO }`. Códigos propios borrados con `deleteCode`. |
| `state.__newerSchema` | `true` si los datos son de una versión más nueva de la app. No se guarda. La UI pide **«Actualiza la app»** (y también lo hace el consejo `newer-schema`). |
| `CodeDef.updatedAt` / `DayEntry.updatedAt` | ISO. Se rellenan al cambiar (para fusionar). |
| `settings.calendarUpdatedAt` | Cambia cuando cambian `reminders` o `sync.publishPlaces`. Hace que el sello y la `SEQUENCE` del `.ics` nunca retrocedan. |
| `settings.remindersUpdatedAt` / `settings.placesUpdatedAt` | Cuándo se cambiaron los avisos o `publishPlaces`. Al fusionar dispositivos gana el cambio más reciente. `LINK_PLACES_AT` (`1970-01-01T00:00:00.001Z`) es una sugerencia de un enlace: pierde ante cualquier decisión real. |

Estos sellos los pone `updateSettings`. Si el parche trae `remindersUpdatedAt` o `placesUpdatedAt` explícitos, se respetan. La UI no tiene que tocarlos.

### `settings.sync`

```js
{ enabled:false, owner:'Mardar91', repo:'mauricio-datos', branch:'', token:'', key:'', deviceId:'',
  baseRev:0, lastPushAt:null, lastPushHash:null, lastIcsHash:null, lastPullAt:null,
  lastError:null, lastErrorCode:null, lastErrorDetail:null, lastErrorSince:null, publishPlaces:false,
  publisher:null, publisherSince:null, unpublished:0, prevKey:'', lastSyncStartedAt:null }
```

- `branch: ''` es la rama por defecto del repo. `repo` es un repo **solo de datos**, nunca el de la app.
- `key`: clave AES-GCM en base64url (43 caracteres). `deviceId`: identificador de este dispositivo. Se crean con `ensureSyncIdentity` al configurar (§4.2).
- `lastError` es el mensaje para Mauricio y `lastErrorCode` su código (§3.4). `lastErrorDetail` es técnico (solo en «Opciones avanzadas»). `lastErrorSince` dice desde cuándo falla.
- `publishPlaces`: interruptor «Publicar lugares en el calendario». Se comparte entre dispositivos (gana el cambio más reciente).
- `publisher` / `publisherSince`: qué dispositivo publica, según la última lectura. Si `backup.json` desaparece, sirve para que este dispositivo siga solo leyendo.
- `unpublished`: en un dispositivo que solo lee, cuántos cambios de aquí no están publicados (días + códigos + 1 si difieren los avisos o los lugares).
- `prevKey`: la clave anterior a un cambio de clave. Se borra en cuanto la clave actual descifra o publica. No se muestra nunca.
- `lastSyncStartedAt`: inicio de la última sincronización aplicada (para descartar resultados viejos).

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
  - publica el primer dispositivo que sincroniza;
  - pero **no** uno que recuerde a otro como `publisher` (ese sigue solo leyendo hasta «Usar este dispositivo»);
  - y **nunca** uno con 0 días si `turnos.ics` tiene eventos (`EMPTY_LOCAL`).
- **Cambiar de dispositivo:** `becomePublisher` (lee + fusiona + publica `rev + 1` con este como `publisher`). Solo tras confirmarlo Mauricio.

### 3.2 Funciones

```js
// Configurar (puros, para usar dentro de store.set)
ensureSyncIdentity(state, { deviceId?, key?, getRandomValues? })  // → state (el mismo si no falta nada); key:false = no crear clave
applySyncConfig(state, cfg, { now?, deviceId?, key? })              // → state: configuración + lugares del enlace + identidad
syncConfigPatch(cfg, state?)                                       // → parche de settings.sync (bajo nivel; sin publishPlaces)
// Comprobar un enlace o formulario antes de guardarlo (lee; no escribe)
await trySetupConfig(state, cfg, { fetchImpl?, now? })   // → { ok:true, res, readOnly, publisher, error, apply(state) } | { ok:false, error, res }
// Sincronizar (nunca lanzan; devuelven el resultado de §3.3)
await syncNow(state, { fetchImpl?, now?, force?, allowEmpty? })  // lee + fusiona; publica SOLO si es el que publica
await pullOnly(state, opts)                                      // lee + fusiona; NUNCA escribe (alias: restoreFromRemote)
await becomePublisher(state, opts)                               // «Usar este dispositivo»
applySyncResult(current, res, { now })                           // → state: SIEMPRE con store.set, también si res.ok es false
// La cola única que usa la UI (§4.0): hace las llamadas de arriba y aplica cada resultado
const q = createSyncQueue(store, { fetchImpl?, clock? });
q.sync(opts?)  q.pull(opts?)  q.becomePublisher(opts?)  q.setup(cfg)  q.idle()
isReadOnlyDevice(sync)                                           // true → otro dispositivo publica
```

- `cfg` es lo que devuelve `parseSetupLink(hash)`, o `normalizeSyncConfig(form)` en el formulario avanzado.
- **`trySetupConfig`** prueba la configuración nueva con una **copia** del estado:
  - Responde `{ ok:false, error }` (y no se guarda nada) si:
    - la clave no descifra la copia (`DECRYPT`);
    - hay copia y no hay clave (`NO_KEY`);
    - el token o el repo fallan (`AUTH`, `FORBIDDEN`, `NOT_FOUND`…);
    - no hay red (`NETWORK`…) y el dispositivo ya tenía una configuración que funcionaba.
  - Sin red en un dispositivo **sin configurar**, responde `ok:true` con `error` pasajero: se guarda y se reintentará solo.
  - `apply(state)` guarda la configuración, la identidad probada (o una clave nueva si no había copia remota) y lo leído (`applySyncResult`).
  - Con el mismo repo y rama, recuerda quién publicaba. Con otro repo, empieza de cero.
- **`syncNow` sin identidad:** si tiene que crear el `deviceId` o la clave, no escribe nada y devuelve `error.code === 'RETRY'` con la identidad en `res.sync`. Al aplicarla, la siguiente llamada publica. La cola lo hace sola. Un dispositivo que solo lee sí termina bien en esa misma llamada (no escribe).

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
  rev, remote: { rev, days, savedAt, deviceId, publisher, legacy } | null,
  startedAt,       // ISO: cuándo empezó (para descartar resultados viejos)
  sync,            // PARCHE para settings.sync (aplicar con applySyncResult)
  error: { code, message, detail, status, retry } | null,
  target: { owner, repo, branch, keyTag }
}
```

**`applySyncResult(current, res, { now })`** fusiona `res.state` con el estado **actual**, sin perder lo editado mientras se sincronizaba, y aplica `res.sync` con estas excepciones:

- `owner`, `repo` o `branch` cambiaron entre medias → no aplica nada;
- **resultado viejo** (`res.startedAt` anterior a `sync.lastSyncStartedAt`) → solo fusiona los datos. No toca `publisher`, `baseRev`, `unpublished`, `lastPull/PushAt`, hashes, errores ni `prevKey`. Una marca en el futuro (reloj adelantado) no cuenta;
- un `deviceId` o una `key` del resultado solo **rellenan** los que falten. La excepción es la clave anterior recuperada (`keyRestored`), si la sincronización empezó con la clave que sigue guardada;
- los errores y el `prevKey` de una sincronización que empezó con otra clave se descartan.

**Qué hace `syncNow` por dentro:**

1. Lee `backup.json`. Si existe, **siempre** lo descifra y fusiona por día y por código (gana el `updatedAt` más reciente; los borrados cuentan; avisos y lugares también). Si la clave no vale pero `prevKey` sí, recupera `prevKey`.
2. Si otro dispositivo publica (según la copia o, si no la hay, según lo recordado), termina aquí con `readOnly: true`.
3. Si publica este, escribe `backup.json` solo si hay algo nuevo, con `rev + 1` y comprobando el `sha` (hasta 3 intentos si otro escribe a la vez).
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
| `RETRY` | `syncNow`/`becomePublisher` tuvo que crear el `deviceId` o la clave: no escribió nada. **No se anota como error**: aplicar y repetir (la cola lo hace sola) | sí |
| `CONFIG` | falta `owner`, `repo` o `token`, tienen caracteres no válidos, o la configuración del enlace o el formulario no vale | no |
| `NO_KEY` | hay copia cifrada y este dispositivo no tiene la clave | no |
| `DECRYPT` | la clave no coincide, o se alteraron los metadatos (también quién publica). No se escribe nada | no |
| `AUTH` / `FORBIDDEN` / `NOT_FOUND` / `INVALID` / `UNKNOWN` | 401 / 403 / 404 / 422 / otro | no |
| `RATE_LIMIT` / `SERVER` / `NETWORK` | límite de peticiones / 5xx / sin red | sí |
| `CONFLICT` | `sha` cambiado 3 veces, o `backup.json` cambió antes de escribir `turnos.ics` (otro pasó a publicar) | sí |
| `BAD_REMOTE` / `NEWER_REMOTE` / `NEWER_LOCAL` | copia dañada / de una versión más nueva / estado de una versión más nueva | no |
| `EMPTY_LOCAL` | publicar dejaría 0 días encima de una copia con días, o (sin `backup.json`) encima de un `turnos.ics` con eventos | no |
| `NO_REMOTE` | solo en `fetchRemoteBackup` y `pullBackup` | no |

- **Hoy:** el consejo `sync-error` ya avisa (§7).
- **Ajustes → Calendario del iPhone:** si `lastErrorCode` no es pasajero, mostrar `lastError` y el botón **«Tengo un enlace nuevo»**.
- **Opciones avanzadas:** mostrar `lastErrorDetail`.

### 3.5 Otras funciones de `sync.js`

- `fetchRemoteBackup(sync, fetch)` devuelve `{ rev, meta, data }`, con `data` en claro, listo para `importBackup` (restaurar **reemplazando**). No escribe.
- `pullBackup(sync, fetch)` devuelve un string JSON en claro (compatibilidad).
- `pushData` está **obsoleto**: lanza `NO_KEY` sin clave y `CONFIG` sin `deviceId`, y no pasa a publicar nunca. Usar la cola.
- `testConnection(sync, fetch)` devuelve `{ ok, message, detail, code?, private?, defaultBranch?, warning? }`. `warning` aparece si el repo publica GitHub Pages: mostrarlo.
- `ensureBranch`, `calendarUrls(sync)` (`branch ''` → `HEAD`), `encryptBackup`, `decryptBackup` y, en `cipher.js`, `generateSyncKey`, `isSyncKey`, `randomId`.
- `parseSetupLink(hash)` devuelve `{ enabled:true, owner, repo, branch, token, key, publishPlaces? }` o `null`. Valida cada campo: `owner` y `repo` con las reglas de GitHub; `branch` como rama de git; `token` con `ghp_` o `github_pat_`; `key` en base64url de 43 caracteres, o vacía. `normalizeSyncConfig(obj)` hace lo mismo para el formulario.
- `buildSetupLink(baseUrl, sync)` incluye `key` (y `publishPlaces` si está activado).

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
- **Crear el enlace:** `buildSetupLink(location.href, store.get().settings.sync)`, en «Opciones avanzadas → Crear enlace de configuración». Solo si `isSyncKey(sync.key)`.

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

   Errores típicos: `DECRYPT` (el enlace trae otra clave: «pide un enlace nuevo»), `NO_KEY`, `AUTH` (token caducado), y `NETWORK` si ya estaba conectado («inténtalo con internet»).
5. Según quién publica:
   - `t.readOnly` (ya publica otro, p. ej. el navegador de quien ayuda) → `confirmDialog`: «¿Usar este iPhone para actualizar el calendario? Tu otra app dejará de hacerlo. Primero se juntan los turnos de los dos.»
     - **Sí:** `const r = await syncQueue.becomePublisher()`. Si `!r.ok`, mostrar `r.error.message`.
     - **No:** este dispositivo solo lee (§4.4).
   - si no: `await syncQueue.sync()`. Si no hay copia, este pasa a publicar y crea `backup.json` y `turnos.ics`. Si devuelve `EMPTY_LOCAL`, mostrar su mensaje.
6. Ir al paso «Suscribirme en el iPhone» (`calendarUrls(sync).webcal`).

`publishPlaces` del enlace: lo aplica `t.apply` solo si este dispositivo nunca eligió, y con el sello mínimo. Un enlace viejo nunca vuelve a activar los lugares que Mauricio desactivó.

**Cambiar la clave** (lo hace quien ayuda, en este orden):

1. Borrar `backup.json` en GitHub.
2. En el dispositivo que publica, aplicar el enlace o el formulario con la clave nueva (`syncQueue.setup`). Al no haber copia, se acepta.
3. `syncQueue.sync()` publica con la clave nueva.
4. Enviar el enlace nuevo a los demás dispositivos. Hasta entonces dan `DECRYPT` y no escriben nada.

Si se aplica la clave nueva **antes** de borrar la copia, la sincronización recupera la anterior (`prevKey`) y no cambia nada.

### 4.3 Sincronización de fondo (`ui/background.js`)

```js
async function runSync({ manual = false, force = false } = {}) {
  const s = store.get().settings.sync;
  if (!s.enabled) return null;
  if (isIOS() && !isStandalone() && !manual) return null;   // Safari sin instalar: nunca automático
  const res = await syncQueue.sync(force ? { force: true } : undefined);
  if (manual) toast(res.ok ? (res.readOnly ? 'Datos al día (este dispositivo solo lee).' : 'Calendario actualizado.') : res.error.message);
  if (!res.ok && res.error.retry) scheduleRetry();           // 1 min, 5 min, 30 min…
  return res;
}
```

- **Cuándo:** al abrir la app; en `visibilitychange → visible` (después de `store.refresh()`); en `online`; cada 30 min con la app visible; y tras cada cambio de datos con un retardo de unos 4 s.
- **Clave de cambios (`dataKey`):** `days`, `tombstones`, `codes`, `codeTombstones`, `reminders`, y de `sync`: `enabled`, `owner`, `repo`, `branch`, `token`, `key` y `publishPlaces`.
- En `visibilitychange → hidden` y `pagehide`, lanzar ya lo pendiente (iOS puede congelar la app).
- En un dispositivo que solo lee, `syncNow` solo lee: es seguro llamarlo igual.
- «Enviar ahora» (Opciones avanzadas): `runSync({ manual: true, force: true })`.

### 4.4 Solo lectura: banner y «Usar este dispositivo»

Si `isReadOnlyDevice(store.get().settings.sync)`, en Ajustes → Calendario del iPhone:

- **Estado:** «Este dispositivo solo lee; el calendario lo actualiza tu otra app.» Si `sync.unpublished > 0`, añadir «Hay cambios aquí que no están en el calendario.»
- **Botón «Usar este dispositivo»** →

  ```js
  const ok = await confirmDialog({
    title: '¿Actualizar el calendario desde este dispositivo?',
    text: 'Tu otra app dejará de hacerlo. Primero se juntan los turnos de los dos.',
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
  - Lleva los ajustes del usuario, `publishPlaces`, `onboardingDone`, `codes`, `days`, `tombstones`, `codeTombstones`, `scans` y `changes`.
  - Con `__newerSchema` lanza un `Error` con `code: 'NEWER'`.
- **`importBackup(state, jsonOrObject, { now, force })`:**
  - No toca `settings.sync` (incluidos `publishPlaces` y la clave), `settings.ntfy` ni un `onboardingDone: true`.
  - En un teléfono **ya conectado** (sync activa que ya leyó o publicó), lo importado pasa a ser lo más nuevo: se sella con `now` y los días que faltan quedan como borrados.
  - En uno **sin conectar** se conservan las fechas de la copia.
  - Un borrado nunca retrocede.
  - Lanza `INVALID`, `NEWER`, `ENCRYPTED` o `EMPTY_BACKUP`.
- **`saveBeforeImport` / `listBeforeImport` / `undoImport`:**
  - `saveBeforeImport` guarda como mucho 3 copias y devuelve `null` si no pudo guardar.
  - `undoImport` **exige** la `key` de esa importación; devuelve `null` si falta o si la copia ya no existe.

---

## 6. Mutaciones, códigos y calendario

- `clearDay(state, key, { now })` deja una tombstone; `setDay` la quita.
- `upsertCode(state, def, { now })`:
  - sin cambios reales devuelve **el mismo** `state`;
  - si cambia el tipo del código, reordena (sin sellar) los días que lo usan;
  - lanza error si hay fin sin inicio, y acepta solo inicio;
  - si cambian las horas y el turno queda en 6 h o menos, una pausa de 30 pasa a 0.
- `deleteCode(state, code, { now })`: uno de fábrica vuelve a su definición original; uno propio deja una tombstone (y una definición supuesta si algún día lo usa). También reordena los días.
- `updateSettings(state, patch, { now })`:
  - es una mezcla profunda; `null` borra los campos que por defecto son `null`;
  - los sellos de avisos y lugares se ponen solos, salvo que vengan explícitos;
  - si una clave buena se sustituye, la anterior queda en `prevKey`, salvo que el parche diga qué hacer con `prevKey`.
- `mergeStates(local, remote, { now, since, adoptSettings })`: por día y por código gana el `updatedAt` más reciente. Al final deja el orden canónico de los días, con los tipos ya fusionados.
- **Saneado de lo importado o cargado:**
  - colores solo `#RGB` o `#RRGGBB`;
  - de los códigos solo los campos conocidos;
  - longitudes máximas;
  - sin las claves `__proto__`, `constructor` ni `prototype`.
- **`guessCode`:**
  - letra + 1 dígito → `shift` (F, S, N y Z copian F1, S1, N1 y Z1);
  - letra + 2 dígitos → `place`;
  - el resto → `other`, sin horario y sin confirmar.
- **Códigos con hora:** `isTimedCode`, `dayTimedItems` (`startOnly` si no hay fin), `timedInterval` y `countsAsWork`.
- **`buildICS(state, { from, to, now, notes = false, places = true })`:**
  - sin notas por defecto;
  - el rango empieza en `defaultIcsFrom(now)`, el día 1 del mes de hace 2 meses;
  - `DTSTAMP` y `LAST-MODIFIED` son estables y `SEQUENCE` nunca retrocede;
  - para el `.ics` manual de Ajustes, usar `buildICS(state, { now })`.

---

## 7. Consejos (`getAdvice`)

`action.section` es `'calendar'` (= `#set-calendar`). La UI llama a `go(tab, { section })`; Ajustes hace scroll a `#set-<section>`.

| `id` | Nivel | Qué es |
|---|---|---|
| `sync-error` | `alert` si no es pasajero | «Tu calendario no se está actualizando». Va el primero en Hoy. |
| `sync-error` | `warn` si es pasajero | Solo si falla desde hace más de 24 h. `RETRY` cuenta como pasajero, aunque nunca se anota como error. |
| `sync-error` | `info` si es pasajero y nunca conectó | «Todavía no se ha podido conectar el calendario…» |
| `read-only` | `warn` | Otro dispositivo publica y aquí hay cambios sin publicar. |
| `reminders-off` | `info` | Sin sync ni ntfy. |
| `gaps-<fecha>` | `info` | «Faltan días en el plan». |
| `newer-schema` | `alert` | «Actualiza la app». |

---

## 8. ntfy (opcional)

- El aviso «mantener recordatorios» se titula «Abre la app Turnos» y no lleva enlace.
- En iPhone/iPad, `syncNtfy` y `testNtfy` no añaden `click` salvo que se pase `{ appUrl }`.

---

## 9. Tests e2e

Los mocks de GitHub deben simular:

- `backup.json` **v3** (`meta.publisher`, `meta.publisherSince`), con PUT que exige el `sha`;
- `turnos.ics` sin `?ref=` cuando `branch` es `''`. El que publica hace GET de `turnos.ics` en cada sincronización. Si difiere, hace **otro GET de `backup.json`** y después el PUT;
- `commit.sha` y `content.sha` en las respuestas de PUT;
- `409`/`404` en `git/ref` para repos vacíos.

Además:

- un dispositivo que solo lee no hace ningún PUT ni POST;
- la primera sincronización de un estado sin `deviceId` o sin clave no escribe nada (`RETRY`) si no se usa `ensureSyncIdentity` o la cola;
- los enlaces de prueba usan un token con formato real (`` `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}` ``).

`test/unit/helpers.mjs` (`fakeGitHub`) es una referencia completa. Los escenarios de esta ronda están en `test/unit/sync-recovery.test.mjs`.
