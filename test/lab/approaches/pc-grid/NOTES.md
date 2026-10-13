# Reconocedor "pc-grid" (impresión mensual de euregon fotografiada del monitor)

Prototipo de `recognize(input, options)` / `dispose()` (SPEC §5) para la tabla mensual
"Dienstplan <Monat> <Jahr>" (una columna por día, cabecera con día de la semana + número, fila de
"Ducuara Mauricio" con 3 sub-líneas). Solo JS + `<canvas>` + tesseract.js 7 (LSTM, `best_int/eng`).
Sin OpenCV, sin red, sin paso de build. Con cualquier otra foto (lista del móvil) devuelve
`layout: 'unknown'` y `days: []` en ~0,1–0,3 s (no se llega a cargar el OCR).

Idea central: **la geometría manda**. La rejilla de la tabla se encuentra con Hough sobre crestas oscuras
finas, se endereza con una homografía y todo lo demás (columnas, filas, celdas) se hace en la imagen
rectificada, donde las líneas son verticales/horizontales exactas. El OCR solo lee trozos pequeños y
normalizados (números de la cabecera, título, texto de cada insignia) y cada decisión se cruza con
restricciones (calendario, vocabulario por color, sub-línea, plantillas, consenso entre insignias
iguales). Ante la duda, el día se omite.

## Resultados (Chromium escritorio)

| Conjunto | Días bien | Mal | Extra | Mes | Tabla | Tiempo medio |
|---|---|---|---|---|---|---|
| dev `pc-2026-06.jpg` (única foto real de este formato) | 30/30 | 0 | 0 | ok | ok | ~3,7 s |
| dev, 11 fotos de la lista del móvil | 0 días (correcto: `unknown`) | 0 | 0 | — | — | ~0,2 s |
| sintético `seed 5` (40 fotos, usado en parte para ajustar) | 933/1210 (77 %) | 0 | 0 | 38/40 | 39/40 | 3,3 s |
| sintético `seed 6` (40, usado en parte para ajustar) | 926/1192 (78 %) | 0 | 0 | 38/40 | 39/40 | 3,4 s |
| sintético `seed 8` (40, validación; solo 2 umbrales tocados tras verlo) | 891/1195 (75 %) | 1 | 0 | 40/40 | 40/40 | 3,3 s |
| sintético difícil `seed 9 --hard 1` (20: tablas pequeñas, desenfoque ≤ 2 px, 1280 px) | 281/590 (48 %) | 0 | 0 | 15/20 | 15/20 | 2,9 s |
| sintético parcial `seed 10 --partial 1` (16: solo se ve parte del mes, a menudo sin título) | 179/306 (58 %) | 0 | 0 | 14/16 | 16/16 | 2,6 s |

`RESUMEN` dev: `{"photos":12,"required":145,"correct":30,"wrong":0,"extra":0,"missed":115,...,"avgMs":599}` (los 115
"falta" son de la lista del móvil, que este reconocedor no lee a propósito). El único error en sintético es una
insignia magenta F51 leída "53" dos veces y confirmada por la plantilla (F53); a nivel de insignia el ajuste
(`tools/tune.mjs`) da 0 insignias mal en los conjuntos 5, 6, difícil y parcial y 2 de 911 en el de validación
(las dos, lecturas OCR erróneas y repetidas en imágenes pobres). Los meses "fallidos" en sintético
son fotos sin título legible: con el respaldo del calendario se elige el único mes compatible cerca de *hoy*
(los años sintéticos son aleatorios 2025–2028), o `null` si hay varios.

## Método (por fases, `recognize.js`)

1. **Carga** (`img.js`): `createImageBitmap` → lienzo ≤ 2000 px (reducción por mitades, Safari filtra mal
   las reducciones grandes). Si la foto es mayor se conserva el original para los recortes de las
   insignias (fase 6). `OffscreenCanvas` si existe, si no `<canvas>`.
2. **Rejilla** (`lines.js`, `table.js`): mapas de "cresta oscura" (píxel más oscuro que sus vecinos a
   ±2/±R px en vertical u horizontal, umbral 16) → Hough para rectas casi horizontales (±25°) y casi
   verticales (±30°) → cada pico se recorre y se convierte en segmentos (huecos tolerados) con la recta
   reajustada por mínimos cuadrados. La tabla es el par de horizontales casi paralelas (borde superior /
   inferior) atravesado por más segmentos verticales (≥ 8); a igualdad, la banda más alta.
3. **Homografía** (`table.js`, `geom.js`): cuadrilátero con las verticales extremas, refinado con todas las
   verticales (sus cortes con las dos horizontales). Se rectifica una región **ampliada** (5,5 columnas a la
   izquierda para el nombre, 8 a la derecha para Soll/Ist, ~7 columnas por encima y hasta 12 por debajo),
   a ~48 px por columna. No depende de que la banda elegida sea exactamente el borde de la tabla: todas
   las líneas son del mismo plano.
4. **Estructura en la imagen rectificada** (`grid.js`): bordes de columna = tramos verticales largos
   (≥ 0,6 columnas, huecos ≤ 4 px en los cruces) acumulados por columna → picos → **cadena regular** (paso =
   mediana; un hueco doble se rellena, un borde espurio entre dos buenos se salta). Extensión vertical de la
   tabla = filas donde ≥ 50 % de esos bordes están presentes. Líneas de fila = picos del perfil horizontal
   → **cadena de paso uniforme** (todas las filas miden lo mismo en esta impresión).
5. **Cabecera, mes y fila del empleado**:
   - Números de día: tira con los recortes de cada celda (contraste estirado, separados por blanco), OCR
     PSM 7 con lista blanca de dígitos; los símbolos (no las palabras: Tesseract junta "0102…") se asignan a
     su hueco; voto `día = índice + desplazamiento`. Se prueban las filas 1, 0, 2; si no hay ≥ 40 % de votos,
     tira más grande y por último celda a celda. Sin ≥ 3 votos → `unknown`.
   - Días de la semana: misma técnica (lista blanca `MoDiMiDoFrSa`). Fines de semana: columnas cuya tinta es
     claramente más roja que la mediana (relativo, inmune a la luz cálida).
   - Mes/año: OCR (PSM 11) del título rectificado **aplanado** (gris dividido por el fondo local: quita
     moiré, reflejos y degradados) y, si no basta, del original; nombres alemanes con distancia de edición,
     años 20xx, fechas dd.mm.aaaa ("Datum des Aushangs", también mes+1). Cada candidato se puntúa con el
     calendario: coincidencia de los días de la semana leídos, columnas rojas = sábado/domingo y, si la cadena
     está completa (columna ancha del nombre a la izquierda, Soll a la derecha), el número de días. Respaldo:
     OCR de una zona más alta sobre la tabla; último recurso: el **único** mes entre −3 y +4 desde hoy
     compatible con el calendario (aviso "Revisa el mes"; si hay varios, `null`). Si los días de la semana
     leídos contradicen el mes elegido, `month = null`.
   - Bloques de empleado: cada uno son 3 sub-filas (ausencias / turno / lugar); las líneas que cruzan
     también la columna del nombre los separan. Con varios, OCR del nombre (`employeeName`, por defecto
     "Ducuara", distancia ≤ 1/4 de su longitud). Estructura dudosa → grupos de 3; sin coincidencia única →
     sin días.
6. **Celdas** (`badges.js`): por cada día visible (las 4 esquinas de la celda dentro de la foto), parche
   rectificado (de la foto original a más resolución si existe, factor ≤ 2,5), **balance de blancos local**
   (mediana de los píxeles claros y poco saturados de la propia celda), HSV.
   - Insignias = componentes saturados (S > 0,12) con forma de insignia (≥ 0,45 col × 0,4 fila, relleno
     ≥ 0,5). Clase por tono: amarillo, verde, azul, magenta, rojo, rosa.
   - Marcas rojas = rojez r−(g+b)/2 que explica el oscurecimiento, fuera de las líneas de la rejilla (±4 px),
     lejos de las insignias y **solo en la línea de ausencias**; forma del núcleo (umbral adaptativo al 50 %
     del oscurecimiento máximo): guion (ancho 0,12–0,5 col, plano) o U (alto 0,24–0,75 fila, w ≤ 1,1 h,
     rojez ≥ 28, confirmada por OCR: si se lee "W" es el texto de una etiqueta W- descolorida → dudoso).
     Guion "gris" (rojo descolorido): marca oscura con forma de guion en la línea de ausencias.
   - Seguridad: manchas de color que no son insignias, marcas rojas sin clasificar, "tinta residual" sin
     explicar (para aceptar `[]` la celda tiene que estar limpia), más de una marca en la línea de ausencias,
     o rejilla casi invisible (contraste < 0,45 × mediana: reflejo/dedo) → el día se omite.
7. **Texto de las insignias** (`badges.js`, `tmatch.js`, `decide.js`): tinta normalizada en la elipse
   interior (luminancia: en JPEG el color va a media resolución; polaridad por clase: N1/TS/S31 texto
   blanco), 4 lecturas OCR (PSM 7: altura 34 y 26 con lista blanca, 44 sin lista, 34 binarizada; PSM 8 no
   funciona en tesseract.js 7), parada anticipada si dos lecturas seguras coinciden. Decisión conjunta:
   - votos = confianza × similitud con cada código de la clase (distancia de edición que abarata las
     confusiones letra↔dígito S/5, I/1, O/0, Z/2, B/8; los dígitos entre sí no);
   - plantillas Arial (NCC sobre la caja de tinta, degradadas a la resolución de la foto) que solo
     **refuerzan** candidatos que el OCR ya apoya; nunca deciden solas;
   - vetos: plantilla claramente en contra (los códigos con "1" solo con un desacuerdo muy grande: el trazo
     fino del 1 cambia mucho con la letra y el desenfoque), imagen ilegible (ninguna plantilla encaja), mayoría
     de lecturas idénticas que no son el ganador, una sola lectura a favor y floja, solo lecturas parciales
     (sin repetirse ni confianza ≥ 0,6), lugar cuya letra el OCR no distingue, lecturas que coinciden con un
     código de **otro** color (colores lavados);
   - rosa: la sub-línea decide (W- en la línea de ausencias, Z en la de turno), el OCR solo puede vetar;
   - clases de un solo código conocido (verde S1, rojo S31) se aceptan por color si alguna lectura se parece
     al código y ninguna lee otro código válido (S2, S7…) ni otro dígito final repetido;
   - códigos nuevos (F4, S2, F54…): solo con 3+ lecturas idénticas, confianza ≥ 1,8 y plantilla a favor;
     una lectura repetida de un código nuevo plausible bloquea el código conocido (mejor omitir);
   - consenso: si la evidencia propia no basta, se suman votos de insignias de la misma clase y aspecto casi
     idéntico (NCC ≥ 0,82 de las firmas de tinta) — los turnos se repiten días seguidos — pero solo si la
     propia insignia apoya algo al ganador.

`result.debug.overlay` (con `debug: true`): foto con la rejilla, tabla rectificada con cajas verdes
(decidido) / rojas (dudoso), tiras de la cabecera, título y hoja de recortes de insignias.
`result.debug.info`: lecturas de cabecera, título, mes elegido, celdas (`día:contraste clase=código[lecturas]`),
evidencias de cada insignia y tiempos por fase.

## Parámetros principales

| Dónde | Parámetro | Valor |
|---|---|---|
| lines.js | radio/umbral de cresta | R = máx(2, lado/650), T = 16 |
| lines.js | Hough | paso 0,25°, ±25° (h) / ±30° (v); segmento mín. 6 % (h) / 1,2 % (v) del lado |
| table.js | verticales mínimas que cruzan la banda | 8 |
| recognize.js | escala rectificada | 48 px por columna (1×–3×) |
| grid.js | tramo vertical mínimo / hueco | 0,6 columnas / 4 px; cadena ±20 % (columnas), ±12 % (filas) |
| badges.js | insignia | S > 0,12, ≥ 0,12·col², ≥ 0,45 col × 0,4 fila, relleno ≥ 0,5 |
| decide.js | `DEFAULTS` | ver comentarios (ajustados con `tools/tune.mjs`) |

## Herramientas (todo dentro de esta carpeta)

- `synth/generate.mjs --out <dir> --n 40 --seed 5 [--hard 1] [--clean 0.15]`: réplica HTML/CSS
  (`synth/print.html`) de la impresión con mes/año/plan/códigos aleatorios (incl. `[]`, TS, S31, F4, S2,
  F54, 1–4 empleados, columnas Soll/Ist, otra ventana con insignias a la derecha), capturada con Playwright
  (DPR 1 o 2) y fotografiada en el navegador (`synth/distort.js`): perspectiva/giro ±15°, moiré con franjas
  de color, luz cálida/fría, degradados, reflejos, dedo, desenfoque, ruido, JPEG, 1600×900 a 4032×3024;
  ~15 % capturas limpias. Escribe `gt.json` con el formato de `ground-truth.json` (días cortados/tapados
  como opcionales `null`). Las imágenes van **fuera del repositorio** (por defecto al directorio temporal).
- `tools/eval-synth.mjs --dir <dir> [--debug outdir] [--opts '{...}']`: evalúa como `eval.mjs`.
- `tools/tune.mjs <dir> <debugdir> ['{"param":v}'] [--list]`: re-ejecuta `decide.js` sobre las evidencias
  guardadas (sin OCR) para ajustar la decisión en segundos; informa aciertos/errores/nulos por clase.
- `tools/run.mjs`: ejecuta un módulo sobre una imagen y guarda la superposición.

## Modos de fallo conocidos

- **Una sola foto real** de este formato: todo lo demás es sintético (misma fuente Arial de las plantillas
  → las plantillas parecen mejores en sintético que en la realidad; por eso solo refuerzan al OCR y se
  ignoran para el "1").
- **Insignias magenta pequeñas** (texto morado sobre magenta, poco contraste): la causa principal de días
  omitidos (≈ 75 % de las omisiones en sintético). Con fotos de 12 MP ayudan los recortes de alta
  resolución; con fotos de WhatsApp (1600 px) y tablas pequeñas se pierde bastante.
- Tablas muy pequeñas en la foto (celdas < ~25 px), desenfoque ≥ 1 px o perspectiva extrema: no se
  encuentra la rejilla o no se leen los números → `unknown` (sin días, nunca inventados).
- Reflejos fuertes sobre una etiqueta W- pueden dejar solo su texto; se detecta como dudoso en la mayoría de
  casos, pero no en todos (el contraste de la rejilla en zonas lavadas es parecido al de una foto normal
  inclinada, así que el filtro de "reflejo" es conservador).
- Papel curvado (impresión real en vez de monitor): la homografía no lo modela; las columnas lejanas
  pueden desalinearse.
- Si la empresa cambia el formato (más/menos sub-líneas, otro orden ausencias/turno/lugar), las reglas de
  sub-línea (3 por empleado, W- arriba, Z en la de turno) dejarán de valer → `pickBlock` devuelve null.
- Sin título legible el mes sale del calendario cercano a hoy (`options.now`) y se marca como dudoso.

## Opciones extra

`options.decide` (parámetros de `decide.js`), `options.now` (fecha de referencia para el respaldo del
calendario), `options.employeeName`, `options.knownCodes`, `options.onProgress(fracción, texto)`.
