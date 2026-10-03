// Feldpruefung fuer die drei Arten von Anfragen.
//
// kontakt  Name, Telefon oder Mail, Nachricht. Ein Zeitwunsch ist freiwillig.
// termin   Name, Telefon oder Mail, Wunschtermin, Nachricht. Das ist das
//          urspruengliche Verhalten und gilt auch, wenn "art" fehlt.
// tisch    Name, Telefon oder Mail, Datum, Uhrzeit, Personen. Die Nachricht
//          (Anmerkungen) ist freiwillig.
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
  datum: 10,
  uhrzeit: 5,
  personenMax: 100,
});

/** Erlaubte Werte fuer das Feld "art". Fehlt es, gilt STANDARD_ART. */
export const ARTEN = Object.freeze(['kontakt', 'termin', 'tisch']);
export const STANDARD_ART = 'termin';

// Bewusst schlicht: ein @, kein Leerzeichen, kein Komma, kein Semikolon, keine
// spitzen Klammern, kein Zeilenumbruch, und nach dem @ ein Punkt. Damit ist
// genau eine Adresse erlaubt, was fuer Reply-To wichtig ist.
const MAIL_MUSTER = /^[^\s@,;<>"()\r\n]+@[^\s@,;<>"()\r\n]+\.[^\s@,;<>"()\r\n]{2,}$/;
const TELEFON_MUSTER = /^[0-9+()/.\s-]{5,40}$/;
// Datum so, wie es ein Datumsfeld im Browser schickt (JJJJ-MM-TT), oder als
// deutsche Schreibweise (TT.MM.JJJJ), falls ein Browser nur ein Textfeld zeigt.
const DATUM_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATUM_DE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const UHRZEIT_MUSTER = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;
const PERSONEN_MUSTER = /^\d{1,3}$/;

export function istEinzelneMailadresse(wert) {
  return typeof wert === 'string' && wert.length <= GRENZEN.email && MAIL_MUSTER.test(wert);
}

/**
 * Liefert die Art der Anfrage oder null, wenn der Wert unbekannt ist.
 * Leer oder fehlend heisst "termin", damit bestehende Formulare weiter gehen.
 */
export function bestimmeArt(wert) {
  const art = typeof wert === 'string' ? wert.trim() : '';
  if (art === '') return STANDARD_ART;
  return ARTEN.includes(art) ? art : null;
}

function text(wert) {
  if (typeof wert !== 'string') return '';
  // Steuerzeichen raus, Zeilenumbrueche in der Nachricht bleiben erhalten.
  return wert.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
}

function einzeilig(wert) {
  return text(wert).replace(/\s+/g, ' ');
}

/** Prueft ein Kalenderdatum und gibt es als TT.MM.JJJJ zurueck, sonst null. */
function normalisiereDatum(wert) {
  let j, m, t;
  const iso = DATUM_ISO.exec(wert);
  const de = DATUM_DE.exec(wert);
  if (iso) [, j, m, t] = iso.map(Number);
  else if (de) [, t, m, j] = de.map(Number);
  else return null;
  if (j < 2000 || j > 2100) return null;
  const d = new Date(Date.UTC(j, m - 1, t));
  if (d.getUTCFullYear() !== j || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== t) return null;
  return `${String(t).padStart(2, '0')}.${String(m).padStart(2, '0')}.${j}`;
}

/** Prueft eine Uhrzeit und gibt sie als HH:MM zurueck, sonst null. */
function normalisiereUhrzeit(wert) {
  const treffer = UHRZEIT_MUSTER.exec(wert);
  if (!treffer) return null;
  return `${treffer[1].padStart(2, '0')}:${treffer[2]}`;
}

/**
 * Prueft die Formularfelder fuer eine bereits bestimmte Art.
 * @param {object} eingabe rohe Felder
 * @param {'kontakt'|'termin'|'tisch'} [art]
 * @returns {{ ok: true, daten: object } | { ok: false, felder: Record<string,string> }}
 */
export function pruefeFelder(eingabe, art = STANDARD_ART) {
  const daten = {
    art,
    name: einzeilig(eingabe.name),
    telefon: einzeilig(eingabe.telefon),
    email: einzeilig(eingabe.email),
    wunschtermin: einzeilig(eingabe.wunschtermin),
    nachricht: text(eingabe.nachricht),
    datum: einzeilig(eingabe.datum),
    uhrzeit: einzeilig(eingabe.uhrzeit),
    personen: einzeilig(eingabe.personen),
  };
  const felder = {};

  // Gemeinsam fuer alle Arten: Name und ein Weg, zu antworten.
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

  // Wunschtermin: Pflicht nur bei "termin", sonst freiwillig, die Grenze gilt immer.
  if (art === 'termin' && !daten.wunschtermin) felder.wunschtermin = 'Bitte nennen Sie einen Wunschtermin.';
  else if (daten.wunschtermin.length > GRENZEN.wunschtermin) felder.wunschtermin = `Der Wunschtermin darf höchstens ${GRENZEN.wunschtermin} Zeichen lang sein.`;

  // Nachricht: Pflicht ausser bei "tisch", die Grenze gilt immer.
  if (art !== 'tisch' && !daten.nachricht) felder.nachricht = 'Bitte schreiben Sie kurz, worum es geht.';
  else if (daten.nachricht.length > GRENZEN.nachricht) felder.nachricht = `Die Nachricht darf höchstens ${GRENZEN.nachricht} Zeichen lang sein.`;

  if (art === 'tisch') {
    if (!daten.datum) felder.datum = 'Bitte wählen Sie ein Datum.';
    else {
      const datum = daten.datum.length <= GRENZEN.datum ? normalisiereDatum(daten.datum) : null;
      if (datum) daten.datum = datum;
      else felder.datum = 'Bitte geben Sie ein gültiges Datum an, zum Beispiel 24.10.2026.';
    }

    if (!daten.uhrzeit) felder.uhrzeit = 'Bitte wählen Sie eine Uhrzeit.';
    else {
      const uhrzeit = daten.uhrzeit.length <= GRENZEN.uhrzeit ? normalisiereUhrzeit(daten.uhrzeit) : null;
      if (uhrzeit) daten.uhrzeit = uhrzeit;
      else felder.uhrzeit = 'Bitte geben Sie eine gültige Uhrzeit an, zum Beispiel 19:30.';
    }

    if (!daten.personen) felder.personen = 'Bitte geben Sie an, für wie viele Personen.';
    else {
      const anzahl = PERSONEN_MUSTER.test(daten.personen) ? Number(daten.personen) : NaN;
      if (Number.isInteger(anzahl) && anzahl >= 1 && anzahl <= GRENZEN.personenMax) daten.personen = String(anzahl);
      else felder.personen = `Bitte geben Sie eine Personenzahl von 1 bis ${GRENZEN.personenMax} an.`;
    }
  } else {
    // Felder, die zu dieser Art nicht gehoeren, gehen nicht in die Mail.
    daten.datum = '';
    daten.uhrzeit = '';
    daten.personen = '';
  }

  return Object.keys(felder).length ? { ok: false, felder } : { ok: true, daten };
}
