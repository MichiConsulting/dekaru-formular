// Vercel-Funktion: POST /api/anfrage
//
// Duenner Adapter. Die Logik liegt in lib/, damit dort keine weiteren
// Endpunkte entstehen (jede Datei unter api/ waere einer).

import { ladeKunden } from '../lib/konfiguration.mjs';
import { erstelleHandler } from '../lib/anfrage.mjs';
import { smtpAusUmgebung, erstelleTransport } from '../lib/mail.mjs';
import { erstelleMengenbegrenzung } from '../lib/mengenbegrenzung.mjs';

const kunden = ladeKunden();

let versandCache = null;
function versand() {
  if (!versandCache) {
    const smtp = smtpAusUmgebung();
    versandCache = { from: smtp.from, transport: erstelleTransport(smtp) };
  }
  return versandCache;
}

const mindestzeit = Number(process.env.FORMULAR_MINDESTZEIT_MS);

const behandle = erstelleHandler({
  kunden,
  versand,
  mengenbegrenzung: erstelleMengenbegrenzung(),
  mindestzeitMs: Number.isFinite(mindestzeit) && mindestzeit >= 0 ? mindestzeit : 3000,
});

export default {
  fetch(request) {
    return behandle(request);
  },
};
