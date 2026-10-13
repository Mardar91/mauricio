# rectify-rows — reconocedor de la lista "Dienstplan" (layout phone-list)

Idea: **rectificar primero, leer después**. Se localiza la lista en la foto a partir de sus líneas
separadoras, se calcula una homografía que la lleva a un rectángulo canónico (filas horizontales y de
altura constante) y en ese plano se ajusta una rejilla uniforme de filas. Cada fila se analiza por
separado (color + forma + OCR) y los días se asignan con restricciones de calendario.

Contrato: SPEC §5 (`recognize(input, options)`, `dispose()`), JS puro + `<canvas>`/OffscreenCanvas,
Tesseract.js 7 (OEM 1, LSTM `best_int`), 2 workers reutilizados entre llamadas.

## Tubería

1. **Carga** (`img.js`): `createImageBitmap` (EXIF) → respaldo `<img>`; reducción en pasos de ½ hasta
   ≤ 2000 px. Acepta Blob/File/`<img>`/`<canvas>`/ImageBitmap. Los workers de Tesseract arrancan en
   paralelo con el procesado de la imagen.
2. **Separadores** (`lines.js`): imagen de análisis de 1200 px (si la lista sale estrecha, < 420 px,
   se repite a 2000 px: teléfono lejos). Respuesta de "línea fina más oscura que arriba y abajo"
   (2 escalas, suavizado 5 px a lo largo de la línea, supresión de no-máximos vertical, umbral
   adaptado al ruido con MAD), solo sobre fondo claro. Hough restringido a ±24°, NMS geométrica,
   refinamiento por mínimos cuadrados y segmento de soporte. Familia = líneas largas, casi paralelas,
   que se solapan en x; el ángulo se suaviza con un ajuste robusto ángulo = α + β·y (convergencia por
   perspectiva).
3. **Cuadrilátero** (`lines.js`): desde los extremos de cada separador se avanza hacia fuera hasta una
   racha oscura (bisel) a ambos lados de la línea → puntos de borde izquierdo/derecho → RANSAC
   (`geom.fitRobust`). Cuadrilátero = bordes ∩ separadores extremos → homografía (DLT 8×8).
4. **Plano canónico** (`raster.warp`): ancho 400–900 px; se extiende mucho hacia arriba (cabecera) y
   abajo; lo que cae fuera de la foto queda con alfa 0 (inválido).
5. **Cabecera + rejilla** (`canon.js`): blanco de referencia = fondo de la lista; fracción naranja por
   fila (tono 14–50°, s ≥ 0,38 tras balance). Se busca la banda naranja subiendo desde la línea mediana
   de la familia (no la primera: puede ser el borde del móvil), parando si aparece un hueco oscuro
   (bisel); la banda debe medir ≥ 0,8 filas (≥ 0,5 si la corta el borde de la foto). Perfil de
   separadores con suavizado horizontal de 9 px; picos con umbral adaptativo; rejilla y = φ + k·P por
   votación de candidatos P (diferencias entre picos / n) con penalización de posiciones vacías
   (evita P/2) y refinamiento por regresión.
6. **Filas** (`canon.buildRows`): fila "completa" si sus dos límites son separadores detectados o
   interpolados entre detectados y está dentro de la zona válida. La fila contigua al tramo detectado
   (p. ej. la última sobre la barra de navegación) solo se acepta si se lee perfectamente.
7. **Contenido de fila** (`rows.js`): fondo = mediana de los píxeles claros refinada; balance de
   blancos por fila (fondo → gris 235). Clases de color por píxel (oscuro, rojo, rosa, amarillo, verde,
   azul, magenta, otro). Columna de texto (número + día) a la izquierda; insignias por clase con forma
   (relleno, aspecto, lado izquierdo recto = etiqueta W-, hexágono TS); insignias pálidas por distancia
   al fondo; marcas pequeñas (guion, "U") por color relativo al entorno (media local enmascarada).
   Controles de seguridad: tinta ajena (dedo oscuro), **residuo** = manchas compactas con contraste local
   fuera de todo lo explicado, **oclusión lateral** = región grande distinta del fondo que entra por la
   derecha hasta el hueco de otra insignia.
8. **OCR** (`crops.js`, `badgeocr.js`): cada recorte se remuestrea **desde la foto original vía la
   homografía** (una sola interpolación) a altura de letra fija (≈ 40 px).
   - Número/día de la semana: Otsu, PSM 7/8, listas blancas `0-9` y `MoDiFrSa`.
   - Cabecera: bandas de texto por perfil de *black-hat* (insensible al degradado naranja), de abajo
     arriba, PSM 7; respaldo PSM 6.
   - Insignias: máscara de texto por *black-hat* (cierre − imagen) dentro de la forma erosionada (los
     reflejos y degradados no cuentan como texto); canal (R+B)/2 para magenta, luminancia invertida para
     azul/rojo (texto blanco). Recorte ajustado a la tinta y re-renderizado a letra de 42 px. Lecturas:
     palabra PSM 7 con lista blanca por color → si duda: glifo a glifo (PSM 8 y 10; glifos pegados se
     parten por el mínimo de la proyección), palabra PSM 8, otra escala (28 px), máscara más fina si la
     tinta es > 19 %.
9. **Ajuste de códigos** (`codes.js`): cada color tiene su familia (amarillo F·, verde S·, azul N·/TS,
   rosa Z·/W-, magenta letra+2 dígitos, rojo S31). Votos: lectura exacta (0,35 + conf), código nuevo,
   vecino a distancia 1 **sin cambiar la letra**. Hace falta voto ≥ 0,85 y margen ≥ 0,3. Una letra que
   contradice el color (S en "amarillo") anula la insignia. Códigos nuevos (F4, S2, F54…): ≥ 3 lecturas
   unánimes, conf. máx ≥ 85 y media ≥ 55, y no a un dígito "confundible" (1/7, 3/5, 3/8, 5/6, 6/8, 0/8,
   2/7) de un conocido del mismo color; se avisa "Código nuevo".
10. **Consenso en la foto** (`recognize.consensus`): una insignia ilegible toma el código de otra del
    mismo color/forma leída con seguridad si sus glifos normalizados (16×24) son casi idénticos
    (IoU suave ≥ 0,66, margen 0,1; calibrado: mismo código ≥ 0,63, distinto ≤ 0,57) y alguna lectura
    está a distancia ≤ 1 con la misma letra. Un código "nuevo" idéntico a uno conocido se descarta.
11. **Calendario** (`calendar.js`): día = d0 + k (k = índice de fila). Para cada (año, mes) candidato se
    puntúan todos los d0: número leído (solo cuenta con 2 dígitos: la app siempre muestra "05"), día
    de la semana leído y número rojo (fin de semana). Años = año del teléfono ± 1 (en 3 años seguidos un
    mes nunca repite la colocación de los días de la semana; un año leído fuera de rango se ignora; si
    otro año queda a < 1,5 puntos → `year: null` + aviso). Fiable si coinciden ≥ ½ de las lecturas de
    2 dígitos, margen ≥ 2 y pocos conflictos; si no, no se devuelve ningún día. Además se descarta la
    fila cuyo número leído (conf ≥ 75) o día de la semana contradiga la asignación.
12. **Orientación**: si no aparece lista + cabecera, se prueba la foto girada 90°, 270° y 180°.
13. **Otra disposición**: si no hay lista del móvil, una heurística (≥ 6 insignias pequeñas alineadas
    en una fila) marca `layout: 'pc-grid'` sin días.

## Resultados (dev, `node test/lab/eval.mjs --impl …/rectify-rows/recognize.js`)

phone-list: 115/115 días correctos, 0 mal, 0 extra, mes/año 11/11; PC: 0 días, layout 12/12;
≈ 1,8 s por foto (Chromium escritorio, 2 workers; la primera llamada incluye arrancar Tesseract).

Pruebas propias (sin fotos holdout): `tools/augment.py` genera 16 variantes por foto dev (giro ±12/15°,
perspectiva, 4032 px, tinte cálido/frío, oscuro + ruido, desenfoque + JPEG 35, moiré, reflejo,
pequeña, giradas 90/180°, teléfono lejos en 900×1600 y en 3024×4032):
1840 días → 93,2 % correctos, **0 mal, 0 extra** (semilla 2: 92,2 %, 0 mal). Por variante: ≥ 97 % salvo
oscuro 80–88 %, reflejo 85–94 %, lejos 83–92 %, desenfoque fuerte 49 %.
Capturas limpias sintéticas (`tools/gen-screens.mjs`, sin bisel): 98–100 %, 0 mal; con códigos nuevos
91 %, 0 mal; con dedo claro entrando por el borde 82 %, 0 mal; variantes de la foto del PC: 0 días.

## Parámetros principales

| Dónde | Valor |
|---|---|
| Análisis | 1200 px (2000 px si la lista mide < 420 px) |
| Respuesta de línea | relativa ≥ max(0,028, 3,5·σ/brillo); fondo ≥ 0,5·p97 |
| Hough | ±24°, paso 0,25°, NMS 7 px en los extremos |
| Familia | soporte ≥ 0,3·máx, |Δángulo| ≤ 4°, solape ≥ 40 % |
| Borde de pantalla | racha de 4 muestras < 0,6·ref, RANSAC tol 1,2 % del ancho |
| Rejilla | tolerancia 6 % de P, penalización 0,35·mediana por hueco, W/P ∈ [3,5, 14] |
| Fila | margen 6 % de P; tinta ajena < 4 %; residuo < 0,006 P²; oclusión lateral ≥ 0,3 P² |
| Insignia | alto 0,35–1,0 P, ancho 0,3–1,6 P, relleno ≥ 0,62, anillo: píxeles ≥ 45 % del relleno |
| Guion | ancho ≥ 1,3·alto, alto ≤ 0,14 P, rojizo, relleno ≥ 0,6 |
| OCR | letra ≈ 40–42 px, margen ≈ 0,45 letra, 2 workers |

## Modos de fallo conocidos (se omite el día, no se inventa)

- Texto magenta sobre magenta con mucho ruido/desenfoque: lecturas tipo "51", "F571" → insignia
  ilegible → fila omitida (salvo consenso con otra igual en la misma foto).
- Desenfoque fuerte: los separadores casi desaparecen; si el borde izquierdo queda mal, el control de
  "columna de días" corta la foto entera (aviso), y los números de 1 dígito no cuentan.
- Reflejos con forma (marcos de ventana) que caen dentro de una fila como manchas compactas → "contenido
  sin explicar" → fila omitida.
- Dedo claro que tapa justo la 2ª insignia sin tocar el borde de la pantalla: no hay forma de saber que
  falta algo; la regla de oclusión lateral cubre el caso real (el dedo entra desde el borde).
- Códigos nuevos a un dígito confundible de uno conocido (p. ej. F7 frente a F1) se omiten siempre.
- Cabecera fuera de la foto → sin mes → no se devuelven días (aviso para elegir el mes a mano).
- La anchura del "1" depende de la fuente: el veto por anchura solo actúa en errores groseros.
- Rendimiento en iPhone no medido aquí (solo Chromium de escritorio).

## Herramientas (`tools/`)

- `dev.mjs` — ejecuta el reconocedor con `debug` y guarda overlay, hoja de recortes OCR y JSON por fila
  (`--only`, `--files`, `--opts '{"skipOcr":true}'`, `--out`).
- `augment.py` — variantes sintéticas de las fotos dev (nunca las holdout) → `synth/aug`.
- `gen-screens.mjs` — capturas sintéticas tipo Dienstplan con su verdad (`--novel`, `--finger`).
- `eval-synth.mjs` — evalúa una carpeta sintética (`--dir synth/aug`, `--only`, `--verbose`).
- `smoke-inputs.mjs` — tipos de entrada, llamadas simultáneas, progreso y `dispose()`.
- `test-codes.mjs` — casos del ajuste de códigos (`node tools/test-codes.mjs`).

`synth/` está en `.gitignore` (se regenera).
