# Turnos de Mauricio

Web app (PWA) in spagnolo per i turni di lavoro di Mauricio:

- **Foto del piano → turni salvati.** Funziona sia con la foto dell'app "Dienstplan" sia con la foto della stampa del PC. La lettura avviene sul telefono, senza server.
- **Promemoria sull'iPhone** tramite il Calendario, con avviso la sera prima alle 20:00 e 1 ora prima del turno.
- **Ore settimanali e mensili** confrontate con le 35 h del contratto, più consigli (riposo < 11 h, troppi giorni di fila, notti…).
- **Cambio turno a mano**, anche con orario speciale solo per un giorno.
- Codici, orari, pause e luoghi modificabili da Ajustes.

App: `https://mardar91.github.io/mauricio/` (dopo aver attivato GitHub Pages, vedi sotto).

## Messa online (una volta sola)

1. **Rendi pubblico questo repo:** Settings → General → Danger Zone → *Change visibility* → Public.
2. **Attiva Pages:** Settings → Pages → *Deploy from a branch* → scegli il branch con il codice e la cartella **`/docs`** → Save.

GitHub Pages è gratis per i repo pubblici e non usa minuti di Actions.

## Calendario dell'iPhone (promemoria)

1. Crea un repo **pubblico e vuoto** chiamato `mauricio-datos`. Contiene solo il calendario e un backup cifrato.
2. Crea un **token fine-grained** (https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select* → `mauricio-datos`.
   - Permissions: *Contents* → **Read and write**.
   - Scadenza: la più lunga possibile. Quando scade, rifai il token e un link nuovo.
3. Sul tuo computer apri l'app → **Ajustes → Opciones avanzadas → GitHub**: owner `Mardar91`, repo `mauricio-datos`, token → *Guardar y conectar* → nel messaggio «Conectado» tocca *Entendido* → **Crear enlace para Mauricio** (anche dal tuo iPhone) → copia il link e mandalo a Mauricio (es. WhatsApp).
4. Sull'iPhone di Mauricio:
   1. Apri il sito in **Safari** e installa l'app: «•••» → Compartir → *Agregar a inicio*, lasciando attivo «Abrir como app web».
   2. Apri l'app **dall'icona**.
   3. Copia il link ricevuto, poi in Ajustes tocca **Tengo un enlace** e scegli «Usar este iPhone».
   4. Tocca **Suscribirme en el iPhone** → Suscribirse, e **disattiva «Eliminar alertas»**.

Da quel momento l'iPhone pubblica il calendario e gli avvisi arrivano anche ad app chiusa.

Privacy:
- Il file del calendario è pubblico (codici e orari, mai le note; i luoghi solo se attivati).
- Il backup `backup.json` è cifrato.

## Come funziona dentro

| Parte | Dove |
|---|---|
| Interfaccia (spagnolo) | `docs/index.html`, `docs/js/ui/`, `docs/css/` |
| Logica (ore, consigli, calendario .ics, sincronizzazione) | `docs/js/core/` — API in `CORE-API.md` |
| Lettura delle foto | `docs/js/recognize/` — 2 metodi combinati per l'app del telefono + 1 per la stampa del PC (Tesseract.js in locale, `docs/vendor/`) |
| Specifiche | `SPEC.md` |
| Foto di prova e verità di riferimento | `test/fotos/`, `test/lab/ground-truth.json` |

Risultati della lettura delle foto (0 giorni sbagliati in tutti i test):

| Insieme | Giorni letti |
|---|---|
| Foto vere | 145/145 |
| Foto mai viste durante lo sviluppo | 41/41 |
| 183 foto rovinate apposta (storte, scure, sfocate, riflessi) | 97% |

I giorni che l'app non riesce a leggere li mostra e li fa completare a mano. Quelli dubbi chiede di controllarli.

## Sviluppo

```bash
npm install
npm test                 # test della logica (node --test)
npm run e2e              # test dell'interfaccia (Playwright, Chromium)
npm run eval -- --impl docs/js/recognize/index.js            # precisione lettura foto
npm run eval -- --impl docs/js/recognize/index.js --set holdout
npm run serve            # http://localhost:8080/docs/
```

A ogni modifica pubblicata, aumenta `VERSION` in `docs/sw.js` e `APP_VERSION` in `docs/js/app.js` (devono coincidere) e aggiungi i file nuovi a `PRECACHE`.
