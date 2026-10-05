# dekaru-formular

Eigener Formular-Empfänger für die Kundenwebsites von dekaru. Er nimmt Kontaktanfragen, Terminanfragen und Tischanfragen (Gastro) an und ersetzt damit Formspree, unter anderem für die Online-Terminanfrage in der Hosting-Stufe Plus (siehe `brain/projekte/vertrieb-partner/13-hosting-konditionen.md`, Punkt 1).

Stand: 03.10.2026. Repo mit Remote auf GitHub. **Noch nicht bei Vercel angelegt, noch nie deployt.** Versanddienst ist entschieden: Google Workspace SMTP-Relay, siehe unten.

## Worum es geht

Eine Anfrage auf der Website eines Betriebs soll im Postfach des Betriebs landen. Sonst nirgends. Formspree hat dafür zwei Nachteile: ein US-Dienst mehr in Anlage 3 des AVV, ohne auffindbares DPA (siehe Notizen in `dekaru-rechnungen/vorlagen/unterauftragsverarbeiter.md`), und Formspree hält Einsendungen vor. Dieser Empfänger läuft stattdessen als eine einzige Serverfunktion bei Vercel, das ohnehin Unterauftragsverarbeiter ist, und speichert nichts.

## Architektur

```
Browser des Besuchers
   |  POST (Formular oder fetch), HTTPS
   v
Vercel, Region fra1 (Frankfurt): api/anfrage.mjs
   |  prüft Herkunft, Honigtopf, Mindestzeit, Menge, Felder
   |  hält den Inhalt nur für die Dauer des Aufrufs im Arbeitsspeicher
   v
Google Workspace SMTP-Relay (smtp-relay.gmail.com:587), STARTTLS und Anmeldung erzwungen
   |
   v
Postfach des Betriebs (Adresse aus kunden.json)
```

- **Ein** zentrales Vercel-Projekt für alle Kunden. Welcher Kunde gemeint ist, sagt das versteckte Feld `formular` im Formular.
- `api/anfrage.mjs` ist nur ein dünner Adapter im Format `export default { fetch(request) }` (Vercel Functions, Web-Standard). Die Logik liegt in `lib/`, weil jede Datei unter `api/` ein eigener Endpunkt würde.
- Kein Framework. Einzige Abhängigkeit ist `nodemailer`.
- `vercel.json` setzt `regions: ["fra1"]` und bindet `kunden.json` per `includeFiles` in die Funktion ein.

| Datei | Aufgabe |
|---|---|
| `api/anfrage.mjs` | Endpunkt `POST /api/anfrage`, verdrahtet Konfiguration, Versand und Mengenbegrenzung |
| `lib/anfrage.mjs` | Ablauf einer Anfrage, Antworten, CORS |
| `lib/validierung.mjs` | Feldprüfung und Längengrenzen |
| `lib/mail.mjs` | SMTP aus Umgebungsvariablen, Aufbau der Mail |
| `lib/mengenbegrenzung.mjs` | Mengenbegrenzung im Arbeitsspeicher |
| `lib/konfiguration.mjs` | Laden und Prüfen von `kunden.json` |
| `kunden.json` | je Formular Empfänger, Origins, Betreff, Danke-Seite |
| `test/anfrage.test.mjs` | Tests mit gemocktem Transport |

## Datenfluss für den AVV

**Welche Daten.** Was der Besucher eingibt: Name, Telefonnummer und/oder E-Mail-Adresse, Nachrichtentext, je nach Art der Anfrage dazu Wunschtermin oder Zeitangabe, bei der Tischanfrage Datum, Uhrzeit und Personenzahl. Dazu technisch: IP-Adresse und Zeitpunkt der Verbindung. Das freie Nachrichtenfeld kann Angaben nach Art. 9 DSGVO enthalten, deshalb steht am Feld „Bitte keine Gesundheitsangaben“.

**Wohin.** Browser, dann die Funktion bei Vercel in Frankfurt (fra1), dann der SMTP-Versanddienst, dann das Postfach des Betriebs. Keine Kopie an dekaru, kein BCC, kein Anhang. Absender der Mail ist immer die Versandadresse, die Adresse des Besuchers steht nur im Reply-To, damit der Betrieb direkt antworten kann.

**Was gespeichert wird.** Vom Empfänger selbst nichts. Keine Datenbank, keine Datei, kein Protokoll mit Inhalten. Im Einzelnen:

- Der Inhalt der Anfrage existiert nur während des Aufrufs im Arbeitsspeicher.
- Protokolliert wird nur, wenn der Versand scheitert, und dann nur `{ereignis, formular, code}`, also z. B. `versand-fehlgeschlagen`, `beispiel-tischlerei`, `EAUTH`. Die Fehlermeldung des SMTP-Servers wird bewusst verworfen, weil sie Adressen enthalten kann. Ein Test prüft das.
- Die Mengenbegrenzung hält für höchstens zehn Minuten einen Hash der IP-Adresse im Arbeitsspeicher der Instanz. Das Salz dafür wird bei jedem Start neu gewürfelt und verlässt die Instanz nie. Die IP-Adresse selbst wird nicht gehalten.
- **Technisch unvermeidbar:** Vercel protokolliert jeden Aufruf der Funktion mit Metadaten (Zeitpunkt, Pfad, Status, laut Anlage 3 auch IP-Adressen). Im Tarif Pro sind diese Laufzeitprotokolle einen Tag lang abrufbar (vercel.com/docs/logs/runtime, Stand 28.08.2026, zitiert nach den Notizen in `unterauftragsverarbeiter.md`). Wie lange Vercel intern aufbewahrt, nennt Vercel nicht. Alle personenbezogenen Felder stehen deshalb im Body, nie in der URL, und die Funktion gibt den Body nirgends aus.
- **Beim Versanddienst** entsteht keine Kopie. Geprüft am 05.10.2026: Geht eine Anfrage an eine andere Adresse als das Versandkonto info@dekaru.de, legt Google über das Relay keine Kopie im Gesendet-Ordner an. Nur Mails an info@dekaru.de selbst erscheinen dort. Als Sicherheitsnetz löscht `werkzeuge/gesendet-aufraeumen.gs` (Google Apps Script in info@dekaru.de, stündlich) solche Kopien endgültig.
- Im Postfach des Betriebs liegt die Mail natürlich. Das ist der Zweck und liegt in der Verantwortung des Betriebs.

**Ehrlich zum Ziel „kein zusätzlicher Unterauftragsverarbeiter“.** Vercel kommt nicht neu dazu. Der SMTP-Versanddienst ist aber zwingend ein Unterauftragsverarbeiter, weil er den Inhalt transportiert. Unterm Strich wird Formspree durch den Versanddienst ersetzt, es wird nicht null. Die einzige Bauweise ohne neuen Eintrag wäre Versand über das Postfach des Betriebs selbst (dessen eigener Anbieter), siehe offene Punkte.

## Schutz gegen Missbrauch

| Maßnahme | Umsetzung |
|---|---|
| Herkunft | `Origin`, ersatzweise `Referer`. Fehlen beide, wird abgewiesen. Der Origin muss in `origins` des angegebenen Formulars stehen. |
| CORS | `Access-Control-Allow-Origin` nur mit dem exakten erlaubten Origin, immer mit `Vary: Origin`. Vorabanfrage (OPTIONS) nur für Origins, die zu irgendeinem Kunden gehören. |
| Honigtopf | Feld `website`, für Menschen unsichtbar. Ist es gefüllt, kommt dieselbe Erfolgsantwort wie sonst, gesendet wird nichts. |
| Mindestzeit | Feld `dauer`: Millisekunden seit dem Laden der Seite, im Browser gemessen. Unter 3 Sekunden wird abgewiesen. Gemessen wird die vergangene Zeit statt eines Zeitstempels, damit eine falsch gehende Uhr beim Besucher keine Rolle spielt. |
| Ohne JavaScript | `dauer` bleibt leer, die Anfrage gilt als zu schnell. Die Fehlerseite bittet dann um einen Anruf. Entscheidung: lieber einzelne Besucher ohne JavaScript ans Telefon schicken als Bots durchlassen. |
| Menge | Höchstens 5 Anfragen je IP und 30 je Formular in 10 Minuten. **Wirkt bei Serverless nur begrenzt:** jede Instanz zählt für sich, eine neu gestartete beginnt bei null. Das bremst einen einzelnen Bot, keinen verteilten Angriff. Ein gemeinsamer Zähler bräuchte einen externen Speicher, also einen weiteren Dienst, und genau den wollen wir nicht. |
| Größe | Body höchstens 16 KB. |
| Art | Feld `art` nur `kontakt`, `termin` oder `tisch`. Fehlt es, gilt `termin`. Jeder andere Wert wird mit 400 abgewiesen. |
| Felder | Je Art unterschiedlich, siehe Schnittstelle. Name bis 100 Zeichen, Wunschtermin bis 100, Nachricht bis 2000, Personen 1 bis 100. Mailadresse genau eine, ohne Komma und Zeilenumbruch, damit Reply-To nicht manipulierbar ist. |
| Weiterleitung | `dankeUrl` muss auf einem der `origins` liegen, sonst lädt die Konfiguration gar nicht (keine offene Weiterleitung). |

## Schnittstelle

`POST /api/anfrage`, Inhalt als `application/x-www-form-urlencoded`, `multipart/form-data` oder `application/json`.

Welche Felder Pflicht sind, hängt von `art` ab:

| Feld | `kontakt` | `termin` (auch ohne `art`) | `tisch` | Bedeutung |
|---|---|---|---|---|
| `formular` | ja | ja | ja | Formular-ID aus `kunden.json` |
| `art` | | | | `kontakt`, `termin` oder `tisch`. Fehlt es oder ist es leer, gilt `termin`. Unbekannter Wert: 400 `art-unbekannt` |
| `name` | ja | ja | ja | bis 100 Zeichen |
| `telefon` | eins von beiden | eins von beiden | eins von beiden | |
| `email` | eins von beiden | eins von beiden | eins von beiden | |
| `wunschtermin` | freiwillig | ja | freiwillig | freier Text bis 100 Zeichen, z. B. „Dienstag vormittags“. Bei `kontakt` und `tisch` steht er als „Zeitangabe“ in der Mail |
| `datum` | | | ja | `JJJJ-MM-TT` (Datumsfeld im Browser) oder `TT.MM.JJJJ`, muss ein echtes Kalenderdatum sein |
| `uhrzeit` | | | ja | `HH:MM` |
| `personen` | | | ja | ganze Zahl von 1 bis 100 |
| `nachricht` | ja | ja | freiwillig | bis 2000 Zeichen, bei `tisch` als „Anmerkungen“ |
| `website` | muss leer sein | muss leer sein | muss leer sein | Honigtopf |
| `dauer` | ja | ja | ja | Millisekunden seit Seitenaufruf, setzt das Skript im Formular |

`datum`, `uhrzeit` und `personen` werden nur bei `tisch` gelesen. Bei den anderen Arten landen sie nicht in der Mail.

Betreff der Mail: `<betreffPraefix> Neue Kontaktanfrage von <Name>`, `... Neue Terminanfrage von <Name>` oder `... Neue Tischanfrage von <Name>, <Datum> <Uhrzeit> Uhr, <Personen> Personen`. Die erste Zeile des Mailtexts nennt dieselbe Art.

Antworten:

- Normales Formular: Erfolg ist `303` auf `dankeUrl`. Fehler ist eine kleine deutsche HTML-Seite mit Statuscode (400, 403, 404, 413, 422, 429, 502). 400 steht für ein unlesbares Format, eine unbekannte `art` oder zu schnelles Absenden.
- fetch mit `Accept: application/json` oder JSON-Body: `{ "ok": true }` oder `{ "ok": false, "fehler": "<code>", "meldung": "...", "felder": {...} }`.

## Einen neuen Kunden einrichten

1. In `kunden.json` einen Eintrag ergänzen:
   ```json
   "friseur-mustermann": {
     "name": "Friseur Mustermann",
     "empfaenger": "termine@friseur-mustermann.de",
     "origins": ["https://friseur-mustermann.de", "https://www.friseur-mustermann.de"],
     "betreffPraefix": "[Friseur Mustermann]",
     "dankeUrl": "https://friseur-mustermann.de/danke"
   }
   ```
   Die ID nur aus Kleinbuchstaben, Ziffern und Bindestrich. `origins` genau so, wie der Browser sie schickt: mit `https://`, ohne Schrägstrich am Ende. Beide Varianten mit und ohne `www` eintragen, wenn beide erreichbar sind. `betreffPraefix` steht vor dem Betreff, z. B. „[Friseur Mustermann] Neue Terminanfrage von ...“. Die Art der Anfrage ergänzt der Empfänger selbst, deshalb gehört sie nicht ins Präfix. Leer ist erlaubt.
2. `npm run pruefe-kunden` und `npm test`.
3. Committen. Danach deployen, **nur mit Freigabe von Michi**.
4. In der `site.config.ts` der Kundenseite unter `formular` den `endpoint` auf die URL dieses Projekts plus `/api/anfrage` setzen und `formularId` wie in `kunden.json`. `versanddienst` leer lassen, leer bedeutet Google Workspace als Standard, und nur so erscheint in der Datenschutzerklärung der Hinweis auf eine mögliche Übermittlung in die USA. Nur bei einem anderen Anbieter dort Name und Sitz eintragen. Für die Terminanfrage zusätzlich `terminanfrage: { aktiv: true }`.
5. Eine Probeanfrage von der echten Domain absenden und im Postfach des Betriebs prüfen, ob sie ankommt und ob „Antworten“ an die Adresse des Besuchers geht.
6. AVV des Kunden: Anlage 3 muss den Versanddienst enthalten (siehe offene Punkte).

Die Beispielkundin in `kunden.json` ist fiktiv und nutzt `.example`-Domains, die niemandem gehören.

## Umgebungsvariablen

Nur im Vercel-Projekt eintragen (Settings, Environment Variables), nie in eine Datei im Repo. `env.beispiel` listet die Namen ohne Werte.

| Name | Bedeutung |
|---|---|
| `FORMULAR_SMTP_HOST` | `smtp-relay.gmail.com` |
| `FORMULAR_SMTP_PORT` | `587` |
| `FORMULAR_SMTP_SECURE` | `false` (dann wird STARTTLS erzwungen, unverschlüsselt geht nichts raus). `true` nur bei Port 465 |
| `FORMULAR_SMTP_USER` | vollständige Workspace-Adresse des Versandkontos |
| `FORMULAR_SMTP_PASS` | App-Passwort dieses Kontos, nicht das normale Passwort |
| `FORMULAR_SMTP_FROM` | Absenderadresse, eine Adresse der eigenen Workspace-Domain, passend zum Konto |
| `FORMULAR_MINDESTZEIT_MS` | optional, Standard 3000 |

Fehlt eine Pflichtvariable, antwortet der Empfänger mit 502 und protokolliert `SMTP_KONFIG_FEHLT`. Benutzer und Passwort sind Pflicht, ohne sie startet kein Versand.

**Anmeldung und Verschlüsselung im Code** (`lib/mail.mjs`, `erstelleTransport`):

- `auth` mit Benutzer und App-Passwort ist immer gesetzt, dazu `forceAuth: true`. Ohne `forceAuth` meldet sich nodemailer nur an, wenn der Server AUTH ankündigt. Mit `forceAuth` gibt es keinen Versand ohne Anmeldung, auch nicht, falls das Relay einmal per IP durchließe.
- Bei `FORMULAR_SMTP_SECURE=false` setzt der Code `requireTLS: true`. Bietet der Server kein STARTTLS an, bricht der Versand ab, statt im Klartext zu senden. Jeder andere Wert als `true` gilt als `false`, fällt also auf erzwungenes STARTTLS zurück, nie auf Klartext.
- Tests prüfen beides an den Optionen des Transports.

## Tests

```
npm install
npm test
```

`node --test` mit gemocktem Transport, es wird nie eine echte Mail verschickt. Abgedeckt: alle drei Arten mit Pflichtfeldern, Betreff und Mailtext, Rückwärtskompatibilität ohne `art`, unbekannte `art` (auch `constructor` und `__proto__`), ungültige Datums-, Uhrzeit- und Personenwerte, Längengrenzen, Honigtopf und Mindestzeit je Art, Transport mit erzwungener Anmeldung und STARTTLS, gültige Anfrage (Formular und fetch), Honigtopf, zu schnell, fehlender Zeitstempel, falsche Origin, fehlende Origin, Referer als Ersatz, unbekannte Formular-ID, Prototyp-ID, zu lange Nachricht, weder Telefon noch Mail, Header-Injection über die Mailadresse, Mengenbegrenzung, Protokoll ohne personenbezogene Daten, CORS-Vorabanfrage, GET, Prüfung von `kunden.json`, und ein Aufbau der Mail durch echtes nodemailer über `streamTransport` ohne Netz.

## Was Michi vor dem ersten Einsatz tun muss

1. **SMTP-Relay in Google Workspace einrichten**, siehe Versanddienst. Ein eigenes Versandkonto anlegen, nicht das Hauptpostfach, mit Bestätigung in zwei Schritten und App-Passwort. Im eigenen Workspace-Vertrag prüfen, dass das Cloud Data Processing Addendum gilt, und den Nachweis ablegen.
2. **Vercel-Projekt anlegen**, im Team „MichiConsulting's projects“ (Pro), aus diesem Ordner. Dafür braucht das Repo ein Remote oder einen Upload per CLI. Beides ist Michis Entscheidung, bewusst nicht vorbereitet.
3. **Region prüfen**: nach dem ersten Deploy in den Projekteinstellungen unter Functions nachsehen, dass `fra1` aktiv ist. `vercel.json` setzt es, aber das Dashboard ist die Bestätigung. Dabei auch prüfen, dass keine Ausweichregion (Function Failover Regions) außerhalb der EU eingestellt ist.
   Beim ersten Deploy außerdem bestätigen, dass `kunden.json` per `includeFiles` in der Funktion landet und der Export `export default { fetch }` greift: eine Probeanfrage mit unbekannter Formular-ID muss 404 liefern, nicht 500.
4. **Umgebungsvariablen** eintragen, nur für Production.
5. **Domain** für den Endpunkt festlegen, z. B. eine Subdomain von dekaru.de. Dann steht in den Formularen der Kunden keine `vercel.app`-Adresse.
6. **Probeanfrage** an ein eigenes Postfach, bevor der erste Kunde umgestellt wird.
7. **Unterlagen anpassen**, siehe offene Punkte. Erst danach den ersten Kunden umstellen.

## Versanddienst: Google Workspace SMTP-Relay

**Entschieden am 03.10.2026.** Versendet wird über das SMTP-Relay von Google Workspace, das dekaru ohnehin nutzt (die MX-Einträge von dekaru.de zeigen auf Google, geprüft am 29.09.2026).

| Einstellung | Wert |
|---|---|
| Server | `smtp-relay.gmail.com` |
| Port | 587 |
| Verschlüsselung | STARTTLS, im Code erzwungen (`requireTLS`) |
| Anmeldung | SMTP-Authentifizierung mit Workspace-Adresse und App-Passwort, im Code erzwungen (`forceAuth`) |
| IP-Bindung | keine |

**Warum ohne IP-Bindung.** Das Relay kann Absender über ihre IP-Adresse zulassen. Vercel-Funktionen haben aber keine festen IP-Adressen, eine IP-Freigabe wäre also entweder unmöglich oder müsste so weit sein, dass sie nichts mehr schützt. Deshalb läuft die Zulassung ausschließlich über die SMTP-Anmeldung. In der Relay-Einstellung der Admin-Konsole heißt das: SMTP-Authentifizierung verlangen, TLS verlangen, keine Beschränkung auf bestimmte IP-Adressen, als Absender nur Adressen der eigenen Domains.

**AVV.** Das Cloud Data Processing Addendum „is incorporated into the Agreement(s)“ und gilt ausdrücklich auch für Google Workspace, Stand „Last modified June 8, 2026“. Drittlandübermittlung über Standardvertragsklauseln. Fundstelle: cloud.google.com/terms/data-processing-addendum. Vertragspartner und Anschrift stehen nicht im Addendum, **im eigenen Workspace-Vertrag prüfen**. Google ist ein US-Konzern, auch wenn der Vertrag über eine EU-Gesellschaft läuft.

**Gesendet-Ordner, geklärt am 05.10.2026.** Zwei Probeanfragen über das Relay: an info@dekaru.de (gleich dem Versandkonto) entstand eine Kopie in Gesendet, an michael.henning@dekaru.de (anderes Postfach) keine. Bei Kundenanfragen geht die Mail immer an den Betrieb, also entsteht keine Kopie. Das Skript `werkzeuge/gesendet-aufraeumen.gs` läuft trotzdem stündlich als Sicherheitsnetz.

Zur Einordnung: Bis zum 29.09.2026 stand hier `smtp.gmail.com` als passender Zugang, weil Google beim Relay die Authentifizierung über IP-Adressen beschreibt. Das Relay lässt aber auch SMTP-Authentifizierung zu, und damit fällt die IP-Frage weg.

## Geprüfte Alternativen (nicht gewählt)

Stand 29.09.2026, nur zur Nachvollziehbarkeit.

### 2. mailbox.org

- **Firma:** Heinlein Hosting GmbH, Schwedter Straße 8/9A, 10119 Berlin, Amtsgericht Berlin-Charlottenburg HRB 220010 B. Fundstelle: mailbox.org/de/impressum, Wortlaut geprüft.
- **Serverstandort:** „an zwei verschiedenen Berliner Standorten“. Fundstelle: kb.mailbox.org/de/privat/faq/wo-stehen-die-server-von-mailbox, Wortlaut geprüft.
- **AVV:** Geschäftskunden können einen AV-Vertrag abschließen, laut Knowledge Base (kb.mailbox.org/de/business/faq/mailbox-fuer-geschaeftskunden) und der Pressemitteilung vom 23.05.2018 online „mit wenigen Mausklicks“ (mailbox.org/de/presse/dsgvo-auskunftsportal). Beide Aussagen nur aus Suchergebnis und Zusammenfassung, nicht im Wortlaut geprüft. Für welche Tarife genau und was er zur Aufbewahrung sagt: **nicht geprüft**.
- **SMTP-Server und Port: nicht aus einer Primärquelle geprüft.** Vor der Wahl in der Knowledge Base nachsehen.
- **Offene Frage wie bei Google:** Ob über SMTP gesendete Mails automatisch im Gesendet-Ordner landen. Bei klassischen Postfächern legt meist das Mailprogramm die Kopie per IMAP ab, nicht der Server. Das wäre günstig, ist aber **nicht belegt**.
- Vorteil: deutscher Anbieter, Verarbeitung in Deutschland, keine Drittlandfrage im Eintrag.

### 3. Brevo (Versanddienst für Transaktionsmails)

- **Firma:** Sendinblue SAS, 9-17 rue Salneuve, 75017 Paris, RCS Paris 498 019 298. Fundstelle: brevo.com/legal/termsofuse.
- **AVV:** Das DPA ist Appendix 3 der Nutzungsbedingungen und „is part of the Terms of Service“. Es gilt also mit dem Konto, ohne gesonderte Unterschrift. Gleiche Fundstelle.
- **Standort und Übermittlung:** Hosting laut Unterauftragsverarbeiter-Liste im DPA bei OVH (Frankreich) und Google Cloud Platform (Belgien). Es gibt aber US-Unterauftragsverarbeiter (u. a. Cloudflare als CDN und WAF, Zendesk), gestützt auf Standardvertragsklauseln und das EU-U.S. Data Privacy Framework. Gleiche Fundstelle.
- **Speicherung:** Laut DPA ist der Kunde selbst für Aufbewahrungsfristen verantwortlich und muss Daten löschen, Brevo löscht nur auf Anweisung. Transaktionsmail-Dienste führen üblicherweise Versandprotokolle. Wie lange Brevo Inhalte und Protokolle von SMTP-Mails vorhält: **nicht geprüft**. Das ist bei dieser Option die entscheidende Frage.
- Vorteil: für Versand aus Anwendungen gebaut, gute Zustellbarkeit. Nachteil: eigener neuer Anbieter mit US-Kette dahinter.

## Offene Punkte

1. **Gesendet-Ordner beim Relay:** erledigt am 05.10.2026, keine Kopie bei Anfragen an andere Adressen, Lösch-Skript als Sicherheitsnetz eingerichtet.
2. **Versand über das Postfach des Betriebs** als Alternative prüfen: je Kunde eigene SMTP-Zugangsdaten, dann läuft die Mail über den Anbieter, den der Betrieb ohnehin hat, und bei dekaru kommt kein Unterauftragsverarbeiter dazu. Kostet: Zugangsdaten je Kunde als Umgebungsvariablen, Pflege bei Passwortwechsel. Bewusst nicht gebaut.
3. **Unterlagen, die mit dem Einsatz veralten** (nur hier notiert, nicht geändert):
   - `dekaru-rechnungen/vorlagen/tom.md`, Abschnitt 1: „als statische Seiten ohne Datenbank“. Ohne Datenbank bleibt wahr, aber es kommt eine Serverfunktion dazu.
   - `tom.md`, Abschnitt 5: spricht vom „Formulardienst“ mit dem Platzhalter `FORMULARDIENST_SPEICHERDAUER`. Neu: keine Speicherung beim Empfänger, Aussage zum Versanddienst je nach Wahl.
   - `unterauftragsverarbeiter.md`, Eintrag Vercel: „Serverfunktionen laufen ... standardmäßig in Washington, D.C.“ und „Die Websites des Auftragnehmers sind statisch.“ Neu: Funktion in Frankfurt (fra1), Zweck um die Weiterleitung von Formulareingaben ergänzen.
   - `unterauftragsverarbeiter.md`: Eintrag Formspree streichen, Eintrag Versanddienst ergänzen. Das ist eine Änderung der Liste und löst nach Paragraf 5 des AVV die Mitteilung an alle laufenden Kunden aus.
   - `dekaru-templates/_system/FORMULARE-DSGVO.md`: beschreibt noch Formspree als Ist-Zustand.
4. **Datenschutzerklärung der Templates:** Im Template `handwerk` gibt es auf dem Branch `terminanfrage` einen eigenen Abschnitt für die Terminanfrage. Die anderen neun Templates nutzen weiter Formspree.
5. **Preisrechner-Baustein „Terminanfrage“** (125 € einmalig) muss laut Hosting-Konditionen noch von der Plus-Funktion abgegrenzt werden. Technisch ist es derselbe Empfänger.
6. **Vercel-Laufzeitprotokolle:** interne Aufbewahrungsdauer bei Vercel unbekannt, siehe Anlage 3.
7. **Mengenbegrenzung** wirkt nur je Instanz. Wenn Spam trotzdem durchkommt, ist der nächste Schritt die Vercel Firewall (Rate Limiting auf Plattformebene, gleicher Anbieter), nicht ein externer Speicher.
