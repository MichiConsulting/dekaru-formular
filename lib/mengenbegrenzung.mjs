// Einfache Mengenbegrenzung im Arbeitsspeicher.
//
// Ehrlich gesagt wirkt das bei Serverless nur begrenzt: Vercel startet je nach
// Last mehrere Instanzen, jede hat ihren eigenen Speicher, und eine kalt
// gestartete Instanz beginnt bei null. Die Begrenzung bremst also einen
// einzelnen Bot, der schnell hintereinander sendet, aber keinen verteilten
// Angriff. Dafuer bleibt nichts dauerhaft liegen, und es braucht keinen
// externen Speicher, der ein weiterer Unterauftragsverarbeiter waere.
//
// Die IP-Adresse wird nicht im Klartext gehalten, sondern mit einem Salz
// gehasht, das bei jedem Start der Instanz neu gewuerfelt wird und nie den
// Speicher verlaesst. Eintraege verfallen nach Ablauf des Zeitfensters.

import { createHash, randomBytes } from 'node:crypto';

/**
 * @param {{ fensterMs?: number, maxJeSchluessel?: number, maxJeFormular?: number, jetzt?: () => number }} optionen
 */
export function erstelleMengenbegrenzung({
  fensterMs = 10 * 60 * 1000,
  maxJeSchluessel = 5,
  maxJeFormular = 30,
  jetzt = () => Date.now(),
} = {}) {
  const salz = randomBytes(16);
  const treffer = new Map(); // gehashter Schluessel -> Liste von Zeitpunkten

  const hash = (wert) => createHash('sha256').update(salz).update(String(wert)).digest('base64url');

  function aufraeumen(t) {
    for (const [schluessel, liste] of treffer) {
      const frisch = liste.filter((z) => t - z < fensterMs);
      if (frisch.length) treffer.set(schluessel, frisch);
      else treffer.delete(schluessel);
    }
  }

  function zaehle(schluessel, max, t) {
    const liste = treffer.get(schluessel) ?? [];
    if (liste.length >= max) return false;
    liste.push(t);
    treffer.set(schluessel, liste);
    return true;
  }

  return {
    /** true, wenn die Anfrage durchgelassen wird. Zaehlt sie dann gleich mit. */
    erlaube(ip, formularId) {
      const t = jetzt();
      aufraeumen(t);
      const ipSchluessel = 'ip:' + hash(ip || 'unbekannt');
      const formSchluessel = 'form:' + formularId;
      const ipListe = treffer.get(ipSchluessel) ?? [];
      const formListe = treffer.get(formSchluessel) ?? [];
      if (ipListe.length >= maxJeSchluessel || formListe.length >= maxJeFormular) return false;
      zaehle(ipSchluessel, maxJeSchluessel, t);
      zaehle(formSchluessel, maxJeFormular, t);
      return true;
    },
    /** Nur fuer Tests: Anzahl gehaltener Schluessel. */
    get groesse() {
      return treffer.size;
    },
  };
}
