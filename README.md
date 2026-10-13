# Turnos

Web app (PWA) in spagnolo per i turni di lavoro di Mauricio (iPhone) e di sua sorella (Android):

- **Foto del piano → turni salvati.** Funziona sia con la foto dell'app "Dienstplan" sia con la foto della stampa del PC (cerca la riga con il nome «come nel piano», es. «Ducuara Ana»). La lettura avviene sul telefono, senza server.
- **Promemoria** tramite il calendario del telefono (iPhone: Calendario; Android: app ICSx⁵), con avviso la sera prima alle 20:00, 1 ora prima del turno (prima ancora se il luogo ha un tempo di viaggio: «Sal a las 13:05») e il giorno 20 se manca il piano del mese dopo.
- **Ore settimanali e mensili** confrontate con il contratto, più consigli; **maggiorazioni** (notte, sabato, domenica, festivi, con stima in € se si inserisce la paga oraria) e **saldi** (ore in più/in meno e ferie dell'anno). I valori di default sono indicativi: vanno controllati sul contratto (Ajustes → «Contrato y nómina»).
- **Cambio turno a mano**, anche con orario speciale solo per un giorno; codice `K` per la malattia.
- Codici, orari, pause, luoghi e tempi di viaggio modificabili da Ajustes. Si usa bene anche su tablet e computer.

App: `https://mardar91.github.io/mauricio/` (dopo aver attivato GitHub Pages, vedi sotto).

## Messa online (una volta sola)

1. **Rendi pubblico questo repo:** Settings → General → Danger Zone → *Change visibility* → Public.
2. **Attiva Pages:** Settings → Pages → *Deploy from a branch* → scegli il branch con il codice e la cartella **`/docs`** → Save.

GitHub Pages è gratis per i repo pubblici e non usa minuti di Actions.

## Mauricio: calendario dell'iPhone (promemoria)

1. Crea un repo **pubblico e vuoto** chiamato `mauricio-datos`. Contiene solo il calendario e un backup cifrato.
2. Crea un **token fine-grained** (https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select* → `mauricio-datos`.
   - Permissions: *Contents* → **Read and write**.
   - Scadenza: la più lunga possibile. Quando scade, rifai il token e un link nuovo.
3. Sul tuo computer apri l'app → **Ajustes → Opciones avanzadas → GitHub**: owner `Mardar91`, repo `mauricio-datos`, token → *Guardar y conectar* → nel messaggio «Conectado» tocca *Entendido* → **Crear enlace de configuración** (o «Crear enlace para Mauricio», se il dispositivo conosce già il nome) → copia il link e mandalo a Mauricio (es. WhatsApp).
4. Sull'iPhone di Mauricio:
   1. Apri il sito in **Safari** e installa l'app: «•••» → Compartir → *Agregar a inicio*, lasciando attivo «Abrir como app web».
   2. Apri l'app **dall'icona**.
   3. Copia il link ricevuto, poi in Ajustes tocca **Tengo un enlace** e scegli «Usar este iPhone».
   4. Tocca **Suscribirme en el iPhone** → Suscribirse, e **disattiva «Eliminar alertas»**.

Da quel momento l'iPhone pubblica il calendario e gli avvisi arrivano anche ad app chiusa.

## La sorella (Android)

Stesso repo `mauricio-datos` e stesso token: i suoi dati vanno nella cartella `ana/` (con una chiave sua) e il suo calendario è separato da quello di Mauricio.

1. Su un dispositivo già collegato (il tuo computer o l'iPhone di Mauricio): **Ajustes → Opciones avanzadas → Crear enlace para otra persona** → scrivi il nome (es. «Ana») → *Crear enlace* → *Copiar el enlace* → mandalo a lei.
2. Sul suo Android apre il link **in Chrome** → «Sí, conectar». Chrome e l'app installata condividono i dati, quindi può installarla prima o dopo: pulsante **Instalar la app** (o menu ⋮ → «Instalar app»).
3. Al primo avvio scrive il nome e **come appare nel piano** (es. «Ducuara Ana»); si cambia in Ajustes → «Tu nombre». Si presume che usi gli stessi codici (F1, S1, N1…): i codici nuovi vengono creati da soli e l'app chiede di confermarne l'orario.
4. Calendario con avvisi (consigliato): installa **ICSx⁵** da Google Play (1,99 €; gratis su F-Droid), aprila una volta e tocca «Permitir». Poi nell'app Turnos: **Ver mis turnos en el calendario** → si apre ICSx⁵ → *SUBSCRIBE* (in basso) o la freccia → (in alto) → nella schermata successiva («Título y color», «Alarms») lascia **spento** «Ignore alerts embedded in the calendar» e tocca la **freccia → in alto a destra** (qui il pulsante in basso non c'è): ICSx⁵ salva l'abbonamento e si chiude da sola. Poi riapri ICSx⁵ dalla sua icona → menu ⋮ → «Marcar intervalo de sincronización» → **Cada hora**. Se ICSx⁵ avvisa per la batteria: «Sin restricciones». La guida passo passo è nell'app (Ajustes → Calendario del teléfono).
5. Alternativa gratis ma lenta (fino a un giorno per gli aggiornamenti, senza gli avvisi dell'app): Google Calendar dal computer → «Otros calendarios» → + → «Desde una URL» con il link di *Copiar enlace*, e poi aggiungere una notifica predefinita a quel calendario.

Ognuno può vedere i turni dell'altro: **Ajustes → Calendarios de la familia → Ver sus turnos en mi calendario** (solo lettura, senza i suoi avvisi). Sull'iPhone l'app lo ricorda prima di aprire l'abbonamento: qui «Eliminar alertas» va lasciato **attivo** (al contrario del proprio calendario); su Android, in ICSx⁵, si attiva «Ignore alerts embedded in the calendar».

Privacy:
- Il file del calendario è pubblico (codici e orari, mai le note; i luoghi solo se attivati).
- Il backup `backup.json` è cifrato (ogni persona con la sua chiave). In chiaro c'è solo il nome di battesimo, per la lista «Calendarios de la familia».

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
node test/e2e/screens.mjs                    # catture di tutte le schermate (test/e2e/out/)
node test/e2e/screens.mjs --only responsive  # solo le dimensioni: Android 360, iPhone 390/430, iPad, computer
```

A ogni modifica pubblicata, aumenta `VERSION` in `docs/sw.js` e `APP_VERSION` in `docs/js/app.js` (devono coincidere) e aggiungi i file nuovi a `PRECACHE`.
