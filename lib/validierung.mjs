// Feldpruefung fuer die Terminanfrage.
//
// Die Meldungen sind auf Deutsch und gehen so an den Besucher zurueck. Sie
// nennen nie den eingegebenen Wert, damit auch eine Antwort nichts Persoenliches
// wiederholt.

export const GRENZEN = Object.freeze({
  name: 100,
  telefon: 40,
  email: 254,
  wunschtermin: 100,
  nachricht: 2000,
});

// Bewusst schlicht: ein @, kein Leerzeichen, kein Komma, kein Semikolon, keine
// spitzen Klammern, kein Zeilenumbruch, und nach dem @ ein Punkt. Damit ist
// genau eine Adresse erlaubt, was fuer Reply-To wichtig ist.
const MAIL_MUSTER = /^[^\s@,;<>"()\r\n]+@[^\s@,;<>"()\r\n]+\.[^\s@,;<>"()\r\n]{2,}$/;
const TELEFON_MUSTER = /^[0-9+()/.\s-]{5,40}$/;

export function istEinzelneMailadresse(wert) {
  return typeof wert === 'string' && wert.length <= GRENZEN.email && MAIL_MUSTER.test(wert);
}

function text(wert) {
  if (typeof wert !== 'string') return '';
  // Steuerzeichen raus, Zeilenumbrueche in der Nachricht bleiben erhalten.
  return wert.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
}

function einzeilig(wert) {
  return text(wert).replace(/\s+/g, ' ');
}

/**
 * Prueft die Formularfelder.
 * @returns {{ ok: true, daten: object } | { ok: false, felder: Record<string,string> }}
 */
export function pruefeFelder(eingabe) {
  const daten = {
    name: einzeilig(eingabe.name),
    telefon: einzeilig(eingabe.telefon),
    email: einzeilig(eingabe.email),
    wunschtermin: einzeilig(eingabe.wunschtermin),
    nachricht: text(eingabe.nachricht),
  };
  const felder = {};

  if (!daten.name) felder.name = 'Bitte geben Sie Ihren Namen an.';
  else if (daten.name.length > GRENZEN.name) felder.name = `Der Name darf höchstens ${GRENZEN.name} Zeichen lang sein.`;

  if (!daten.telefon && !daten.email) {
    felder.telefon = 'Bitte geben Sie eine Telefonnummer oder eine E-Mail-Adresse an.';
    felder.email = 'Bitte geben Sie eine Telefonnummer oder eine E-Mail-Adresse an.';
  }
  if (daten.telefon && !TELEFON_MUSTER.test(daten.telefon)) {
    felder.telefon = 'Bitte geben Sie eine gültige Telefonnummer an, nur Ziffern, Leerzeichen und + ( ) / - .';
  }
  if (daten.email && !istEinzelneMailadresse(daten.email)) {
    felder.email = 'Bitte geben Sie eine gültige E-Mail-Adresse an.';
  }

  if (!daten.wunschtermin) felder.wunschtermin = 'Bitte nennen Sie einen Wunschtermin.';
  else if (daten.wunschtermin.length > GRENZEN.wunschtermin) felder.wunschtermin = `Der Wunschtermin darf höchstens ${GRENZEN.wunschtermin} Zeichen lang sein.`;

  if (!daten.nachricht) felder.nachricht = 'Bitte schreiben Sie kurz, worum es geht.';
  else if (daten.nachricht.length > GRENZEN.nachricht) felder.nachricht = `Die Nachricht darf höchstens ${GRENZEN.nachricht} Zeichen lang sein.`;

  return Object.keys(felder).length ? { ok: false, felder } : { ok: true, daten };
}
