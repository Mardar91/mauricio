# Reconocedor "color-first" (lista del móvil)

Prototipo de `recognize(input, options)` / `dispose()` (SPEC §5). Idea: **primero color y forma, después OCR dirigido**
sobre recortes pequeños y enderezados, y al final **coherencia de calendario** (números consecutivos + día de la
semana del mes/año). Ante la duda, el día se omite.

## Resultados (Chromium escritorio)

| Conjunto | Días bien | Mal | Extra | Mes | Tiempo medio |
|---|---|---|---|---|---|
| dev (`test/lab/eval.mjs`), lista del móvil | 115/115 | 0 | 0 | 12/12 (incl. PC) | ~1,4 s |
| `synth/aug` (10 variantes × 11 fotos: giro ±8/12/15°, perspectiva, 4032 px, dominantes cálida/fría, oscura+ruido, blur+JPEG q55) | 1097/1150 | 0 | 0 | 111/113 | ~1,35 s |
| `synth/aug2` (reflejos, dedo, moiré, sin cabecera, 640 px, móvil pequeño en la foto, giros 20/−22°, insignias borradas) | 886/1035 | 0 | 0 | 86/99 (11 sin cabecera → `null`) | ~1,3 s |
| `synth/screens` (capturas limpias sintéticas, con `[]`, F4, S2, F54, TS, S31) | 272/273 | 0 | 0 | 24/24 | ~1,2 s |
| `synth/screens-free` (solo guiones, U y filas vacías: escala sin insignias) | 90/91 | 0 | 0 | 8/8 | ~0,75 s |

La foto del PC (`pc-grid`) se detecta como tal y devuelve **0 días** (y el mes del título si se lee).
Máximo observado ≈ 2,3 s por foto.

## Método (por fases)

1. **Carga**: `Blob` → `<img>` (respeta EXIF; si no hay DOM, `createImageBitmap`); también canvas/ImageBitmap/img.
   Copia ≤ 2000 px (lado mayor) y copia de análisis ≤ 1400 px. `OffscreenCanvas` si existe; si no, `<canvas>`.
2. **Balance de blancos**: global = mediana del fondo en anillos alrededor de manchas saturadas del tamaño de una
   insignia (fallback: modo cromático de los píxeles claros). Después **balance local** por bloques (~1,6 insignias):
   referencia de fondo por bloque (píxeles claros y poco saturados), validada contra la global, rellenada, mediana 3×3 e
   interpolación bilineal. Corrige degradados de pantalla (OLED de lado, reflejos azulados). Blanco de pantalla → 235.
3. **Clasificación por píxel** (HSV tras el balance): amarillo F, verde S, azul N/TS, magenta (lugares), rosa claro
   (Z1/W-), rojo (S31/U/guion/números de fin de semana), naranja (cabecera), tinta, blanco. Neutro tolerante a
   dominantes (S<0,2 fuera de los rosas). Componentes conexas 8-vecinas con momentos.
4. **Escala D** = moda (KDE en log) del tamaño de manchas tipo insignia (relleno de elipse ≥ 0,6, alargamiento ≤ 1,9)
   que están sobre fondo claro (anillo ≥ 45 % blanco). Sin insignias: D ≈ longitud de guion / 0,27.
5. **Elementos**: insignias (0,68–1,5 D, anillo claro) y grupos de piezas rojas pequeñas (unidas si distan < 0,2 D:
   una U suele partirse en dos trazos) con anillo claro ≥ 60 %.
6. **Inclinación**: moda (KDE) del ángulo de pares de insignias vecinas en la misma fila; si no hay, de vectores
   casi verticales entre elementos del mismo tipo (columna). Marco (u, v) girado.
7. **Columna**: RANSAC sobre pares (u = a + b·v) con preferencia por la paralela de la izquierda si tiene insignias
   (1.ª insignia). Filas = agrupación por v (< 0,5 D); la 1.ª pieza debe estar en la columna (± 0,55 D); cadena de
   insignias contiguas (< 1,75 D). Tamaño local de insignia por ajuste lineal tamaño~v (perspectiva).
8. **2.ª pasada (ROI)**: si la lista ocupa poca parte de una foto grande, se recorta esa zona de la fuente a ≤ 2000 px
   y se repite el análisis (gana resolución sin pasar de 2000 px).
9. **Controles por fila**: *incompleta* (insignia < 0,85 D local: cortada), *sucia* (píxeles de color/tinta en
   componentes no diminutas o gris medio a media peso en la franja de insignias, fuera de los elementos > 5 % D²:
   dedo, insignia no detectada), *rara* (elementos sueltos fuera de la cadena, o "fantasma": croma elevado en la
   siguiente posición de insignia = insignia borrada por un reflejo).
10. **Cabecera y mes**: borde inferior del naranja encima de la 1.ª fila (varias columnas, mediana), extensión
    horizontal acotada a la pantalla. OCR (PSM 7) de la línea del mes justo encima del borde (umbral adaptativo
    relativo, luego absoluto, luego toda la cabecera PSM 6). Meses DE/ES/EN con Levenshtein, prefijos de 3 letras,
    variantes de confusión ("li"→"h", "ni"→"m"…), empates conservados. Año: 20xx; si es imposible (p. ej. "2076")
    vale si difiere en un dígito de un único año plausible.
11. **Celda del día** (recorte enderezado, D → 90 px): Otsu (2.ª pasada sin manchas que tocan el borde: marco del
    móvil), componentes, 2 líneas por k-medias en y (número arriba, día abajo), dígitos con misma altura y base.
    OCR número PSM 7 solo dígitos; día PSM 7/8 con `MoDiFrSa`. Rojo del número → fin de semana.
12. **Insignias** (recorte enderezado, insignia → 110 px): relleno = misma clase o tono parecido al color medio de la
    mancha (tolerante a reflejos); interior convexo por filas/columnas erosionado; texto por **top-hat morfológico**
    (cierre para texto oscuro en amarillo/verde/rosa/magenta; apertura para texto blanco en azul/rojo) sobre el canal
    más separable (luminancia / máximo / mínimo; el magenta solo contrasta en el máximo), Otsu, fuera arcos del borde.
    Variantes: binaria, gris normalizada y binaria fina × PSM 7/8, lista blanca por clase. Forma rosa: esquinas
    izquierdas llenas + borde izquierdo recto → etiqueta W-; si duda, decide el OCR.
13. **Ajuste a códigos** (`codes.js`): los códigos conocidos se agrupan por clase de color (S31 es rojo, no magenta).
    Votos de lecturas exactas (con conflicto → nada); código nuevo solo si 2 lecturas seguras idénticas, encaja con
    la clase y **no es confundible** con uno conocido (F33≈F53 → nada); aproximado solo con margen claro; código único
    del color solo con alguna lectura que se le parezca más que a cualquier otro del mismo color.
14. **Guion / U** (`readRed`): recorte enderezado, mapa de "rojez" (R − max(G,B)), umbral a media altura del pico;
    guion = barra baja (alto < 0,2 D) no hueca; U = alto 0,2–0,55 D y hueco arriba en el centro.
15. **Calendario**: índices de fila por paso (separación / tamaño local, redondeo); para cada mes/año candidato
    (cabecera ± 1 mes, años del reloj ± 1; sin cabecera: 36 meses) se busca el día inicial que maximiza: número OCR
    exacto (+4·q), día de la semana (+2/−1,5), rojo = fin de semana (±1). Leve preferencia por meses cercanos a hoy.
    Mes = `null` si otra opción queda a < 4 puntos. Días válidos si ≥ 2 aciertos de número, margen ≥ 4 y todas las
    opciones empatadas coinciden en el día inicial.
16. **Salida**: fila con número leído = esperado, o interior entre dos filas confirmadas; se descarta si contradice
    (número o día de la semana distinto), está sucia/rara/incompleta o alguna insignia es ilegible.
    **Filas vacías** (`[]`): se sondean huecos del paso y extremos; solo si la franja está vacía y blanca, el fondo
    coincide con filas del mismo tipo (laborable/fin de semana), el contraste del número es normal (descarta filas
    desvaídas bajo la barra de navegación) y el OCR coincide exactamente.
17. Presupuesto de tiempo: a partir de 4 s se dejan de probar variantes de OCR. `onProgress` con textos en español.
    `recognize` nunca lanza: errores → resultado vacío con aviso en español.

## Parámetros principales (en unidades de D = diámetro de insignia)

Celda del día u ∈ [−2,05; −0,5]·D, v ∈ [−0,85; +0,95]·D respecto a la columna/fila. Número ≈ v −0,2 D, día ≈ v +0,45 D.
Franja de insignias u ∈ [−0,55; +4,5]·D, |v| < 0,42 D. Línea del mes: v ∈ [−1,05; −0,1]·D sobre el borde de la cabecera.
Paso de fila ≈ 1,45–1,6 D (se mide, no se fija). Separación de insignias ≈ 1,2 D.

## Modos de fallo conocidos

- **Magenta de poca resolución o muy comprimido** (JPEG q55 + blur): la letra inicial (F/S/N) se pierde → día omitido.
- **Reflejos fuertes** que borran insignias: fila omitida (no se inventa), pero baja la cobertura.
- **Fotos muy pequeñas** (lado mayor ≈ 640 px): números de ~10 px, magenta ilegible → ~45 % de días.
- **Giros > ~24°** fuera del alcance de la estimación por columna si no hay filas con 2 insignias.
- **Sin cabecera**: mes `null` (correcto: los meses con la misma alineación de días empatan), los días sí salen.
- Primera fila bajo la cabecera y última bajo la barra de navegación: se omiten salvo que el número se lea completo.
- Festivos entre semana en rojo (si la app los pinta) solo penalizan un poco la alineación (±1).
- Tabla del PC: solo se detecta (`layout: 'pc-grid'`, 0 días) y se intenta leer el mes del título.
- El reloj del aparato limita los años plausibles (± 1 año).

## Herramientas (solo desarrollo, en `tools/`)

```
node test/lab/eval.mjs --impl test/lab/approaches/color-first/recognize.js [--debug] [--verbose]
python3 test/lab/approaches/color-first/tools/augment.py      # → synth/aug + aug.json
python3 test/lab/approaches/color-first/tools/augment2.py     # → synth/aug2 + aug2.json (variantes difíciles)
node test/lab/approaches/color-first/tools/gen-screens.mjs 24        # capturas sintéticas → synth/screens
node test/lab/approaches/color-first/tools/gen-screens.mjs 8 free    # solo guiones/U/vacías → synth/screens-free
node test/lab/approaches/color-first/tools/eval-synth.mjs --gt synth/aug2.json [--only txt] [--debug] [--verbose]
node test/lab/approaches/color-first/tools/edge-tests.mjs     # tipos de entrada, sin OffscreenCanvas, dispose
```
Con `--debug` la superposición tiene 3 paneles: imagen corregida con filas/celdas/estado, mapa de clases y los
recortes enviados al OCR con su lectura. Con `--verbose` se imprime `FILA …` (estado de cada fila) y `NOTA …`.
`synth/` está en `.gitignore` (se regenera).

## Integración en `docs/js/recognize/`

Copiar `recognize.js`, `img.js`, `geom.js`, `ocr.js`, `calendar.js`, `codes.js`, `debug.js` (este último solo hace falta
con `debug: true`; se puede cargar con `import()` dinámico). Cambiar la ruta por defecto de Tesseract en
`defaultTess()` a `new URL('../../vendor/tesseract/', import.meta.url)`. Solo se usa LSTM (`best_int`); no hace falta
`langPathLegacy`. Un worker reutilizado entre llamadas; `dispose()` lo termina.
