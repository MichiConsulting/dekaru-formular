// Tests mit gemocktem Transport. Es wird nie eine echte Mail verschickt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erstelleHandler } from '../lib/anfrage.mjs';
import { pruefeKunden, ladeKunden } from '../lib/konfiguration.mjs';
import { erstelleMengenbegrenzung } from '../lib/mengenbegrenzung.mjs';
import { smtpAusUmgebung, erstelleTransport, KonfigFehler } from '../lib/mail.mjs';

const ORIGIN = 'https://tischlerei-beispiel.example';
const DANKE = 'https://tischlerei-beispiel.example/danke';

const kunden = pruefeKunden({
  'beispiel-tischlerei': {
    name: 'Tischlerei Beispiel',
    empfaenger: 'anfragen@tischlerei-beispiel.example',
    origins: [ORIGIN],
    betreffPraefix: '[Tischlerei Beispiel]',
    dankeUrl: DANKE,
  },
});

function aufbau({ sendMail, limiter, log } = {}) {
  const gesendet = [];
  const protokoll = [];
  const transport = {
    sendMail: sendMail ?? (async (n) => {
      gesendet.push(n);
      return { messageId: 'test' };
    }),
  };
  const behandle = erstelleHandler({
    kunden,
    versand: () => ({ from: 'formular@versand.example', transport }),
    mengenbegrenzung: limiter ?? erstelleMengenbegrenzung(),
    mindestzeitMs: 3000,
    jetzt: () => new Date('2026-09-29T10:00:00Z'),
    log: log ?? ((e) => protokoll.push(e)),
  });
  return { behandle, gesendet, protokoll };
}

function felder(ueberschreiben = {}) {
  return {
    formular: 'beispiel-tischlerei',
    name: 'Erika Musterfrau',
    telefon: '0123 456789',
    email: 'erika@beispiel.example',
    wunschtermin: 'Dienstag vormittags',
    nachricht: 'Ich brauche ein neues Regal im Flur.',
    website: '',
    dauer: '8000',
    ...ueberschreiben,
  };
}

function formPost(daten, { origin = ORIGIN, ip = '203.0.113.7' } = {}) {
  const koepfe = { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip };
  if (origin) koepfe.origin = origin;
  return new Request('https://formular.example/api/anfrage', {
    method: 'POST',
    headers: koepfe,
    body: new URLSearchParams(daten).toString(),
  });
}

function jsonPost(daten, { origin = ORIGIN } = {}) {
  return new Request('https://formular.example/api/anfrage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin, 'x-forwarded-for': '203.0.113.8' },
    body: JSON.stringify(daten),
  });
}

test('gueltige Anfrage per Formular: Mail geht raus, 303 auf die Danke-Seite', async () => {
  const { behandle, gesendet, protokoll } = aufbau();
  const res = await behandle(formPost(felder()));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), DANKE);
  assert.equal(gesendet.length, 1);
  const m = gesendet[0];
  assert.equal(m.from, 'formular@versand.example');
  assert.equal(m.to, 'anfragen@tischlerei-beispiel.example');
  assert.equal(m.replyTo, 'erika@beispiel.example');
  assert.equal(m.subject, '[Tischlerei Beispiel] Neue Terminanfrage von Erika Musterfrau');
  assert.match(m.text, /^Neue Terminanfrage über das Formular/);
  assert.equal(m.bcc, undefined);
  assert.equal(m.cc, undefined);
  assert.match(m.text, /Dienstag vormittags/);
  assert.match(m.text, /neues Regal/);
  assert.equal(protokoll.length, 0, 'bei Erfolg wird nichts protokolliert');
});

test('gueltige Anfrage per fetch: JSON ok und CORS nur fuer den eigenen Origin', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ email: '' })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].replyTo, undefined, 'ohne Mailadresse kein Reply-To');
});

test('Honeypot gefuellt: gleiche Antwort wie Erfolg, aber kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(felder({ website: 'http://spam.example' })));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), DANKE);
  assert.equal(gesendet.length, 0);
});

test('zu schnell abgesendet: 400, kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ dauer: '800' })));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fehler, 'zu-schnell');
  assert.equal(gesendet.length, 0);
});

test('fehlender Zeitstempel (kein JavaScript) gilt als zu schnell', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(felder({ dauer: '' })));
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(gesendet.length, 0);
});

test('falsche Origin: 403, kein CORS-Kopf, kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder(), { origin: 'https://fremde-seite.example' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).fehler, 'herkunft');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(gesendet.length, 0);
});

test('ohne Origin und ohne Referer: 403', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(felder(), { origin: null }));
  assert.equal(res.status, 403);
  assert.equal(gesendet.length, 0);
});

test('Referer als Ersatz, wenn Origin fehlt', async () => {
  const { behandle, gesendet } = aufbau();
  const req = new Request('https://formular.example/api/anfrage', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: ORIGIN + '/#termin' },
    body: new URLSearchParams(felder()).toString(),
  });
  const res = await behandle(req);
  assert.equal(res.status, 303);
  assert.equal(gesendet.length, 1);
});

test('unbekannte Formular-ID: 404, kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ formular: 'gibt-es-nicht' })));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).fehler, 'formular-unbekannt');
  assert.equal(gesendet.length, 0);
});

test('Formular-ID aus dem Objekt-Prototyp wird nicht akzeptiert', async () => {
  const { behandle } = aufbau();
  const res = await behandle(jsonPost(felder({ formular: 'constructor' })));
  assert.equal(res.status, 404);
});

test('zu lange Nachricht: 422 mit Feldhinweis, kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ nachricht: 'x'.repeat(2001) })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.fehler, 'felder');
  assert.match(body.felder.nachricht, /höchstens 2000 Zeichen/);
  assert.equal(JSON.stringify(body).includes('xxxx'), false, 'Antwort wiederholt die Eingabe nicht');
  assert.equal(gesendet.length, 0);
});

test('weder Telefon noch Mail: 422', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ telefon: '', email: '' })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.felder.telefon && body.felder.email);
  assert.equal(gesendet.length, 0);
});

test('Header-Injection ueber Mailadresse wird abgewiesen', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ email: 'a@b.example\r\nBcc: opfer@c.example' })));
  assert.equal(res.status, 422);
  assert.equal(gesendet.length, 0);
});

test('Mengenbegrenzung: die sechste Anfrage derselben IP wird abgewiesen', async () => {
  const { behandle, gesendet } = aufbau();
  for (let i = 0; i < 5; i++) {
    assert.equal((await behandle(formPost(felder()))).status, 303);
  }
  const res = await behandle(formPost(felder()));
  assert.equal(res.status, 429);
  assert.equal(gesendet.length, 5);
});

test('Mengenbegrenzung verfaellt nach dem Zeitfenster', () => {
  let t = 0;
  const l = erstelleMengenbegrenzung({ fensterMs: 1000, maxJeSchluessel: 1, jetzt: () => t });
  assert.equal(l.erlaube('1.2.3.4', 'f'), true);
  assert.equal(l.erlaube('1.2.3.4', 'f'), false);
  t = 1001;
  assert.equal(l.erlaube('1.2.3.4', 'f'), true);
});

test('Versandfehler: 502, Protokoll ohne personenbezogene Daten', async () => {
  const fehler = Object.assign(new Error('550 mailbox anfragen@tischlerei-beispiel.example unavailable'), { code: 'EENVELOPE', responseCode: 550 });
  const { behandle, protokoll } = aufbau({ sendMail: async () => { throw fehler; } });
  const res = await behandle(formPost(felder()));
  assert.equal(res.status, 502);
  assert.equal(protokoll.length, 1);
  const zeile = JSON.stringify(protokoll[0]);
  assert.deepEqual(protokoll[0], { ereignis: 'versand-fehlgeschlagen', formular: 'beispiel-tischlerei', code: 'EENVELOPE' });
  for (const persoenlich of ['Erika', '0123 456789', 'erika@', '203.0.113', 'anfragen@', 'Regal']) {
    assert.equal(zeile.includes(persoenlich), false, `Protokoll enthaelt ${persoenlich}`);
  }
});

test('OPTIONS-Vorabanfrage: erlaubt fuer bekannten Origin, verweigert fuer fremden', async () => {
  const { behandle } = aufbau();
  const ok = await behandle(new Request('https://formular.example/api/anfrage', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const nein = await behandle(new Request('https://formular.example/api/anfrage', { method: 'OPTIONS', headers: { origin: 'https://fremd.example' } }));
  assert.equal(nein.status, 403);
  assert.equal(nein.headers.get('access-control-allow-origin'), null);
});

test('GET wird abgewiesen', async () => {
  const { behandle } = aufbau();
  const res = await behandle(new Request('https://formular.example/api/anfrage', { headers: { origin: ORIGIN } }));
  assert.equal(res.status, 405);
});

test('kunden.json im Repo ist gueltig', () => {
  const k = ladeKunden();
  assert.ok(k['beispiel-tischlerei']);
});

test('Konfiguration: Danke-Seite auf fremder Domain wird beim Laden abgelehnt', () => {
  assert.throws(
    () => pruefeKunden({ x1: { empfaenger: 'a@b.example', origins: [ORIGIN], betreffPraefix: '', dankeUrl: 'https://boese.example/' } }),
    /dankeUrl/,
  );
});

test('Konfiguration: mehrere Empfaenger in einem Feld werden abgelehnt', () => {
  assert.throws(
    () => pruefeKunden({ x1: { empfaenger: 'a@b.example, c@d.example', origins: [ORIGIN], betreffPraefix: '', dankeUrl: DANKE } }),
    /empfaenger/,
  );
});

test('nodemailer baut die Mail korrekt (streamTransport, kein Netz)', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const behandle = erstelleHandler({
    kunden,
    versand: () => ({ from: 'formular@versand.example', transport: { sendMail: async (n) => { roh = (await transport.sendMail(n)).message.toString(); } } }),
    mengenbegrenzung: erstelleMengenbegrenzung(),
    jetzt: () => new Date('2026-09-29T10:00:00Z'),
    log: () => {},
  });
  let roh = '';
  const res = await behandle(formPost(felder({ name: 'Jörg Übel' })));
  assert.equal(res.status, 303);
  assert.match(roh, /^From: formular@versand\.example$/m);
  assert.match(roh, /^To: anfragen@tischlerei-beispiel\.example$/m);
  assert.match(roh, /^Reply-To: erika@beispiel\.example$/m);
  assert.doesNotMatch(roh, /^(Bcc|Cc):/m);
});

// ---------------------------------------------------------------------------
// Art der Anfrage: kontakt, termin, tisch

function kontaktFelder(ueberschreiben = {}) {
  return felder({ art: 'kontakt', wunschtermin: '', ...ueberschreiben });
}

function tischFelder(ueberschreiben = {}) {
  return felder({
    art: 'tisch',
    wunschtermin: '',
    nachricht: '',
    datum: '2026-10-24',
    uhrzeit: '19:30',
    personen: '4',
    ...ueberschreiben,
  });
}

test('ohne art: Verhalten wie bisher, Wunschtermin ist Pflicht', async () => {
  const { behandle, gesendet } = aufbau();
  const leer = await behandle(jsonPost(felder({ wunschtermin: '' })));
  assert.equal(leer.status, 422);
  const body = await leer.json();
  assert.deepEqual(Object.keys(body.felder), ['wunschtermin']);
  assert.equal(gesendet.length, 0);

  const ok = await behandle(jsonPost(felder()));
  assert.equal(ok.status, 200);
  assert.equal(gesendet[0].subject, '[Tischlerei Beispiel] Neue Terminanfrage von Erika Musterfrau');
  assert.match(gesendet[0].text, /^Wunschtermin: Dienstag vormittags$/m);
});

test('leere art gilt wie fehlende art als termin', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(felder({ art: '' })));
  assert.equal(res.status, 303);
  assert.match(gesendet[0].subject, /Neue Terminanfrage/);
});

test('art termin: Wunschtermin und Nachricht sind Pflicht', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(felder({ art: 'termin', wunschtermin: '', nachricht: '' })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.felder.wunschtermin && body.felder.nachricht);
  assert.equal(gesendet.length, 0);
  assert.equal((await behandle(jsonPost(felder({ art: 'termin' })))).status, 200);
  assert.match(gesendet[0].subject, /Neue Terminanfrage von Erika Musterfrau$/);
});

test('art kontakt: ohne Wunschtermin gueltig, Betreff Kontaktanfrage', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(kontaktFelder()));
  assert.equal(res.status, 303);
  assert.equal(gesendet.length, 1);
  const m = gesendet[0];
  assert.equal(m.subject, '[Tischlerei Beispiel] Neue Kontaktanfrage von Erika Musterfrau');
  assert.match(m.text, /^Neue Kontaktanfrage über das Formular/);
  assert.doesNotMatch(m.text, /Wunschtermin|Zeitangabe/);
  assert.match(m.text, /neues Regal/);
});

test('art kontakt: freiwillige Zeitangabe steht in der Mail', async () => {
  const { behandle, gesendet } = aufbau();
  await behandle(formPost(kontaktFelder({ wunschtermin: 'werktags ab 16 Uhr' })));
  assert.match(gesendet[0].text, /^Zeitangabe: werktags ab 16 Uhr$/m);
});

test('art kontakt: Name, Kontaktweg und Nachricht sind Pflicht', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(kontaktFelder({ name: '', telefon: '', email: '', nachricht: '' })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.felder).sort(), ['email', 'nachricht', 'name', 'telefon']);
  assert.equal(gesendet.length, 0);
});

test('art kontakt: zu lange Zeitangabe wird abgewiesen', async () => {
  const { behandle } = aufbau();
  const res = await behandle(jsonPost(kontaktFelder({ wunschtermin: 'x'.repeat(101) })));
  assert.equal(res.status, 422);
  assert.match((await res.json()).felder.wunschtermin, /höchstens 100 Zeichen/);
});

test('art tisch: Datum, Uhrzeit, Personen, Betreff Tischanfrage', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(formPost(tischFelder()));
  assert.equal(res.status, 303);
  assert.equal(gesendet.length, 1);
  const m = gesendet[0];
  assert.equal(m.subject, '[Tischlerei Beispiel] Neue Tischanfrage von Erika Musterfrau, 24.10.2026 19:30 Uhr, 4 Personen');
  assert.match(m.text, /^Neue Tischanfrage über das Formular/);
  assert.match(m.text, /^Datum: 24\.10\.2026$/m);
  assert.match(m.text, /^Uhrzeit: 19:30 Uhr$/m);
  assert.match(m.text, /^Personen: 4$/m);
  assert.match(m.text, /^Anmerkungen:\n\(keine\)$/m);
  assert.doesNotMatch(m.text, /Wunschtermin/);
});

test('art tisch: deutsche Datumsschreibweise und eine Person', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(tischFelder({ datum: '5.1.2027', uhrzeit: '9:05', personen: '1', nachricht: 'Platz am Fenster' })));
  assert.equal(res.status, 200);
  assert.match(gesendet[0].subject, /05\.01\.2027 09:05 Uhr, 1 Person$/);
  assert.match(gesendet[0].text, /Anmerkungen:\nPlatz am Fenster/);
});

test('art tisch: Datum, Uhrzeit und Personen sind Pflicht, Nachricht nicht', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(jsonPost(tischFelder({ datum: '', uhrzeit: '', personen: '' })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.felder).sort(), ['datum', 'personen', 'uhrzeit']);
  assert.equal(gesendet.length, 0);
});

test('art tisch: ungueltige Werte werden abgewiesen', async () => {
  const { behandle, gesendet } = aufbau({ limiter: { erlaube: () => true } });
  const faelle = [
    { datum: '2026-02-30' },
    { datum: '31.04.2026' },
    { datum: 'naechsten Samstag' },
    { datum: '2026-10-24T19:30' },
    { uhrzeit: '24:00' },
    { uhrzeit: '19 Uhr' },
    { uhrzeit: '19:3' },
    { personen: '0' },
    { personen: '101' },
    { personen: '4,5' },
    { personen: 'vier' },
  ];
  for (const fall of faelle) {
    const res = await behandle(jsonPost(tischFelder(fall)));
    assert.equal(res.status, 422, JSON.stringify(fall));
    const feld = Object.keys(fall)[0];
    assert.ok((await res.json()).felder[feld], `Meldung fuer ${feld} fehlt`);
  }
  assert.equal(gesendet.length, 0);
});

test('art tisch: Laengengrenzen fuer Name, Nachricht und Zeitangabe gelten weiter', async () => {
  const { behandle } = aufbau();
  const res = await behandle(jsonPost(tischFelder({ name: 'x'.repeat(101), nachricht: 'y'.repeat(2001), wunschtermin: 'z'.repeat(101) })));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.felder.name && body.felder.nachricht && body.felder.wunschtermin);
});

test('Tischfelder bei art kontakt landen nicht in der Mail', async () => {
  const { behandle, gesendet } = aufbau();
  await behandle(formPost(kontaktFelder({ datum: '2026-10-24', uhrzeit: '19:30', personen: '4' })));
  assert.doesNotMatch(gesendet[0].text, /Datum|Uhrzeit|Personen/);
});

test('unbekannte art: 400 mit CORS-Kopf, kein Versand', async () => {
  const { behandle, gesendet } = aufbau();
  for (const art of ['bestellung', 'constructor', '__proto__', 'Kontakt']) {
    const res = await behandle(jsonPost(felder({ art })));
    assert.equal(res.status, 400, art);
    const body = await res.json();
    assert.equal(body.fehler, 'art-unbekannt');
    assert.notEqual(body.meldung, 'Unbekannter Fehler.');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  }
  const html = await behandle(formPost(felder({ art: 'bestellung' })));
  assert.equal(html.status, 400);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.equal(gesendet.length, 0);
});

test('Honigtopf greift bei jeder art', async () => {
  const { behandle, gesendet } = aufbau();
  for (const daten of [kontaktFelder(), tischFelder(), felder({ art: 'termin' })]) {
    const res = await behandle(formPost({ ...daten, website: 'spam' }));
    assert.equal(res.status, 303);
  }
  assert.equal(gesendet.length, 0);
});

test('Mindestzeit greift bei jeder art', async () => {
  const { behandle, gesendet } = aufbau();
  for (const daten of [kontaktFelder({ dauer: '100' }), tischFelder({ dauer: '' }), felder({ art: 'termin', dauer: '2999' })]) {
    const res = await behandle(jsonPost(daten));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).fehler, 'zu-schnell');
  }
  assert.equal(gesendet.length, 0);
});

// ---------------------------------------------------------------------------
// SMTP-Transport: Anmeldung und Verschluesselung

const ENV = {
  FORMULAR_SMTP_HOST: 'smtp-relay.gmail.com',
  FORMULAR_SMTP_PORT: '587',
  FORMULAR_SMTP_SECURE: 'false',
  FORMULAR_SMTP_USER: 'formular@versand.example',
  FORMULAR_SMTP_PASS: 'nur-ein-test',
  FORMULAR_SMTP_FROM: 'formular@versand.example',
};

test('Transport bei Port 587: STARTTLS erzwungen und Anmeldung immer', () => {
  const t = erstelleTransport(smtpAusUmgebung(ENV));
  const o = t.options;
  assert.equal(o.host, 'smtp-relay.gmail.com');
  assert.equal(o.port, 587);
  assert.equal(o.secure, false);
  assert.equal(o.requireTLS, true);
  assert.equal(o.forceAuth, true);
  assert.deepEqual(o.auth, { user: 'formular@versand.example', pass: 'nur-ein-test' });
  assert.equal(o.ignoreTLS, undefined);
  t.close();
});

test('Transport: unbekannter Wert in FORMULAR_SMTP_SECURE faellt auf STARTTLS zurueck, nie auf Klartext', () => {
  const t = erstelleTransport(smtpAusUmgebung({ ...ENV, FORMULAR_SMTP_SECURE: 'ja' }));
  assert.equal(t.options.secure, false);
  assert.equal(t.options.requireTLS, true);
  t.close();
});

test('Ohne Benutzer oder Passwort startet der Versand nicht', () => {
  for (const fehlt of ['FORMULAR_SMTP_USER', 'FORMULAR_SMTP_PASS']) {
    assert.throws(() => smtpAusUmgebung({ ...ENV, [fehlt]: '' }), (e) => e instanceof KonfigFehler && e.message.includes(fehlt));
  }
});
