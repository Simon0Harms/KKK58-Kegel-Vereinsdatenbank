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
const MAX = 180;

fs.mkdirSync(DATA_DIR, { recursive: true });

let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  if (!SECRET) { SECRET = crypto.randomBytes(48).toString('base64url'); try { fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); } catch (_) {} }
}

// ---------- Datenmodell ----------
function emptySheet() {
  return { event: '', date: '', lanes: { bohle: true, schere: false }, priceNK: 1, pricePump: 0.1,
    pumpen: '', note: '', seq: 0, players: [], updatedBy: '', updatedAt: 0 };
}
let db = { users: [], seqUser: 0, roster: [], seqRoster: 0, sheet: emptySheet(), archive: [], seqArchive: 0, log: [], invites: [], ledger: [], seqLedger: 0, cashSettings: { duesCent: 2000, absenceCent: 100, expenseCent: 3500, duesStartMonth: null }, version: 0 };
const LOG_MAX = 400;

function cint(v, mn, mx, fb) { let n = Math.round(Number(v)); if (!isFinite(n)) return fb; return Math.min(mx, Math.max(mn, n)); }
function nscore(v) { if (v == null || v === '') return null; return cint(v, 0, MAX, 0); }
function normPlayer(p) {
  return { id: p.id, rosterId: (p.rosterId != null ? Number(p.rosterId) : null), name: String(p.name || ''),
    c9: cint(p.c9, 0, 99999, 0), cK: cint(p.cK != null ? p.cK : p.cS, 0, 99999, 0), cP: cint(p.cP, 0, 99999, 0),
    b1: nscore(p.b1), b2: nscore(p.b2), s1: nscore(p.s1), s2: nscore(p.s2) };
}
function loadDb() {
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = Array.isArray(j.users) ? j.users.map(u => Object.assign({}, u, {
      rosterId: (u.rosterId != null ? Number(u.rosterId) : null),
      role: u.role === 'admin' ? 'admin' : (ALL_ROLES.indexOf(u.role) !== -1 ? u.role : 'beschraenkt') // Alt-Rolle "member" -> "beschraenkt" (Rechte bleiben gleich)
    })) : [];
    db.seqUser = j.seqUser || db.users.length;
    db.roster = Array.isArray(j.roster) ? j.roster.map(r => ({ id: r.id, name: String(r.name || ''), active: r.active !== false, leftAt: (r.leftAt && /^\d{4}-\d{2}-\d{2}$/.test(r.leftAt)) ? r.leftAt : null, duesLiable: r.duesLiable !== false })) : [];
    db.seqRoster = j.seqRoster || db.roster.reduce((m, r) => Math.max(m, r.id), 0);
    db.sheet = Object.assign(emptySheet(), j.sheet || {});
    db.sheet.lanes = Object.assign({ bohle: true, schere: false }, db.sheet.lanes || {});
    db.sheet.players = Array.isArray(db.sheet.players) ? db.sheet.players.map(normPlayer) : [];
    db.archive = Array.isArray(j.archive) ? j.archive : [];
    db.seqArchive = j.seqArchive || db.archive.reduce((m, a) => Math.max(m, a.id), 0);
    db.log = Array.isArray(j.log) ? j.log.slice(-LOG_MAX) : [];
    const nowL = Date.now();
    db.invites = Array.isArray(j.invites) ? j.invites.filter(x => x && !x.used && x.expires > nowL) : [];
    db.ledger = Array.isArray(j.ledger) ? j.ledger : [];
    db.seqLedger = j.seqLedger || db.ledger.reduce((m, e) => Math.max(m, e.id || 0), 0);
    const cs = j.cashSettings || {};
    db.cashSettings = { duesCent: Number.isFinite(cs.duesCent) ? cs.duesCent : 2000, absenceCent: Number.isFinite(cs.absenceCent) ? cs.absenceCent : 100, expenseCent: Number.isFinite(cs.expenseCent) ? cs.expenseCent : 3500, duesStartMonth: /^\d{4}-\d{2}$/.test(cs.duesStartMonth) ? cs.duesStartMonth : null };
    db.version = j.version || 0;
  } catch (_) { /* Erststart */ }
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
function personNameOf(user) { if (!user || user.rosterId == null) return null; const r = db.roster.find(x => x.id === user.rosterId); return r ? r.name : null; }
function labelKey(k) { return k === 'c9' ? '9' : k === 'cK' ? 'Kränze' : k === 'cP' ? 'Pumpen' : k; }
function pNameById(id) { const p = db.sheet.players.find(x => x.id === id); return p ? (p.name || '#' + id) : '#' + id; }
function describeOp(op, ctx) {
  switch (op.type) {
    case 'setMeta': return (op.field === 'event' ? 'Anlass' : 'Datum') + ' geändert';
    case 'setNote': return (op.field === 'pumpen' ? 'Pumpenkegel-Notiz' : 'Bemerkung') + ' geändert';
    case 'setPrice': return 'Preis ' + (op.field === 'priceNK' ? '9/Kranz' : 'Pumpe') + ' geändert';
    case 'setLane': return 'Bahn ' + (op.lane === 'bohle' ? 'Bohle' : 'Schere') + (op.on ? ' aktiviert' : ' deaktiviert');
    case 'addPlayer': return 'Spieler hinzugefügt: ' + (op.player ? op.player.name : '') + (op.roster ? ' (neu im Stamm)' : '');
    case 'removePlayer': return 'Spieler entfernt: ' + (ctx && ctx.removedName || '');
    case 'setName': return 'Name geändert: ' + op.value;
    case 'counterDelta': return pNameById(op.id) + ': ' + labelKey(op.key) + ' ' + (op.delta >= 0 ? '+' : '') + op.delta;
    case 'setCounter': return pNameById(op.id) + ': ' + labelKey(op.key) + ' = ' + op.value;
    case 'setScore': return pNameById(op.id) + ': ' + op.key.toUpperCase() + ' = ' + (op.value == null ? '–' : op.value);
    case 'order': return 'Liste nach Platz sortiert';
    case 'reset': return 'Liste geleert';
    case 'newGame': return 'Neues Spiel begonnen';
    case 'addRoster': return 'Stamm: Spieler angelegt (' + op.person.name + ')';
    case 'renameRoster': return 'Stamm: umbenannt in ' + op.name;
    case 'setRosterActive': return 'Stamm: Spieler ' + (op.active ? 'aktiviert' : ('deaktiviert' + (op.leftAt ? ' (Austritt ' + op.leftAt + ')' : '')));
    case 'setRosterDues': return 'Stamm: Beitragspflicht ' + (op.duesLiable ? 'aktiviert' : 'deaktiviert');
    case 'removeRoster': return 'Stamm: Spieler gelöscht';
    case 'archiveChanged': return op.removed ? 'Spiel aus Archiv gelöscht' : 'Spiel gespeichert';
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
  const lt = p => (g.lanes.bohle ? (p.b1 || 0) + (p.b2 || 0) : 0) + (g.lanes.schere ? (p.s1 || 0) + (p.s2 || 0) : 0);
  const rows = g.players.map((p, i) => {
    const scores = [];
    if (g.lanes.bohle) scores.push(p.b1 || 0, p.b2 || 0);
    if (g.lanes.schere) scores.push(p.s1 || 0, p.s2 || 0);
    return { idx: i, rosterId: p.rosterId != null ? p.rosterId : null, name: p.name || '',
      c9: p.c9 || 0, cK: p.cK || 0, cP: p.cP || 0, b1: p.b1, b2: p.b2, s1: p.s1, s2: p.s2,
      total: lt(p), bestRound: scores.length ? Math.max.apply(null, scores) : 0,
      roundBohle: g.lanes.bohle ? Math.max(p.b1 || 0, p.b2 || 0) : null,
      roundSchere: g.lanes.schere ? Math.max(p.s1 || 0, p.s2 || 0) : null,
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
    players: a.players.length, silberNames: e.silberNames, pumpenNames: e.pumpenNames, kasseTotal: e.kasseTotal };
}

// ---------- Statistik über alle archivierten Spiele ----------
function groupKey(r) { return r.rosterId != null ? 'r' + r.rosterId : 'n:' + (r.name || '').trim().toLowerCase(); }
function computeStats() {
  const agg = new Map();
  let kasse = 0, from = null, to = null;
  for (const g of db.archive) {
    if (from == null || g.savedAt < from) from = g.savedAt;
    if (to == null || g.savedAt > to) to = g.savedAt;
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
  const players = Array.from(agg.values()).map(a => Object.assign(a, { avg: a.games ? a.points / a.games : 0, arrAvg: a.games ? a.arrSum / a.games : 0 }))
    .sort((x, y) => y.avg - x.avg || y.games - x.games);
  return { summary: { games: db.archive.length, from, to, kasse }, players };
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
  }
  snap._export = { at: Date.now(), by: (byUser && byUser.username) || null, full: !!full, version: db.version };
  return JSON.stringify(snap, null, 2);
}

function buildExportHtml() {
  const st = computeStats();
  const span = (st.summary.from && st.summary.to) ? (fmtDT(st.summary.from).slice(0, 10) + ' – ' + fmtDT(st.summary.to).slice(0, 10)) : '';
  const now = fmtDT(Date.now());
  const games = db.archive.slice().sort((a, b) => a.savedAt - b.savedAt);
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

  if (st.players.length) {
    h += '<h2>Gesamtstatistik</h2><table><thead><tr><th class="l">Spieler</th><th>Sp.</th><th>Ø Pkt</th><th>Best</th><th>Beste Bo</th><th>Beste Sc</th><th>9</th><th>⑧</th><th>Pump</th><th>Ⓢ</th><th>Ⓟ</th><th>Siege</th><th>Ø Ank.</th><th>1. da</th><th>Kasse</th></tr></thead><tbody>';
    st.players.forEach(p => {
      h += '<tr><td class="l">' + escHtml(p.name || '(ohne Namen)') + '</td><td>' + p.games + '</td><td>' + p.avg.toFixed(1).replace('.', ',') + '</td><td>' + p.best + '</td><td>' + (p.bestBohle == null ? '–' : p.bestBohle) + '</td><td>' + (p.bestSchere == null ? '–' : p.bestSchere) + '</td><td>' + p.c9 + '</td><td>' + p.cK + '</td><td>' + p.cP + '</td><td>' + p.silber + '</td><td>' + p.pumpen + '</td><td>' + p.wins + '</td><td>' + (p.arrAvg ? p.arrAvg.toFixed(1).replace('.', ',') : '–') + '</td><td>' + (p.firsts || 0) + '</td><td class="n">' + escHtml(euroS(p.kasse)) + '</td></tr>';
    });
    h += '</tbody></table>';
  }

  h += '<h2>Spiele (' + games.length + ')</h2>';
  if (!games.length) h += '<p class="sub">Keine gespeicherten Spiele.</p>';
  games.forEach(g => {
    const ev = evalGame(g);
    h += '<div class="game"><h3>' + (escHtml(g.event) || 'Spiel') + ' – ' + escHtml(fmtD(g.date)) + '</h3>';
    h += '<p class="sub">gespeichert von ' + escHtml(g.savedBy || '') + ' am ' + escHtml(fmtDT(g.savedAt)) +
      (ev.silberNames.length ? (' · <span class="sil">Ⓢ ' + ev.silberNames.map(escHtml).join(', ') + '</span>') : '') +
      (ev.pumpenNames.length ? (' · <span class="pmp">Ⓟ ' + ev.pumpenNames.map(escHtml).join(', ') + '</span>') : '') + '</p>';
    h += '<table><thead><tr><th>Pl.</th><th>Ank.</th><th class="l">Name</th><th>9</th><th>⑧</th><th>Pump</th>';
    if (ev.lanes.bohle) h += '<th>Bo1</th><th>Bo2</th><th>ΣBo</th>';
    if (ev.lanes.schere) h += '<th>Sc1</th><th>Sc2</th><th>ΣSc</th>';
    h += '<th>Σ</th><th>Ⓢ</th><th>Ⓟ</th><th>Kasse</th></tr></thead><tbody>';
    ev.rows.slice().sort((a, b) => b.total - a.total).forEach(r => {
      h += '<tr><td>' + (r.place || '–') + '</td><td>' + (r.idx + 1) + '</td><td class="l">' + escHtml(r.name || '(ohne Namen)') + '</td><td>' + r.c9 + '</td><td>' + r.cK + '</td><td>' + r.cP + '</td>';
      if (ev.lanes.bohle) h += '<td>' + (r.b1 == null ? '' : r.b1) + '</td><td>' + (r.b2 == null ? '' : r.b2) + '</td><td>' + ((r.b1 || 0) + (r.b2 || 0)) + '</td>';
      if (ev.lanes.schere) h += '<td>' + (r.s1 == null ? '' : r.s1) + '</td><td>' + (r.s2 == null ? '' : r.s2) + '</td><td>' + ((r.s1 || 0) + (r.s2 || 0)) + '</td>';
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
function applyOp(op, user) {
  const s = db.sheet;
  switch (op && op.type) {
    case 'setMeta': if (!['event', 'date'].includes(op.field)) return null; s[op.field] = String(op.value || '').slice(0, 120); return { type: 'setMeta', field: op.field, value: s[op.field] };
    case 'setNote': if (!['pumpen', 'note'].includes(op.field)) return null; s[op.field] = String(op.value || '').slice(0, 4000); return { type: 'setNote', field: op.field, value: s[op.field] };
    case 'setPrice': { if (!['priceNK', 'pricePump'].includes(op.field)) return null; let v = Number(op.value); if (!isFinite(v) || v < 0) v = 0; s[op.field] = v; return { type: 'setPrice', field: op.field, value: v }; }
    case 'setLane': { if (!['bohle', 'schere'].includes(op.lane)) return null; const nx = Object.assign({}, s.lanes); nx[op.lane] = !!op.on; if (!nx.bohle && !nx.schere) return null; s.lanes = nx; return { type: 'setLane', lane: op.lane, on: !!op.on }; }
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
          person = { id: ++db.seqRoster, name: nm.slice(0, 60), active: true, duesLiable: true }; db.roster.push(person); newPerson = person;
        }
      }
      const p = { id: ++s.seq, rosterId: person.id, name: person.name, c9: 0, cK: 0, cP: 0, b1: null, b2: null, s1: null, s2: null };
      s.players.push(p);
      return { type: 'addPlayer', player: p, roster: newPerson };
    }
    case 'removePlayer': { const b = s.players.length; s.players = s.players.filter(p => p.id !== op.id); if (s.players.length === b) return null; return { type: 'removePlayer', id: op.id }; }
    case 'setName': { const p = findP(op.id); if (!p) return null; p.name = String(op.value || '').slice(0, 60); return { type: 'setName', id: op.id, value: p.name }; }
    case 'counterDelta': { if (!['c9', 'cK', 'cP'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; const old = p[op.key] || 0; p[op.key] = Math.max(0, Math.min(99999, old + (Math.sign(op.delta) || 0))); return { type: 'counterDelta', id: op.id, key: op.key, delta: p[op.key] - old }; }
    case 'setCounter': { if (!['c9', 'cK', 'cP'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; p[op.key] = cint(op.value, 0, 99999, 0); return { type: 'setCounter', id: op.id, key: op.key, value: p[op.key] }; }
    case 'setScore': { if (!['b1', 'b2', 's1', 's2'].includes(op.key)) return null; const p = findP(op.id); if (!p) return null; p[op.key] = nscore(op.value); return { type: 'setScore', id: op.id, key: op.key, value: p[op.key] }; }
    case 'sortByPlace': return null; // Sortierung ist reine Anzeige (clientseitig); Ankunftsreihenfolge bleibt erhalten
    case 'reset': { if (!canManage(user.role)) return null; s.players = []; s.seq = 0; return { type: 'reset' }; }
    case 'newGame': { s.players = []; s.seq = 0; s.event = ''; s.pumpen = ''; s.note = ''; return { type: 'newGame' }; }
    // ----- Spielerstamm -----
    case 'addRoster': { const nm = String(op.name || '').trim(); if (!nm) return null; if (db.roster.some(r => r.name.toLowerCase() === nm.toLowerCase())) return null; const person = { id: ++db.seqRoster, name: nm.slice(0, 60), active: true, leftAt: null, duesLiable: true }; db.roster.push(person); return { type: 'addRoster', person }; }
    case 'renameRoster': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; const nm = String(op.name || '').trim(); if (nm) r.name = nm.slice(0, 60); return { type: 'renameRoster', id: r.id, name: r.name }; }
    case 'setRosterActive': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; r.active = !!op.active; if (r.active) r.leftAt = null; else r.leftAt = (op.leftAt && /^\d{4}-\d{2}-\d{2}$/.test(op.leftAt) && !isNaN(Date.parse(op.leftAt))) ? op.leftAt : null; return { type: 'setRosterActive', id: r.id, active: r.active, leftAt: r.leftAt }; }
    case 'setRosterDues': { if (!canManage(user.role)) return null; const r = db.roster.find(x => x.id === Number(op.id)); if (!r) return null; r.duesLiable = !!op.duesLiable; return { type: 'setRosterDues', id: r.id, duesLiable: r.duesLiable }; }
    case 'removeRoster': { if (!canManage(user.role)) return null; const b = db.roster.length; db.roster = db.roster.filter(x => x.id !== Number(op.id)); if (db.roster.length === b) return null; db.users.forEach(u => { if (u.rosterId === Number(op.id)) u.rosterId = null; }); return { type: 'removeRoster', id: Number(op.id) }; }
    // ----- Archiv -----
    case 'saveGame': {
      if (s.players.length === 0) return null;
      const snap = { id: ++db.seqArchive, savedAt: Date.now(), savedBy: user.username,
        event: s.event, date: s.date, lanes: { bohle: s.lanes.bohle, schere: s.lanes.schere },
        priceNK: s.priceNK, pricePump: s.pricePump, pumpen: s.pumpen, note: s.note,
        players: s.players.map(p => ({ rosterId: p.rosterId != null ? p.rosterId : null, name: p.name, c9: p.c9 || 0, cK: p.cK || 0, cP: p.cP || 0, b1: p.b1, b2: p.b2, s1: p.s1, s2: p.s2 })) };
      db.archive.push(snap);
      // Spielabrechnung automatisch dem Kassenkonto der Personen belasten
      const ev = evalGame(snap);
      ev.rows.forEach(r => { if (r.rosterId != null && r.kasse > 0) addLedger('game', r.rosterId, Math.round(r.kasse * 100), 'Spielabrechnung ' + (snap.date || todayStr()) + (snap.event ? ' · ' + snap.event : ''), user.username, snap.date || todayStr(), { archiveId: snap.id }); });
      return { type: 'archiveChanged', id: snap.id };
    }
    case 'deleteGame': { if (!canManage(user.role)) return null; const b = db.archive.length; db.archive = db.archive.filter(a => a.id !== Number(op.id)); if (db.archive.length === b) return null; db.ledger = db.ledger.filter(e => !(e.kind === 'game' && e.meta && e.meta.archiveId === Number(op.id))); return { type: 'archiveChanged', id: Number(op.id), removed: true }; }
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

  if (api === '/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    const ip = clientIp(req);
    if (throttled(ip)) return send(res, 429, { error: 'zu viele Versuche, bitte später erneut' });
    return readJson(req, body => {
      if (!body) return send(res, 400, { error: 'bad request' });
      const user = db.users.find(x => x.username.toLowerCase() === String(body.username || '').toLowerCase());
      if (!user || !verifyPw(user, body.password || '')) { badLogin(ip); return send(res, 401, { error: 'Login fehlgeschlagen' }); }
      attempts.delete(ip); setSessionCookie(res, user.id);
      send(res, 200, { user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: !!user.mustChangePassword });
    });
  }

  const me = sessionUser(req);
  if (!me) return send(res, 401, { error: 'nicht angemeldet' });

  if (api === '/me' && req.method === 'GET') return send(res, 200, { user: { id: me.id, username: me.username, role: me.role }, mustChangePassword: !!me.mustChangePassword });
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
  if (api === '/qr' && req.method === 'GET') {
    const data = u.searchParams.get('data') || '';
    if (!data || data.length > 512) return send(res, 400, { error: 'bad request' });
    try { return send(res, 200, qr.qrSvg(data), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }); }
    catch (e) { return send(res, 400, { error: 'Daten zu lang für QR' }); }
  }
  if (api === '/logout' && req.method === 'POST') { clearSessionCookie(res); return send(res, 200, { ok: true }); }
  if (api === '/state' && req.method === 'GET') return send(res, 200, { version: db.version, sheet: db.sheet, roster: db.roster, me: { id: me.id, username: me.username, role: me.role, mustChangePassword: !!me.mustChangePassword } });
  if (api === '/roster' && req.method === 'GET') return send(res, 200, { roster: db.roster });
  if (api === '/archive' && req.method === 'GET') return send(res, 200, { archive: db.archive.map(archiveMeta).sort((a, b) => b.savedAt - a.savedAt) });
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
  if (mA && req.method === 'GET') { const g = db.archive.find(a => a.id === Number(mA[1])); if (!g) return send(res, 404, { error: 'nicht gefunden' }); return send(res, 200, { game: { id: g.id, event: g.event, date: g.date, savedAt: g.savedAt, savedBy: g.savedBy, pumpen: g.pumpen, note: g.note }, eval: evalGame(g) }); }
  if (api === '/stats' && req.method === 'GET') return send(res, 200, computeStats());

  if (api === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'sync', v: db.version, sheet: db.sheet, roster: db.roster }) + '\n\n');
    const c = { res, uid: me.id }; clients.add(c); req.on('close', () => clients.delete(c)); return;
  }

  if (api === '/op' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' });
    return readJson(req, body => {
      if (!body || !body.op) return send(res, 400, { error: 'bad request' });
      const ctx = {};
      if (body.op.type === 'removePlayer') { const rp = db.sheet.players.find(p => p.id === body.op.id); ctx.removedName = rp ? rp.name : ''; }
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
function shutdown() { flushDb(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
