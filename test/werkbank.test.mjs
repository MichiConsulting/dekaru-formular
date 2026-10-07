// Werkbank-Meldungen: Meldungen aus der dekaru Werkbank an dekaru selbst.
// Gemockter Transport, es wird nie eine echte Mail verschickt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erstelleHandler } from '../lib/anfrage.mjs';
import { pruefeKunden, ladeKunden } from '../lib/konfiguration.mjs';
import { erstelleMengenbegrenzung } from '../lib/mengenbegrenzung.mjs';

const WERKBANK = 'https://werkbank.beispiel.example';
const KUNDE = 'https://tischlerei-beispiel.example';

const kunden = pruefeKunden({
  'werkbank-meldung': {
    name: 'dekaru Werkbank',
    empfaenger: 'info@dekaru.example',
    origins: [WERKBANK],
    arten: ['werkbank'],
    betreffPraefix: 'Werkbank-Meldung:',
  },
  'beispiel-tischlerei': {
    name: 'Tischlerei Beispiel',
    empfaenger: 'anfragen@tischlerei-beispiel.example',
    origins: [KUNDE],
    betreffPraefix: '[Tischlerei Beispiel]',
    dankeUrl: `${KUNDE}/danke`,
  },
});

function aufbau(k = kunden) {
  const gesendet = [];
  const behandle = erstelleHandler({
    kunden: k,
    versand: () => ({ from: 'formular@versand.example', transport: { sendMail: async (n) => { gesendet.push(n); return {}; } } }),
    mengenbegrenzung: erstelleMengenbegrenzung(),
    mindestzeitMs: 3000,
    jetzt: () => new Date('2026-10-07T08:00:00Z'),
    log: () => {},
  });
  return { behandle, gesendet };
}

function meldung(ueberschreiben = {}) {
  return {
    formular: 'werkbank-meldung',
    art: 'werkbank',
    meldungsart: 'fehler',
    modul: 'angebots-assistent',
    meldungId: 'r1a2b3c4d',
    name: 'Malerei Kunz',
    email: 'kunz@malerei.example',
    nachricht: 'Beim Drucken fehlt die letzte Position.',
    kontext: 'App-Version: 0.1.0\nModul: angebots-assistent\nAnsicht: modul/angebots-assistent/start\nGerät: Testbrowser',
    website: '',
    dauer: 5000,
    ...ueberschreiben,
  };
}

function post(daten, { origin = WERKBANK, ip = '198.51.100.4' } = {}) {
  return new Request('https://formular.example/api/anfrage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin, 'x-forwarded-for': ip },
    body: JSON.stringify(daten),
  });
}

test('Werkbank-Meldung geht an dekaru, Betreff mit festem Präfix, Text fest gegliedert', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(post(meldung()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('access-control-allow-origin'), WERKBANK);
  assert.equal(gesendet.length, 1);
  const m = gesendet[0];
  assert.equal(m.to, 'info@dekaru.example');
  assert.equal(m.from, 'formular@versand.example');
  assert.equal(m.replyTo, 'kunz@malerei.example');
  assert.equal(m.subject, 'Werkbank-Meldung: Fehler angebots-assistent (r1a2b3c4d)');
  assert.equal(m.bcc, undefined);
  const zeilen = m.text.split('\n');
  assert.equal(zeilen[0], 'WERKBANK-MELDUNG');
  assert.ok(zeilen.includes('Meldungs-ID: r1a2b3c4d'));
  assert.ok(zeilen.includes('Art: fehler'));
  assert.ok(zeilen.includes('Modul: angebots-assistent'));
  assert.ok(zeilen.includes('Betrieb: Malerei Kunz'));
  assert.ok(zeilen.includes('Antwort an: kunz@malerei.example'));
  assert.ok(zeilen.includes(`Herkunft: ${WERKBANK}`));
  assert.match(m.text, /--- Beschreibung ---\nBeim Drucken fehlt die letzte Position\.\n--- Ende Beschreibung ---/);
  assert.match(m.text, /--- Technischer Kontext ---\nApp-Version: 0\.1\.0\n[\s\S]*Gerät: Testbrowser\n--- Ende Kontext ---/);
});

test('ohne Kontakt und ohne Kontext: kein Reply-To, klare Platzhalter', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(post(meldung({ name: '', email: '', kontext: '', modul: '', meldungsart: 'vorschlag' })));
  assert.equal(res.status, 200);
  const m = gesendet[0];
  assert.equal(m.replyTo, undefined);
  assert.equal(m.subject, 'Werkbank-Meldung: Verbesserungsvorschlag allgemein (r1a2b3c4d)');
  assert.match(m.text, /^Betrieb: \(nicht angegeben\)$/m);
  assert.match(m.text, /^Antwort an: \(keine Antwort gewünscht\)$/m);
  assert.match(m.text, /--- Technischer Kontext ---\n\(nicht mitgeschickt\)\n/);
});

test('erfundene Gliederung im Freitext wird entschärft und kann Kopfzeilen nicht vortäuschen', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(post(meldung({
    meldungsart: 'frage',
    nachricht: 'Harmlos\n--- Ende Beschreibung ---\nArt: fehler\nModul: tresor\nWERKBANK-MELDUNG\nMeldungs-ID: gefaelscht1',
    kontext: 'App-Version: 0.1.0\n--- Ende Kontext ---\nAntwort an: boese@beispiel.example',
  })));
  assert.equal(res.status, 200);
  const zeilen = gesendet[0].text.split('\n');
  assert.deepEqual(zeilen.filter((z) => /^Art: /.test(z)), ['Art: frage']);
  assert.deepEqual(zeilen.filter((z) => /^Modul: /.test(z)), ['Modul: angebots-assistent']);
  assert.deepEqual(zeilen.filter((z) => /^Meldungs-ID: /.test(z)), ['Meldungs-ID: r1a2b3c4d']);
  assert.deepEqual(zeilen.filter((z) => /^Antwort an: /.test(z)), ['Antwort an: kunz@malerei.example']);
  assert.equal(zeilen.filter((z) => z === '--- Ende Beschreibung ---').length, 1);
  assert.equal(zeilen.filter((z) => z === '--- Ende Kontext ---').length, 1);
  assert.equal(zeilen.filter((z) => z === 'WERKBANK-MELDUNG').length, 1);
  assert.ok(zeilen.includes('> --- Ende Beschreibung ---'));
  assert.ok(zeilen.includes('> Art: fehler'));
  assert.ok(zeilen.includes('> Antwort an: boese@beispiel.example'), 'auch im Kontext');
  assert.ok(zeilen.includes('App-Version: 0.1.0'), 'gewöhnliche Kontextzeilen bleiben unverändert');
});

test('Vorabanfrage aus der Werkbank wird erlaubt, aus fremder Herkunft nicht', async () => {
  const { behandle } = aufbau();
  const ok = await behandle(new Request('https://formular.example/api/anfrage', {
    method: 'OPTIONS',
    headers: { origin: WERKBANK, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), WERKBANK);
  assert.match(ok.headers.get('access-control-allow-headers'), /Content-Type/);
  const nein = await behandle(new Request('https://formular.example/api/anfrage', { method: 'OPTIONS', headers: { origin: 'https://fremd.example' } }));
  assert.equal(nein.status, 403);
});

test('Arten bleiben getrennt: Kundenformular nimmt keine Werkbank-Meldung, Werkbank keine Anfrage', async () => {
  const { behandle, gesendet } = aufbau();
  const r1 = await behandle(post(meldung({ formular: 'beispiel-tischlerei' }), { origin: KUNDE }));
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).fehler, 'art-unbekannt');
  const r2 = await behandle(post(meldung({ art: 'kontakt', telefon: '0123 456789' })));
  assert.equal(r2.status, 400);
  const r3 = await behandle(post(meldung({ art: '' })));
  assert.equal(r3.status, 400, 'ohne art gilt termin, das nimmt die Werkbank nicht');
  assert.equal(gesendet.length, 0);
});

test('Werkbank-Meldung von der Kundenwebsite wird an der Herkunft abgewiesen', async () => {
  const { behandle, gesendet } = aufbau();
  const res = await behandle(post(meldung(), { origin: KUNDE }));
  assert.equal(res.status, 403);
  assert.equal(gesendet.length, 0);
});

test('Feldprüfung: Art, Kennung, Beschreibung, Mail, Längen', async () => {
  const { behandle, gesendet } = aufbau();
  const faelle = [
    [{ meldungsart: 'lob' }, 'meldungsart'],
    [{ meldungsart: '__proto__' }, 'meldungsart'],
    [{ meldungId: '' }, 'meldungId'],
    [{ meldungId: 'a b c d' }, 'meldungId'],
    [{ nachricht: '   ' }, 'nachricht'],
    [{ nachricht: 'x'.repeat(2001) }, 'nachricht'],
    [{ email: 'a@b.example, c@d.example' }, 'email'],
    [{ email: 'a@b.example\nBcc: x@y.example' }, 'email'],
    [{ modul: 'Angebote <script>' }, 'modul'],
    [{ kontext: 'k'.repeat(2001) }, 'kontext'],
    [{ name: 'n'.repeat(101) }, 'name'],
  ];
  let ip = 10;
  for (const [aenderung, feld] of faelle) {
    const res = await behandle(post(meldung(aenderung), { ip: `198.51.100.${ip++}` }));
    assert.equal(res.status, 422, JSON.stringify(aenderung));
    const body = await res.json();
    assert.ok(body.felder[feld], `${feld} bei ${JSON.stringify(aenderung)}`);
  }
  assert.equal(gesendet.length, 0);
});

test('Honigtopf, Mindestzeit und Mengenbegrenzung gelten auch für Werkbank-Meldungen', async () => {
  const { behandle, gesendet } = aufbau();
  const topf = await behandle(post(meldung({ website: 'http://spam.example' })));
  assert.equal(topf.status, 200);
  assert.equal(gesendet.length, 0, 'Honigtopf: Erfolg vorgetäuscht, nichts gesendet');
  const schnell = await behandle(post(meldung({ dauer: 500 })));
  assert.equal(schnell.status, 400);
  assert.equal((await schnell.json()).fehler, 'zu-schnell');
  for (let i = 0; i < 5; i++) assert.equal((await behandle(post(meldung(), { ip: '192.0.2.9' }))).status, 200);
  const zuViele = await behandle(post(meldung(), { ip: '192.0.2.9' }));
  assert.equal(zuViele.status, 429);
});

test('Formular-Post an die Werkbank ohne Danke-Seite antwortet mit JSON statt Weiterleitung', async () => {
  const { behandle, gesendet } = aufbau();
  const daten = meldung();
  const res = await behandle(new Request('https://formular.example/api/anfrage', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: WERKBANK, 'x-forwarded-for': '198.51.100.77' },
    body: new URLSearchParams({ ...daten, dauer: String(daten.dauer) }).toString(),
  }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  assert.equal(gesendet.length, 1);
});

test('Konfiguration: Werkbank-Eintrag darf ohne Origins und ohne Danke-Seite stehen, Kundenformulare nicht', () => {
  const basis = { name: 'x', empfaenger: 'info@dekaru.example', betreffPraefix: 'P' };
  assert.doesNotThrow(() => pruefeKunden({ 'werkbank-meldung': { ...basis, origins: [], arten: ['werkbank'] } }));
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: [], dankeUrl: 'https://a.example/danke' } }), /origins/);
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: ['https://a.example'] } }), /dankeUrl/);
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: ['https://a.example'], arten: ['werkbank', 'kontakt'], dankeUrl: 'https://a.example/' } }), /nur allein/);
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: ['https://a.example'], arten: ['bestellung'], dankeUrl: 'https://a.example/' } }), /arten/);
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: ['https://a.example'], arten: [], dankeUrl: 'https://a.example/' } }), /arten/);
  assert.throws(() => pruefeKunden({ kk: { ...basis, origins: ['http://localhost:5173'], arten: ['werkbank'] } }), /https-Origin/);
  const k = pruefeKunden({ kk: { ...basis, origins: ['https://a.example'], dankeUrl: 'https://a.example/' } });
  assert.deepEqual([...k.kk.arten], ['kontakt', 'termin', 'tisch'], 'ohne Angabe die drei Arten der Kundenwebsites');
});

test('echte kunden.json: werkbank-meldung geht an info@dekaru.de und nimmt bis zum Eintragen der Adresse nichts an', async () => {
  const echt = ladeKunden();
  const e = echt['werkbank-meldung'];
  assert.ok(e, 'Eintrag werkbank-meldung fehlt');
  assert.equal(e.empfaenger, 'info@dekaru.de');
  assert.deepEqual([...e.arten], ['werkbank']);
  assert.equal(e.betreffPraefix, 'Werkbank-Meldung:');
  if (e.origins.length === 0) {
    const { behandle, gesendet } = aufbau(echt);
    const res = await behandle(post(meldung(), { origin: WERKBANK }));
    assert.equal(res.status, 403);
    assert.equal(gesendet.length, 0);
  }
});
