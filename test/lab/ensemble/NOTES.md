# Reconocedor de producción: conjunto de tres lectores (`docs/js/recognize/`)

`docs/js/recognize/index.js` cumple el contrato de SPEC §5 (`recognize(input, options)`, `dispose()`) combinando
tres prototipos ya evaluados, copiados sin cambiar su lógica:

| Carpeta | Prototipo de origen | Papel |
|---|---|---|
| `phone-a/` | `test/lab/approaches/color-first` | Lector A de la lista del móvil: rápido (~1,4 s); también detecta la tabla del PC |
| `phone-b/` | `test/lab/approaches/rectify-rows` | Lector B (~1,9 s): segunda lectura, solo si la de A parece incompleta |
| `pc/` | `test/lab/approaches/pc-grid` | Tabla mensual impresa de euregon |
| `ocr-pool.js` | nuevo | Worker de Tesseract compartido por los tres |

Cambios en las copias (todo lo demás es idéntico al prototipo):
- `ocr.js` de cada lector delega en `ocr-pool.js` (mismas firmas que antes).
- Rutas de Tesseract por defecto: `docs/vendor/tesseract/` vía `import.meta.url` (antes apuntaban a
  `../../../../docs/…` o, en pc-grid, al CDN).
- `debug.js` se carga con `import()` solo con `debug: true` (la superposición sigue funcionando con `eval.mjs --debug`).
- A: `console.error` → `console.warn`. B: no cierra un `ImageBitmap` que no ha creado él (antes cerraba el del
  llamante); quitada la opción de desarrollo `skipOcr`.
- A y B devuelven además `unread` / `unreadWhy` (días que vieron pero no pudieron leer, y por qué); `index.js` los
  usa para fusionar y para el aviso, y no los pasa a la UI.

Equivalencia comprobada: las copias (cada una sola, `--impl docs/js/recognize/phone-a/recognize.js`, etc.) dan
exactamente los mismos días, mes y disposición que los prototipos en las 16 fotos reales (`--set all`), y las
copias A/B sobre la muestra de estrés reproducen los 1619 / 1694 días de los informes originales.

## Flujo de `recognize()`

```
decodificar UNA vez (Blob → <img>, respeta EXIF; sin DOM → createImageBitmap)   "Leyendo la foto…"
  └─ el worker de Tesseract arranca en paralelo (prewarm)
A (0,03 → 0,55)                                     "Buscando los días…" / "Leyendo los turnos…"
  ├─ A dice 'pc-grid', o no hay días y la foto es apaisada → pc (0,55 → 0,97)
  │     └─ pc dice 'pc-grid' → se devuelve el resultado de pc
  ├─ A parece incompleto → B (0,55 → 0,97)                          "Comprobando…"
  ├─ fusión A + B                                                   "Comprobando…"
  └─ ningún día y pc sin probar → pc como último recurso (< 0,3 s si no hay tabla)
"Listo" (1)
```

- `onProgress` siempre crece (nunca retrocede) y solo usa las etiquetas «Leyendo la foto…», «Buscando los
  días…», «Leyendo los turnos…», «Comprobando…» y «Listo».
- Nunca lanza: cada lector va en `try/catch` (si falla uno, siguen los otros); cualquier otro error →
  `{ layout:'unknown', month:null, year:null, days:[], warnings:['…'] }` y `console.warn`. Sin
  `globalThis.Tesseract` devuelve enseguida un aviso (y no ejecuta nada).
- `dispose()` termina el/los worker(s) del pool; los trabajos pendientes fallan (la lectura en curso termina con
  lo que tenga, no se cuelga) y la siguiente llamada crea un worker nuevo.
- Opciones de laboratorio (no forman parte del contrato): `phoneB: 'auto'|'always'|'never'`, `ocrWorkers: n`.
  `test/lab/ensemble/variant.js?b=always&w=2` las fija para `eval.mjs`.

## Regla de disparo de B

B se ejecuta si **A parece incompleto** (`looksIncomplete` en `index.js`, umbral en `RULES.minDaysA`):

> layout ≠ `phone-list`, **o** mes o año `null`, **o** A no pudo leer alguna fila que vio (o algún aviso),
> **o** A devuelve **menos de 11 días**.

Una captura de la app muestra 10-11 filas: con 11 días leídos, sin avisos y con mes/año, A ya ha leído todo lo
visible y B no añade nada. Con OCR caído (A avisa de que no arranca el lector) no se ejecuta B.

Medido sin OCR con `analyze.mjs` sobre los resultados en bruto de A y B (`collect.mjs`), con la fusión real
de `index.js` (solo fotos de la lista del móvil; tiempos de Chromium de escritorio, A + B cuando se ejecuta):

| Conjunto | Solo A | B siempre | **B si A incompleto (< 11)** | < 10 días |
|---|---|---|---|---|
| 16 fotos reales (dev + holdout) | 156/156, 1,45 s | 156/156, 3,42 s | **156/156, 2,44 s** (B en 8/15) | 156/156, 2,04 s (B en 5/15) |
| muestra de estrés (172 móvil) | 1619/1806 (89,6 %) | 1762 (97,6 %), 3,26 s | **1764 (97,7 %), 2,73 s** (B en 124) | 1764, 2,55 s |
| resto del estrés, sin ver (447 móvil) | 3895/4673 (83,4 %), **2 mal** | 4454 (95,3 %), 3,33 s | **4456 (95,4 %), 2,72 s** (B en 307) | 4445 (95,1 %), 2,45 s |

Todas las columnas del conjunto con 0 días mal. Con «< 11» se obtiene lo mismo (o un poco más: si B no se
ejecuta, las lecturas de A con confianza 0,5 no se ponen en duda) que ejecutando B siempre, con ~18 % menos de
tiempo; «< 10» ahorra otros ~0,3 s pero pierde 11 días en el conjunto sin ver. El conjunto «sin ver»
(`stress-rest-gt.json` = `stress-gt.json` menos la muestra) sirvió para validar la regla de disparo, pero
también destapó los 3 días mal que motivaron las dos reglas de fusión de abajo: su «0 mal» ya no es una prueba
independiente de esas dos reglas (sí de que no quitan días bien de más: coste medido en los tres conjuntos).

## Fusión A + B (`mergePhone`)

- Días: unión. Si los dos leen el mismo día con códigos distintos → ese día se omite y se avisa
  («El día 12: dos lecturas distintas de la foto, revísalo a mano.»). Si coinciden, confianza = máximo.
- Si hay 2 o más días en conflicto, o el mes/año no coincide y hay algún conflicto (o ningún día en común),
  solo se conservan los días en los que A y B coinciden (las dos lecturas no cuadran entre sí).
- Mes y año (por separado): iguales → se mantienen; uno `null` → el otro; distintos → `null` + «No estoy seguro
  del mes: elígelo tú.» (o del año).
- `RULES.contestedMinConf = 0.55`: un día que solo lee un lector se omite si el otro vio esa fila sin poder
  leerla y la confianza es < 0,55 (en A, 0,5 = insignia decidida «por aproximación» o «por mayoría»).
  Evita los 2 días mal de A en el conjunto sin ver (F51 leído S51 en una foto lejana; B vio la fila pero la
  insignia le salió ilegible). Coste: 19 días bien de 6479 (0,3 %).
- `RULES.placeNeedsShift = true`: un día con un lugar (letra + 2 dígitos, p. ej. F52, o S31) y sin turno se
  omite: la insignia del turno se ha perdido (reflejo, dedo). En los 7290 días de todas las verdades (reales y
  sintéticas) no hay ninguno así. Evita el día mal de B en el conjunto sin ver (`_ghost`: F1 borrado por un
  reflejo → B leía solo `[F52]`, A no vio la fila). Coste: 0 días.
- `RULES.vetoWhy` / `soloMinConf` existen pero están desactivados (los datos no los justifican).
- Avisos recalculados (sin repetir los de cada lector): días vistos y no leídos («No pude leer bien los días
  12 y 15: revísalos a mano.»), mes/año, «Código nuevo: F4 — confirma su horario.», OCR que no arranca y, si no
  queda ningún día, el motivo más útil de cada lector (sin los de «solo leo la lista del móvil»).
- La tabla del PC se devuelve tal cual la da `pc/` (no se mezcla con A).

## OCR compartido (`ocr-pool.js`)

Los tres usan OEM 1 (LSTM, `best_int/eng`) y solo cambian `tessedit_pageseg_mode`,
`tessedit_char_whitelist` y `user_defined_dpi` (pc: 300; A y B: 0 = valor de Tesseract por defecto). Cada
trabajo lleva los **tres** parámetros y el pool fija la diferencia antes de leer con el worker reservado para
ese trabajo, así que un lector nunca hereda los ajustes de otro (comprobado: mismos resultados que con
workers separados). Al crear el worker se fija `debug_file=/dev/null`: los avisos internos de Tesseract
(«Bottom=0, top=…») salían como errores de consola con la foto del PC.

Tamaño: **1 worker** (por defecto). Con 2 no es más rápido en el harness (todas las fotos reales, auto:
2551/2616 ms con 1 frente a 2558 ms con 2; B siempre: 3367 frente a 3424 ms), porque domina el análisis de la
imagen en el hilo principal; 1 worker ahorra memoria en el iPhone.

## Entrada y memoria

`index.js` decodifica la entrada una vez: Blob/File → `<img>` (orientación EXIF aplicada; si falla,
`createImageBitmap(…, {imageOrientation:'from-image'})`); `<img>`, `<canvas>` e `ImageBitmap` se pasan tal
cual. Los tres lectores reciben esa misma imagen (ninguno la cierra) y trabajan en copias ≤ 2000 px que liberan
al terminar; se ejecutan uno detrás de otro, así que nunca hay más de una copia de 12 MP viva (más, durante la
reducción de A, un lienzo intermedio temporal del mismo tamaño que A libera enseguida).

## Medidas finales (Chromium de escritorio, 4 núcleos)

```
node test/lab/eval.mjs --impl docs/js/recognize/index.js
RESUMEN {"photos":12,"required":145,"correct":145,"wrong":0,"extra":0,"missed":0,"monthOk":12,"layoutOk":12,"avgMs":2470,
         "byLayout":{"phone-list":{"required":115,"correct":115},"pc-grid":{"required":30,"correct":30}}}
node test/lab/eval.mjs --impl docs/js/recognize/index.js --set holdout
RESUMEN {"photos":4,"required":41,"correct":41,"wrong":0,"extra":0,"missed":0,"monthOk":4,"layoutOk":4,"avgMs":3769}
node test/lab/eval.mjs --impl docs/js/recognize/index.js --gt test/lab/out/stress-sample-gt.json
RESUMEN {"photos":183,"required":1836,"correct":1788,"wrong":0,"extra":250,"missed":48,"optionalWrong":0,"monthOk":180,"layoutOk":182,
         "avgMs":2874,"byLayout":{"phone-list":{"required":1806,"correct":1764,"wrong":0,"extra":0},"pc-grid":{"required":30,"correct":24,"extra":250}},
         "accuracy":0.974}
# los 250 "extra" son días de las 10 variantes synth/aug-pc (0 días en esa verdad); con la verdad corregida:
node test/lab/eval.mjs --impl docs/js/recognize/index.js --gt test/lab/out/ensemble/stress-sample-pcfix-gt.json
RESUMEN {"photos":183,"required":1836,"correct":1788,"wrong":0,"extra":0,"missed":48,"optionalWrong":0,"monthOk":180,"layoutOk":182,"avgMs":2846,"accuracy":0.974}
         (274 días opcionales bien, 0 mal)
# validación con las 449 fotos de estrés que no se usaron para elegir nada (make-gt.mjs):
node test/lab/eval.mjs --impl docs/js/recognize/index.js --gt test/lab/out/ensemble/stress-rest-gt.json
RESUMEN {"photos":449,"required":4733,"correct":4508,"wrong":0,"extra":0,"missed":225,"optionalWrong":0,"monthOk":436,"layoutOk":449,
         "avgMs":2732,"byLayout":{"phone-list":{"required":4673,"correct":4456},"pc-grid":{"required":60,"correct":52}},"accuracy":0.952}
         (por separado: A 3895 + 2 mal, B 4171 + 1 mal; la unión sin las dos reglas de fusión tendría 3 mal,
          y esas reglas se diseñaron mirando estos 3 casos)
```

Pruebas de borde (`node test/lab/ensemble/edge.mjs`, 34/34 correctas):
- Entradas Blob, File, `<img>` (decodificada y sin decodificar), `<canvas>`, `ImageBitmap` (y la foto del PC como
  ImageBitmap y `<canvas>`): mismos días que con el Blob, 0 mal.
- Sin OffscreenCanvas (`window.OffscreenCanvas = undefined` antes de importar), con B forzado:
  phone-2026-08-b 11/11 (4,9 s), pc-2026-06 30/30 (4,5 s), sin errores de consola.
- 12 MP: phone-2026-07-a en 3024×4032 (con margen oscuro) 11/11 en 1,8 s; phone-2026-09-a escalada a 2268×4032
  11/11 en 2,1 s; pc-2026-06 en 4032×3024 29/30 en 5,5 s y escalada a 4032×2268 30/30 en 4,9 s. 0 mal. (JPEG
  ampliados: decodificar una foto real de 3-5 MB tarda algo más.)
- EXIF orientación 6 (píxeles girados 90°): 11/11.
- Núcleos `tesseract-core-simd-lstm` (Safari 16.4) y `tesseract-core-lstm` (sin SIMD) forzados con `corePath`: 11/11.
- Entradas inválidas (null, undefined, Blob vacío, texto, `{}`, lienzo de 1 px) y sin `globalThis.Tesseract`:
  no lanza, aviso en español. `dispose()` deja 0 workers y se puede volver a leer (también con las rutas por
  defecto); `dispose()` a mitad de una lectura no la cuelga; dos lecturas simultáneas: 0 mal.

Tests de la app: `npm test` verde; `npm run e2e` 20/20 (incluye «el reconocedor actual procesa una foto sin
errores» y «precache completo») sobre una copia del árbol con `docs/js/core` de HEAD. En el árbol compartido
fallan tests por el trabajo en curso de otro agente en `docs/js/core` (sincronización, copia de seguridad) y por
`docs/js/core/CHANGES-FOR-UI.md`, que no debería estar dentro de `docs/js/` (el test exige precachear todo lo
que hay ahí); `js/core/cipher.js` ya está en PRECACHE.

## Limpieza de `docs/vendor/tesseract/`

Con OEM 1 tesseract.js pide `lstmOnly` y, si `corePath` es una carpeta, elige
`tesseract-core-{relaxedsimd-,simd-,}lstm.wasm.js` según el navegador (Chromium: relaxedsimd; Safari 16.4: simd;
antiguos: sin SIMD). Antes de borrar se comprobó con grep (las únicas referencias a `lang/legacy` son cadenas
`langPathLegacy` que nunca llegan a `createWorker`) y con `edge.mjs`, que registra en el servidor cada archivo de
`vendor/` pedido (también desde los workers). Borrados: `core/tesseract-core.wasm.js`,
`core/tesseract-core-simd.wasm.js`, `core/tesseract-core-relaxedsimd.wasm.js`, `lang/legacy/` y
`tesseract.esm.min.js` (≈ 25 MB). Quedan las tres variantes `-lstm` (probadas las tres), `best_int` y las licencias.

## Herramientas (`test/lab/ensemble/`)

| Archivo | Uso |
|---|---|
| `variant.js` | `--impl "test/lab/ensemble/variant.js?b=always&w=2"`: el reconocedor con B siempre/nunca y n workers |
| `make-gt.mjs` | genera en `test/lab/out/ensemble/` `stress-rest-gt.json` y `stress-sample-pcfix-gt.json` |
| `collect.mjs` | `--gt <json> --out <json>`: resultados en bruto de A y B por foto (≈ 3,3 s/foto) |
| `analyze.mjs` | `<col.json>… [--rules '{…}'] [--why]`: regla de disparo + fusión de `index.js` sin OCR |
| `compare.mjs` | compara dos informes `--json` de `eval.mjs` (o `--union` para la unión de dos lectores) |
| `edge.mjs` | entradas, sin OffscreenCanvas, 12 MP, EXIF, núcleos, entradas inválidas, `dispose()`, concurrencia |

`stress-sample-gt.json` lista las 10 variantes `synth/aug-pc/pc_*.jpg` con 0 días (se hicieron para un lector
que no leía el PC), así que los días bien que ahora lee `pc/` cuentan allí como «extra». `make-gt.mjs` crea una
copia con los días reales de `pc-2026-06` como opcionales (un día bien no penaliza; uno mal sale como «opt-mal»).

## Limitaciones conocidas

- Tiempos medidos en Chromium de escritorio; en iPhone se espera bastante más (no medido aquí). B solo corre en
  ~⅔ de las fotos de estrés y en ~½ de las reales.
- Las reglas de fusión se ajustaron con 2 casos de error (3 días) en datos sintéticos; con fotos reales nuevas
  puede aparecer otro tipo de error que ninguna regla cubra.
- La tabla del PC girada 90° (`pc_q90`) no la lee nadie (pc solo admite giros de ±25-30°).
- `scan.js` sigue pasando `langPathLegacy` (inofensivo: no se usa) y SPEC §1/§5 aún nombran `lang/legacy`.
