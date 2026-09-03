'use strict';
/*
 * Abhängigkeitsfreier QR-Code-Encoder (nur für den Bedarf dieser App).
 * Byte-Modus, Fehlerkorrektur-Level M, Versionen 1–10. Erzeugt eine Bitmatrix
 * bzw. ein eigenständiges SVG. Keine externen Pakete.
 */

// ---- Galois-Feld GF(256), Polynom 0x11d ----
const EXP = new Array(512), LOG = new Array(256);
(function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
function gmul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }
function rsGenPoly(deg) { let poly = [1]; for (let i = 0; i < deg; i++) { const np = new Array(poly.length + 1).fill(0); for (let j = 0; j < poly.length; j++) { np[j] ^= gmul(poly[j], 1); np[j + 1] ^= gmul(poly[j], EXP[i]); } poly = np; } return poly; }
function rsEncode(data, ecLen) { const gen = rsGenPoly(ecLen); const res = new Array(ecLen).fill(0); for (let i = 0; i < data.length; i++) { const factor = data[i] ^ res[0]; res.shift(); res.push(0); if (factor !== 0) for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor); } return res; }

// ---- Versionstabellen (ECC-Level M) ----
// ec = EC-Codewörter pro Block; groups = [[Blockanzahl, Daten-Codewörter/Block], ...]
const VER = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] }
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
function dataCwTotal(v) { return VER[v].groups.reduce((s, g) => s + g[0] * g[1], 0); }
function byteCapacity(v) { const bits = dataCwTotal(v) * 8; const count = v >= 10 ? 16 : 8; return Math.floor((bits - 4 - count) / 8); }
function chooseVersion(len) { for (let v = 1; v <= 10; v++) if (byteCapacity(v) >= len) return v; throw new Error('Daten zu lang für QR V1–10'); }

// ---- Datenkodierung (Byte-Modus) ----
function encodeData(bytes, v) {
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                       // Modus: Byte
  push(bytes.length, v >= 10 ? 16 : 8);  // Zeichenanzahl
  for (const b of bytes) push(b, 8);
  const totalBits = dataCwTotal(v) * 8;
  for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0); // Terminator
  while (bits.length % 8 !== 0) bits.push(0);                          // auf Byte-Grenze
  const cw = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }
  const pads = [0xEC, 0x11]; let pi = 0; while (cw.length < dataCwTotal(v)) { cw.push(pads[pi & 1]); pi++; }
  return cw;
}
function makeCodewords(text, v) {
  const dataCw = encodeData(text, v);
  const { ec, groups } = VER[v];
  const blocks = []; let pos = 0;
  for (const [n, dcw] of groups) for (let b = 0; b < n; b++) { const d = dataCw.slice(pos, pos + dcw); pos += dcw; blocks.push({ d, e: rsEncode(d, ec) }); }
  const maxD = Math.max.apply(null, blocks.map(b => b.d.length));
  const out = [];
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ---- Matrix / Funktionsmuster ----
function newMat(size) { const m = []; for (let i = 0; i < size; i++) { m.push(new Array(size).fill(0)); } return m; }
function placeFinder(m, res, r, c) {
  for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
    const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
    const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
    m[rr][cc] = on ? 1 : 0; res[rr][cc] = true;
  }
}
function buildFunctions(v) {
  const size = 21 + 4 * (v - 1); const m = newMat(size); const res = newMat(size).map(r => r.map(() => false));
  placeFinder(m, res, 0, 0); placeFinder(m, res, 0, size - 7); placeFinder(m, res, size - 7, 0);
  // Timing
  for (let i = 8; i < size - 8; i++) { const b = i % 2 === 0 ? 1 : 0; if (!res[6][i]) { m[6][i] = b; res[6][i] = true; } if (!res[i][6]) { m[i][6] = b; res[i][6] = true; } }
  // Alignment
  const ap = ALIGN[v];
  for (const r of ap) for (const c of ap) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const on = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0; m[r + i][c + j] = on; res[r + i][c + j] = true; }
  }
  // Dunkelmodul
  m[size - 8][8] = 1; res[size - 8][8] = true;
  // Format-Info-Bereiche reservieren
  for (let i = 0; i <= 8; i++) { if (!res[8][i]) res[8][i] = true; if (!res[i][8]) res[i][8] = true; }
  for (let i = 0; i < 8; i++) { res[8][size - 1 - i] = true; res[size - 1 - i][8] = true; }
  // Versions-Info-Bereiche (V7+)
  if (v >= 7) { for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { res[i][size - 11 + j] = true; res[size - 11 + j][i] = true; } }
  return { m, res, size };
}

// ---- Datenplatzierung (Zickzack) ----
function placeData(m, res, cw) {
  const size = m.length; const bits = []; for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let k = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let t = 0; t < size; t++) {
      const row = up ? size - 1 - t : t;
      for (let c2 = 0; c2 < 2; c2++) { const cc = col - c2; if (res[row][cc]) continue; m[row][cc] = k < bits.length ? bits[k] : 0; k++; }
    }
    up = !up;
  }
}

// ---- Masken ----
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

// ---- Format-/Versionsinfo ----
function bch15(data5) { let d = data5 << 10; for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10); return ((data5 << 10) | d) ^ 0x5412; }
function bch18(ver) { let d = ver << 12; for (let i = 17; i >= 12; i--) if ((d >> i) & 1) d ^= 0x1f25 << (i - 12); return (ver << 12) | d; }
function placeFormat(m, mask) {
  const size = m.length; const bits = bch15((0b00 << 3) | mask); // ECC M = 00
  const get = i => (bits >> (14 - i)) & 1; // Array-Index 0 = MSB (bit 14)
  // Kopie 1 (um oben-links)
  const p1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  for (let i = 0; i < 15; i++) { const [r, c] = p1[i]; m[r][c] = get(i); }
  // Kopie 2 (oben-rechts + unten-links)
  const p2 = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  for (let i = 0; i < 15; i++) { const [r, c] = p2[i]; m[r][c] = get(i); }
}
function placeVersion(m, v) {
  if (v < 7) return; const size = m.length; const bits = bch18(v);
  for (let i = 0; i < 18; i++) { const b = (bits >> i) & 1; const r = Math.floor(i / 3), c = i % 3; m[size - 11 + c][r] = b; m[r][size - 11 + c] = b; }
}

// ---- Penalty ----
function penalty(m) {
  const n = m.length; let p = 0;
  for (let r = 0; r < n; r++) { let run = 1; for (let c = 1; c < n; c++) { if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
  for (let c = 0; c < n; c++) { let run = 1; for (let r = 1; r < n; r++) { if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const pat = [1, 0, 1, 1, 1, 0, 1];
  const check = arr => { let cnt = 0; for (let i = 0; i + 7 <= arr.length; i++) { let ok1 = true, ok2 = true; for (let j = 0; j < 7; j++) { if (arr[i + j] !== pat[j]) ok1 = false; if (arr[i + j] !== pat[6 - j]) ok2 = false; } if ((ok1 && ((i + 7 + 4 <= arr.length && arr.slice(i + 7, i + 11).every(x => x === 0)) || (i - 4 >= 0 && arr.slice(i - 4, i).every(x => x === 0)))) ) cnt++; } return cnt; };
  for (let r = 0; r < n; r++) p += 40 * check(m[r]);
  for (let c = 0; c < n; c++) { const col = []; for (let r = 0; r < n; r++) col.push(m[r][c]); p += 40 * check(col); }
  let dark = 0; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c]; const ratio = dark / (n * n) * 100; p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

function applyMaskClone(base, res, mask, v) {
  const m = base.map(r => r.slice());
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (!res[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
  placeFormat(m, mask); placeVersion(m, v);
  return m;
}

function toBytes(str) { return Array.from(Buffer.from(String(str), 'utf8')); }

function qrMatrix(text, opts) {
  opts = opts || {};
  const bytes = toBytes(text);
  const v = opts.version || chooseVersion(bytes.length);
  const { m, res } = buildFunctions(v);
  placeData(m, res, makeCodewords(bytes, v));
  if (opts.mask != null) return applyMaskClone(m, res, opts.mask, v);
  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) { const cand = applyMaskClone(m, res, mask, v); const pp = penalty(cand); if (pp < bestP) { bestP = pp; best = cand; } }
  return best;
}

function qrSvg(text, opts) {
  opts = opts || {}; const quiet = opts.quiet != null ? opts.quiet : 4; const mat = qrMatrix(text, opts);
  const n = mat.length, dim = n + quiet * 2;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (mat[r][c]) rects += '<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1" height="1"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="Login-QR-Code">' +
    '<rect x="0" y="0" width="' + dim + '" height="' + dim + '" fill="#ffffff"/><g fill="#000000">' + rects + '</g></svg>';
}

module.exports = { qrMatrix, qrSvg, chooseVersion, byteCapacity };
