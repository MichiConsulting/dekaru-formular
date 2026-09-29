// Kern des Formular-Empfaengers. Nimmt einen Web-Request, gibt eine
// Web-Response zurueck. Alles, was von aussen kommt (Kunden, Transport, Uhr,
// Mengenbegrenzung, Protokoll), wird hineingereicht, damit die Tests ohne
// echten Versand und ohne geteilten Zustand laufen.
//
// Datenschutz: Der Inhalt einer Anfrage existiert nur waehrend dieses Aufrufs
// im Arbeitsspeicher und geht danach ausschliesslich per Mail an den Betrieb.
// Nichts wird geschrieben, nichts protokolliert ausser einem Fehlercode ohne
// personenbezogene Daten.

import { alleOrigins } from './konfiguration.mjs';
import { pruefeFelder } from './validierung.mjs';
import { baueNachricht } from './mail.mjs';

const MAX_BYTES = 16 * 1024;
const FELDNAMEN = ['formular', 'name', 'telefon', 'email', 'wunschtermin', 'nachricht', 'website', 'dauer'];

const MELDUNGEN = {
  'formular-unbekannt': 'Dieses Formular ist nicht eingerichtet.',
  herkunft: 'Die Anfrage kam nicht von einer freigegebenen Website.',
  methode: 'Nur das Absenden des Formulars ist hier möglich.',
  'zu-gross': 'Die Anfrage ist zu groß.',
  format: 'Die Anfrage konnte nicht gelesen werden.',
  'zu-schnell': 'Das ging sehr schnell. Bitte warten Sie einen kleinen Moment und senden Sie dann erneut. Ohne JavaScript im Browser klappt das Formular leider nicht, dann rufen Sie uns bitte an.',
  'zu-viele': 'Es sind gerade zu viele Anfragen eingegangen. Bitte versuchen Sie es später noch einmal oder rufen Sie uns an.',
  felder: 'Bitte prüfen Sie Ihre Angaben.',
  versand: 'Ihre Anfrage konnte gerade nicht zugestellt werden. Bitte versuchen Sie es später noch einmal oder rufen Sie uns an.',
};

function standardLog(eintrag) {
  // Nur Ereignis, Formular-ID und Fehlercode. Nie Feldinhalte, nie IP, nie Adressen.
  console.error(JSON.stringify(eintrag));
}

function herkunftAus(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return origin;
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function corsKoepfe(origin) {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : { Vary: 'Origin' };
}

async function leseFelder(request) {
  const laenge = Number(request.headers.get('content-length') || 0);
  if (laenge > MAX_BYTES) return { fehler: 'zu-gross' };
  const typ = (request.headers.get('content-type') || '').toLowerCase();
  try {
    let quelle;
    if (typ.startsWith('multipart/form-data')) {
      const fd = await request.formData();
      quelle = (n) => {
        const w = fd.get(n);
        return typeof w === 'string' ? w : '';
      };
    } else {
      const roh = await request.text();
      if (Buffer.byteLength(roh) > MAX_BYTES) return { fehler: 'zu-gross' };
      if (typ.startsWith('application/json')) {
        const obj = JSON.parse(roh);
        if (!obj || typeof obj !== 'object') return { fehler: 'format' };
        quelle = (n) => (typeof obj[n] === 'string' || typeof obj[n] === 'number' ? String(obj[n]) : '');
      } else if (typ.startsWith('application/x-www-form-urlencoded')) {
        const p = new URLSearchParams(roh);
        quelle = (n) => p.get(n) ?? '';
      } else {
        return { fehler: 'format' };
      }
    }
    const felder = {};
    for (const n of FELDNAMEN) felder[n] = quelle(n);
    return { felder };
  } catch {
    return { fehler: 'format' };
  }
}

/**
 * @param {object} optionen
 * @param {object} optionen.kunden geprueftes Ergebnis aus pruefeKunden/ladeKunden
 * @param {() => ({ from: string, transport: { sendMail: Function } })} optionen.versand
 *        liefert Absender und Transport. Wird erst beim ersten gueltigen Versand aufgerufen.
 * @param {{ erlaube: (ip: string, id: string) => boolean }} optionen.mengenbegrenzung
 * @param {number} [optionen.mindestzeitMs]
 * @param {() => Date} [optionen.jetzt]
 * @param {(eintrag: object) => void} [optionen.log]
 */
export function erstelleHandler({ kunden, versand, mengenbegrenzung, mindestzeitMs = 3000, jetzt = () => new Date(), log = standardLog }) {
  const erlaubteOrigins = alleOrigins(kunden);

  return async function behandle(request) {
    const origin = herkunftAus(request);
    const methode = request.method.toUpperCase();

    // CORS-Vorabanfrage. Die Formular-ID steht erst im Body, deshalb genuegt
    // hier, dass der Origin zu irgendeinem Kunden gehoert. Die genaue Pruefung
    // folgt beim POST.
    if (methode === 'OPTIONS') {
      if (!origin || !erlaubteOrigins.has(origin)) return new Response(null, { status: 403, headers: corsKoepfe(null) });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsKoepfe(origin),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Access-Control-Max-Age': '600',
        },
      });
    }

    const akzeptiert = (request.headers.get('accept') || '').toLowerCase();
    const typ = (request.headers.get('content-type') || '').toLowerCase();
    const willJson = akzeptiert.includes('application/json') || typ.startsWith('application/json');

    let kunde = null;
    let corsOrigin = null;

    const antwort = (status, code, extra = {}) => {
      const meldung = MELDUNGEN[code] || 'Unbekannter Fehler.';
      const koepfe = { ...corsKoepfe(corsOrigin), 'Cache-Control': 'no-store' };
      if (willJson) {
        return Response.json({ ok: false, fehler: code, meldung, ...extra }, { status, headers: koepfe });
      }
      const liste = extra.felder
        ? '<ul>' + Object.values(extra.felder).map((m) => `<li>${escapeHtml(m)}</li>`).join('') + '</ul>'
        : '';
      const zurueck = kunde ? `<p><a href="${escapeHtml(kunde.origins[0])}">Zurück zur Website</a></p>` : '';
      const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Anfrage nicht gesendet</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff"><h1>Anfrage nicht gesendet</h1><p>${escapeHtml(meldung)}</p>${liste}<p>Mit der Zurück-Taste Ihres Browsers kommen Sie zum Formular zurück.</p>${zurueck}</body></html>`;
      return new Response(html, { status, headers: { ...koepfe, 'Content-Type': 'text/html; charset=utf-8' } });
    };

    const erfolg = () => {
      const koepfe = { ...corsKoepfe(corsOrigin), 'Cache-Control': 'no-store' };
      if (willJson) return Response.json({ ok: true }, { status: 200, headers: koepfe });
      // 303: der Browser holt die Danke-Seite per GET, ein Neuladen sendet nicht doppelt.
      return new Response(null, { status: 303, headers: { ...koepfe, Location: kunde.dankeUrl } });
    };

    if (methode !== 'POST') return antwort(405, 'methode');
    if (!origin) return antwort(403, 'herkunft');

    const gelesen = await leseFelder(request);
    if (gelesen.fehler) return antwort(gelesen.fehler === 'zu-gross' ? 413 : 400, gelesen.fehler);
    const f = gelesen.felder;

    kunde = Object.hasOwn(kunden, f.formular) ? kunden[f.formular] : null;
    if (!kunde) return antwort(404, 'formular-unbekannt');
    if (!kunde.origins.includes(origin)) {
      kunde = null; // keinen Link auf fremde Seite anbieten
      return antwort(403, 'herkunft');
    }
    corsOrigin = origin;

    // Honigtopf: ein fuer Menschen unsichtbares Feld. Ist es gefuellt, war es
    // ein Bot. Er bekommt dieselbe Antwort wie ein Mensch, damit er nicht
    // lernt, was ihn verraten hat. Gesendet wird nichts.
    if (f.website.trim() !== '') return erfolg();

    // Mindestzeit. Das Formular schickt die vergangenen Millisekunden seit dem
    // Laden der Seite mit, gemessen im Browser. So spielt eine falsch gehende
    // Uhr beim Besucher keine Rolle. Fehlt der Wert (kein JavaScript), gilt
    // die Anfrage als zu schnell.
    const dauer = Number(f.dauer);
    if (!Number.isFinite(dauer) || dauer < mindestzeitMs) return antwort(400, 'zu-schnell');

    if (!mengenbegrenzung.erlaube(clientIp(request), f.formular)) return antwort(429, 'zu-viele');

    const pruefung = pruefeFelder(f);
    if (!pruefung.ok) return antwort(422, 'felder', { felder: pruefung.felder });

    try {
      const { from, transport } = versand();
      await transport.sendMail(baueNachricht(kunde, pruefung.daten, { from, origin, zeitpunkt: jetzt() }));
    } catch (err) {
      // Fehlermeldungen von SMTP-Servern koennen Adressen enthalten. Deshalb
      // nur der Code, nie die Meldung.
      log({ ereignis: 'versand-fehlgeschlagen', formular: f.formular, code: err?.code || err?.responseCode || 'unbekannt' });
      return antwort(502, 'versand');
    }
    return erfolg();
  };
}
