// Baut die Mail an den Betrieb und den SMTP-Transport.
//
// Absender ist immer FORMULAR_SMTP_FROM, nie die Adresse des Besuchers. Sonst
// scheitert die Mail an SPF und DMARC. Die Adresse des Besuchers steht nur im
// Reply-To, und nur, wenn sie genau eine gueltige Adresse ist.
//
// Keine Kopie an dekaru, kein BCC, kein Anhang, nur Klartext.

import nodemailer from 'nodemailer';
import { istEinzelneMailadresse } from './validierung.mjs';

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

/**
 * Baut das Nachrichtenobjekt fuer transport.sendMail.
 * @param {object} kunde Eintrag aus kunden.json
 * @param {object} daten gepruefte Felder
 * @param {{ from: string, origin: string, zeitpunkt: Date }} rahmen
 */
export function baueNachricht(kunde, daten, { from, origin, zeitpunkt }) {
  const eingang = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(zeitpunkt);

  const zeilen = [
    `Neue Terminanfrage über das Formular auf ${origin}`,
    `Eingegangen: ${eingang} Uhr`,
    '',
    `Name: ${daten.name}`,
    `Telefon: ${daten.telefon || '(nicht angegeben)'}`,
    `E-Mail: ${daten.email || '(nicht angegeben)'}`,
    `Wunschtermin: ${daten.wunschtermin}`,
    '',
    'Nachricht:',
    daten.nachricht,
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
    subject: einzeilig(`${kunde.betreffPraefix} ${daten.name}`).slice(0, 150),
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
