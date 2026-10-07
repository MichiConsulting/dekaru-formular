// Baut die Mail an den Betrieb und den SMTP-Transport.
//
// Absender ist immer FORMULAR_SMTP_FROM, nie die Adresse des Besuchers. Sonst
// scheitert die Mail an SPF und DMARC. Die Adresse des Besuchers steht nur im
// Reply-To, und nur, wenn sie genau eine gueltige Adresse ist.
//
// Keine Kopie an dekaru, kein BCC, kein Anhang, nur Klartext. Einzige
// Ausnahme sind Werkbank-Meldungen: Die richten sich an dekaru selbst und
// gehen deshalb an den Empfaenger aus kunden.json (info@dekaru.de).

import nodemailer from 'nodemailer';
import { istEinzelneMailadresse, MELDUNGSARTEN } from './validierung.mjs';

const PFLICHT = ['FORMULAR_SMTP_HOST', 'FORMULAR_SMTP_PORT', 'FORMULAR_SMTP_USER', 'FORMULAR_SMTP_PASS', 'FORMULAR_SMTP_FROM'];

export class KonfigFehler extends Error {
  constructor(message) {
    super(message);
    this.code = 'SMTP_KONFIG_FEHLT';
  }
}

/** Liest die SMTP-Zugangsdaten ausschliesslich aus Umgebungsvariablen. */
export function smtpAusUmgebung(env = process.env) {
  const fehlend = PFLICHT.filter((n) => !env[n]);
  if (fehlend.length) throw new KonfigFehler('Umgebungsvariablen fehlen: ' + fehlend.join(', '));
  const port = Number(env.FORMULAR_SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new KonfigFehler('FORMULAR_SMTP_PORT ist keine Portnummer');
  return {
    host: env.FORMULAR_SMTP_HOST,
    port,
    secure: env.FORMULAR_SMTP_SECURE === 'true',
    user: env.FORMULAR_SMTP_USER,
    pass: env.FORMULAR_SMTP_PASS,
    from: env.FORMULAR_SMTP_FROM,
  };
}

/** Erzeugt einen nodemailer-Transport. Protokollierung von nodemailer ist aus. */
export function erstelleTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Ohne TLS von Anfang an wird STARTTLS erzwungen. Unverschluesselt geht nichts raus.
    requireTLS: !smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    // Anmeldung immer, auch wenn der Server AUTH nicht ankuendigt. Ohne diese
    // Einstellung meldet sich nodemailer nur an, wenn der Server danach fragt.
    // Ein Relay, das per IP-Adresse durchlaesst, wuerde dann ohne Anmeldung
    // versenden. Das soll nie passieren, weil Vercel keine festen IPs hat.
    forceAuth: true,
    logger: false,
    debug: false,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
}

function einzeilig(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

const ART_TEXT = Object.freeze({
  kontakt: 'Neue Kontaktanfrage',
  termin: 'Neue Terminanfrage',
  tisch: 'Neue Tischanfrage',
});

function angabenJeArt(daten) {
  if (daten.art === 'tisch') {
    const zeilen = [
      `Datum: ${daten.datum}`,
      `Uhrzeit: ${daten.uhrzeit} Uhr`,
      `Personen: ${daten.personen}`,
    ];
    if (daten.wunschtermin) zeilen.push(`Zeitangabe: ${daten.wunschtermin}`);
    return zeilen;
  }
  if (daten.art === 'kontakt') {
    return daten.wunschtermin ? [`Zeitangabe: ${daten.wunschtermin}`] : [];
  }
  return [`Wunschtermin: ${daten.wunschtermin}`];
}

function betreffZusatz(daten) {
  if (daten.art === 'tisch') {
    return `, ${daten.datum} ${daten.uhrzeit} Uhr, ${daten.personen} ${daten.personen === '1' ? 'Person' : 'Personen'}`;
  }
  return '';
}

/**
 * Baut das Nachrichtenobjekt fuer transport.sendMail.
 * @param {object} kunde Eintrag aus kunden.json
 * @param {object} daten gepruefte Felder, mit daten.art
 * @param {{ from: string, origin: string, zeitpunkt: Date }} rahmen
 */
export function baueNachricht(kunde, daten, { from, origin, zeitpunkt }) {
  const art = ART_TEXT[daten.art] ? daten.art : 'termin';
  const titel = ART_TEXT[art];
  const eingang = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(zeitpunkt);

  const zeilen = [
    `${titel} über das Formular auf ${origin}`,
    `Eingegangen: ${eingang} Uhr`,
    '',
    `Name: ${daten.name}`,
    `Telefon: ${daten.telefon || '(nicht angegeben)'}`,
    `E-Mail: ${daten.email || '(nicht angegeben)'}`,
    ...angabenJeArt({ ...daten, art }),
    '',
    art === 'tisch' ? 'Anmerkungen:' : 'Nachricht:',
    daten.nachricht || '(keine)',
    '',
    '-- ',
    'Diese Anfrage wurde nur an Ihr Postfach zugestellt. Der Formular-Empfänger speichert sie nicht.',
    daten.email
      ? 'Mit "Antworten" schreiben Sie direkt an die angegebene E-Mail-Adresse.'
      : 'Es wurde keine E-Mail-Adresse angegeben. Bitte melden Sie sich telefonisch.',
  ];

  const nachricht = {
    from,
    to: kunde.empfaenger,
    subject: einzeilig(`${kunde.betreffPraefix} ${titel} von ${daten.name}${betreffZusatz({ ...daten, art })}`).slice(0, 150),
    text: zeilen.join('\n'),
    // Keine Dateien oder URLs als Inhalte nachladen, auch nicht versehentlich.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (daten.email && istEinzelneMailadresse(daten.email)) {
    nachricht.replyTo = daten.email;
  }
  return nachricht;
}

/**
 * Mail fuer eine Meldung aus der dekaru Werkbank. Der Text ist fest gegliedert,
 * damit /werkbank-meldung in Claude Code ihn zeilenweise lesen kann: Kopfzeilen
 * "Feld: Wert", danach Beschreibung und Kontext zwischen festen Markierungen.
 * Aendert sich hier etwas, muss der Befehl mitziehen.
 * @param {object} kunde Eintrag aus kunden.json
 * @param {object} daten Ergebnis von pruefeWerkbankMeldung
 * @param {{ from: string, origin: string, zeitpunkt: Date }} rahmen
 */
export function baueWerkbankNachricht(kunde, daten, { from, origin, zeitpunkt }) {
  const eingang = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(zeitpunkt);
  const artName = MELDUNGSARTEN[daten.meldungsart];
  const modul = daten.modul || 'allgemein';

  const zeilen = [
    'WERKBANK-MELDUNG',
    `Meldungs-ID: ${daten.meldungId}`,
    `Art: ${daten.meldungsart}`,
    `Modul: ${modul}`,
    `Betrieb: ${daten.name || '(nicht angegeben)'}`,
    `Antwort an: ${daten.email || '(keine Antwort gewünscht)'}`,
    `Eingegangen: ${eingang} Uhr`,
    `Herkunft: ${origin}`,
    '',
    '--- Beschreibung ---',
    daten.nachricht,
    '--- Ende Beschreibung ---',
    '',
    '--- Technischer Kontext ---',
    daten.kontext || '(nicht mitgeschickt)',
    '--- Ende Kontext ---',
    '',
    '-- ',
    'Gesendet über den Feedback-Knopf der dekaru Werkbank. Der Formulardienst speichert nichts.',
    'Weiter in Claude Code mit /werkbank-meldung und diesem Mailtext.',
  ];

  const nachricht = {
    from,
    to: kunde.empfaenger,
    subject: einzeilig(`${kunde.betreffPraefix} ${artName} ${modul} (${daten.meldungId})`).slice(0, 150),
    text: zeilen.join('\n'),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (daten.email && istEinzelneMailadresse(daten.email)) {
    nachricht.replyTo = daten.email;
  }
  return nachricht;
}
