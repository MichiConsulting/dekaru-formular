/**
 * Löscht die Kopien von Formular-Mails aus dem Ordner "Gesendet" von info@dekaru.de.
 *
 * Warum: Der Formulardienst verschickt Anfragen über das Google-SMTP-Relay mit
 * dem Konto info@dekaru.de. Google legt dabei von jeder Mail eine Kopie im
 * Ordner "Gesendet" ab. Die Anfrage gehört aber dem Kunden, nicht dekaru. Dieses
 * Skript löscht diese Kopien jede Stunde endgültig, ohne Umweg über den Papierkorb.
 *
 * Gelöscht wird nur, was alle drei Bedingungen erfüllt:
 *   1. liegt im Ordner "Gesendet" und NICHT im Posteingang,
 *   2. wurde von info@dekaru.de verschickt,
 *   3. der Betreff enthält "Neue Kontaktanfrage von", "Neue Terminanfrage von"
 *      oder "Neue Tischanfrage von" (so baut der Formulardienst den Betreff).
 * Eigene Mails von Michi bleiben also unberührt.
 *
 * Einrichtung (einmalig, angemeldet als info@dekaru.de):
 *   script.google.com, Neues Projekt, diesen Text einfügen, links bei "Services"
 *   auf + und "Gmail API" hinzufügen, oben "einrichten" auswählen und ausführen,
 *   Berechtigung bestätigen. Danach läuft "aufraeumen" jede Stunde von selbst.
 */

const ABSENDER = 'info@dekaru.de';
const BETREFFS = ['Neue Kontaktanfrage von', 'Neue Terminanfrage von', 'Neue Tischanfrage von'];

function aufraeumen() {
  const teile = BETREFFS.map((b) => `subject:"${b}"`).join(' OR ');
  const suche = `in:sent from:${ABSENDER} (${teile})`;
  let seite;
  let geloescht = 0;
  do {
    const antwort = Gmail.Users.Messages.list('me', { q: suche, maxResults: 100, pageToken: seite });
    for (const kurz of antwort.messages || []) {
      const nachricht = Gmail.Users.Messages.get('me', kurz.id, { format: 'metadata', metadataHeaders: ['Subject'] });
      const labels = nachricht.labelIds || [];
      if (!labels.includes('SENT') || labels.includes('INBOX')) continue;
      const betreff = ((nachricht.payload && nachricht.payload.headers) || [])
        .filter((h) => h.name === 'Subject')
        .map((h) => h.value)[0] || '';
      if (!BETREFFS.some((b) => betreff.includes(b))) continue;
      Gmail.Users.Messages.remove('me', kurz.id);
      geloescht++;
    }
    seite = antwort.nextPageToken;
  } while (seite);
  console.log(`Gelöscht: ${geloescht}`);
}

/** Einmal ausführen: legt den stündlichen Lauf an und räumt sofort einmal auf. */
function einrichten() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'aufraeumen') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('aufraeumen').timeBased().everyHours(1).create();
  aufraeumen();
}
