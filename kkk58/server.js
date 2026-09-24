'use strict';
/*
 * KKk58 Vereinsdatenbank – abhängigkeitsfreier Node-Server (nur Bordmittel).
 * - Mitglieder-Login (scrypt-Hash, signiertes Cookie)
 * - Spielerstamm (Personen), aus dem beim Anschreiben gewählt wird
 * - Eine gemeinsame Live-Anschreibliste, Live-Sync per SSE
 * - Archiv gespeicherter Spiele + Statistik über alle Spiele
 * - JSON-Datei als Speicher (atomar geschrieben)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const qr = require('./qr.js');

// ---------- Konfiguration ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const BIND = process.env.BIND || '127.0.0.1';
let BASE = '/' + String(process.env.BASE_PATH || '/kkk58').replace(/^\/+|\/+$/g, '');
if (BASE === '/') BASE = '';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'true') !== 'false';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, '.session_secret');
// Spool-Verzeichnis für den Matrix-Sidecar: die Node-App legt hier Sende-Aufträge
// (Code-/Login-Link-Nachrichten) ab, der Sidecar sendet sie verschlüsselt und löscht die Datei.
const MATRIX_OUTBOX_DIR = process.env.KKK_OUTBOX_DIR || path.join(DATA_DIR, 'matrix-outbox');
// Eingangs-Spool (Gegenrichtung): der Sidecar legt hier Nachrichten ab, die in einem privaten
// Bot-Chat einen Verknüpfungscode enthalten. Die Node-App verarbeitet und löscht sie.
const MATRIX_INBOX_DIR = process.env.KKK_INBOX_DIR || path.join(DATA_DIR, 'matrix-inbox');
// Öffentliche Basis-URL (für absolute Login-Links in den Matrix-Raum). Leer => aus Request ableiten.
const PUBLIC_URL = String(process.env.KKK_PUBLIC_URL || '').replace(/\/+$/, '');
// Zentraler Vereinsraum für Abstimmungs-Ankündigungen/-Erinnerungen. Leer lassen, wenn der
// Sidecar den Raum kennt: dann wird der Sentinel '__club__' abgelegt und der Sidecar ersetzt
// ihn durch seinen KKK_MATRIX_ROOM. Alternativ hier direkt eine Raum-ID (!id:server) setzen.
const CLUB_ROOM_ENV = String(process.env.KKK_CLUB_ROOM || '').trim();
// Öffentlich anzeigbarer Matrix-Vereinsraum (Adresse für die Unterseite „Matrix-Raum").
// Quelle in dieser Reihenfolge: explizit gesetztes KKK_MATRIX_ROOM > Wert aus der Sidecar-
// Env-Datei (KKK_MATRIX_ENV_FILE) > KKK_CLUB_ROOM. So genügt es, den Raum einmal beim
// Sidecar zu pflegen; die Node-App liest ihn von dort mit.
const MATRIX_ENV_FILE = String(process.env.KKK_MATRIX_ENV_FILE || '/opt/kkk58/matrix-backup/kkk58-matrix.env').trim();
// Vom Matrix-Sidecar geschriebener Nachrichten-Feed (JSONL, eine Nachricht je Zeile,
// chronologisch). Nur lesend genutzt für die Unterseite „Matrix-Raum". Muss mit dem
// KKK_FEED_FILE des Sidecars übereinstimmen. Standard: <DATA_DIR>/matrix-feed.jsonl
const MATRIX_FEED_FILE = String(process.env.KKK_FEED_FILE || path.join(DATA_DIR, 'matrix-feed.jsonl')).trim();
const MATRIX_SAY_MAX = 2000;  // max. Zeichen je Relay-Nachricht aus der Webapp in den Raum
const POLL_REMINDER_INTERVAL = 7 * 864e5; // wöchentlich an offene Stimmen erinnern
const MAX = 180;
const MATRIX_CODE_TTL = 5 * 60 * 1000;  // Verknüpfungscode: 5 Minuten gültig
const MATRIX_MAGIC_TTL = 5 * 60 * 1000;  // Matrix-Login-Link: 5 Minuten gültig

fs.mkdirSync(DATA_DIR, { recursive: true });
try { fs.mkdirSync(MATRIX_OUTBOX_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
try { fs.mkdirSync(MATRIX_INBOX_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}

let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  if (!SECRET) { SECRET = crypto.randomBytes(48).toString('base64url'); try { fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); } catch (_) {} }
}

// ---------- Datenmodell ----------
// Bahnen-Modell: "bahnen" ist ein geordnetes Array der Disziplinen der physischen
// Bahnen (Index 0 = Bahn 1, Index 1 = Bahn 2), z. B. ['schere','bohle'] = Bahn 1
// Schere, Bahn 2 Bohle. Erlaubt sind 1 oder 2 Bahnen; zwei Bahnen dürfen dieselbe
// Disziplin haben (z. B. zwei Scherenbahnen). Punkte werden je physischer Bahn
// gespeichert (l1a/l1b = Bahn 1, l2a/l2b = Bahn 2). "lanes" {bohle,schere} bleibt
// als abgeleiteter Cache (welche Disziplinen vorkommen) für Statistik/Kasse erhalten.
const DISCIPLINES = ['bohle', 'schere'];
// Punkte werden je PHYSISCHER Bahn gespeichert (zwei Würfe je Bahn), damit auch zwei
// Bahnen derselben Disziplin (z. B. zwei Scherenbahnen) möglich sind. Die Disziplin
// einer Bahn ergibt sich aus dem bahnen-Array (Index 0 = Bahn 1, Index 1 = Bahn 2).
const LANE_SLOTS = [['l1a', 'l1b'], ['l2a', 'l2b']];
function rowIsNew(row) { return LANE_SLOTS.some(([a, b]) => Object.prototype.hasOwnProperty.call(row, a) || Object.prototype.hasOwnProperty.call(row, b)); }
// Rohwerte [wurf1, wurf2] der i-ten Bahn (neues Format) bzw. Altformat je Disziplin
function rowLane(row, i, disc) { return rowIsNew(row) ? [row[LANE_SLOTS[i][0]], row[LANE_SLOTS[i][1]]] : (disc === 'bohle' ? [row.b1, row.b2] : [row.s1, row.s2]); }
// Wurfwerte je Disziplin (über alle aktiven Bahnen aggregiert) – Basis für Statistik/Silber/Kasse
function discScores(row, bahnen) {
  const out = { bohle: [], schere: [] };
  if (rowIsNew(row)) { (bahnen || []).forEach((d, i) => { const sl = LANE_SLOTS[i]; if (sl && out[d]) out[d].push(row[sl[0]], row[sl[1]]); }); }
  else { if ((bahnen || []).includes('bohle')) out.bohle.push(row.b1, row.b2); if ((bahnen || []).includes('schere')) out.schere.push(row.s1, row.s2); }
  return out;
}
function sumVals(a) { return a.reduce((x, v) => x + (v || 0), 0); }
function resolveBahnen(g) { return normBahnen(g.bahnen, g.lanes); }
function normBahnen(src, fallbackLanes) {
  let arr = Array.isArray(src) ? src.filter(d => DISCIPLINES.includes(d)) : null;
  if (arr) arr = arr.slice(0, 2); // 1-2 Bahnen; Duplikate erlaubt (zwei gleiche Disziplinen möglich)
  if (!arr || arr.length === 0) {
    // Migration aus dem alten lanes-Modell (Reihenfolge: Bohle vor Schere)
    const l = fallbackLanes || {};
    arr = [];
    if (l.bohle) arr.push('bohle');
    if (l.schere) arr.push('schere');
    if (arr.length === 0) arr = ['bohle'];
  }
  return arr;
}
function lanesFromBahnen(bahnen) { return { bohle: bahnen.includes('bohle'), schere: bahnen.includes('schere') }; }
function emptySheet() {
  return { event: '', date: '', placeId: null, bahnen: ['bohle'], lanes: { bohle: true, schere: false }, priceNK: 1, pricePump: 0.1,
    pumpen: '', note: '', seq: 0, players: [], updatedBy: '', updatedAt: 0 };
}
let db = { users: [], seqUser: 0, roster: [], seqRoster: 0, places: [], seqPlaces: 0, sheet: emptySheet(), archive: [], seqArchive: 0, prizes: [], seqPrizes: 0, trips: [], seqTrips: 0, develop: [], seqDevelop: 0, events: [], seqEvents: 0, polls: [], seqPolls: 0, log: [], invites: [], magic: [], ledger: [], seqLedger: 0, cashSettings: { duesCent: 2000, absenceCent: 100, expenseCent: 3500, duesStartMonth: null }, lastBahnen: null, version: 0 };
const LOG_MAX = 400;

// ---------- Kegelorte (Spielorte) ----------
// Ein Kegelort: id, Name (Pflicht, eindeutig ohne Groß-/Kleinschreibung), active.
// Jede Anschreibliste MUSS beim Archivieren einem Ort zugeordnet sein (harter Block);
// im Archiv wird zusätzlich der Name als Snapshot mitgespeichert, damit spätere
// Umbenennungen/Löschungen die historische Statistik nicht verändern.
const PLACE_NAME_MAX = 80;
const PLACE_ADDRESS_MAX = 200;
function normPlaceAddress(v) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, PLACE_ADDRESS_MAX); }
function normPlace(src) {
  const lb = (src && Array.isArray(src.lastBahnen)) ? normBahnen(src.lastBahnen) : null;
  return {
    id: (src && src.id != null) ? Number(src.id) : null,
    name: String((src && src.name) || '').trim().slice(0, PLACE_NAME_MAX),
    active: !(src && src.active === false),
    address: normPlaceAddress(src && src.address), // optionale Anschrift des Kegelorts (Freitext), '' = keine
    lastBahnen: lb // zuletzt an diesem Ort gespielte Bahn-Konstellation (Vorschlag), null = keine Historie
  };
}
function placeById(id) { if (id == null) return null; const n = Number(id); return db.places.find(p => p.id === n) || null; }
function placeNameById(id) { const p = placeById(id); return p ? p.name : null; }

function cint(v, mn, mx, fb) { let n = Math.round(Number(v)); if (!isFinite(n)) return fb; return Math.min(mx, Math.max(mn, n)); }
function nscore(v) { if (v == null || v === '') return null; return cint(v, 0, MAX, 0); }
function normPlayer(p) {
  const o = { id: p.id, rosterId: (p.rosterId != null ? Number(p.rosterId) : null), name: String(p.name || ''),
    c9: cint(p.c9, 0, 99999, 0), cK: cint(p.cK != null ? p.cK : p.cS, 0, 99999, 0), cP: cint(p.cP, 0, 99999, 0) };
  if (rowIsNew(p)) { o.l1a = nscore(p.l1a); o.l1b = nscore(p.l1b); o.l2a = nscore(p.l2a); o.l2b = nscore(p.l2b); }
  else { o.b1 = nscore(p.b1); o.b2 = nscore(p.b2); o.s1 = nscore(p.s1); o.s2 = nscore(p.s2); } // Altformat, wird per migrateRow überführt
  return o;
}
// Altformat (b1/b2/s1/s2, je Disziplin) in das neue Bahn-Format (l1a/l1b/l2a/l2b) überführen
function migrateRow(p, bahnen) {
  if (rowIsNew(p)) return p;
  (bahnen || []).forEach((d, i) => { const sl = LANE_SLOTS[i]; if (!sl) return; if (d === 'bohle') { p[sl[0]] = p.b1 != null ? p.b1 : null; p[sl[1]] = p.b2 != null ? p.b2 : null; } else { p[sl[0]] = p.s1 != null ? p.s1 : null; p[sl[1]] = p.s2 != null ? p.s2 : null; } });
  // fehlende Bahn-Slots (nicht belegte Bahnen) sicher auf null
  LANE_SLOTS.forEach(([a, b], i) => { if (i >= (bahnen || []).length) { p[a] = null; p[b] = null; } });
  delete p.b1; delete p.b2; delete p.s1; delete p.s2;
  return p;
}
// ---------- Mitgliedsverzeichnis: Kontaktfelder ----------
// Zusatzangaben je Stamm-Person (Verzeichnis). Freitext mit Längenbegrenzung;
// geburtsdatum als YYYY-MM-DD oder null. Werte werden mit dem Stamm live synchronisiert.
const CONTACT_KEYS = ['telefonPrivat', 'telefonDienst', 'handy', 'adresse', 'geburtsdatum', 'emailPrivat', 'emailDienst', 'mxid'];
const CONTACT_MAX = { telefonPrivat: 40, telefonDienst: 40, handy: 40, adresse: 200, emailPrivat: 120, emailDienst: 120, mxid: 255 };
function normDate(v) { const s = String(v == null ? '' : v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null; }
// Kontaktobjekt aus beliebiger Quelle säubern (nur bekannte Felder, getrimmt, gekappt)
function normContact(src) {
  const o = {};
  for (const k of CONTACT_KEYS) {
    if (k === 'geburtsdatum') { o[k] = normDate(src && src[k]); continue; }
    o[k] = String((src && src[k]) || '').trim().slice(0, CONTACT_MAX[k]);
  }
  return o;
}
// Leere Kontaktfelder (für neu angelegte Stamm-Personen)
function emptyContact() { const o = {}; for (const k of CONTACT_KEYS) o[k] = (k === 'geburtsdatum') ? null : ''; return o; }

// ---------- Preise / Wanderpreise ----------
// Beschreibung je Preis: Titel + drei Freitextblöcke (Einleitung, Vergabe-Regel, Bewertung der Würfe).
// Freitext mit Zeilenumbrüchen, längenbegrenzt. Titel ist Pflicht; leere Preise werden verworfen.
const PRIZE_TEXT_MAX = 6000;
function normText(v) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, PRIZE_TEXT_MAX); }
function normPrize(src) {
  return {
    id: (src && src.id != null) ? Number(src.id) : null,
    title: String((src && src.title) || '').trim().slice(0, 120),
    intro: normText(src && src.intro),
    rules: normText(src && src.rules),
    evaluation: normText(src && src.evaluation)
  };
}
// Startdatensatz (W-Weber-Preis) für frische bzw. auf Preise migrierte Datenbanken
function seedPrizes() {
  db.prizes = [{
    id: ++db.seqPrizes,
    title: 'W-Weber-Preis (Wolf-Weber-Kegeln)',
    intro: 'Zum Gedenken an unseren am 30. Dezember 1985 verstorbenen Kegelbruder Wolf Weber, vergibt der Kegelklub KONUS 58 einen Wanderpreis.\n\nAllen älteren Kegelbrüdern ist bekannt, dass Wolf Weber ein sehr „gleichmäßiger" Kegler war. Dieses fiel spätestens dann auf, wenn das Display mal wieder einen „Staketenzaun" von Siebenen anzeigte. Dieser „Stil" ist maßgeblich für die nachfolgend niedergeschriebenen Regeln zur Vergabe der Trophäe.',
    rules: 'Jeder Kegelbruder kann auf der Bohlenbahn jederzeit die Trophäe erringen.\n\nDazu müssen auf der zehnstelligen Wurfanzeige mindestens 7 Siebenen hintereinander angezeigt werden.\n\nAlternativ können auch mindestens 8 Achten hintereinander angemeldet werden.',
    evaluation: 'Den Anspruch auf den Preis muss der Kegler selbst anmelden! Die Schriftwarte sind in diesem Falle für die Beobachtung der Anzeige nicht verantwortlich. Sie notieren allerdings die Anzahl der Siebenen sowie den Durchgang und das Datum.\n\nErheben an einem Abend mehrere Kegelbrüder den Anspruch auf den Preis, so ist derjenige mit den meisten hintereinander angezeigten Siebenen der Gewinner.\n\nAls Wanderpreis ist eine Plakette ausgelobt, auf welcher derjenige Kegelbruder seinen Namen, die Anzahl der Siebenen und das Datum eingravieren lassen darf, der als erster im Kalenderjahr die höchste Anzahl von „777…" angemeldet hat (Mit gilt nicht!). Der Preis wird jeweils am ersten Kegelabend im neuen Jahr vergeben. Die Plakette verbleibt jeweils solange im Besitz des Gewinners, bis im Folgejahr ein weiterer Name eingraviert wird.'
  }];
}
// ---------- Kegelausflüge ----------
// Ein Ausflug je Jahr: Jahr (Pflicht), Ort, Beschreibung (optional, mehrzeilig), Zeitraum (Freitext).
// Sortierung erfolgt im Frontend nach Jahr; hier nur Normalisierung/Validierung.
const TRIP_DESC_MAX = 2000;
function normTripYear(v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 1900 && n <= 2200 ? n : null; }
function normTrip(src) {
  return {
    id: (src && src.id != null) ? Number(src.id) : null,
    year: normTripYear(src && src.year),
    place: String((src && src.place) || '').trim().slice(0, 120),
    description: String(src && src.description == null ? '' : src.description).replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, TRIP_DESC_MAX),
    period: String((src && src.period) || '').trim().slice(0, 120)
  };
}
// Startdatensatz für frische bzw. auf Ausflüge migrierte Datenbanken.
// Übernommen aus „KKK 58 – Zusammenstellung der Kegelausflüge" (Stand September 2019),
// offensichtliche Tippfehler in den Jahreszahlen der Zeitraum-Spalte korrigiert.
function seedTrips() {
  const data = [
    [1968, 'Helgoland', '1. Ausflug zum 10-jährigen Bestehen des Klubs', '21.–22.09.1968'],
    [1969, '', 'kein Ausflug', ''],
    [1970, 'Bodenwerder', 'Weser', '06.–07.09.1970'],
    [1971, '', 'KK-Schießen (statt Ausflug)', ''],
    [1972, 'Hermannsburg', '', '17.–19.09.1972'],
    [1973, 'Helgoland', '', '15.–16.09.1973'],
    [1974, 'Marienhagen', '', '06.–08.09.1974'],
    [1975, 'Hermannsburg', '', ''],
    [1976, 'Marienhagen', '', ''],
    [1977, 'Karlshafen', 'Weser', ''],
    [1978, 'Gellenhausen', 'Barbarossastadt; Hessen / mit KK-Schießen', ''],
    [1979, 'Rothenburg o. d. Tauber', '', ''],
    [1980, 'Hann. Münden – Laubach', 'Hotel Werrastrand', '12.–14.09.1980'],
    [1981, 'Einbeck', 'Hotel Hasenjäger', '22.–24.05.1981'],
    [1982, '', 'nur Schießen in Vechelde', '07.05. und 17.09.1982'],
    [1983, 'Borkum', 'Hotel Jägerheim; zum 25-jährigen Bestehen', '02.–05.09.1983'],
    [1984, 'Borkum', 'Hotel Jägerheim', '31.08.–02.09.1984'],
    [1985, 'Groß Hehlen', 'Weserbergland, Haus Siever', '20.–22.09.1985'],
    [1986, 'Wingst-Höftgrube', 'Hotel Peter', '26.–28.09.1986'],
    [1987, 'Laßbruch', 'Extertal, Hotel Meier', '25.–27.09.1987'],
    [1988, 'Büdingen', 'Hessen; Hotel Stadt Büdingen', '02.–06.09.1988'],
    [1989, 'Laßbruch', 'Extertal; Hotel Meier', '06.–08.10.1989'],
    [1990, 'Nienburg-Holtorf', 'Hotel Holtorfer Hof', '12.–14.10.1990'],
    [1991, 'Steyerberg', 'Lk. Nienburg; Waldhotel Süllhof', '11.–13.10.1991'],
    [1992, 'Tübingen', 'Hotel am Bad', '11.–13.09.1992'],
    [1993, 'Schwerin', 'Hotel Fritz Reutter', '17.–19.09.1993'],
    [1994, 'Freital', 'bei Dresden; Berghotel', '09.–11.09.1994'],
    [1995, 'Osnabrück', 'Parkhotel', '08.–10.09.1995'],
    [1996, 'Bücken', 'Weser, Grafschaft Hoya; Hotel zur Linde', '27.–29.09.1996'],
    [1997, 'Stavenhagen', 'Reuterstadt; Hotel Kutzbach', '03.–05.10.1997'],
    [1998, 'Würzburg', 'Schlosshotel Steinburg', '23.–25.10.1998'],
    [1999, 'Wernigerode-Silstedt', 'Hotel Blocksberg', '05.–07.11.1999'],
    [2000, 'Dielmissen', 'Weser, Am Ith; Gasthaus Angerkrug', '29.09.–01.10.2000'],
    [2001, 'Stralsund', 'Hotel An den Bleichen', '28.–30.09.2001'],
    [2002, 'Cottbus', 'Hotel Cottbusser Hof', '27.–29.09.2002'],
    [2003, 'Goslar', 'Hotel zur Börse', '26.–28.09.2003'],
    [2004, 'Magdeburg', 'Hotel Stadtfeld; Besuch der Bundesgartenschau', '01.–03.10.2004'],
    [2005, 'St. Andreasberg', 'Hotel Rehberg', '26.–27.11.2005'],
    [2006, 'Quedlinburg', 'Hotel Domschatz', '20.–22.10.2006'],
    [2007, 'Lüneburg-Mehlbeck', 'Comfort-Hotel', '21.–23.09.2007'],
    [2008, 'Kiel – Oslo – Kiel', 'Fährschiff Color Fantasy; anlässlich des 50-jährigen Bestehens des KKK58', '27.–29.08.2008'],
    [2009, 'Bremerhaven', 'Hotel Adena / Besuch des Alfred-Wegener-Instituts', '23.–25.10.2009'],
    [2010, 'Rostock', 'Hotel Citymaxx', '28.–30.08.2010'],
    [2011, 'Seligenstadt', 'Hotel Zum Ritter / Besuch des Senders Mainflingen', '14.–16.10.2011'],
    [2012, 'Paderborn – Elsen', 'Hotel Kaiserpfalz / Besuch des Nixdorf-Museums', '19.–21.10.2012'],
    [2013, 'Papenburg', 'Hotel Atlantis / Besuch der Meyerwerft', '18.–20.10.2013'],
    [2014, 'Wangerland', '', '17.–19.10.2014'],
    [2015, 'Potsdam', 'Kongresshotel Potsdam / Besuch des Hohenzollernschlosses „Sanssouci"', '02.–04.10.2015'],
    [2016, 'Wismar', 'Hotel Alter Speicher', '30.09.–02.10.2016'],
    [2017, 'Heidelberg', 'Hotel Perkeo', '27.–29.10.2017'],
    [2018, 'Emden', 'Parkhotel Upstalsboom', '07.–09.12.2018'],
    [2019, 'Göttingen', 'Leine Hotel', '06.–08.09.2019']
  ];
  db.trips = data.map(([year, place, description, period]) => normTrip({ id: ++db.seqTrips, year, place, description, period }));
}
// ---------- Mitgliederentwicklung / Chronik ----------
// Ein Eintrag je Ereignis: Datum (Freitext, weil die Vorlage gemischte Formate nutzt –
// "1958", "01.01.1960", "Sept 1994"), Beschreibung (mehrzeilig) und optional die
// aktuelle Mitgliederzahl zum Zeitpunkt (wie in der Vorlage sporadisch geführt).
// Sortiert wird chronologisch über den aus dem Datumstext abgeleiteten Schlüssel (siehe developSortKey).
const DEVELOP_DESC_MAX = 3000;
function normDevelopCount(v) { if (v == null || v === '') return null; const n = Math.round(Number(v)); return isFinite(n) && n >= 0 && n <= 9999 ? n : null; }
function normDevelop(src) {
  return {
    id: (src && src.id != null) ? Number(src.id) : null,
    date: String((src && src.date) || '').trim().slice(0, 60),
    description: String(src && src.description == null ? '' : src.description).replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, DEVELOP_DESC_MAX),
    count: normDevelopCount(src && src.count)
  };
}
// Startdatensatz für frische bzw. auf die Chronik migrierte Datenbanken.
// Öffentliche Version ohne reale Vereinsdaten: die Chronik startet leer und wird
// über die Oberfläche gepflegt. Zwei neutrale Beispielzeilen zeigen Datumsformat und
// Sortierung; wer ohne Beispiel starten will, setzt das Array einfach auf [].
function seedDevelop() {
  const data = [
    ['1958', 'Kegelklub gegründet (Beispieleintrag – zum Bearbeiten oder Löschen).', 7],
    ['01.01.2020', 'Beispieleintrag: Eingetreten: Max Mustermann', 8]
  ];
  db.develop = data.map(([date, description, count]) => normDevelop({ id: ++db.seqDevelop, date, description, count }));
}
// ---------- Termine / Kalender ----------
// Ein Termin: Datum (JJJJ-MM-TT, Pflicht), Beschreibung (Freitext), Wiederholung
// (none/weekly/monthly/yearly) und – nur bei Wiederholung – ein optionales Enddatum "until",
// bis zu dem der Termin wiederkehrt (leer = ohne Ende). Die Geburtstage werden NICHT hier
// gespeichert, sondern im Frontend aus dem Mitgliedsverzeichnis (geburtsdatum) abgeleitet.
//
// Uhrzeit: Ein Termin ist entweder ganztägig (startTime === null) ODER hat eine
// Startuhrzeit (startTime "HH:MM") und optional eine Enduhrzeit (endTime "HH:MM").
// endTime wird nur gespeichert, wenn eine startTime gesetzt ist und die Enduhrzeit
// nach der Startuhrzeit liegt (Termine über Mitternacht werden nicht abgebildet).
// Alt-Termine ohne Zeitfelder bleiben ganztägig (Migration über normTime -> null).
const EVENT_TEXT_MAX = 200;
const EVENT_PLACE_MAX = 120;
const EVENT_REPEATS = ['none', 'weekly', 'biweekly', 'monthly', 'yearly'];
function normEventRepeat(v) { return EVENT_REPEATS.indexOf(v) !== -1 ? v : 'none'; }
// Uhrzeit "HH:MM" (00:00–23:59) normalisieren, sonst null.
function normTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function normEvent(src) {
  const repeat = normEventRepeat(src && src.repeat);
  const pid = (src && src.placeId != null && src.placeId !== '') ? Number(src.placeId) : null;
  const startTime = normTime(src && src.startTime);
  // Enduhrzeit nur bei gesetzter Startuhrzeit und wenn sie echt nach dem Start liegt.
  let endTime = startTime ? normTime(src && src.endTime) : null;
  if (endTime && endTime <= startTime) endTime = null;
  return {
    id: (src && src.id != null) ? Number(src.id) : null,
    date: normDate(src && src.date),
    text: String((src && src.text) || '').trim().slice(0, EVENT_TEXT_MAX),
    place: String((src && src.place) || '').trim().slice(0, EVENT_PLACE_MAX),
    // Optionale Verknüpfung zu einem Kegelort (db.places): placeId als Referenz,
    // placeName als Snapshot des Namens (bleibt lesbar, falls der Ort später gelöscht wird).
    placeId: (pid != null && isFinite(pid)) ? pid : null,
    placeName: String((src && src.placeName) || '').trim().slice(0, PLACE_NAME_MAX),
    startTime,
    endTime,
    repeat,
    until: repeat === 'none' ? null : normDate(src && src.until)
  };
}
// Verknüpften Kegelort prüfen und Namens-Snapshot aktualisieren; unbekannte Referenz wird verworfen.
function resolveEventPlace(e) {
  if (e.placeId != null) { const pl = placeById(e.placeId); if (pl) e.placeName = pl.name; else { e.placeId = null; e.placeName = ''; } }
  else e.placeName = '';
  return e;
}
function loadDb() {
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = Array.isArray(j.users) ? j.users.map(u => Object.assign({}, u, {
      rosterId: (u.rosterId != null ? Number(u.rosterId) : null),
      role: u.role === 'admin' ? 'admin' : (ALL_ROLES.indexOf(u.role) !== -1 ? u.role : 'beschraenkt') // Alt-Rolle "member" -> "beschraenkt" (Rechte bleiben gleich)
    })) : [];
    // Abgelaufene Matrix-Verknüpfungscodes verwerfen (Matrix-Verknüpfung selbst bleibt erhalten)
    const nowP = Date.now();
    db.users.forEach(u => { if (u.matrixPending && !(u.matrixPending.expires > nowP)) delete u.matrixPending; });
    db.seqUser = j.seqUser || db.users.length;
    db.roster = Array.isArray(j.roster) ? j.roster.map(r => Object.assign({ id: r.id, name: String(r.name || ''), active: r.active !== false, leftAt: (r.leftAt && /^\d{4}-\d{2}-\d{2}$/.test(r.leftAt)) ? r.leftAt : null, duesLiable: r.duesLiable !== false }, normContact(r))) : [];
    db.seqRoster = j.seqRoster || db.roster.reduce((m, r) => Math.max(m, r.id), 0);
    db.places = Array.isArray(j.places) ? j.places.map(normPlace).filter(p => p.id != null && p.name) : [];
    db.seqPlaces = j.seqPlaces || db.places.reduce((m, p) => Math.max(m, p.id), 0);
    db.sheet = Object.assign(emptySheet(), j.sheet || {});
    // Bahnen-Konstellation herleiten: bevorzugt aus dem eingelesenen bahnen-Feld,
    // sonst (Altbestand ohne bahnen) aus lanes ableiten – dann lanes daraus spiegeln.
    db.sheet.bahnen = normBahnen(j.sheet && j.sheet.bahnen, db.sheet.lanes);
    db.sheet.lanes = lanesFromBahnen(db.sheet.bahnen);
    // Ort der Live-Liste nur übernehmen, wenn er (noch) existiert
    db.sheet.placeId = (db.sheet.placeId != null && db.places.some(p => p.id === Number(db.sheet.placeId))) ? Number(db.sheet.placeId) : null;
    db.sheet.players = Array.isArray(db.sheet.players) ? db.sheet.players.map(p => migrateRow(normPlayer(p), db.sheet.bahnen)) : [];
    db.archive = Array.isArray(j.archive) ? j.archive : [];
    db.seqArchive = j.seqArchive || db.archive.reduce((m, a) => Math.max(m, a.id), 0);
    db.prizes = Array.isArray(j.prizes) ? j.prizes.map(normPrize).filter(p => p.id != null && p.title) : [];
    db.seqPrizes = j.seqPrizes || db.prizes.reduce((m, p) => Math.max(m, p.id), 0);
    // Migration älterer Datenbanken ohne Preise: W-Weber-Preis als Startdatensatz anlegen
    if (!Object.prototype.hasOwnProperty.call(j, 'prizes')) seedPrizes();
    db.trips = Array.isArray(j.trips) ? j.trips.map(normTrip).filter(t => t.id != null && t.year != null) : [];
    db.seqTrips = j.seqTrips || db.trips.reduce((m, t) => Math.max(m, t.id), 0);
    // Migration älterer Datenbanken ohne Ausflüge: historische Liste als Startdatensatz anlegen
    if (!Object.prototype.hasOwnProperty.call(j, 'trips')) seedTrips();
    db.develop = Array.isArray(j.develop) ? j.develop.map(normDevelop).filter(d => d.id != null && (d.description || d.date)) : [];
    db.seqDevelop = j.seqDevelop || db.develop.reduce((m, d) => Math.max(m, d.id), 0);
    // Migration älterer Datenbanken ohne Chronik: Mitgliederentwicklung als Startdatensatz anlegen
    if (!Object.prototype.hasOwnProperty.call(j, 'develop')) seedDevelop();
    db.events = Array.isArray(j.events) ? j.events.map(normEvent).filter(e => e.id != null && e.date && e.text) : [];
    db.seqEvents = j.seqEvents || db.events.reduce((m, e) => Math.max(m, e.id), 0);
    db.polls = Array.isArray(j.polls) ? j.polls.map(normPoll).filter(Boolean) : [];
    db.seqPolls = j.seqPolls || db.polls.reduce((m, p) => Math.max(m, p.id), 0);
    db.log = Array.isArray(j.log) ? j.log.slice(-LOG_MAX) : [];
    const nowL = Date.now();
    db.invites = Array.isArray(j.invites) ? j.invites.filter(x => x && !x.used && x.expires > nowL) : [];
    db.magic = Array.isArray(j.magic) ? j.magic.filter(x => x && !x.used && x.expires > nowL) : [];
    db.ledger = Array.isArray(j.ledger) ? j.ledger : [];
    db.seqLedger = j.seqLedger || db.ledger.reduce((m, e) => Math.max(m, e.id || 0), 0);
    const cs = j.cashSettings || {};
    db.cashSettings = { duesCent: Number.isFinite(cs.duesCent) ? cs.duesCent : 2000, absenceCent: Number.isFinite(cs.absenceCent) ? cs.absenceCent : 100, expenseCent: Number.isFinite(cs.expenseCent) ? cs.expenseCent : 3500, duesStartMonth: /^\d{4}-\d{2}$/.test(cs.duesStartMonth) ? cs.duesStartMonth : null };
    db.lastBahnen = Array.isArray(j.lastBahnen) ? normBahnen(j.lastBahnen) : null;
    db.version = j.version || 0;
  } catch (_) { /* Erststart */ seedPrizes(); seedTrips(); seedDevelop(); }
}
let saveTimer = null;
function saveDb() { clearTimeout(saveTimer); saveTimer = setTimeout(flushDb, 250); }
function flushDb() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, DB_FILE); }
  catch (e) { console.error('DB-Schreibfehler:', e.message); }
}

// ---------- Auth ----------
// Berechtigungsgruppen: admin, kassenwart, mitglied haben volle Verwaltungsrechte;
// beschraenkt darf nur die Liste bearbeiten (wie das bisherige "Mitglied").
const ALL_ROLES = ['admin', 'kassenwart', 'mitglied', 'beschraenkt'];
const MANAGE_ROLES = ['admin', 'kassenwart', 'mitglied'];
const CASH_ROLES = ['admin', 'kassenwart'];
function normRole(role) { return ALL_ROLES.indexOf(role) !== -1 ? role : 'beschraenkt'; }
function canManage(role) { return MANAGE_ROLES.indexOf(role) !== -1; }
function canCash(role) { return CASH_ROLES.indexOf(role) !== -1; }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function makeUser(username, pw, role, rosterId, mustChange) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: ++db.seqUser, username, role: normRole(role), rosterId: (rosterId != null ? Number(rosterId) : null), salt, hash: hashPw(pw, salt), mustChangePassword: !!mustChange, createdAt: Date.now() };
}
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
function createInvite(userId) {
  db.invites = db.invites.filter(x => !x.used && x.expires > Date.now() && x.userId !== userId); // alte des Nutzers ersetzen
  const inv = { token: crypto.randomBytes(16).toString('base64url'), userId, expires: endOfToday(), used: false, createdAt: Date.now() };
  db.invites.push(inv); return inv;
}
function findInvite(token) { const t = String(token || ''); return db.invites.find(x => x.token === t && !x.used && x.expires > Date.now()) || null; }

// ---------- Matrix-Login (Verknüpfung + Login-Link) ----------
// Raum-ID (!id:server) oder Raum-Alias (#alias:server); Gesamtlänge begrenzt.
function validRoom(s) { s = String(s || '').trim(); return s.length >= 3 && s.length <= 255 && /^[!#][^\s:]+:[^\s:]+$/.test(s) ? s : null; }
// Matrix-Benutzer-ID (@name:server); optional, dient nur als Nachschlage-Schlüssel beim Login.
function validMxid(s) { s = String(s || '').trim(); return s.length >= 3 && s.length <= 255 && /^@[^\s:]+:[^\s:]+$/.test(s) ? s : null; }
// Kontaktfelder aus dem Mitgliedsverzeichnis, über die man sich zusätzlich anmelden kann.
// (Adresse/Geburtsdatum bewusst NICHT, da nicht eindeutig genug.)
const LOGIN_CONTACT_KEYS = ['telefonPrivat', 'telefonDienst', 'handy', 'emailPrivat', 'emailDienst', 'mxid'];
function isPhoneKey(k) { return k === 'telefonPrivat' || k === 'telefonDienst' || k === 'handy'; }
// Telefon nur nach Ziffern vergleichen (Leerzeichen, /, -, (), + werden ignoriert).
// Annahme/Grenze: 0049… und +49… gelten damit NICHT automatisch als dieselbe Nummer.
function normPhone(s) { return String(s || '').replace(/\D+/g, ''); }
// Alle Konten, deren zugeordnete Stamm-Person einen zur Eingabe passenden Kontaktwert trägt.
function usersByContact(login) {
  const raw = String(login || '').trim(); if (!raw) return [];
  const low = raw.toLowerCase();
  const phone = normPhone(raw);
  const out = [];
  for (const u of db.users) {
    if (u.rosterId == null) continue;
    const r = db.roster.find(x => x.id === u.rosterId);
    if (!r) continue;
    let match = false;
    for (const k of LOGIN_CONTACT_KEYS) {
      const val = r[k];
      if (!val) continue; // leere Verzeichnisfelder nie als Treffer werten
      if (isPhoneKey(k)) { if (phone && normPhone(val) === phone) { match = true; break; } }
      else if (String(val).trim().toLowerCase() === low) { match = true; break; }
    }
    if (match) out.push(u);
  }
  return out;
}
// Konto anhand der Eingabe finden. Reihenfolge:
//  1) exakter Benutzername (Vorrang, damit bestehendes Verhalten stabil bleibt)
//  2) verifizierte Matrix-ID (@name:server) aus der Matrix-Verknüpfung
//  3) Kontaktfeld aus dem Mitgliedsverzeichnis – NUR bei eindeutigem Treffer
//     (0 oder >1 Treffer => null, damit man nie im falschen Konto landet)
function findUserByLogin(login) {
  const s = String(login || '').trim(); if (!s) return null;
  const byName = db.users.find(u => u.username.toLowerCase() === s.toLowerCase());
  if (byName) return byName;
  if (s[0] === '@') {
    const l = s.toLowerCase();
    const mx = db.users.find(u => u.matrix && u.matrix.verified && u.matrix.mxid && u.matrix.mxid.toLowerCase() === l);
    if (mx) return mx;
  }
  const c = usersByContact(s);
  return c.length === 1 ? c[0] : null;
}
// Prüft, ob eine MXID bereits einem anderen Konto zugeordnet ist.
function mxidTakenBy(mxid, exceptUserId) { const l = String(mxid).toLowerCase(); return db.users.find(u => u.id !== exceptUserId && u.matrix && u.matrix.mxid && u.matrix.mxid.toLowerCase() === l) || null; }
function hmacHex(v) { return crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex'); }
function eqHex(a, b) { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); }
// Verknüpfungscode: "KKK-XXXX-XXXX" aus 32 gut unterscheidbaren Zeichen (ohne 0/O/1/I) => 40 Bit.
const MX_CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newMatrixCode() { let c = ''; for (let i = 0; i < 8; i++) c += MX_CODE_ALPHA[crypto.randomInt(0, 32)]; return c; }
function fmtMatrixCode(c) { return 'KKK-' + c.slice(0, 4) + '-' + c.slice(4); }
// Code aus einem Nachrichtentext ziehen (tolerant gegenüber Groß/Klein, Leerzeichen, Bindestrichen).
function extractMatrixCode(text) {
  const m = String(text || '').toUpperCase().match(/KKK[\s-]*([A-Z0-9]{4})[\s-]*([A-Z0-9]{4})/);
  if (!m) return null; const c = m[1] + m[2];
  for (const ch of c) if (MX_CODE_ALPHA.indexOf(ch) === -1) return null;
  return c;
}
// MXID des Bots (nur zur Anzeige: „schicke den Code an …").
function matrixBotId() { return validMxid(process.env.KKK_MATRIX_USER || readEnvFileKey(MATRIX_ENV_FILE, 'KKK_MATRIX_USER')) || null; }
// Sende-Auftrag für den Sidecar ablegen (atomar via tmp+rename, ein Auftrag = eine Datei).
function enqueueMatrix(roomId, body) {
  try {
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
    const tmp = path.join(MATRIX_OUTBOX_DIR, '.' + id + '.tmp');
    const fin = path.join(MATRIX_OUTBOX_DIR, id + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ id, roomId: String(roomId), body: String(body), createdAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, fin);
    return true;
  } catch (e) { console.error('Matrix-Outbox-Fehler:', e.message); return false; }
}
// Einladungs-Auftrag für den Sidecar ablegen: die angegebene MXID in einen Raum einladen.
// Gleiches Spool wie enqueueMatrix, aber mit action:'invite' statt einer Textnachricht.
// Der Sidecar ersetzt den Sentinel '__club__' durch seinen konfigurierten KKK_MATRIX_ROOM.
function enqueueMatrixInvite(roomId, mxid) {
  try {
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
    const tmp = path.join(MATRIX_OUTBOX_DIR, '.' + id + '.tmp');
    const fin = path.join(MATRIX_OUTBOX_DIR, id + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ id, action: 'invite', roomId: String(roomId), mxid: String(mxid), createdAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, fin);
    return true;
  } catch (e) { console.error('Matrix-Outbox-Fehler:', e.message); return false; }
}
// Auftrag für den Sidecar: optional einen Abschiedstext senden, dann den Raum verlassen.
// Nur für persönliche Bot-Chats; nie für den Vereinsraum und nicht, solange ein anderes
// Konto denselben Raum noch verknüpft hat.
function enqueueMatrixLeave(roomId, body, exceptUserId) {
  const rid = validRoom(roomId); if (!rid || rid[0] !== '!') return false;
  const club = validRoom(clubRoom()); if (club && club === rid) return false;
  if (db.users.some(u => u.id !== exceptUserId && u.matrix && u.matrix.roomId === rid)) return false;
  try {
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
    const tmp = path.join(MATRIX_OUTBOX_DIR, '.' + id + '.tmp');
    const fin = path.join(MATRIX_OUTBOX_DIR, id + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ id, action: 'leave', roomId: rid, body: body ? String(body) : '', createdAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, fin);
    return true;
  } catch (e) { console.error('Matrix-Outbox-Fehler:', e.message); return false; }
}
function matrixInfo(user) {
  if (!user) return null;
  const pend = user.matrixPending && user.matrixPending.expires > Date.now() ? { pending: true, expires: user.matrixPending.expires, since: user.matrixPending.since || 0 } : {};
  if (user.matrix && user.matrix.verified) return Object.assign({ roomId: user.matrix.roomId, mxid: user.matrix.mxid || null, verified: true, linkedAt: user.matrix.linkedAt || 0 }, pend);
  if (pend.pending) return Object.assign({ verified: false }, pend);
  return null;
}
// ---------- Matrix-Eingang: Verknüpfungscodes aus privaten Bot-Chats ----------
// Fehlversuche je Absender begrenzen (Schutz gegen Durchprobieren von Codes).
const MX_SENDER_MAX_FAILS = 10, MX_SENDER_WINDOW = 10 * 60 * 1000;
const mxSenderFails = new Map(); // mxid -> { n, since }
function mxSenderBlocked(mxid) { const f = mxSenderFails.get(mxid); if (!f) return false; if (Date.now() - f.since > MX_SENDER_WINDOW) { mxSenderFails.delete(mxid); return false; } return f.n >= MX_SENDER_MAX_FAILS; }
function mxSenderFail(mxid) { const f = mxSenderFails.get(mxid); if (!f || Date.now() - f.since > MX_SENDER_WINDOW) mxSenderFails.set(mxid, { n: 1, since: Date.now() }); else f.n++; }
function handleMatrixInboxEntry(m) {
  // Sidecar hat einen Raum verlassen, weil er dort allein war: Verknüpfungen darauf lösen
  if (m && m.type === 'left') {
    const rid = validRoom(m.roomId); if (!rid) return;
    let n = 0;
    for (const u of db.users) if (u.matrix && u.matrix.roomId === rid) { delete u.matrix; n++; console.log('Matrix-Verknüpfung gelöst (Raum leer):', u.username, rid); }
    if (n) flushDb();
    return;
  }
  const roomId = validRoom(m && m.roomId), sender = validMxid(m && m.sender);
  if (!roomId || roomId[0] !== '!' || !sender) return;
  const bot = matrixBotId(); if (bot && bot.toLowerCase() === sender.toLowerCase()) return;
  if (m.members != null && Number(m.members) > 2) return; // nur private 1:1-Chats (Sidecar prüft ebenfalls)
  const code = extractMatrixCode(m.body); if (!code) return;
  const key = sender.toLowerCase();
  if (mxSenderBlocked(key)) return; // gesperrt: auch keine Antwort mehr
  const h = hmacHex(code), now = Date.now();
  const user = db.users.find(u => u.matrixPending && u.matrixPending.expires > now && eqHex(h, u.matrixPending.codeHash));
  if (!user) { mxSenderFail(key); enqueueMatrix(roomId, '🎳 KKk58 – Verknüpfung\nDieser Code ist unbekannt oder abgelaufen. Bitte in der App einen neuen Code erzeugen.'); return; }
  const other = mxidTakenBy(sender, user.id);
  if (other) { delete user.matrixPending; flushDb(); enqueueMatrix(roomId, '🎳 KKk58 – Verknüpfung\nDeine Matrix-ID ist bereits mit einem anderen KKk58-Konto verknüpft. Entferne dort zuerst die Verknüpfung.'); return; }
  const prevRoom = user.matrix && user.matrix.roomId;
  user.matrix = { roomId, mxid: sender, verified: true, linkedAt: now };
  // Neu verknüpft mit anderem Chat: den bisherigen Bot-Chat verlassen
  if (prevRoom && prevRoom !== roomId) enqueueMatrixLeave(prevRoom, '🎳 KKk58 – Dein Konto ist jetzt mit einem anderen Chat verknüpft. Der Bot verlässt diesen Raum.', user.id);
  delete user.matrixPending;
  // Matrix-ID im Mitgliedsverzeichnis der zugeordneten Person eintragen (bei Änderung:
  // Einladung in den Vereinsraum wie beim manuellen Eintragen im Verzeichnis).
  const r = user.rosterId != null ? db.roster.find(x => x.id === user.rosterId) : null;
  if (r && String(r.mxid || '').toLowerCase() !== key) {
    r.mxid = sender;
    enqueueMatrixInvite(clubRoom(), sender);
    const e = { ts: now, user: user.username, person: personNameOf(user), text: 'Matrix-ID per Verknüpfung eingetragen: ' + r.name + ' (' + sender + ')' };
    db.log.push(e); if (db.log.length > LOG_MAX) db.log.splice(0, db.log.length - LOG_MAX);
    db.version++; saveDb();
    broadcast({ v: db.version, op: { type: 'setRosterContact', id: r.id, fields: { mxid: sender } }, opId: null, by: user.username, log: e });
  } else flushDb();
  enqueueMatrix(roomId, '🎳 KKk58 – Verknüpfung\n✓ Dieser Chat ist jetzt mit dem Konto „' + user.username + '" verknüpft. Login-Links kommen künftig hierher.');
  console.log('Matrix verknüpft:', user.username, sender, roomId);
}
function processMatrixInbox() {
  let names; try { names = fs.readdirSync(MATRIX_INBOX_DIR).filter(n => n.endsWith('.json') && n[0] !== '.').sort(); } catch (_) { return; }
  for (const n of names) {
    const f = path.join(MATRIX_INBOX_DIR, n);
    let m = null; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
    try { fs.unlinkSync(f); } catch (_) {}
    if (!m || (m.type !== 'left' && m.ts && Date.now() - Number(m.ts) > MATRIX_CODE_TTL)) continue; // Altlast: Code wäre ohnehin abgelaufen
    try { handleMatrixInboxEntry(m); } catch (e) { console.error('Matrix-Inbox-Fehler:', e.message); }
  }
}
function createMagic(userId) {
  db.magic = db.magic.filter(x => !x.used && x.expires > Date.now() && x.userId !== userId); // alte des Nutzers ersetzen
  const m = { token: crypto.randomBytes(24).toString('base64url'), userId, expires: Date.now() + MATRIX_MAGIC_TTL, used: false, createdAt: Date.now() };
  db.magic.push(m); return m;
}
function findMagic(token) { const t = String(token || ''); return db.magic.find(x => x.token === t && !x.used && x.expires > Date.now()) || null; }
function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || 'https';
  const host = (String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim());
  return proto + '://' + host + BASE;
}
// einfache Ratenbegrenzung je Schlüssel (Matrix-Aktionen): min. Abstand zwischen zwei Aktionen
const matrixRate = new Map();
function mRateHit(key, minMs) { const now = Date.now(); const t = matrixRate.get(key) || 0; if (now - t < minMs) return true; matrixRate.set(key, now); return false; }
function personNameOf(user) { if (!user || user.rosterId == null) return null; const r = db.roster.find(x => x.id === user.rosterId); return r ? r.name : null; }

// ---------- Abstimmungen (Ja/Nein) ----------
// Ein Poll: Frage, Ersteller, Ablaufzeitpunkt (der Ersteller legt die Laufzeit fest),
// Stimmen je Login-Konto (userId -> 'yes'|'no'). Stimmberechtigt sind alle Login-Konten;
// die Einzelstimmen sind offen sichtbar (passend zur Kegelfahrt-Abfrage).
const POLL_Q_MAX = 200;
function normPollChoice(v) { return v === 'yes' || v === 'no' ? v : null; }
function pollIsClosed(p) { return Date.now() > p.closesAt; }
// Ablauf aus einem Enddatum (JJJJ-MM-TT) = Ende dieses Tages (lokale Zeit) in ms
function pollClosesFromDate(dateStr) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null; const [y, m, d] = dateStr.split('-').map(Number); const dt = new Date(y, m - 1, d, 23, 59, 59, 999); return isNaN(dt.getTime()) ? null : dt.getTime(); }
function normPoll(src) {
  if (!src || src.id == null) return null;
  const closesAt = Number(src.closesAt); if (!Number.isFinite(closesAt)) return null;
  const votes = {};
  if (src.votes && typeof src.votes === 'object') for (const k of Object.keys(src.votes)) { const c = normPollChoice(src.votes[k]); if (c) votes[String(k)] = c; }
  return { id: Number(src.id), question: String(src.question || '').slice(0, POLL_Q_MAX), createdBy: String(src.createdBy || ''),
    createdByPerson: src.createdByPerson != null ? String(src.createdByPerson) : null, createdAt: Number(src.createdAt) || 0,
    closesAt, votes, lastReminderAt: Number(src.lastReminderAt) || 0 };
}
// Öffentliche Sicht eines Polls für die Clients: Zählstand + namentliche Stimmen aller Konten.
function pollView(p) {
  const voters = db.users.map(u => ({ userId: u.id, name: personNameOf(u) || u.username, choice: p.votes[String(u.id)] || null }));
  let yes = 0, no = 0, open = 0;
  voters.forEach(v => { if (v.choice === 'yes') yes++; else if (v.choice === 'no') no++; else open++; });
  return { id: p.id, question: p.question, createdBy: p.createdBy, createdByPerson: p.createdByPerson, createdAt: p.createdAt,
    closesAt: p.closesAt, closed: pollIsClosed(p), counts: { yes, no, open, total: voters.length }, voters };
}
function fmtDateMs(ms) { const d = new Date(ms); const z = n => String(n).padStart(2, '0'); return z(d.getDate()) + '.' + z(d.getMonth() + 1) + '.' + d.getFullYear(); }
function pollLink() { return PUBLIC_URL ? PUBLIC_URL + '/' : null; }
// Zielraum für die Vereins-Ankündigung: entweder eine konfigurierte Raum-ID oder der Sentinel,
// den der Sidecar durch seinen KKK_MATRIX_ROOM ersetzt.
function clubRoom() { return validRoom(CLUB_ROOM_ENV) || '__club__'; }
// Einen einzelnen Wert aus einer .env-Datei lesen. Spiegelt das Parsing des Sidecars:
// Kommentar- (#, ;) und Leerzeilen ignorieren, optionales "export ", Anführungszeichen
// und Inline-Kommentare (Leerraum + #) berücksichtigen. Fehler (Datei fehlt/keine Rechte)
// führen zu leerem Ergebnis.
function parseEnvValue(val) {
  val = String(val).trim();
  if (val[0] === "'" || val[0] === '"') { const q = val[0], end = val.indexOf(q, 1); return end !== -1 ? val.slice(1, end) : val.slice(1); }
  // Inline-Kommentar nur bei Leerraum vor dem '#' abschneiden. Ein führendes '#' gehört
  // zu einer Raum-Alias-Adresse (#alias:server) und ist kein Kommentar.
  let out = '';
  for (let i = 0; i < val.length; i++) { const ch = val[i]; if (ch === '#' && i > 0 && /\s/.test(val[i - 1])) break; out += ch; }
  return out.trim();
}
function readEnvFileKey(file, key) {
  if (!file) return '';
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      let s = raw.trim();
      if (!s || s[0] === '#' || s[0] === ';') continue;
      if (s.startsWith('export ')) s = s.slice(7);
      const eq = s.indexOf('='); if (eq < 0) continue;
      if (s.slice(0, eq).trim() !== key) continue;
      return parseEnvValue(s.slice(eq + 1));
    }
  } catch (_) {}
  return '';
}
// Rohe Raum-Adresse aus den konfigurierten Quellen (siehe MATRIX_ENV_FILE oben).
function matrixRoomRaw() {
  return String(process.env.KKK_MATRIX_ROOM || readEnvFileKey(MATRIX_ENV_FILE, 'KKK_MATRIX_ROOM') || CLUB_ROOM_ENV || '').trim();
}
// Öffentlich anzeigbarer Vereinsraum für die Unterseite. Gibt die validierte Adresse
// (#alias:server oder !id:server) samt matrix.to-Link zurück, oder null wenn nicht konfiguriert.
function publicMatrixRoom() {
  const addr = validRoom(matrixRoomRaw());
  if (!addr) return null;
  return { address: addr, url: 'https://matrix.to/#/' + addr };
}
// Vom Sidecar geschriebenen Nachrichten-Feed einlesen (chronologisch nach seq).
// Beschädigte Zeilen werden übersprungen; fehlt die Datei, ist der Feed leer.
function readFeed() {
  let txt;
  try { txt = fs.readFileSync(MATRIX_FEED_FILE, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch (_) { continue; }
    if (o && typeof o.seq === 'number') out.push(o);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
function feedItem(o) {
  return { seq: o.seq, name: String(o.name || o.sender || '?'), sender: String(o.sender || ''),
    ts: Number(o.ts) || 0, type: String(o.type || 'm.text'), body: String(o.body || '') };
}
function announcePoll(p) {
  const link = pollLink();
  enqueueMatrix(clubRoom(), '🎳 KKk58 – Neue Abstimmung\n„' + p.question + '"\nLäuft bis ' + fmtDateMs(p.closesAt) + '. Bitte mit Ja oder Nein abstimmen.' + (link ? ('\n' + link) : ''));
}
function pollNonVoters(p) { return db.users.filter(u => !(String(u.id) in p.votes)); }
// Wöchentliche Erinnerung an offene Abstimmungen: in den Vereinsraum (mit offenen Namen)
// und zusätzlich privat in den verknüpften Raum jedes noch offenen Kontos.
function sendPollReminders() {
  const now = Date.now(); let changed = false;
  for (const p of db.polls) {
    if (pollIsClosed(p)) continue;
    const base = p.lastReminderAt || p.createdAt || 0;
    if (now - base < POLL_REMINDER_INTERVAL) continue;
    const missing = pollNonVoters(p);
    if (missing.length === 0) continue;
    const link = pollLink();
    const names = missing.map(u => personNameOf(u) || u.username);
    enqueueMatrix(clubRoom(), '🎳 KKk58 – Erinnerung Abstimmung\n„' + p.question + '" (läuft bis ' + fmtDateMs(p.closesAt) + ')\nEs fehlen noch: ' + names.join(', ') + (link ? ('\n' + link) : ''));
    for (const u of missing) {
      if (u.matrix && u.matrix.verified && u.matrix.roomId) {
        enqueueMatrix(u.matrix.roomId, '🎳 KKk58 – Erinnerung\nDu hast noch nicht abgestimmt: „' + p.question + '" (bis ' + fmtDateMs(p.closesAt) + ').' + (link ? ('\nBitte Ja oder Nein abgeben: ' + link) : ''));
      }
    }
    p.lastReminderAt = now; changed = true;
  }
  if (changed) flushDb();
}
function labelKey(k) { return k === 'c9' ? '9' : k === 'cK' ? 'Kränze' : k === 'cP' ? 'Pumpen' : k; }
function pNameById(id) { const p = db.sheet.players.find(x => x.id === id); return p ? (p.name || '#' + id) : '#' + id; }
// Vorher-Zustand einer Operation erfassen (für Lösch-/Umbenennungs-/Änderungsmeldungen,
// da das Objekt nach applyOp nicht mehr bzw. nur noch im neuen Zustand existiert).
function captureCtx(op) {
  const c = {}, id = Number(op.id), s = db.sheet;
  const pick = (arr) => (arr || []).find(x => x.id === id) || null;
  switch (op.type) {
    case 'removePlayer': { const rp = s.players.find(p => p.id === op.id); c.removedName = rp ? rp.name : ''; break; }
    case 'setName': { const rp = s.players.find(p => p.id === op.id); c.oldName = rp ? rp.name : ''; break; }
    case 'setMeta': c.old = s[op.field]; break;
    case 'setPlace': c.oldPlace = placeNameById(s.placeId); break;
    case 'setPrice': c.old = s[op.field]; break;
    case 'renameRoster': case 'removeRoster': { const r = pick(db.roster); c.name = r ? r.name : ''; break; }
    case 'renamePlace': case 'removePlace': case 'setPlaceAddress': case 'setPlaceActive': { const pl = placeById(op.id); c.name = pl ? pl.name : ''; break; }
    case 'setGamePlace': case 'deleteGame': { const g = pick(db.archive); if (g) { c.gameDate = g.date; c.gameEvent = g.event; c.oldPlace = g.placeName || placeNameById(g.placeId); } break; }
    case 'updatePrize': case 'removePrize': { const x = pick(db.prizes); c.name = x ? x.title : ''; break; }
    case 'updateTrip': case 'removeTrip': { const x = pick(db.trips); c.name = x ? (x.year + ' ' + (x.place || '')).trim() : ''; break; }
    case 'updateDevelop': case 'removeDevelop': { const x = pick(db.develop); c.name = x ? ((x.date ? fmtD(x.date) : 'ohne Datum') + (x.description ? ' – ' + clip(x.description, 60) : '')) : ''; break; }
    case 'updateEvent': case 'removeEvent': { const x = pick(db.events); c.name = x ? evText(x) : ''; break; }
    case 'removePoll': case 'closePoll': { const x = pick(db.polls); c.name = x ? x.question : ''; break; }
  }
  return c;
}
function clip(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function quoteDe(t) { return '„' + t + '"'; }
function euro(v) { return (Number(v) || 0).toFixed(2).replace('.', ',') + ' €'; }
function evText(e) { return fmtD(e.date) + (e.startTime ? ' ' + e.startTime + (e.endTime ? '–' + e.endTime : '') : '') + (e.text ? ' – ' + e.text : '') + (e.placeName || e.place ? ' (' + (e.placeName || e.place) + ')' : ''); }
function gameLabel(date, event) { return 'vom ' + fmtD(date) + (event ? ' (' + event + ')' : ''); }
function sheetLabel() { return 'Liste ' + (db.sheet.date ? 'vom ' + fmtD(db.sheet.date) : '') ; }
function describeOp(op, ctx) {
  ctx = ctx || {};
  const was = (o, n) => (o != null && o !== '' && String(o) !== String(n)) ? ' (vorher: ' + o + ')' : '';
  switch (op.type) {
    case 'setMeta': return op.field === 'event'
      ? 'Anlass ' + (op.value ? 'geändert auf ' + quoteDe(op.value) : 'entfernt') + was(ctx.old, op.value)
      : 'Datum der Liste geändert auf ' + fmtD(op.value) + (ctx.old && ctx.old !== op.value ? ' (vorher: ' + fmtD(ctx.old) + ')' : '');
    case 'setPlace': return op.value == null ? ('Kegelort der Liste entfernt' + (ctx.oldPlace ? ' (vorher: ' + ctx.oldPlace + ')' : ''))
      : ('Kegelort ' + (placeNameById(op.value) || '#' + op.value) + ' für ' + sheetLabel().trim() + ' gesetzt' + was(ctx.oldPlace, placeNameById(op.value)));
    case 'addPlace': return 'Kegelort angelegt: ' + (op.place ? op.place.name : '') + (op.place && op.place.address ? ' (' + clip(op.place.address, 80) + ')' : '');
    case 'renamePlace': return 'Kegelort ' + (ctx.name ? ctx.name + ' ' : '') + 'umbenannt in ' + op.name;
    case 'setPlaceAddress': return 'Adresse des Kegelorts ' + (ctx.name || placeNameById(op.id) || '') + ' ' + (op.address ? 'gesetzt: ' + clip(op.address, 120) : 'entfernt');
    case 'setPlaceActive': return 'Kegelort ' + (ctx.name || placeNameById(op.id) || '') + (op.active ? ' aktiviert' : ' deaktiviert');
    case 'removePlace': return 'Kegelort ' + (ctx.name || '') + ' gelöscht';
    case 'setNote': return (op.field === 'pumpen' ? 'Pumpenkegel-Notiz' : 'Bemerkung') + (op.value ? ' geändert: ' + quoteDe(clip(op.value, 100)) : ' entfernt');
    case 'setPrice': return 'Preis ' + (op.field === 'priceNK' ? '9/Kranz' : 'Pumpe') + ' geändert auf ' + euro(op.value) + (ctx.old != null && Number(ctx.old) !== Number(op.value) ? ' (vorher: ' + euro(ctx.old) + ')' : '');
    case 'setLane': return 'Bahn ' + (op.lane === 'bohle' ? 'Bohle' : 'Schere') + (op.on ? ' aktiviert' : ' deaktiviert');
    case 'setBahnen': return 'Bahnen gesetzt: ' + (op.bahnen || []).map((d, i) => 'Bahn ' + (i + 1) + ' ' + (d === 'bohle' ? 'Bohle' : 'Schere')).join(', ');
    case 'addPlayer': return 'Spieler hinzugefügt: ' + (op.player ? op.player.name : '') + (op.roster ? ' (neu im Stamm)' : '');
    case 'removePlayer': return 'Spieler entfernt: ' + (ctx.removedName || '');
    case 'setName': return 'Name geändert: ' + (ctx.oldName && ctx.oldName !== op.value ? ctx.oldName + ' → ' : '') + op.value;
    case 'counterDelta': return pNameById(op.id) + ': ' + labelKey(op.key) + ' ' + (op.delta >= 0 ? '+' : '') + op.delta;
    case 'setCounter': return pNameById(op.id) + ': ' + labelKey(op.key) + ' = ' + op.value;
    case 'setScore': return pNameById(op.id) + ': ' + op.key.toUpperCase() + ' = ' + (op.value == null ? '–' : op.value);
    case 'order': return 'Liste nach Platz sortiert';
    case 'reset': return 'Liste geleert';
    case 'newGame': return 'Neues Spiel begonnen';
    case 'addRoster': return 'Stamm: Spieler angelegt (' + op.person.name + ')';
    case 'renameRoster': return 'Stamm: ' + (ctx.name && ctx.name !== op.name ? ctx.name + ' ' : '') + 'umbenannt in ' + op.name;
    case 'setRosterActive': return 'Stamm: ' + rosterNameById(op.id) + ' ' + (op.active ? 'aktiviert' : ('deaktiviert' + (op.leftAt ? ' (Austritt ' + fmtD(op.leftAt) + ')' : '')));
    case 'setRosterDues': return 'Stamm: Beitragspflicht für ' + rosterNameById(op.id) + ' ' + (op.duesLiable ? 'aktiviert' : 'deaktiviert');
    case 'setRosterContact': return 'Verzeichnis: Kontaktdaten geändert (' + rosterNameById(op.id) + ')';
    case 'removeRoster': return 'Stamm: Spieler ' + (ctx.name || '') + ' gelöscht';
    case 'archiveChanged': {
      if (op.removed) return 'Archivspiel ' + gameLabel(ctx.gameDate, ctx.gameEvent) + ' gelöscht' + (ctx.oldPlace ? ' (Kegelort ' + ctx.oldPlace + ')' : '');
      const g = db.archive.find(x => x.id === op.id);
      if (!g) return 'Spiel gespeichert';
      if (op.placeSet) return 'Kegelort ' + (g.placeName || '') + ' für Archivspiel ' + gameLabel(g.date, g.event) + ' gesetzt' + was(ctx.oldPlace, g.placeName);
      return 'Spiel ' + gameLabel(g.date, g.event) + ' in ' + (g.placeName || '') + ' gespeichert (' + g.players.length + ' Spieler)';
    }
    case 'addPrize': return 'Preis angelegt: ' + (op.prize ? op.prize.title : '');
    case 'updatePrize': return 'Preis bearbeitet: ' + (op.prize ? op.prize.title : '') + was(ctx.name, op.prize && op.prize.title);
    case 'removePrize': return 'Preis gelöscht: ' + (ctx.name || '');
    case 'addTrip': return 'Ausflug angelegt: ' + (op.trip ? (op.trip.year + ' ' + (op.trip.place || '')).trim() : '');
    case 'updateTrip': { const n = op.trip ? (op.trip.year + ' ' + (op.trip.place || '')).trim() : ''; return 'Ausflug bearbeitet: ' + n + was(ctx.name, n); }
    case 'removeTrip': return 'Ausflug gelöscht: ' + (ctx.name || '');
    case 'addDevelop': return 'Chronik: Eintrag angelegt (' + (op.entry && op.entry.date ? fmtD(op.entry.date) : 'ohne Datum') + (op.entry && op.entry.description ? ' – ' + clip(op.entry.description, 60) : '') + ')';
    case 'updateDevelop': return 'Chronik: Eintrag bearbeitet (' + (op.entry && op.entry.date ? fmtD(op.entry.date) : 'ohne Datum') + (op.entry && op.entry.description ? ' – ' + clip(op.entry.description, 60) : '') + ')';
    case 'removeDevelop': return 'Chronik: Eintrag gelöscht (' + (ctx.name || '') + ')';
    case 'addEvent': return 'Termin angelegt: ' + (op.event ? evText(op.event) : '');
    case 'updateEvent': { const n = op.event ? evText(op.event) : ''; return 'Termin bearbeitet: ' + n + was(ctx.name, n); }
    case 'removeEvent': return 'Termin gelöscht: ' + (ctx.name || '');
    case 'addPoll': return 'Abstimmung erstellt: ' + (op.poll ? quoteDe(op.poll.question) : '');
    case 'votePoll': return 'Abgestimmt: ' + (op.poll ? quoteDe(op.poll.question) : '') + ' (' + (op.choice === 'yes' ? 'Ja' : 'Nein') + ')';
    case 'closePoll': return 'Abstimmung beendet: ' + (op.poll ? quoteDe(op.poll.question) : '');
    case 'removePoll': return 'Abstimmung gelöscht: ' + (ctx.name ? quoteDe(ctx.name) : '');
    default: return op.type;
  }
}
function pushLog(user, op, ctx) {
  if (op.type === 'counterDelta' && op.delta === 0) return null; // keine echte Änderung
  const e = { ts: Date.now(), user: user.username, person: personNameOf(user), text: describeOp(op, ctx) };
  db.log.push(e); if (db.log.length > LOG_MAX) db.log.splice(0, db.log.length - LOG_MAX); return e;
}
function verifyPw(user, pw) { const h = Buffer.from(hashPw(pw, user.salt), 'hex'), k = Buffer.from(user.hash, 'hex'); return h.length === k.length && crypto.timingSafeEqual(h, k); }
function sign(v) { return v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function unsign(s) {
  if (!s) return null; const i = s.lastIndexOf('.'); if (i < 0) return null;
  const val = s.slice(0, i), mac = s.slice(i + 1);
  const exp = crypto.createHmac('sha256', SECRET).update(val).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; return val;
}
function makeSession(uid) { return sign(Buffer.from(JSON.stringify({ uid, iat: Date.now() })).toString('base64url')); }
function sessionUser(req) {
  const v = unsign(parseCookies(req)['kkk_sess']); if (!v) return null;
  try { const o = JSON.parse(Buffer.from(v, 'base64url').toString()); if (Date.now() - o.iat > 30 * 864e5) return null; return db.users.find(u => u.id === o.uid) || null; } catch (_) { return null; }
}
function setSessionCookie(res, uid) { const p = ['kkk_sess=' + makeSession(uid), 'Path=' + (BASE || '/'), 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + (30 * 86400)]; if (COOKIE_SECURE) p.push('Secure'); res.setHeader('Set-Cookie', p.join('; ')); }
function clearSessionCookie(res) { const p = ['kkk_sess=', 'Path=' + (BASE || '/'), 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']; if (COOKIE_SECURE) p.push('Secure'); res.setHeader('Set-Cookie', p.join('; ')); }

const attempts = new Map();
function throttled(ip) { const a = attempts.get(ip); return !!(a && a.n >= 8 && Date.now() - a.t < 6e5); }
function badLogin(ip) { const a = attempts.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 6e5) { a.n = 0; a.t = Date.now(); } a.n++; attempts.set(ip, a); }

// ---------- HTTP-Hilfen ----------
function parseCookies(req) { const o = {}, h = req.headers.cookie; if (!h) return o; h.split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); }); return o; }
function send(res, code, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }, headers || {});
  res.writeHead(code, h); res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readJson(req, cb) { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 262144) { req.destroy(); return; } c.push(d); }); req.on('end', () => { try { cb(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (_) { cb(null); } }); req.on('error', () => cb(null)); }
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
function sameOrigin(req) { return req.headers['x-requested-with'] === 'fetch'; }

// ---------- SSE ----------
const clients = new Set();
function broadcast(msg) { const d = 'data: ' + JSON.stringify(msg) + '\n\n'; for (const c of clients) { try { c.res.write(d); } catch (_) {} } }
setInterval(() => { for (const c of clients) { try { c.res.write(': hb\n\n'); } catch (_) {} } }, 25000).unref();

// ---------- Auswertung eines Spiels (Live-Sheet oder Snapshot) ----------
function evalGame(g) {
  const bahnen = resolveBahnen(g);
  const rows = g.players.map((p, i) => {
    const ds = discScores(p, bahnen);
    const bohleArr = ds.bohle.map(v => v || 0), schereArr = ds.schere.map(v => v || 0);
    const scores = bohleArr.concat(schereArr);
    return { idx: i, rosterId: p.rosterId != null ? p.rosterId : null, name: p.name || '',
      c9: p.c9 || 0, cK: p.cK || 0, cP: p.cP || 0,
      // Rohwerte durchreichen (Archiv-Detail/Export): neues Bahn-Format und – falls vorhanden – Altformat
      l1a: p.l1a, l1b: p.l1b, l2a: p.l2a, l2b: p.l2b, b1: p.b1, b2: p.b2, s1: p.s1, s2: p.s2,
      total: sumVals(ds.bohle) + sumVals(ds.schere), bestRound: scores.length ? Math.max.apply(null, scores) : 0,
      roundBohle: bahnen.includes('bohle') ? Math.max.apply(null, [0].concat(bohleArr)) : null,
      roundSchere: bahnen.includes('schere') ? Math.max.apply(null, [0].concat(schereArr)) : null,
      silber: false, pumpen: false, kasse: 0 };
  });
  // Silberkegel = meiste Punkte
  let mx = 0; rows.forEach(r => { if (r.total > mx) mx = r.total; });
  if (mx > 0) rows.forEach(r => { if (r.total === mx) r.silber = true; });
  // Pumpenkegel = meiste Pumpen, Gleichstand -> wenigste Punkte
  let pmx = 0; rows.forEach(r => { if (r.cP > pmx) pmx = r.cP; });
  if (pmx > 0) {
    let pool = rows.filter(r => r.cP === pmx);
    if (pool.length > 1) { let mn = Infinity; pool.forEach(r => { if (r.total < mn) mn = r.total; }); pool = pool.filter(r => r.total === mn); }
    pool.forEach(r => { r.pumpen = true; });
  }
  // Kasse: 9/Kränze zahlen die anderen, Pumpe selbst
  const totalNK = rows.reduce((a, r) => a + r.c9 + r.cK, 0);
  rows.forEach(r => { r.kasse = (totalNK - (r.c9 + r.cK)) * g.priceNK + r.cP * g.pricePump; });
  const place = {}; let lp = 0, ltv = null;
  rows.slice().sort((a, b) => b.total - a.total).forEach((r, i) => { if (r.total === ltv) place[r.idx] = lp; else { place[r.idx] = i + 1; lp = i + 1; ltv = r.total; } });
  rows.forEach(r => { r.place = r.total > 0 ? place[r.idx] : null; });
  return {
    lanes: g.lanes, priceNK: g.priceNK, pricePump: g.pricePump, rows,
    silberNames: rows.filter(r => r.silber).map(r => r.name), silberMax: mx,
    pumpenNames: rows.filter(r => r.pumpen).map(r => r.name), pumpenMax: pmx,
    kasseTotal: rows.reduce((a, r) => a + r.kasse, 0)
  };
}
function archiveMeta(a) {
  const e = evalGame(a);
  return { id: a.id, event: a.event, date: a.date, savedAt: a.savedAt, savedBy: a.savedBy,
    placeId: a.placeId != null ? a.placeId : null, place: a.placeName || placeNameById(a.placeId) || '',
    players: a.players.length, silberNames: e.silberNames, pumpenNames: e.pumpenNames, kasseTotal: e.kasseTotal };
}

// ---------- Statistik über alle archivierten Spiele ----------
function groupKey(r) { return r.rosterId != null ? 'r' + r.rosterId : 'n:' + (r.name || '').trim().toLowerCase(); }
// Jahr eines Spiels: bevorzugt das Spiel-Datum (YYYY-MM-DD), sonst der Speicherzeitpunkt
function gameYear(g) { const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(g && g.date || '')); return m ? Number(m[1]) : new Date(g.savedAt).getFullYear(); }
// Zeitstempel eines Spiels: bevorzugt das eingetragene Spiel-Datum (12:00 lokal, vermeidet TZ-Kanten), sonst der Speicherzeitpunkt
function gameTime(g) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(g && g.date || '')); if (m) { const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime(); if (!isNaN(t)) return t; } return Number(g && g.savedAt) || 0; }
// Sortierung: neuestes Spiel-Datum zuerst, bei Gleichstand zuletzt gespeichertes zuerst
function byGameDesc(a, b) { return gameTime(b) - gameTime(a) || (b.savedAt || 0) - (a.savedAt || 0); }
// Liste aller Jahre mit archivierten Spielen (absteigend)
function archiveYears() { const s = new Set(); for (const g of db.archive) s.add(gameYear(g)); return Array.from(s).sort((a, b) => b - a); }
// Kegelorte für den Statistik-Filter: alle bekannten Orte (auch inaktive), die im Archiv
// vorkommen, plus – falls es Altbestand ohne Ort gibt – ein Sentinel für „Ohne Ort".
function archivePlaces() {
  const counts = new Map(); let noPlace = 0;
  for (const g of db.archive) { if (g.placeId != null) counts.set(Number(g.placeId), (counts.get(Number(g.placeId)) || 0) + 1); else noPlace++; }
  const list = [];
  for (const p of db.places) if (counts.has(p.id)) list.push({ id: p.id, name: p.name, active: p.active, games: counts.get(p.id) });
  // Orte, die es nicht mehr in db.places gibt, aber im Archiv referenziert sind (Name aus Snapshot)
  for (const [pid, n] of counts) if (!db.places.some(p => p.id === pid)) { const g = db.archive.find(x => Number(x.placeId) === pid); list.push({ id: pid, name: (g && g.placeName) || ('#' + pid), active: false, games: n }); }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { list, noPlace };
}
// year = null/undefined -> alle Spiele; sonst nur Spiele des angegebenen Jahres
// place = null/undefined -> alle Orte; Zahl -> nur dieser Ort; 'none' -> nur Spiele ohne Ort
function computeStats(year, place) {
  const agg = new Map();
  let kasse = 0, from = null, to = null, games = 0;
  for (const g of db.archive) {
    if (year != null && gameYear(g) !== year) continue;
    if (place === 'none') { if (g.placeId != null) continue; }
    else if (place != null && Number(g.placeId) !== Number(place)) continue;
    games++;
    const gt = gameTime(g);
    if (from == null || gt < from) from = gt;
    if (to == null || gt > to) to = gt;
    const ev = evalGame(g); kasse += ev.kasseTotal;
    for (const r of ev.rows) {
      const k = groupKey(r);
      let a = agg.get(k);
      if (!a) { a = { key: k, rosterId: r.rosterId, name: r.name, games: 0, points: 0, best: 0, bestRound: 0, bestBohle: null, bestSchere: null, c9: 0, cK: 0, cP: 0, silber: 0, pumpen: 0, kasse: 0, wins: 0, arrSum: 0, firsts: 0 }; agg.set(k, a); }
      a.games++; a.points += r.total; a.c9 += r.c9; a.cK += r.cK; a.cP += r.cP; a.kasse += r.kasse;
      a.arrSum += (r.idx + 1); if (r.idx === 0) a.firsts++;
      if (r.total > a.best) a.best = r.total;
      if (r.bestRound > a.bestRound) a.bestRound = r.bestRound;
      if (r.roundBohle != null) a.bestBohle = (a.bestBohle == null) ? r.roundBohle : Math.max(a.bestBohle, r.roundBohle);
      if (r.roundSchere != null) a.bestSchere = (a.bestSchere == null) ? r.roundSchere : Math.max(a.bestSchere, r.roundSchere);
      if (r.silber) a.silber++;
      if (r.pumpen) a.pumpen++;
      if (r.place === 1) a.wins++;
      const rp = r.rosterId != null ? db.roster.find(x => x.id === r.rosterId) : null;
      if (rp) a.name = rp.name;
    }
  }
  const players = Array.from(agg.values()).map(a => Object.assign(a, { avg: a.games ? a.points / a.games : 0, arrAvg: a.games ? a.arrSum / a.games : 0, pumpAvg: a.games ? a.cP / a.games : 0 }))
    .sort((x, y) => y.avg - x.avg || y.games - x.games);
  const ap = archivePlaces();
  return { summary: { games, from, to, kasse, year: year != null ? year : null, place: place != null ? place : null }, years: archiveYears(), places: ap.list, noPlaceGames: ap.noPlace, players };
}

// ---------- HTML-Export aller archivierten Spiele ----------
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function euroS(n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }

// ---------- Kasse / Kassenbuch ----------
function euroC(cent) { return euroS((cent || 0) / 100); }
function parseEuroToCent(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
function curMonth() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function monthList(startYM, endYM) { // inklusive, [] wenn start>end
  const out = []; if (!/^\d{4}-\d{2}$/.test(startYM) || !/^\d{4}-\d{2}$/.test(endYM) || startYM > endYM) return out;
  let [y, m] = startYM.split('-').map(Number); const [ey, em] = endYM.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
function rosterNameById(id) { const r = db.roster.find(x => x.id === id); return r ? r.name : ('#' + id); }
function addLedger(kind, rosterId, amount, note, by, date, meta) {
  const e = { id: ++db.seqLedger, ts: Date.now(), date: date || todayStr(), rosterId: rosterId != null ? rosterId : null, kind, amount, note: note || '', by: by || 'system' };
  if (meta) e.meta = meta;
  db.ledger.push(e); return e;
}
function personBalance(rosterId) { let s = 0; for (const e of db.ledger) if (e.rosterId === rosterId) s += e.amount; return s; }
function cashOnHand() { let c = 0; for (const e of db.ledger) { if (e.kind === 'openingCash') c += e.amount; else if (e.kind === 'payment') c += -e.amount; else if (e.kind === 'expense') c -= e.amount; } return c; }
// Nutzen aus Ausgaben je Person (Statistik): Ausgabe wird gleichmäßig auf ihre Begünstigten verteilt
function expenseBenefit() {
  const acc = {};
  for (const e of db.ledger) if (e.kind === 'expense' && e.meta && Array.isArray(e.meta.beneficiaries) && e.meta.beneficiaries.length) {
    const share = e.amount / e.meta.beneficiaries.length;
    for (const rid of e.meta.beneficiaries) acc[rid] = (acc[rid] || 0) + share;
  }
  return acc;
}
function openClaimsSum() { const bal = {}; for (const e of db.ledger) if (e.rosterId != null) bal[e.rosterId] = (bal[e.rosterId] || 0) + e.amount; let s = 0; for (const k in bal) if (bal[k] > 0) s += bal[k]; return s; }
// Automatischer Monatsbeitrag: bucht für aktive, beitragspflichtige Personen jeden noch offenen Monat
function runDues() {
  const cs = db.cashSettings; const now = curMonth();
  if (!cs.duesStartMonth) { cs.duesStartMonth = now; flushDb(); }
  let added = 0;
  for (const r of db.roster) {
    if (!r.active || r.duesLiable === false) continue;
    let end = now; if (r.leftAt) { const lm = r.leftAt.slice(0, 7); if (lm < end) end = lm; }
    for (const m of monthList(cs.duesStartMonth, end)) {
      if (db.ledger.some(e => e.kind === 'fee' && e.rosterId === r.id && e.meta && e.meta.month === m)) continue;
      addLedger('fee', r.id, cs.duesCent, 'Monatsbeitrag ' + m, 'system', m + '-01', { month: m }); added++;
    }
  }
  if (added > 0) flushDb();
  return added;
}
// Vorschläge für Abwesenheitsstrafen je Kegeltermin (Datum mit archiviertem Spiel)
function absenceSuggestions() {
  const byDate = {};
  for (const a of db.archive) { if (!a.date) continue; (byDate[a.date] = byDate[a.date] || new Set()); a.players.forEach(p => { if (p.rosterId != null) byDate[a.date].add(p.rosterId); }); }
  const liable = db.roster.filter(r => r.active && r.duesLiable !== false);
  const out = [];
  for (const d of Object.keys(byDate).sort().reverse().slice(0, 12)) {
    const present = byDate[d];
    const absent = liable.filter(r => !present.has(r.id) && !(r.leftAt && r.leftAt < d));
    const already = new Set(db.ledger.filter(e => e.kind === 'absence' && e.meta && e.meta.date === d).map(e => e.rosterId));
    const open = absent.filter(r => !already.has(r.id));
    if (open.length > 0) out.push({ date: d, open: open.map(r => ({ id: r.id, name: r.name })) });
  }
  return out;
}
function cashOverview(mayWrite) {
  if (mayWrite) runDues();
  const persons = db.roster.map(r => ({ rosterId: r.id, name: r.name, active: r.active, duesLiable: r.duesLiable !== false, balance: personBalance(r.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries = db.ledger.slice(-80).reverse().map(e => ({ id: e.id, ts: e.ts, date: e.date, kind: e.kind, amount: e.amount, note: e.note, by: e.by, rosterId: e.rosterId, name: e.rosterId != null ? rosterNameById(e.rosterId) : null, beneficiaries: (e.kind === 'expense' && e.meta && Array.isArray(e.meta.beneficiaries)) ? e.meta.beneficiaries.map(rosterNameById) : null, beneficiaryIds: (e.kind === 'expense' && e.meta && Array.isArray(e.meta.beneficiaries)) ? e.meta.beneficiaries.slice() : null }));
  const ben = expenseBenefit();
  const benefit = Object.keys(ben).map(rid => ({ rosterId: +rid, name: rosterNameById(+rid), total: Math.round(ben[rid]) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const expensesTotal = db.ledger.reduce((s, e) => s + (e.kind === 'expense' ? e.amount : 0), 0);
  return { settings: db.cashSettings, cashOnHand: cashOnHand(), openClaims: openClaimsSum(), expensesTotal, persons, entries, absence: absenceSuggestions(), benefit };
}
// GnuCash-Export: unkomprimiertes GnuCash-XML (Doppelte Buchführung), abhängigkeitsfrei
const GNC_NS = ['gnc','act','book','cd','cmdty','price','slot','split','sx','trn','ts','fs','bgt','recurrence','lot','addr','billterm','bt-days','bt-prox','cust','employee','entry','invoice','job','order','owner','taxtable','tte','vendor'];
function gncEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function buildGnuCash() {
  const guid = () => crypto.randomBytes(16).toString('hex');
  const z = n => String(n).padStart(2, '0');
  const dPost = ds => (/^\d{4}-\d{2}-\d{2}$/.test(ds) ? ds : todayStr()) + ' 00:00:00 +0000';
  const dEnt = ms => { const d = new Date(ms || Date.now()); return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()) + ' ' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()) + ' +0000'; };
  const A = {};
  A.root = { guid: guid(), name: 'Root Account', type: 'ROOT', parent: null };
  A.assets = { guid: guid(), name: 'Aktiva', type: 'ASSET', parent: A.root.guid };
  A.cash = { guid: guid(), name: 'Kasse (Bargeld)', type: 'CASH', parent: A.assets.guid };
  A.recv = { guid: guid(), name: 'Forderungen an Mitglieder', type: 'ASSET', parent: A.assets.guid };
  A.income = { guid: guid(), name: 'Erträge', type: 'INCOME', parent: A.root.guid };
  A.fee = { guid: guid(), name: 'Mitgliedsbeiträge', type: 'INCOME', parent: A.income.guid };
  A.absence = { guid: guid(), name: 'Abwesenheitsstrafen', type: 'INCOME', parent: A.income.guid };
  A.game = { guid: guid(), name: 'Spielabrechnung', type: 'INCOME', parent: A.income.guid };
  A.adjust = { guid: guid(), name: 'Korrekturen', type: 'INCOME', parent: A.income.guid };
  A.equity = { guid: guid(), name: 'Eigenkapital', type: 'EQUITY', parent: A.root.guid };
  A.opening = { guid: guid(), name: 'Anfangsbestände', type: 'EQUITY', parent: A.equity.guid };
  A.expense = { guid: guid(), name: 'Ausgaben', type: 'EXPENSE', parent: A.root.guid };
  const accts = [A.root, A.assets, A.cash, A.recv, A.income, A.fee, A.absence, A.game, A.adjust, A.equity, A.opening, A.expense];
  const pers = {};
  for (const e of db.ledger) if (e.rosterId != null && !(e.rosterId in pers)) { pers[e.rosterId] = { guid: guid(), name: rosterNameById(e.rosterId), type: 'ASSET', parent: A.recv.guid }; accts.push(pers[e.rosterId]); }
  const KLBL = { fee: 'Monatsbeitrag', absence: 'Abwesenheit', game: 'Spielabrechnung', payment: 'Zahlung', opening: 'Anfangsbestand', openingCash: 'Anfangsbestand Kasse', adjust: 'Korrektur', expense: 'Ausgabe' };
  function splits(e) {
    const P = (e.rosterId != null && pers[e.rosterId]) ? pers[e.rosterId].guid : null;
    let r;
    switch (e.kind) {
      case 'fee': r = [[P, e.amount], [A.fee.guid, -e.amount]]; break;
      case 'absence': r = [[P, e.amount], [A.absence.guid, -e.amount]]; break;
      case 'game': r = [[P, e.amount], [A.game.guid, -e.amount]]; break;
      case 'adjust': r = [[P, e.amount], [A.adjust.guid, -e.amount]]; break;
      case 'opening': r = [[P, e.amount], [A.opening.guid, -e.amount]]; break;
      case 'openingCash': r = [[A.cash.guid, e.amount], [A.opening.guid, -e.amount]]; break;
      case 'payment': r = [[A.cash.guid, -e.amount], [P, e.amount]]; break;
      case 'expense': r = [[A.expense.guid, e.amount], [A.cash.guid, -e.amount]]; break;
      default: return null;
    }
    return r.some(s => !s[0]) ? null : r;
  }
  const txns = db.ledger.filter(e => splits(e));
  let x = '<?xml version="1.0" encoding="utf-8"?>\n<gnc-v2\n';
  x += GNC_NS.map(n => '     xmlns:' + n + '="http://www.gnucash.org/XML/' + n + '"').join('\n') + '>\n';
  x += '<gnc:count-data cd:type="book">1</gnc:count-data>\n<gnc:book version="2.0.0">\n';
  x += '<book:id type="guid">' + guid() + '</book:id>\n';
  x += '<gnc:count-data cd:type="commodity">1</gnc:count-data>\n';
  x += '<gnc:count-data cd:type="account">' + accts.length + '</gnc:count-data>\n';
  x += '<gnc:count-data cd:type="transaction">' + txns.length + '</gnc:count-data>\n';
  x += '<gnc:commodity version="2.0.0">\n<cmdty:space>CURRENCY</cmdty:space>\n<cmdty:id>EUR</cmdty:id>\n<cmdty:get_quotes/>\n<cmdty:quote_source>currency</cmdty:quote_source>\n<cmdty:quote_tz/>\n</gnc:commodity>\n';
  for (const a of accts) {
    x += '<gnc:account version="2.0.0">\n<act:name>' + gncEsc(a.name) + '</act:name>\n<act:id type="guid">' + a.guid + '</act:id>\n<act:type>' + a.type + '</act:type>\n';
    if (a.type !== 'ROOT') x += '<act:commodity>\n<cmdty:space>CURRENCY</cmdty:space>\n<cmdty:id>EUR</cmdty:id>\n</act:commodity>\n<act:commodity-scu>100</act:commodity-scu>\n';
    if (a.parent) x += '<act:parent type="guid">' + a.parent + '</act:parent>\n';
    x += '</gnc:account>\n';
  }
  for (const e of txns) {
    const sp = splits(e);
    x += '<gnc:transaction version="2.0.0">\n<trn:id type="guid">' + guid() + '</trn:id>\n';
    x += '<trn:currency>\n<cmdty:space>CURRENCY</cmdty:space>\n<cmdty:id>EUR</cmdty:id>\n</trn:currency>\n';
    x += '<trn:date-posted><ts:date>' + dPost(e.date) + '</ts:date></trn:date-posted>\n';
    x += '<trn:date-entered><ts:date>' + dEnt(e.ts) + '</ts:date></trn:date-entered>\n';
    let desc = e.note || KLBL[e.kind] || e.kind;
    if (e.kind === 'expense' && e.meta && Array.isArray(e.meta.beneficiaries) && e.meta.beneficiaries.length) desc += ' (Begünstigte: ' + e.meta.beneficiaries.map(rosterNameById).join(', ') + ')';
    x += '<trn:description>' + gncEsc(desc) + '</trn:description>\n<trn:splits>\n';
    for (const s of sp) x += '<trn:split>\n<split:id type="guid">' + guid() + '</split:id>\n<split:reconciled-state>n</split:reconciled-state>\n<split:value>' + s[1] + '/100</split:value>\n<split:quantity>' + s[1] + '/100</split:quantity>\n<split:account type="guid">' + s[0] + '</split:account>\n</trn:split>\n';
    x += '</trn:splits>\n</gnc:transaction>\n';
  }
  x += '</gnc:book>\n</gnc-v2>\n';
  return x;
}
function fmtD(s) { if (!s) return 'ohne Datum'; const p = String(s).split('-'); return p.length === 3 ? (p[2] + '.' + p[1] + '.' + p[0]) : String(s); }
function fmtDT(ts) { const d = new Date(ts); const z = n => String(n).padStart(2, '0'); return z(d.getDate()) + '.' + z(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
// Datenbank-Export als JSON. full=false: bereinigt (ohne Zugangsdaten), für jede angemeldete Rolle.
// full=true: vollständige Sicherung inkl. Passwort-Hashes/Salts und Einladungs-Tokens – nur für Admins.
function buildDbExport(full, byUser) {
  const snap = JSON.parse(JSON.stringify(db)); // tiefe Kopie, Original bleibt unangetastet
  if (!full) {
    // Zugangsdaten entfernen: Passwort-Hash/Salt je Konto, komplette Einladungsliste (Einmal-Login-Tokens)
    snap.users = (snap.users || []).map(u => ({
      id: u.id, username: u.username, role: u.role, createdAt: u.createdAt,
      rosterId: (u.rosterId != null ? u.rosterId : null),
      mustChangePassword: !!u.mustChangePassword
    }));
    delete snap.invites;
    delete snap.magic; // Matrix-Login-Tokens
  }
  snap._export = { at: Date.now(), by: (byUser && byUser.username) || null, full: !!full, version: db.version };
  return JSON.stringify(snap, null, 2);
}

function buildExportHtml() {
  const st = computeStats();
  const span = (st.summary.from && st.summary.to) ? (fmtDT(st.summary.from).slice(0, 10) + ' – ' + fmtDT(st.summary.to).slice(0, 10)) : '';
  const now = fmtDT(Date.now());
  const games = db.archive.slice().sort((a, b) => byGameDesc(b, a));
  let h = '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  h += '<title>KKk58 – Archiv-Export</title><style>';
  h += 'body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#14202b;max-width:1000px;margin:0 auto;padding:24px 16px;line-height:1.4}';
  h += 'h1{color:#164f40;margin:0 0 2px} h2{color:#164f40;border-bottom:2px solid #1d6b57;padding-bottom:4px;margin:28px 0 10px} h3{margin:0 0 2px}';
  h += '.meta{color:#64727e;margin:0 0 6px} .sub{color:#64727e;font-size:.9em;margin:0 0 8px}';
  h += 'table{border-collapse:collapse;width:100%;margin:6px 0 4px;font-size:.92em} th,td{border:1px solid #dbe1e7;padding:4px 7px;text-align:center} ';
  h += 'th{background:#eef2f5;font-size:.8em;text-transform:uppercase;letter-spacing:.02em;color:#4a5560} td.l,th.l{text-align:left} td.n{text-align:right;font-variant-numeric:tabular-nums} ';
  h += 'tbody tr:nth-child(even){background:#f5f7f9} .game{margin:0 0 26px;page-break-inside:avoid} .kasse{font-weight:700;text-align:right;margin:2px 0} .note{color:#64727e;font-size:.9em;white-space:pre-wrap} ';
  h += '.sil{color:#5a6570;font-weight:700} .pmp{color:#7a541c;font-weight:700} .foot{color:#94a0aa;font-size:.8em;margin-top:30px;border-top:1px solid #dbe1e7;padding-top:8px}';
  h += '@media print{.game{page-break-inside:avoid}}</style></head><body>';
  h += '<h1>KKk58 – Vereinsarchiv</h1>';
  h += '<p class="meta">Export vom ' + escHtml(now) + ' · ' + st.summary.games + ' Spiel' + (st.summary.games === 1 ? '' : 'e') + (span ? (' · Zeitraum ' + escHtml(span)) : '') + ' · Gesamtkasse ' + escHtml(euroS(st.summary.kasse)) + '</p>';

  const statsTable = s => {
    let t = '<table><thead><tr><th class="l">Spieler</th><th>Sp.</th><th>Ø Pkt</th><th>Best</th><th>Beste Bo</th><th>Beste Sc</th><th>9</th><th>⑧</th><th>Pump</th><th>Ø Pump</th><th>Ⓢ</th><th>Ⓟ</th><th>Siege</th><th>Ø Ank.</th><th>1. da</th><th>Kasse</th></tr></thead><tbody>';
    s.players.forEach(p => {
      t += '<tr><td class="l">' + escHtml(p.name || '(ohne Namen)') + '</td><td>' + p.games + '</td><td>' + p.avg.toFixed(1).replace('.', ',') + '</td><td>' + p.best + '</td><td>' + (p.bestBohle == null ? '–' : p.bestBohle) + '</td><td>' + (p.bestSchere == null ? '–' : p.bestSchere) + '</td><td>' + p.c9 + '</td><td>' + p.cK + '</td><td>' + p.cP + '</td><td>' + (p.pumpAvg || 0).toFixed(1).replace('.', ',') + '</td><td>' + p.silber + '</td><td>' + p.pumpen + '</td><td>' + p.wins + '</td><td>' + (p.arrAvg ? p.arrAvg.toFixed(1).replace('.', ',') : '–') + '</td><td>' + (p.firsts || 0) + '</td><td class="n">' + escHtml(euroS(p.kasse)) + '</td></tr>';
    });
    return t + '</tbody></table>';
  };
  if (st.players.length) {
    h += '<h2>Gesamtstatistik (All-Time)</h2>' + statsTable(st);
    // Jahresstatistik zusätzlich, wenn Spiele aus mehr als einem Jahr vorliegen
    const years = st.years || [];
    if (years.length > 1) years.forEach(y => { const sy = computeStats(y); if (sy.players.length) h += '<h2>Jahresstatistik ' + y + ' (' + sy.summary.games + ' Spiel' + (sy.summary.games === 1 ? '' : 'e') + ')</h2>' + statsTable(sy); });
  }

  h += '<h2>Spiele (' + games.length + ')</h2>';
  if (!games.length) h += '<p class="sub">Keine gespeicherten Spiele.</p>';
  games.forEach(g => {
    const ev = evalGame(g);
    const gpn = g.placeName || placeNameById(g.placeId) || '';
    h += '<div class="game"><h3>' + (escHtml(g.event) || 'Spiel') + ' – ' + escHtml(fmtD(g.date)) + (gpn ? (' · ' + escHtml(gpn)) : '') + '</h3>';
    h += '<p class="sub">gespeichert von ' + escHtml(g.savedBy || '') + ' am ' + escHtml(fmtDT(g.savedAt)) +
      (ev.silberNames.length ? (' · <span class="sil">Ⓢ ' + ev.silberNames.map(escHtml).join(', ') + '</span>') : '') +
      (ev.pumpenNames.length ? (' · <span class="pmp">Ⓟ ' + ev.pumpenNames.map(escHtml).join(', ') + '</span>') : '') + '</p>';
    const DISC_X = { bohle: { short: 'Bo', long: 'Bohle' }, schere: { short: 'Sc', long: 'Schere' } };
    const abn = resolveBahnen(g);
    h += '<table><thead><tr><th>Pl.</th><th>Ank.</th><th class="l">Name</th><th>9</th><th>⑧</th><th>Pump</th>';
    abn.forEach((d, i) => { const m = DISC_X[d]; h += '<th title="Bahn ' + (i + 1) + ' – ' + m.long + '">B' + (i + 1) + ' ' + m.short + '1</th><th>' + m.short + '2</th><th>Σ' + m.short + '</th>'; });
    h += '<th>Σ</th><th>Ⓢ</th><th>Ⓟ</th><th>Kasse</th></tr></thead><tbody>';
    ev.rows.slice().sort((a, b) => b.total - a.total).forEach(r => {
      h += '<tr><td>' + (r.place || '–') + '</td><td>' + (r.idx + 1) + '</td><td class="l">' + escHtml(r.name || '(ohne Namen)') + '</td><td>' + r.c9 + '</td><td>' + r.cK + '</td><td>' + r.cP + '</td>';
      abn.forEach((d, i) => { const lv = rowLane(r, i, d); const v1 = lv[0], v2 = lv[1]; h += '<td>' + (v1 == null ? '' : v1) + '</td><td>' + (v2 == null ? '' : v2) + '</td><td>' + ((v1 || 0) + (v2 || 0)) + '</td>'; });
      h += '<td><b>' + r.total + '</b></td><td>' + (r.silber ? 'Ⓢ' : '') + '</td><td>' + (r.pumpen ? 'Ⓟ' : '') + '</td><td class="n">' + escHtml(euroS(r.kasse)) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<p class="kasse">Kasse gesamt: ' + escHtml(euroS(ev.kasseTotal)) + '</p>';
    if (g.pumpen) h += '<p class="note"><b>Pumpenkegel:</b> ' + escHtml(g.pumpen) + '</p>';
    if (g.note) h += '<p class="note"><b>Bemerkungen:</b> ' + escHtml(g.note) + '</p>';
    h += '</div>';
  });
  h += '<p class="foot">KKk58 Vereinsdatenbank · automatisch erzeugter Export</p></body></html>';
  return h;
}

// ---------- Operationen (mit Live-Broadcast) ----------
function findP(id) { return db.sheet.players.find(p => p.id === id); }
function throwCount(p, bahnen) { let n = 0; const ds = discScores(p, bahnen); ds.bohle.concat(ds.schere).forEach(v => { if (v != null) n++; }); return n; }
function throwsUnequal(s) { if (!s.players || s.players.length < 2) return false; const bn = resolveBahnen(s); return new Set(s.players.map(p => throwCount(p, bn))).size > 1; }
function applyOp(op, user) {
  const s = db.sheet;
  switch (op && op.type) {
    case 'setMeta': if (!['event', 'date'].includes(op.field)) return null; s[op.field] = String(op.value || '').slice(0, 120); return { type: 'setMeta', field: op.field, value: s[op.field] };
    case 'setPlace': { if (op.value == null || op.value === '') { s.placeId = null; return { type: 'setPlace', value: null }; } const pl = placeById(op.value); if (!pl) return null; s.placeId = pl.id; return { type: 'setPlace', value: pl.id }; }
    case 'setNote': if (!['pumpen', 'note'].includes(op.field)) return null; s[op.field] = String(op.value || '').slice(0, 4000); return { type: 'setNote', field: op.field, value: s[op.field] };
    case 'setPrice': { if (!['priceNK', 'pricePump'].includes(op.field)) return null; let v = Number(op.value); if (!isFinite(v) || v < 0) v = 0; s[op.field] = v; return { type: 'setPrice', field: op.field, value: v }; }
    case 'setLane': { if (!['bohle', 'schere'].includes(op.lane)) return null; const nx = Object.assign({}, s.lanes); nx[op.lane] = !!op.on; if (!nx.bohle && !nx.schere) return null; s.lanes = nx;
      // bahnen synchron halten: bestehende Reihenfolge behalten, neu aktivierte Disziplin hinten anfügen
      let bn = (s.bahnen || []).filter(d => nx[d]); DISCIPLINES.forEach(d => { if (nx[d] && !bn.includes(d)) bn.push(d); }); s.bahnen = bn;
      return { type: 'setLane', lane: op.lane, on: !!op.on }; }
    case 'setBahnen': {
      let arr = Array.isArray(op.bahnen) ? op.bahnen.filter(d => DISCIPLINES.includes(d)) : [];
      arr = arr.slice(0, 2); // 1-2 Bahnen; Duplikate erlaubt (zwei gleiche Disziplinen möglich)
      if (arr.length === 0) return null;
      s.bahnen = arr; s.lanes = lanesFromBahnen(arr);
      return { type: 'setBahnen', bahnen: arr, lanes: s.lanes };
    }
    case 'addPlayer': {
      let person = null, newPerson = null;
      if (op.rosterId != null) {
        person = db.roster.find(r => r.id === Number(op.rosterId));
        if (!person) return null; // rosterId nicht im Stamm
      } else {
        const nm = String(op.name || '').trim();
        if (!nm) return null;
        person = db.roster.find(r => r.name.toLowerCase() === nm.toLowerCase());
        if (!person) {
          if (!op.createRoster) return null; // nicht im Stamm und kein Anlege-Auftrag
          person = Object.assign({ id: ++db.seqRoster, name: nm.slice(0, 60), active: true, duesLiable: true }, emptyContact()); db.roster.push(person); newPerson = person;
        }
      }
      const p = { id: ++s.seq, rosterId: person.id, name: person.name, c9: 0, cK: 0, cP: 0, l1a: null, l1b: null, l2a: null, l2b: null };
      s.players.push(p);
      return { type: 'addPlayer', player: p, roster: newPerson };
    }
    case 'removePlayer': { const b = s.players.length; s.players = s.players.filter(p => p.id !== op.id); if (s.players.length === b) return null; return { type: 'removePlayer', id: op.id }; }
    case 'setName': { const p = findP(op.id); if (!p) return null; p.name = String(op.value || '').slice(0, 60); return { type: 'setName', id: op.id, value: p.name }; }
    case 'counterDelta': { if (!['c9', 'cK', 'cP'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; const old = p[op.key] || 0; p[op.key] = Math.max(0, Math.min(99999, old + (Math.sign(op.delta) || 0))); return { type: 'counterDelta', id: op.id, key: op.key, delta: p[op.key] - old }; }
    case 'setCounter': { if (!['c9', 'cK', 'cP'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; p[op.key] = cint(op.value, 0, 99999, 0); return { type: 'setCounter', id: op.id, key: op.key, value: p[op.key] }; }
    case 'setScore': { if (!['l1a', 'l1b', 'l2a', 'l2b'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; p[op.key] = nscore(op.value); return { type: 'setScore', id: op.id, key: op.key, value: p[op.key] }; }
    case 'sortByPlace': return null; // Sortierung ist reine Anzeige (clientseitig); Ankunftsreihenfolge bleibt erhalten
    case 'reset': { if (!canManage(user.role)) return null; s.players = []; s.seq = 0; return { type: 'reset' }; }
    case 'newGame': { s.players = []; s.seq = 0; s.event = ''; s.pumpen = ''; s.note = ''; return { type: 'newGame' }; }
    // ----- Spielerstamm -----
    case 'addRoster': { const nm = String(op.name || '').trim(); if (!nm) return null; if (db.roster.some(r => r.name.toLowerCase() === nm.toLowerCase())) return null; const person = Object.assign({ id: ++db.seqRoster, name: nm.slice(0, 60), active: true, leftAt: null, duesLiable: true }, emptyContact()); db.roster.push(person); return { type: 'addRoster', person }; }
    case 'renameRoster': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; const nm = String(op.name || '').trim(); if (nm) r.name = nm.slice(0, 60); return { type: 'renameRoster', id: r.id, name: r.name }; }
    case 'setRosterActive': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; r.active = !!op.active; if (r.active) r.leftAt = null; else r.leftAt = (op.leftAt && /^\d{4}-\d{2}-\d{2}$/.test(op.leftAt) && !isNaN(Date.parse(op.leftAt))) ? op.leftAt : null; return { type: 'setRosterActive', id: r.id, active: r.active, leftAt: r.leftAt }; }
    case 'setRosterDues': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; r.duesLiable = !!op.duesLiable; return { type: 'setRosterDues', id: r.id, duesLiable: r.duesLiable }; }
    case 'setRosterContact': {
      if (!canManage(user.role)) return null;
      const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null;
      const patch = normContact(op.fields || {});
      const fields = {};
      const prevMxid = String(r.mxid || '');
      // nur die tatsächlich übergebenen Felder ändern
      for (const k of CONTACT_KEYS) { if (op.fields && Object.prototype.hasOwnProperty.call(op.fields, k)) { r[k] = patch[k]; fields[k] = patch[k]; } }
      if (Object.keys(fields).length === 0) return null;
      // Neu eingetragene oder geänderte MXID im Verzeichnis => automatische Einladung
      // in den Vereinsraum (nur bei gültiger, tatsächlich veränderter, nicht-leerer MXID;
      // ein Leeren des Feldes oder eine unveränderte MXID lösen keine Einladung aus).
      if (Object.prototype.hasOwnProperty.call(fields, 'mxid')) {
        const mx = validMxid(fields.mxid);
        if (mx && mx.toLowerCase() !== prevMxid.toLowerCase()) enqueueMatrixInvite(clubRoom(), mx);
      }
      return { type: 'setRosterContact', id: r.id, fields };
    }
    case 'removeRoster': { if (!canManage(user.role)) return null; const b = db.roster.length; db.roster = db.roster.filter(x => x.id !== Number(op.id)); if (db.roster.length === b) return null; db.users.forEach(u => { if (u.rosterId === Number(op.id)) u.rosterId = null; }); return { type: 'removeRoster', id: Number(op.id) }; }
    // ----- Archiv -----
    case 'saveGame': {
      if (s.players.length === 0) return null;
      // Harter Block: ohne gültigen Kegelort wird nicht archiviert
      const gp = placeById(s.placeId); if (!gp) return null;
      const snap = { id: ++db.seqArchive, savedAt: Date.now(), savedBy: user.username,
        event: s.event, date: s.date, placeId: gp.id, placeName: gp.name, bahnen: (s.bahnen || []).slice(), lanes: { bohle: s.lanes.bohle, schere: s.lanes.schere },
        priceNK: s.priceNK, pricePump: s.pricePump, pumpen: s.pumpen, note: s.note,
        players: s.players.map(p => ({ rosterId: p.rosterId != null ? p.rosterId : null, name: p.name, c9: p.c9 || 0, cK: p.cK || 0, cP: p.cP || 0, l1a: p.l1a, l1b: p.l1b, l2a: p.l2a, l2b: p.l2b })) };
      db.archive.push(snap);
      // Konstellation für Vorschläge merken: je Kegelort und global (zuletzt gespielt)
      gp.lastBahnen = (s.bahnen || []).slice();
      db.lastBahnen = (s.bahnen || []).slice();
      // Spielabrechnung automatisch dem Kassenkonto der Personen belasten
      const ev = evalGame(snap);
      ev.rows.forEach(r => { if (r.rosterId != null && r.kasse > 0) addLedger('game', r.rosterId, Math.round(r.kasse * 100), 'Spielabrechnung ' + (snap.date || todayStr()) + (snap.event ? ' · ' + snap.event : ''), user.username, snap.date || todayStr(), { archiveId: snap.id }); });
      return { type: 'archiveChanged', id: snap.id };
    }
    case 'setGamePlace': {
      // Kegelort eines archivierten Spiels nachträglich setzen/ändern (nur Verwaltungsrecht)
      if (!canManage(user.role)) return null;
      const g = db.archive.find(x => x.id === Number(op.id)); if (!g) return null;
      // Einen bereits vorhandenen Ort darf nur ein Admin ändern
      if (g.placeId != null && user.role !== 'admin') return null;
      const pl = placeById(op.placeId); if (!pl) return null;
      g.placeId = pl.id; g.placeName = pl.name;
      return { type: 'archiveChanged', id: g.id, placeSet: true };
    }
    case 'deleteGame': { if (!canManage(user.role)) return null; const b = db.archive.length; db.archive = db.archive.filter(a => a.id !== Number(op.id)); if (db.archive.length === b) return null; db.ledger = db.ledger.filter(e => !(e.kind === 'game' && e.meta && e.meta.archiveId === Number(op.id))); return { type: 'archiveChanged', id: Number(op.id), removed: true }; }
    // ----- Preise (Anlegen/Bearbeiten/Löschen nur mit Verwaltungsrecht) -----
    case 'addPrize': {
      if (!canManage(user.role)) return null;
      const p = normPrize(op.prize || {}); if (!p.title) return null;
      p.id = ++db.seqPrizes; db.prizes.push(p);
      return { type: 'addPrize', prize: p };
    }
    case 'updatePrize': {
      if (!canManage(user.role)) return null;
      const cur = db.prizes.find(x => x.id === Number(op.id)); if (!cur) return null;
      const p = normPrize(Object.assign({}, op.prize, { id: cur.id })); if (!p.title) return null;
      cur.title = p.title; cur.intro = p.intro; cur.rules = p.rules; cur.evaluation = p.evaluation;
      return { type: 'updatePrize', id: cur.id, prize: cur };
    }
    case 'removePrize': {
      if (!canManage(user.role)) return null;
      const b = db.prizes.length; db.prizes = db.prizes.filter(x => x.id !== Number(op.id));
      if (db.prizes.length === b) return null;
      return { type: 'removePrize', id: Number(op.id) };
    }
    // ----- Kegelausflüge (Anlegen/Bearbeiten/Löschen nur mit Verwaltungsrecht) -----
    // ----- Kegelorte: Anlegen jeder Rolle erlaubt; Umbenennen/Deaktivieren/Löschen nur mit Verwaltungsrecht -----
    case 'addPlace': {
      const nm = String(op.name || '').trim(); if (!nm) return null;
      if (db.places.some(p => p.name.toLowerCase() === nm.toLowerCase())) return null;
      const place = { id: ++db.seqPlaces, name: nm.slice(0, PLACE_NAME_MAX), active: true, address: normPlaceAddress(op.address), lastBahnen: null };
      db.places.push(place);
      return { type: 'addPlace', place };
    }
    case 'renamePlace': {
      if (!canManage(user.role)) return null;
      const p = placeById(op.id); if (!p) return null;
      const nm = String(op.name || '').trim(); if (!nm) return null;
      if (db.places.some(x => x.id !== p.id && x.name.toLowerCase() === nm.toLowerCase())) return null;
      p.name = nm.slice(0, PLACE_NAME_MAX);
      return { type: 'renamePlace', id: p.id, name: p.name };
    }
    case 'setPlaceAddress': {
      if (!canManage(user.role)) return null;
      const p = placeById(op.id); if (!p) return null;
      p.address = normPlaceAddress(op.address);
      return { type: 'setPlaceAddress', id: p.id, address: p.address };
    }
    case 'setPlaceActive': {
      if (!canManage(user.role)) return null;
      const p = placeById(op.id); if (!p) return null;
      p.active = !!op.active;
      if (!p.active && s.placeId === p.id) s.placeId = null;
      return { type: 'setPlaceActive', id: p.id, active: p.active };
    }
    case 'removePlace': {
      if (!canManage(user.role)) return null;
      const b = db.places.length; db.places = db.places.filter(x => x.id !== Number(op.id));
      if (db.places.length === b) return null;
      if (s.placeId === Number(op.id)) s.placeId = null;
      return { type: 'removePlace', id: Number(op.id) };
    }
    case 'addTrip': {
      if (!canManage(user.role)) return null;
      const t = normTrip(op.trip || {}); if (t.year == null) return null;
      t.id = ++db.seqTrips; db.trips.push(t);
      return { type: 'addTrip', trip: t };
    }
    case 'updateTrip': {
      if (!canManage(user.role)) return null;
      const cur = db.trips.find(x => x.id === Number(op.id)); if (!cur) return null;
      const t = normTrip(Object.assign({}, op.trip, { id: cur.id })); if (t.year == null) return null;
      cur.year = t.year; cur.place = t.place; cur.description = t.description; cur.period = t.period;
      return { type: 'updateTrip', id: cur.id, trip: cur };
    }
    case 'removeTrip': {
      if (!canManage(user.role)) return null;
      const b = db.trips.length; db.trips = db.trips.filter(x => x.id !== Number(op.id));
      if (db.trips.length === b) return null;
      return { type: 'removeTrip', id: Number(op.id) };
    }
    // ----- Mitgliederentwicklung / Chronik (Anlegen/Bearbeiten/Löschen nur mit Verwaltungsrecht) -----
    case 'addDevelop': {
      if (!canManage(user.role)) return null;
      const e = normDevelop(op.entry || {}); if (!e.description && !e.date) return null;
      e.id = ++db.seqDevelop; db.develop.push(e);
      return { type: 'addDevelop', entry: e };
    }
    case 'updateDevelop': {
      if (!canManage(user.role)) return null;
      const cur = db.develop.find(x => x.id === Number(op.id)); if (!cur) return null;
      const e = normDevelop(Object.assign({}, op.entry, { id: cur.id })); if (!e.description && !e.date) return null;
      cur.date = e.date; cur.description = e.description; cur.count = e.count;
      return { type: 'updateDevelop', id: cur.id, entry: cur };
    }
    case 'removeDevelop': {
      if (!canManage(user.role)) return null;
      const b = db.develop.length; db.develop = db.develop.filter(x => x.id !== Number(op.id));
      if (db.develop.length === b) return null;
      return { type: 'removeDevelop', id: Number(op.id) };
    }
    // ----- Termine / Kalender (Anlegen/Bearbeiten/Löschen nur mit Verwaltungsrecht;
    // „beschränkt" hat ausschließlich lesenden Zugriff) -----
    case 'addEvent': {
      if (!canManage(user.role)) return null;
      const e = normEvent(op.event || {}); if (!e.date || !e.text) return null;
      resolveEventPlace(e);
      e.id = ++db.seqEvents; db.events.push(e);
      return { type: 'addEvent', event: e };
    }
    case 'updateEvent': {
      if (!canManage(user.role)) return null;
      const cur = db.events.find(x => x.id === Number(op.id)); if (!cur) return null;
      const e = normEvent(Object.assign({}, op.event, { id: cur.id })); if (!e.date || !e.text) return null;
      resolveEventPlace(e);
      cur.date = e.date; cur.text = e.text; cur.place = e.place; cur.placeId = e.placeId; cur.placeName = e.placeName; cur.startTime = e.startTime; cur.endTime = e.endTime; cur.repeat = e.repeat; cur.until = e.until;
      return { type: 'updateEvent', id: cur.id, event: cur };
    }
    case 'removeEvent': {
      if (!canManage(user.role)) return null;
      const b = db.events.length; db.events = db.events.filter(x => x.id !== Number(op.id));
      if (db.events.length === b) return null;
      return { type: 'removeEvent', id: Number(op.id) };
    }
    // ----- Abstimmungen -----
    // Erstellen und Abstimmen darf jedes angemeldete Konto; frühzeitig beenden/löschen
    // nur der Ersteller oder ein Konto mit Verwaltungsrecht.
    case 'addPoll': {
      const q = String(op.question || '').trim().slice(0, POLL_Q_MAX); if (!q) return null;
      let closesAt = null;
      if (op.closesAt != null && Number.isFinite(Number(op.closesAt))) closesAt = Number(op.closesAt);
      else if (op.endDate) closesAt = pollClosesFromDate(op.endDate);
      else if (op.days != null) { const d = cint(op.days, 1, 3650, 0); if (d > 0) { const dt = new Date(); dt.setHours(23, 59, 59, 999); closesAt = dt.getTime() + (d - 1) * 864e5; } }
      if (!closesAt || closesAt <= Date.now()) return null;
      const p = { id: ++db.seqPolls, question: q, createdBy: user.username, createdByPerson: personNameOf(user), createdAt: Date.now(), closesAt, votes: {}, lastReminderAt: 0 };
      db.polls.push(p);
      announcePoll(p);
      return { type: 'addPoll', poll: pollView(p) };
    }
    case 'votePoll': {
      const p = db.polls.find(x => x.id === Number(op.id)); if (!p) return null;
      if (pollIsClosed(p)) return null;
      const c = normPollChoice(op.choice); if (!c) return null;
      p.votes[String(user.id)] = c;
      return { type: 'votePoll', poll: pollView(p), choice: c };
    }
    case 'closePoll': {
      const p = db.polls.find(x => x.id === Number(op.id)); if (!p) return null;
      if (!(user.username === p.createdBy || canManage(user.role))) return null;
      if (!pollIsClosed(p)) p.closesAt = Date.now();
      return { type: 'closePoll', poll: pollView(p) };
    }
    case 'removePoll': {
      const p = db.polls.find(x => x.id === Number(op.id)); if (!p) return null;
      if (!(user.username === p.createdBy || canManage(user.role))) return null;
      db.polls = db.polls.filter(x => x.id !== p.id);
      return { type: 'removePoll', id: p.id };
    }
    default: return null;
  }
}

// ---------- Frontend ----------
let INDEX_HTML = '';
function loadIndex() { INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace(/__BASE__/g, BASE); }

// ---------- Router ----------
function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  let pth = decodeURIComponent(u.pathname);
  if (BASE && !(pth === BASE || pth.startsWith(BASE + '/'))) { if (pth === '/') return send(res, 302, '', { Location: BASE + '/' + u.search }); return send(res, 404, { error: 'not found' }); }
  let rel = BASE ? pth.slice(BASE.length) : pth;
  if (rel === '') return send(res, 302, '', { Location: BASE + '/' + u.search });

  if (rel === '/' && req.method === 'GET')
    return send(res, 200, INDEX_HTML, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'" });

  if (!rel.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  const api = rel.slice(4);

  // Einladung prüfen (ohne Login, ohne Einlösung) – für den Bestätigungs-Screen
  if (api === '/invite/check' && req.method === 'GET') {
    const inv = findInvite(u.searchParams.get('token'));
    if (!inv) return send(res, 404, { error: 'Einladung ungültig oder abgelaufen' });
    const user = db.users.find(x => x.id === inv.userId);
    if (!user) return send(res, 404, { error: 'Konto nicht gefunden' });
    return send(res, 200, { username: user.username });
  }
  // Einladung einlösen (einmalig) – meldet den Nutzer an
  if (api === '/invite/redeem' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const inv = findInvite(body && body.token);
      if (!inv) return send(res, 404, { error: 'Einladung ungültig oder abgelaufen' });
      const user = db.users.find(x => x.id === inv.userId);
      if (!user) return send(res, 404, { error: 'Konto nicht gefunden' });
      inv.used = true; user.mustChangePassword = true; flushDb();
      setSessionCookie(res, user.id);
      send(res, 200, { user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: true });
    });
  }

  // Matrix-Login: Login-Link anfordern (in den verknüpften Raum). Antwort immer generisch
  // (kein Rückschluss, ob es den Nutzer gibt / ob er verknüpft ist), um Konten-Aufzählung zu verhindern.
  if (api === '/login/matrix/request' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const ip = clientIp(req);
    if (throttled(ip)) return send(res, 429, { error: 'zu viele Versuche, bitte später erneut' });
    return readJson(req, body => {
      // "login" akzeptiert Benutzername ODER Matrix-ID (@name:server); "username" bleibt kompatibel
      const login = String((body && (body.login != null ? body.login : body.username)) || '').trim();
      const generic = { ok: true, sent: true };
      if (!login) return send(res, 400, { error: 'bad request' });
      const user = findUserByLogin(login);
      if (user && user.matrix && user.matrix.verified && user.matrix.roomId) {
        // je Nutzer höchstens alle 30 s einen Login-Link erzeugen
        if (!mRateHit('mlogin:' + user.id, 30000)) {
          const m = createMagic(user.id); flushDb();
          const link = publicBase(req) + '/?mlogin=' + m.token;
          enqueueMatrix(user.matrix.roomId,
            '🎳 KKk58 – Anmeldung\nDein Login-Link (5 Minuten gültig, einmal verwendbar):\n' + link +
            '\nWenn du das nicht angefordert hast, ignoriere diese Nachricht.');
        }
      }
      // konstante, generische Antwort
      send(res, 200, generic);
    });
  }
  // Matrix-Login: Login-Link einlösen -> meldet an (ohne Passwortzwang)
  if (api === '/login/matrix/redeem' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const ip = clientIp(req);
    if (throttled(ip)) return send(res, 429, { error: 'zu viele Versuche, bitte später erneut' });
    return readJson(req, body => {
      const m = findMagic(body && body.token);
      if (!m) { badLogin(ip); return send(res, 404, { error: 'Login-Link ungültig oder abgelaufen' }); }
      const user = db.users.find(x => x.id === m.userId);
      if (!user) return send(res, 404, { error: 'Konto nicht gefunden' });
      m.used = true; flushDb();
      attempts.delete(ip); setSessionCookie(res, user.id);
      send(res, 200, { user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: !!user.mustChangePassword, matrix: matrixInfo(user) });
    });
  }

  if (api === '/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const ip = clientIp(req);
    if (throttled(ip)) return send(res, 429, { error: 'zu viele Versuche, bitte später erneut' });
    return readJson(req, body => {
      if (!body) return send(res, 400, { error: 'bad request' });
      // "login" akzeptiert Benutzername, Matrix-ID oder ein Verzeichnis-Kontaktfeld
      // (Telefon/Handy/E-Mail/MXID); "username" bleibt aus Kompatibilität erhalten.
      const login = String((body.login != null ? body.login : body.username) || '').trim();
      const user = findUserByLogin(login);
      if (!user || !verifyPw(user, body.password || '')) { badLogin(ip); return send(res, 401, { error: 'Login fehlgeschlagen' }); }
      attempts.delete(ip); setSessionCookie(res, user.id);
      send(res, 200, { user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: !!user.mustChangePassword });
    });
  }

  const me = sessionUser(req);
  if (!me) return send(res, 401, { error: 'nicht angemeldet' });

  if (api === '/me' && req.method === 'GET') return send(res, 200, { user: { id: me.id, username: me.username, role: me.role }, mustChangePassword: !!me.mustChangePassword, matrix: matrixInfo(me) });
  if (api === '/me/password' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const np = String((body && body.newPassword) || '');
      if (np.length < 6) return send(res, 422, { error: 'Passwort mind. 6 Zeichen' });
      if (!me.mustChangePassword) { if (!verifyPw(me, (body && body.currentPassword) || '')) return send(res, 401, { error: 'Aktuelles Passwort falsch' }); }
      me.salt = crypto.randomBytes(16).toString('hex'); me.hash = hashPw(np, me.salt); me.mustChangePassword = false; flushDb();
      send(res, 200, { ok: true });
    });
  }
  // Matrix-Verknüpfung starten: Code erzeugen und im Browser anzeigen. Der Nutzer schickt ihn
  // in einem privaten Chat an den Bot; Raum-ID und Absender-MXID übernimmt dann processMatrixInbox().
  if (api === '/me/matrix/link' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    if (mRateHit('mlink:' + me.id, 5000)) return send(res, 429, { error: 'Bitte kurz warten, bevor du einen neuen Code anforderst.' });
    const code = newMatrixCode();
    const since = Date.now();
    me.matrixPending = { codeHash: hmacHex(code), since, expires: since + MATRIX_CODE_TTL };
    flushDb();
    return send(res, 200, { ok: true, code: fmtMatrixCode(code), bot: matrixBotId(), since, expires: me.matrixPending.expires });
  }
  // Laufenden Verknüpfungsversuch abbrechen
  if (api === '/me/matrix/cancel' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    delete me.matrixPending; flushDb();
    return send(res, 200, { ok: true, matrix: matrixInfo(me) });
  }
  // Matrix-Verknüpfung entfernen
  if (api === '/me/matrix/unlink' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const oldRoom = me.matrix && me.matrix.roomId;
    delete me.matrix; delete me.matrixPending; flushDb();
    if (oldRoom) enqueueMatrixLeave(oldRoom, '🎳 KKk58 – Verknüpfung aufgehoben\nDieser Chat ist nicht mehr mit deinem KKk58-Konto verknüpft. Der Bot verlässt den Raum.', me.id);
    return send(res, 200, { ok: true, matrix: null });
  }
  if (api === '/qr' && req.method === 'GET') {
    const data = u.searchParams.get('data') || '';
    if (!data || data.length > 512) return send(res, 400, { error: 'bad request' });
    try { return send(res, 200, qr.qrSvg(data), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }); }
    catch (e) { return send(res, 400, { error: 'Daten zu lang für QR' }); }
  }
  // Nachrichten des Vereinsraums (read-only). Paginierung über stabile seq-Cursor:
  //   ?before=<seq>  -> die neuesten <limit> Nachrichten ÄLTER als seq (Endlos-Scroll nach oben)
  //   ?after=<seq>   -> alle Nachrichten NEUER als seq (Live-Nachladen unten)
  //   sonst          -> die neuesten <limit> Nachrichten
  if (api === '/matrix/messages' && req.method === 'GET') {
    const feed = readFeed();
    const latestSeq = feed.length ? feed[feed.length - 1].seq : null;
    let limit = parseInt(u.searchParams.get('limit'), 10); if (!(limit > 0)) limit = 30; if (limit > 100) limit = 100;
    const beforeRaw = u.searchParams.get('before'), afterRaw = u.searchParams.get('after');
    if (afterRaw !== null) {
      const after = parseInt(afterRaw, 10);
      let newer = Number.isFinite(after) ? feed.filter(x => x.seq > after) : feed;
      if (newer.length > 300) newer = newer.slice(-300); // Schutz gegen sehr große Nachhol-Antworten
      return send(res, 200, { messages: newer.map(feedItem), latestSeq });
    }
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : null;
    const subset = (before !== null && Number.isFinite(before)) ? feed.filter(x => x.seq < before) : feed;
    const page = subset.slice(-limit);
    return send(res, 200, {
      messages: page.map(feedItem),
      firstSeq: page.length ? page[0].seq : null,
      hasMore: subset.length > page.length,
      latestSeq,
    });
  }
  // Relay: eine in der Webapp geschriebene Nachricht als Bot (KKK_MATRIX_USER) in den
  // Vereinsraum senden – formatiert als „Person: Nachricht". „Person" ist der Stammname
  // des Kontos; ist keiner zugeordnet, wird der Benutzername verwendet. Der eigentliche
  // Versand läuft über den Sidecar (Outbox); die Nachricht taucht danach im Feed auf.
  if (api === '/matrix/say' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      if (!body) return send(res, 400, { error: 'ungültige Anfrage' });
      let text = String(body.text != null ? body.text : '').replace(/\r\n/g, '\n').trim();
      if (!text) return send(res, 422, { error: 'Leere Nachricht' });
      if (text.length > MATRIX_SAY_MAX) text = text.slice(0, MATRIX_SAY_MAX);
      if (mRateHit('say:' + me.id, 2000)) return send(res, 429, { error: 'Zu schnell – bitte kurz warten.' });
      const who = personNameOf(me) || me.username;
      const queued = enqueueMatrix(clubRoom(), who + ': ' + text);
      return send(res, 200, { ok: true, queued });
    });
  }
  if (api === '/logout' && req.method === 'POST') { clearSessionCookie(res); return send(res, 200, { ok: true }); }
  if (api === '/state' && req.method === 'GET') return send(res, 200, { version: db.version, sheet: db.sheet, roster: db.roster, places: db.places, lastBahnen: db.lastBahnen, prizes: db.prizes, trips: db.trips, develop: db.develop, events: db.events, polls: db.polls.map(pollView), matrixRoom: publicMatrixRoom(), me: { id: me.id, username: me.username, role: me.role, mustChangePassword: !!me.mustChangePassword, matrix: matrixInfo(me) } });
  if (api === '/roster' && req.method === 'GET') return send(res, 200, { roster: db.roster });
  if (api === '/archive' && req.method === 'GET') return send(res, 200, { archive: db.archive.slice().sort(byGameDesc).map(archiveMeta) });
  if (api === '/export' && req.method === 'GET') {
    const z = n => String(n).padStart(2, '0'); const d = new Date();
    const fname = 'KKk58-Archiv-' + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '.html';
    return send(res, 200, buildExportHtml(), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + fname + '"', 'Cache-Control': 'no-store' });
  }
  if (api === '/db' && req.method === 'GET') {
    // Voll-Sicherung (mit Zugangsdaten) nur für Admins; sonst bereinigte Kopie für jede angemeldete Rolle.
    const wantFull = u.searchParams.get('full') === '1';
    const full = wantFull && me.role === 'admin';
    if (wantFull && !full) return send(res, 403, { error: 'Vollständige Sicherung nur für Admins' });
    const z = n => String(n).padStart(2, '0'); const d = new Date();
    const stamp = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    const fname = 'KKk58-Datenbank-' + stamp + (full ? '-voll' : '') + '.json';
    return send(res, 200, buildDbExport(full, me), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + fname + '"', 'Cache-Control': 'no-store' });
  }

  const mA = api.match(/^\/archive\/(\d+)$/);
  if (mA && req.method === 'GET') { const g = db.archive.find(a => a.id === Number(mA[1])); if (!g) return send(res, 404, { error: 'nicht gefunden' }); return send(res, 200, { game: { id: g.id, event: g.event, date: g.date, place: g.placeName || placeNameById(g.placeId) || '', savedAt: g.savedAt, savedBy: g.savedBy, pumpen: g.pumpen, note: g.note }, eval: evalGame(g) }); }
  if (api === '/stats' && req.method === 'GET') { const yq = u.searchParams.get('year'); const yr = /^\d{4}$/.test(String(yq || '')) ? Number(yq) : null; const pq = u.searchParams.get('place'); const pl = (pq === 'none') ? 'none' : (/^\d+$/.test(String(pq || '')) ? Number(pq) : null); return send(res, 200, computeStats(yr, pl)); }

  if (api === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'sync', v: db.version, sheet: db.sheet, roster: db.roster, places: db.places, lastBahnen: db.lastBahnen, prizes: db.prizes, trips: db.trips, develop: db.develop, events: db.events, polls: db.polls.map(pollView) }) + '\n\n');
    const c = { res, uid: me.id }; clients.add(c); req.on('close', () => clients.delete(c)); return;
  }

  if (api === '/op' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      if (!body || !body.op) return send(res, 400, { error: 'bad request' });
      if (body.op.type === 'saveGame' && !placeById(db.sheet.placeId)) {
        return send(res, 422, { error: 'Kein Kegelort gewählt – bitte zuerst einen Ort zuordnen.' });
      }
      if (body.op.type === 'saveGame' && me.role !== 'admin' && throwsUnequal(db.sheet)) {
        return send(res, 422, { error: 'Ungleiche Wurf-Anzahl – nur ein Admin kann ein solches Spiel speichern.' });
      }
      const ctx = captureCtx(body.op);
      const norm = applyOp(body.op, me);
      if (!norm) return send(res, 422, { error: 'ungültige Operation' });
      const logEntry = pushLog(me, norm, ctx);
      db.version++; db.sheet.updatedBy = me.username; db.sheet.updatedAt = Date.now(); saveDb();
      broadcast({ v: db.version, op: norm, opId: body.op.opId || null, by: me.username, log: logEntry });
      send(res, 200, { ok: true, v: db.version });
    });
  }

  if (api === '/log' && req.method === 'GET') return send(res, 200, { log: db.log.slice(-200).reverse() });

  // ----- Kasse (nur Verwaltung: Admin/Kassenwart/Mitglied) -----
  if (api === '/cash' && req.method === 'GET') { return send(res, 200, cashOverview(canCash(me.role))); }
  if (api === '/cash/gnucash' && req.method === 'GET') {
    const z = n => String(n).padStart(2, '0'); const d = new Date();
    const fname = 'KKk58-Kasse-' + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '.gnucash';
    return send(res, 200, buildGnuCash(), { 'Content-Type': 'application/x-gnucash', 'Content-Disposition': 'attachment; filename="' + fname + '"', 'Cache-Control': 'no-store' });
  }
  if (api === '/cash/payment' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const rid = Number(body && body.rosterId); if (!db.roster.some(r => r.id === rid)) return send(res, 422, { error: 'Person nicht im Stamm' });
      const cent = parseEuroToCent(body && body.euro); if (cent == null || cent <= 0) return send(res, 422, { error: 'Betrag ungültig' });
      const date = (body && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayStr();
      addLedger('payment', rid, -cent, String((body && body.note) || 'Zahlung').slice(0, 120), me.username, date); flushDb();
      send(res, 200, cashOverview(true));
    });
  }
  if (api === '/cash/opening' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const cent = parseEuroToCent(body && body.euro); if (cent == null) return send(res, 422, { error: 'Betrag ungültig' });
      const isCash = (body && (body.rosterId == null || body.rosterId === '' || body.rosterId === 'cash'));
      if (isCash) { db.ledger = db.ledger.filter(e => e.kind !== 'openingCash'); if (cent !== 0) addLedger('openingCash', null, cent, 'Anfangsbestand Kasse', me.username, todayStr()); }
      else { const rid = Number(body.rosterId); if (!db.roster.some(r => r.id === rid)) return send(res, 422, { error: 'Person nicht im Stamm' }); db.ledger = db.ledger.filter(e => !(e.kind === 'opening' && e.rosterId === rid)); if (cent !== 0) addLedger('opening', rid, cent, 'Anfangsbestand', me.username, todayStr()); }
      flushDb(); send(res, 200, cashOverview(true));
    });
  }
  if (api === '/cash/expense' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const cent = parseEuroToCent(body && body.euro); if (cent == null || cent <= 0) return send(res, 422, { error: 'Betrag ungültig' });
      const date = (body && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayStr();
      const note = String((body && body.note) || 'Ausgabe').slice(0, 120);
      let bens = Array.isArray(body && body.beneficiaries) ? body.beneficiaries.map(Number).filter(id => db.roster.some(r => r.id === id)) : [];
      bens = Array.from(new Set(bens));
      addLedger('expense', null, cent, note, me.username, date, { beneficiaries: bens }); flushDb();
      send(res, 200, cashOverview(true));
    });
  }
  const mEX = api.match(/^\/cash\/expense\/(\d+)$/);
  if (mEX && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const id = parseInt(mEX[1], 10); const e = db.ledger.find(x => x.id === id && x.kind === 'expense');
      if (!e) return send(res, 404, { error: 'Ausgabe nicht gefunden' });
      const cent = parseEuroToCent(body && body.euro); if (cent == null || cent <= 0) return send(res, 422, { error: 'Betrag ungültig' });
      e.amount = cent;
      if (body && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) e.date = body.date;
      if (body && typeof body.note === 'string') e.note = body.note.slice(0, 120);
      if (Array.isArray(body && body.beneficiaries)) { e.meta = e.meta || {}; e.meta.beneficiaries = Array.from(new Set(body.beneficiaries.map(Number).filter(rid => db.roster.some(r => r.id === rid)))); }
      flushDb(); send(res, 200, cashOverview(true));
    });
  }
  if (api === '/cash/adjust' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const rid = Number(body && body.rosterId); if (!db.roster.some(r => r.id === rid)) return send(res, 422, { error: 'Person nicht im Stamm' });
      const cent = parseEuroToCent(body && body.euro); if (cent == null || cent === 0) return send(res, 422, { error: 'Betrag ungültig' });
      addLedger('adjust', rid, cent, String((body && body.note) || 'Korrektur').slice(0, 120), me.username, todayStr()); flushDb();
      send(res, 200, cashOverview(true));
    });
  }
  if (api === '/cash/absence' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const date = body && body.date; if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 422, { error: 'Datum ungültig' });
      const sug = absenceSuggestions().find(x => x.date === date); if (!sug) return send(res, 200, cashOverview(true));
      let ids = sug.open.map(o => o.id);
      if (Array.isArray(body.rosterIds)) { const sel = new Set(body.rosterIds.map(Number)); ids = ids.filter(id => sel.has(id)); }
      ids.forEach(id => addLedger('absence', id, db.cashSettings.absenceCent, 'Abwesenheit ' + date, me.username, date, { date }));
      flushDb(); send(res, 200, cashOverview(true));
    });
  }
  if (api === '/cash/settings' && req.method === 'POST') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      if (body && body.duesEuro != null) { const c = parseEuroToCent(body.duesEuro); if (c == null || c < 0) return send(res, 422, { error: 'Beitrag ungültig' }); db.cashSettings.duesCent = c; }
      if (body && body.absenceEuro != null) { const c = parseEuroToCent(body.absenceEuro); if (c == null || c < 0) return send(res, 422, { error: 'Strafe ungültig' }); db.cashSettings.absenceCent = c; }
      if (body && body.expenseEuro != null) { const c = parseEuroToCent(body.expenseEuro); if (c == null || c < 0) return send(res, 422, { error: 'Ausgabe-Vorgabe ungültig' }); db.cashSettings.expenseCent = c; }
      if (body && body.duesStartMonth != null) { if (!/^\d{4}-\d{2}$/.test(body.duesStartMonth)) return send(res, 422, { error: 'Startmonat ungültig (JJJJ-MM)' }); db.cashSettings.duesStartMonth = body.duesStartMonth; }
      flushDb(); send(res, 200, cashOverview(true));
    });
  }
  const mCE = api.match(/^\/cash\/entry\/(\d+)$/);
  if (mCE && req.method === 'DELETE') {
    if (!canCash(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const id = parseInt(mCE[1], 10); const e = db.ledger.find(x => x.id === id);
    if (!e) return send(res, 404, { error: 'Buchung nicht gefunden' });
    if (e.kind === 'fee') return send(res, 422, { error: 'Monatsbeiträge nicht einzeln löschen – nutze eine Korrektur oder deaktiviere die Beitragspflicht' });
    if (e.kind === 'game') return send(res, 422, { error: 'Spielabrechnung über „Spiel löschen" im Archiv entfernen' });
    db.ledger = db.ledger.filter(x => x.id !== id);
    flushDb(); return send(res, 200, cashOverview(true));
  }

  // ----- Admin: Login-Konten -----
  if (api === '/users' && req.method === 'GET') { if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); return send(res, 200, { users: db.users.map(x => ({ id: x.id, username: x.username, role: x.role, createdAt: x.createdAt, rosterId: x.rosterId != null ? x.rosterId : null, person: personNameOf(x) })), roster: db.roster }); }
  if (api === '/users' && req.method === 'POST') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      if (!body) return send(res, 400, { error: 'bad request' });
      const username = String(body.username || '').trim();
      if (!/^[a-zA-Z0-9_.\-]{2,32}$/.test(username)) return send(res, 422, { error: 'Benutzername 2–32 Zeichen (a–z, 0–9, . _ -)' });
      if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'Benutzername existiert bereits' });
      let rosterId = null;
      if (body.rosterId != null && body.rosterId !== '') {
        rosterId = Number(body.rosterId);
        if (!db.roster.some(r => r.id === rosterId)) return send(res, 422, { error: 'Person nicht im Stamm' });
        if (db.users.some(u => u.rosterId === rosterId)) return send(res, 409, { error: 'Person ist bereits einem Konto zugeordnet' });
      }
      // Server vergibt ein zufälliges internes Passwort; der Zugang läuft über den Einmal-Link.
      const nu = makeUser(username, crypto.randomBytes(24).toString('base64url'), body.role, rosterId, true);
      db.users.push(nu); const inv = createInvite(nu.id); flushDb();
      send(res, 200, { user: { id: nu.id, username: nu.username, role: nu.role, rosterId: nu.rosterId, person: personNameOf(nu) }, invite: { token: inv.token, expires: inv.expires } });
    });
  }
  // Neuen Einmal-Link für ein bestehendes Konto erzeugen (z. B. Passwort vergessen)
  const mI = api.match(/^\/users\/(\d+)\/invite$/);
  if (mI && req.method === 'POST') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const t = db.users.find(x => x.id === parseInt(mI[1], 10)); if (!t) return send(res, 404, { error: 'nicht gefunden' });
    const inv = createInvite(t.id); flushDb();
    return send(res, 200, { user: { id: t.id, username: t.username }, invite: { token: inv.token, expires: inv.expires } });
  }
  const mL = api.match(/^\/users\/(\d+)\/link$/);
  if (mL && req.method === 'POST') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const t = db.users.find(x => x.id === parseInt(mL[1], 10)); if (!t) return send(res, 404, { error: 'nicht gefunden' });
      if (body && (body.rosterId == null || body.rosterId === '')) { t.rosterId = null; flushDb(); return send(res, 200, { user: { id: t.id, rosterId: null, person: null } }); }
      const rosterId = Number(body.rosterId);
      if (!db.roster.some(r => r.id === rosterId)) return send(res, 422, { error: 'Person nicht im Stamm' });
      if (db.users.some(u => u.rosterId === rosterId && u.id !== t.id)) return send(res, 409, { error: 'Person ist bereits einem Konto zugeordnet' });
      t.rosterId = rosterId; flushDb(); send(res, 200, { user: { id: t.id, rosterId, person: personNameOf(t) } });
    });
  }
  const mU = api.match(/^\/users\/(\d+)$/);
  if (mU && req.method === 'DELETE') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const id = parseInt(mU[1], 10); if (id === me.id) return send(res, 422, { error: 'sich selbst kann man nicht löschen' });
    const t = db.users.find(x => x.id === id); if (!t) return send(res, 404, { error: 'nicht gefunden' });
    if (canManage(t.role) && db.users.filter(x => canManage(x.role)).length <= 1) return send(res, 422, { error: 'das letzte verwaltungsberechtigte Konto bleibt bestehen' });
    db.users = db.users.filter(x => x.id !== id); flushDb(); return send(res, 200, { ok: true });
  }
  const mR = api.match(/^\/users\/(\d+)\/role$/);
  if (mR && req.method === 'POST') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      const t = db.users.find(x => x.id === parseInt(mR[1], 10)); if (!t) return send(res, 404, { error: 'nicht gefunden' });
      const nr = normRole(body && body.role);
      if (canManage(t.role) && !canManage(nr) && db.users.filter(x => canManage(x.role)).length <= 1) return send(res, 422, { error: 'das letzte verwaltungsberechtigte Konto bleibt bestehen' });
      t.role = nr; flushDb(); send(res, 200, { user: { id: t.id, role: t.role } });
    });
  }
  const mP = api.match(/^\/users\/(\d+)\/password$/);
  if (mP && req.method === 'POST') {
    if (!canManage(me.role)) return send(res, 403, { error: 'keine Berechtigung' }); if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => { const id = parseInt(mP[1], 10), pw = String((body && body.password) || ''); if (pw.length < 6) return send(res, 422, { error: 'Passwort mind. 6 Zeichen' }); const t = db.users.find(x => x.id === id); if (!t) return send(res, 404, { error: 'nicht gefunden' }); t.salt = crypto.randomBytes(16).toString('hex'); t.hash = hashPw(pw, t.salt); t.mustChangePassword = false; flushDb(); send(res, 200, { ok: true }); });
  }

  send(res, 404, { error: 'not found' });
}

// ---------- Start ----------
function bootstrapAdmin() {
  if (db.users.length > 0) return;
  const eu = process.env.KKK_ADMIN_USER, ep = process.env.KKK_ADMIN_PASS;
  let username = 'admin', pw;
  if (eu && ep) { username = eu; pw = ep; } else { pw = crypto.randomBytes(9).toString('base64url'); }
  db.users.push(makeUser(username, pw, 'admin')); flushDb();
  if (!(eu && ep)) {
    const line = 'Erst-Admin  Benutzer: ' + username + '  Passwort: ' + pw;
    try { fs.writeFileSync(path.join(DATA_DIR, 'INITIAL-ADMIN.txt'), line + '\n', { mode: 0o600 }); } catch (_) {}
    console.log('==============================================\n ' + line + '\n (auch in data/INITIAL-ADMIN.txt)\n==============================================');
  }
}

loadDb(); loadIndex(); bootstrapAdmin();
const server = http.createServer((req, res) => { try { handle(req, res); } catch (e) { console.error(e); try { send(res, 500, { error: 'server error' }); } catch (_) {} } });
server.listen(PORT, BIND, () => console.log('KKk58 läuft auf http://' + BIND + ':' + PORT + (BASE || '/')));
// Wöchentliche Erinnerung an offene Abstimmungen: alle 6 h prüfen (feuert je Poll höchstens
// einmal pro Woche), plus einmal kurz nach dem Start.
setInterval(sendPollReminders, 6 * 3600 * 1000).unref();
setInterval(processMatrixInbox, 3000).unref();
setTimeout(sendPollReminders, 60 * 1000).unref();
function shutdown() { flushDb(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
