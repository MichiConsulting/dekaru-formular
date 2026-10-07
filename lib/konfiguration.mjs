// Laedt und prueft kunden.json.
//
// Die Datei ist eingecheckt und enthaelt keine Geheimnisse, nur je Formular
// die Empfaengeradresse, die erlaubten Origins, die erlaubten Arten, das
// Betreff-Praefix und die Danke-Seite. Fehler in der Datei sollen beim Laden auffallen und nicht erst,
// wenn ein Besucher absendet.

import { readFileSync } from 'node:fs';
import { istEinzelneMailadresse, ARTEN, KUNDEN_ARTEN } from './validierung.mjs';

const ID_MUSTER = /^[a-z0-9][a-z0-9-]{1,62}$/;

function istOrigin(wert) {
  try {
    const url = new URL(wert);
    // Nur https. Ein Origin hat weder Pfad noch Query noch Fragment.
    return url.protocol === 'https:' && url.origin === wert;
  } catch {
    return false;
  }
}

/**
 * Prueft ein bereits geparstes Kunden-Objekt und gibt es eingefroren zurueck.
 * Wirft bei jedem Fehler, mit Angabe der Formular-ID und des Feldes.
 */
export function pruefeKunden(roh) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    throw new Error('kunden.json: Objekt mit Formular-IDs als Schluessel erwartet');
  }
  const ergebnis = {};
  for (const [id, k] of Object.entries(roh)) {
    const fehler = (feld, text) => new Error(`kunden.json, Formular "${id}", Feld ${feld}: ${text}`);
    if (!ID_MUSTER.test(id)) throw fehler('(ID)', 'nur Kleinbuchstaben, Ziffern und Bindestrich, 2 bis 63 Zeichen');
    if (!istEinzelneMailadresse(k.empfaenger)) throw fehler('empfaenger', 'genau eine gueltige Mailadresse');

    // arten: welche Arten von Anfragen dieses Formular annimmt. Ohne Angabe
    // die drei der Kundenwebsites. "werkbank" (Meldungen aus der dekaru
    // Werkbank) steht immer allein, damit ein Kundenformular nie Meldungen
    // an dekaru schicken kann und umgekehrt.
    const arten = k.arten === undefined ? [...KUNDEN_ARTEN] : k.arten;
    if (!Array.isArray(arten) || arten.length === 0 || arten.some((a) => !ARTEN.includes(a)) || new Set(arten).size !== arten.length) {
      throw fehler('arten', `Liste aus ${ARTEN.join(', ')}`);
    }
    const nurWerkbank = arten.length === 1 && arten[0] === 'werkbank';
    if (arten.includes('werkbank') && !nurWerkbank) throw fehler('arten', '"werkbank" nur allein');

    // Ein Werkbank-Eintrag darf ohne Origins stehen. Dann nimmt er nichts an
    // (jede Anfrage scheitert an der Herkunft), bis die Adresse der Werkbank
    // feststeht. Kundenformulare brauchen immer mindestens einen Origin.
    if (!Array.isArray(k.origins) || (k.origins.length === 0 && !nurWerkbank)) throw fehler('origins', 'mindestens ein Origin');
    for (const o of k.origins) {
      if (!istOrigin(o)) throw fehler('origins', `"${o}" ist kein https-Origin ohne Pfad`);
    }
    if (typeof k.betreffPraefix !== 'string' || k.betreffPraefix.length > 60 || /[\r\n]/.test(k.betreffPraefix)) {
      throw fehler('betreffPraefix', 'Text bis 60 Zeichen ohne Zeilenumbruch');
    }
    // Die Werkbank sendet nur per fetch und liest die JSON-Antwort. Eine
    // Danke-Seite braucht sie nicht, alle anderen Formulare schon.
    let danke = null;
    if (k.dankeUrl !== undefined || !nurWerkbank) {
      try {
        danke = new URL(k.dankeUrl);
      } catch {
        throw fehler('dankeUrl', 'keine gueltige URL');
      }
      // Die Danke-Seite muss auf einer der eigenen Domains liegen. Sonst liesse
      // sich der Empfaenger als offene Weiterleitung missbrauchen.
      if (!k.origins.includes(danke.origin)) throw fehler('dankeUrl', 'muss auf einem der origins liegen');
    }
    ergebnis[id] = Object.freeze({
      name: typeof k.name === 'string' ? k.name : id,
      empfaenger: k.empfaenger,
      origins: Object.freeze([...k.origins]),
      arten: Object.freeze([...arten]),
      betreffPraefix: k.betreffPraefix,
      dankeUrl: danke ? danke.href : null,
    });
  }
  return Object.freeze(ergebnis);
}

/** Liest kunden.json aus dem Projektordner. vercel.json bindet die Datei per includeFiles ein. */
export function ladeKunden(pfad = new URL('../kunden.json', import.meta.url)) {
  return pruefeKunden(JSON.parse(readFileSync(pfad, 'utf8')));
}

/** Alle erlaubten Origins ueber alle Formulare. Gebraucht fuer den CORS-Vorabcheck. */
export function alleOrigins(kunden) {
  const menge = new Set();
  for (const k of Object.values(kunden)) for (const o of k.origins) menge.add(o);
  return menge;
}
