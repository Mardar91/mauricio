# Reconocedor "ocr-first" (lista del móvil, app Dienstplan)

Prototipo de `recognize(input, options)` / `dispose()` según SPEC §5. Solo JS + `<canvas>` + tesseract.js 7
(LSTM, `best_int/eng`, OEM 1). Sin OpenCV, sin red, sin paso de build. Funciona con Blob, File,
ImageBitmap, `<img>` y `<canvas>`, con o sin OffscreenCanvas.

Para integrarlo en `docs/js/recognize/`, cambiar `VENDOR` en `recognize.js` a `'../../vendor/tesseract/'`.

## Archivos

| Archivo | Qué hace |
|---|---|
| `recognize.js` | Orquesta todo, decide qué días se devuelven y genera el overlay de depuración. |
| `img.js` | Canvas (OffscreenCanvas o `<canvas>`), carga/reducción, giro, recortes, fondo por mediana, mapa de "tinta" con ganancia local, luminancia aplanada, fondo neutro, desenfoque/unsharp. |
| `layout.js` | Región de la pantalla (lista + cabecera naranja) e inclinación. |
| `ocr.js` | Pool de 2 workers de Tesseract reutilizados; cada trabajo fija su PSM y lista blanca. |
| `rows.js` | Tokens (día / día de semana / mes / año), columna de días (RANSAC), modelo de secuencia y(v), mes/año. |
| `calendar.js` | Calendario y emparejamiento difuso (meses y días alemanes, confusiones típicas del OCR). |
| `badges.js` | Clases de color por píxel, componentes, forma, renders de recorte para el OCR y su limpieza. |
| `codes.js` | Decodificación de cada insignia: votación entre lecturas, códigos conocidos, códigos nuevos. |
| `debug.js` | Overlay PNG: tokens, filas, componentes, motivo de cada descarte, hoja con los recortes del OCR. |
| `tools/probe.mjs` + `tools/exp2.js` | Ejecutar funciones sueltas en Chromium (volcar recortes, cabecera, máscara de ROI, tiempos…). |
| `tools/synth.js` + `tools/robust.mjs` | Prueba de robustez: 5 fotos dev × 11 perturbaciones, 5 capturas sintéticas con verdad, 1 negativo. |

## Método

1. **Carga**: `createImageBitmap` (EXIF aplicado), reducción por mitades a ≤ 2000 px.
2. **Pantalla**: rejilla gruesa (~220 celdas en el lado mayor). Celdas claras y lisas cuya cromaticidad
   se parece a la mediana de las claras (admite pantallas teñidas) o casi grises; umbral de brillo
   min(Otsu, 0,75·p90) para no partir la lista entre filas blancas y grises. Componente mayor → caja,
   extendida hacia arriba por la cabecera naranja (tolera 2 filas de mezcla en el borde).
3. **Enderezado**: perfil de proyección del gradiente vertical en ±16° (paso 0,5° y luego 0,1°); se
   gira el lienzo y se recalcula la región. Recorte reescalado a ~800 px de ancho (apaisado: sin reducir).
4. **Renders** del recorte:
   - *Tinta*: fondo local = mediana por canal a 1/3 de resolución (ventana ≈ 15 px); tinta = distancia
     de color al fondo vecino más parecido o al segmento entre dos fondos vecinos (el antialias de los
     bordes de las insignias no es tinta). Ganancia local (máximo de tinta en ~3 alturas de texto, ×1…2,5).
     Resultado: TODO el texto (negro, gris, blanco sobre azul, rojo, morado sobre magenta) negro sobre blanco.
   - *Luminancia aplanada*: L / fondo local (quita reflejos suaves), fondos casi negros → blanco (el marco
     negro del móvil arruinaba el Otsu interno de Tesseract), + unsharp suave.
5. **OCR disperso** (PSM 11) de los dos renders en paralelo; fusión de tokens (misma caja y significado
   → uno). Clasificación: número de día (O→0, l→1…), día de la semana (Mo…So; empates como "Se" =
   Sa/So quedan *ambiguos* y no cuentan ni a favor ni en contra), mes alemán (edición ponderada), año 20xx.
6. **Filas**: número + día de la semana debajo = ancla. Columna por RANSAC (x = a + b·y). Secuencia por
   RANSAC sobre (día, y) y refinado cuadrático → y(v) para cada día v (absorbe la perspectiva).
   Centro de fila = número + ½ del desplazamiento número→día de semana. Huecos y extremos: OCR dirigido
   del número (dígitos, PSM 7) y del día de la semana; solo cuenta si lee exactamente lo esperado.
7. **Mes/año**: tokens de cabecera; si faltan, OCR de la franja de cabecera (luminancia estirada primero;
   si no basta, también los dos renders). Combinación con el desplazamiento semanal votado por los
   días de la semana (wd = (v + off) mod 7). **Nunca** se cambia a un mes distinto del leído (solo
   alternativas de nombre casi igual, p. ej. Juni/Juli); el año puede corregirse ±1. Si nada cuadra →
   `month: null` con aviso. Sin días de la semana coherentes → `layout: 'unknown'` y ningún día.
8. **Validez de fila**: número leído (o día de la semana correcto entre dos vecinos con número), día de
   la semana coherente, no tapada por la cabecera (el número empieza bajo el borde naranja y tiene altura
   normal), no cortada abajo, la última fila exige día de la semana, número no desvaído (< 0,42 de la tinta típica).
9. **Insignias** (una segmentación para toda la columna de códigos, cuyo borde izquierdo sale de la recta
   de la columna + desplazamiento mediano, no de cada token): equilibrio de color con un fondo *neutro*
   (cromaticidad del fondo de la lista, sin contaminar por las insignias); clase por píxel (amarillo,
   verde, azul, magenta, rojo, rosa); se elimina el halo rosado junto a magenta; componentes por clase;
   fragmentos rojos/rosas que se tocan se unen (guion, U); se suprimen componentes contenidas o pegadas a
   otra mucho mayor. Forma: insignia, etiqueta (W-: esquinas izquierdas llenas), guion, letra. Tamaño
   coherente con la altura de fila local (proporción mediana × paso del modelo).
10. **OCR de cada insignia**, por etapas: renders del interior (máscara erosionada) contra el fondo local
    — *lum* (diferencia de luminancia con polaridad automática) e *ink* con PSM 7; si no coinciden con
    nitidez (≥ 85) en un código conocido de la clase, también *sharp* (unsharp), *soft* (estirado lineal
    sin umbrales) y PSM 13. Limpieza: borrar lo oscuro conectado al borde (aro de la insignia) y motas.
    Lista blanca por clase. Votación (`codes.js`): parecido con los códigos conocidos de la clase
    (S↔5, Z↔2, I↔1… con peso sim⁴ para que las lecturas exactas dominen) y margen exigido; código nuevo
    (F4, S2, F54…) solo con ≥ 3 lecturas nítidas iguales y mejor que cualquier conocido; código único de
    la clase solo con algo de apoyo del OCR. **U**: OCR de un carácter (PSM 10, y 8/7 si no es nítida),
    voto ponderado (los tokens globales pesan menos; la basura de varios símbolos no cuenta).
11. **Antes de devolver un día** (si algo falla → se omite y se avisa): insignia cortada o fuera de la
    fila, insignia ilegible, marca roja rara, objeto grande con color (dedo), zona oscura, hueco antes de
    la primera marca (> 1,6 h; guion/U > 2,6 h) o entre insignias (> 1 h), lugar sin turno, guion/U junto a
    otros códigos. Fila vacía → `[]` solo si la banda no tiene tinta (tras la ganancia local), ni color,
    ni texto leído por el OCR global.

`layout: 'pc-grid'` si ≥ 6 días de la semana en una misma línea (o ≥ 4 + palabras de la tabla del PC):
se devuelve el mes/año pero **ningún día** (aviso en español).

## Parámetros principales

- Reducción ≤ 2000 px; recorte a ~800 px de ancho; tinta con fondo f = 3 / radio 2 y vecindad 3×3.
- Fondo neutro: celda ≈ H/3, radio 6 celdas, cromaticidad ±0,045 (H = altura típica del número).
- Tolerancias: ancla a ≤ 0,3·paso del modelo; columna RANSAC 0,9·H; pitch válido 1,8–6·H.
- Insignias: alto 0,7–1,35 × esperado; w/h 0,75–1,6 (etiqueta 1–2,1); relleno 0,62–0,95.

## Resultados

- Dev (`node test/lab/eval.mjs --impl test/lab/approaches/ocr-first/recognize.js`): 114/115 días
  obligatorios de la lista del móvil, 0 mal, 0 extra, 0 opcionales mal, mes y layout 12/12, ~2,5 s/foto
  (máx. ~4 s en 10-a). La foto del PC → `pc-grid`, Juni 2026, 0 días.
- Robustez (`node test/lab/approaches/ocr-first/tools/robust.mjs`): 589/623 (94,5 %) en 60 variantes
  (giros ±8/12/15°, foto grande con fondo, dominantes amarilla/azul, oscura, desenfoque, JPEG+ruido,
  perspectiva, reflejo; 5 capturas sintéticas con F4/F54/S2, filas vacías, TS, U, W-, S31) con
  **0 mal y 0 extra**; el negativo (lista numerada) no devuelve días.

## Fallos conocidos / límites

- **Desenfoque fuerte** (≈ 1,4 px a 900 px de ancho): se omiten muchas filas y a veces no se lee el
  mes. No inventa, pero pierde cobertura.
- Insignias magenta con texto muy tenue (10-a, día 10): las lecturas discrepan (F51/S51) → se omite.
- Guiones/U muy desaturados (dominante azul, foto oscura) a veces no se segmentan → la fila se omite
  ("banda con marcas sin identificar").
- Sin texto de mes legible el mes solo se deduce si el patrón semanal lo hace único (raro) → `month: null`.
- Filas cortadas arriba/abajo (cabecera, barra de navegación, dedo) se omiten aunque se vean en parte.
- TS (hexágono) frente a N1 (círculo) no se distingue por forma: depende del OCR (que lee "TS" bien).
- Tabla del PC: solo se detecta. Tiempo en iPhone previsiblemente mayor que en Chromium de escritorio.
