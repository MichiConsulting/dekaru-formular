// Tests mit gemocktem Transport. Es wird nie eine echte Mail verschickt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erstelleHandler } from '../lib/anfrage.mjs';
import { pruefeKunden, ladeKunden } from '../lib/konfiguration.mjs';
import { erstelleMengenbegrenzung } from '../lib/mengenbegrenzung.mjs';

const ORIGIN = 'https://tischlerei-beispiel.example';
const DANKE = 'https://tischlerei-beispiel.example/danke';

const kunden = pruefeKunden({
  'beispiel-tischlerei': {
    name: 'Tischlerei Beispiel',
    empfaenger: 'anfragen@tischlerei-beispiel.example',
    origins: [ORIGIN],
    betreffPraefix: '[Terminanfrage]',
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
    telefon: '07451 123456',
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
  assert.equal(m.subject, '[Terminanfrage] Erika Musterfrau');
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
  for (const persoenlich of ['Erika', '07451', 'erika@', '203.0.113', 'anfragen@', 'Regal']) {
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
