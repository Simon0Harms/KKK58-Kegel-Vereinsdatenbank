# KKk58 – Vereinsdatenbank (Anschreibliste)

Gemeinsame, mehrbenutzerfähige Anschreibliste:

- **Login pro Mitglied** (Passwörter als scrypt-Hash, signiertes Session-Cookie)
- **Eine gemeinsame Liste**, die jedes Mitglied bearbeiten kann
- **Live-Sync**: Änderungen erscheinen sofort bei allen (Server-Sent Events)
- **Spielerstamm**: eine Personendatenbank, aus der beim Anschreiben gewählt wird (Basis für die Statistik)
- **Archiv**: Spiele speichern und später als Snapshot wieder abrufen
- **Statistik**: Auswertung über alle gespeicherten Spiele (Ø-Punkte, Siege, Silber-/Pumpenkegel, Kasse …)
- **Keine externen Abhängigkeiten** – nur Node-Bordmittel, kein `npm install`, keine nativen Module
- **Speicher**: eine JSON-Datei (`data/db.json`, atomar geschrieben)

Erreichbar am Ziel unter: `https://nas.9w33icj4tty8y27z.myfritz.net/kkk58`

---

## 1. Installation im LXC

Voraussetzung: Node.js ≥ 18 (getestet mit v22). Debian/Ubuntu-LXC:

```bash
# Node prüfen/installieren
node --version || sudo apt update && sudo apt install -y nodejs
# Falls die Distro-Version < 18 ist, NodeSource verwenden:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# Dienstbenutzer + Zielverzeichnis
sudo useradd --system --home /opt/kkk58 --shell /usr/sbin/nologin kkk58
sudo mkdir -p /opt/kkk58

# Projektdateien nach /opt/kkk58 kopieren (server.js, public/, package.json)
# z.B. per scp das entpackte Verzeichnis, dann:
sudo cp -r server.js public package.json /opt/kkk58/
sudo mkdir -p /opt/kkk58/data
sudo chown -R kkk58:kkk58 /opt/kkk58
sudo chmod 750 /opt/kkk58/data
```

### Als systemd-Dienst starten

```bash
sudo cp /opt/kkk58/kkk58.service /etc/systemd/system/    # oder die mitgelieferte Datei
sudo systemctl daemon-reload
sudo systemctl enable --now kkk58

# Log ansehen – hier steht beim ERSTEN Start das Admin-Passwort:
sudo journalctl -u kkk58 -n 30 --no-pager
sudo cat /opt/kkk58/data/INITIAL-ADMIN.txt
```

> **Erst-Admin:** Ohne die Variablen `KKK_ADMIN_USER`/`KKK_ADMIN_PASS` erzeugt der
> Server beim ersten Start automatisch den Benutzer `admin` mit Zufallspasswort
> (im Log und in `data/INITIAL-ADMIN.txt`). Danach über die Weboberfläche
> (Panel „Mitglieder verwalten") das Passwort ändern und Mitglieder anlegen.

---

## 2. Konfiguration (Umgebungsvariablen)

| Variable         | Default        | Bedeutung |
|------------------|----------------|-----------|
| `PORT`           | `3000`         | HTTP-Port der App |
| `BIND`           | `127.0.0.1`    | Lausch-Adresse. Siehe Hinweis unten. |
| `BASE_PATH`      | `/kkk58`       | Unterpfad, unter dem alles läuft |
| `DATA_DIR`       | `./data`       | Speicherort für DB/Secret |
| `COOKIE_SECURE`  | `true`         | Session-Cookie nur über HTTPS (hinter NPM korrekt) |
| `SESSION_SECRET` | *(auto)*       | Wird sonst automatisch erzeugt & in `data/.session_secret` gespeichert |
| `KKK_ADMIN_USER` / `KKK_ADMIN_PASS` | – | Nur beim allerersten Start relevant |

**Wichtig – `BIND` (dieses Setup: NPMplus in separatem LXC):**
- Die App-LXC und der NPM-LXC sind getrennt → `BIND=0.0.0.0` (Default in der
  mitgelieferten `kkk58.service`), oder die konkrete IP dieser App-LXC.
  Mit `127.0.0.1` wäre die App vom NPM-LXC aus **nicht** erreichbar.
- Da Port 3000 damit im LAN offen ist, den Zugriff per Firewall auf den
  NPM-LXC beschränken – z. B. mit nftables/ufw auf der App-LXC:
  ```bash
  sudo ufw allow from NPM_LXC_IP to any port 3000 proto tcp
  sudo ufw deny 3000/tcp
  ```
  (`NPM_LXC_IP` = IP des NPMplus-LXC.)

---

## 3. NPMplus: Unterpfad `/kkk58` einrichten

Die App bedient bewusst den **kompletten** Pfad inkl. `/kkk58` (kein Strippen des
Präfix nötig). Wichtig ist, dass der Proxy die **SSE-Verbindung nicht puffert**,
sonst kommt der Live-Sync nicht durch.

> Hinweis: Die genauen Feldbezeichnungen in der NPMplus-Oberfläche kenne ich nicht
> mit Sicherheit und sie können je nach Version abweichen. Verlässlich ist die
> resultierende nginx-Konfiguration unten – deshalb ist der **direkte nginx-Weg**
> (Reiter „Advanced" des Proxy-Hosts) die empfohlene, eindeutige Methode.

### Empfohlen: „Advanced"-Snippet am bestehenden Proxy-Host

Beim Proxy-Host für `nas.9w33icj4tty8y27z.myfritz.net` in den Reiter
**Advanced / Custom Nginx Configuration** eintragen (IP der App-LXC einsetzen):

```nginx
# --- KKk58 Vereinsdatenbank unter /kkk58 ---
location /kkk58 {
    proxy_pass http://APP_LXC_IP:3000;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Wichtig für Server-Sent Events (Live-Sync):
    proxy_set_header Connection        "";
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding off;
}
```

- `APP_LXC_IP` = IP der LXC, in der **diese App** (nicht NPMplus) läuft.
- `proxy_pass` ohne Trailing-Slash und ohne Pfad → nginx hängt den Original-URI
  (inkl. `/kkk58`) an. Genau das erwartet die App.

### Alternative: „Custom Location" in der NPMplus-UI

Falls du die UI-Felder nutzen willst: eine Custom Location mit
**Location = `/kkk58`**, **Scheme = http**, **Forward Hostname = APP_LXC_IP**,
**Forward Port = 3000** anlegen und in deren Advanced-Feld die o. g.
SSE-Zeilen (`proxy_http_version 1.1;` … `proxy_read_timeout 3600s;`) eintragen.
Ergebnis muss der nginx-Block oben sein.

Das TLS-Zertifikat (Let's Encrypt) übernimmt wie gewohnt NPMplus für den Host.

---

## 4. Bedienung

- Aufruf: `https://nas.9w33icj4tty8y27z.myfritz.net/kkk58`
- Anmelden mit Mitglieds-Zugang.
- Jede Änderung (Namen, Zähler 9/⑧/Pump, Bahn-Ergebnisse, Preise, Notizen)
  wird sofort gespeichert und bei allen anderen live aktualisiert.
- **Silberkegel Ⓢ** = meiste Punkte, **Pumpenkegel Ⓟ** = meiste Pumpen
  (bei Gleichstand: wenigste Punkte). Beides wird automatisch ermittelt.
- **Kasse:** 9en/Kränze zahlen jeweils die *anderen* Mitspieler,
  Pumpen zahlt jede/r selbst. Preise unten einstellbar.
- **Verwaltungsrechte** (Panel „Login-Konten verwalten": Konten anlegen/löschen,
  Berechtigung ändern, Passwort/Einladungslink, Spielerstamm verwalten, „Liste zurücksetzen",
  Archiv-Spiele löschen) haben die Gruppen **Admin, Kassenwart, Mitglied**.
- Drucken/PDF und JSON-Snapshot (Backup) oben rechts.

### Berechtigungsgruppen

Es gibt vier Gruppen. **Admin, Kassenwart und Mitglied** besitzen derzeit **identische,
volle Verwaltungsrechte**; **beschränkt** darf nur die gemeinsame Liste und den Spielerstamm
bearbeiten, aber keine Konten/Reset/Archiv-Löschungen.

| Gruppe | Liste bearbeiten | Verwaltung (Konten, Reset, Stamm-Löschung, Archiv) |
| --- | --- | --- |
| Admin | ✓ | ✓ |
| Kassenwart | ✓ | ✓ |
| Mitglied | ✓ | ✓ |
| beschränkt | ✓ | — |

> Die drei verwaltenden Gruppen sind heute rechtlich gleichgestellt – die Trennung ist
> vorbereitet, um später einzelne Rechte je Gruppe zu differenzieren (z. B. Kassenwart nur
> Kasse). Intern heißen die Rollen `admin`, `kassenwart`, `mitglied`, `beschraenkt`.
> Bestehende Konten der alten Rolle `member` werden beim Update automatisch zu **beschränkt**
> (die effektiven Rechte bleiben dadurch unverändert). Es bleibt stets **mindestens ein
> verwaltungsberechtigtes Konto** erhalten (Löschen/Herabstufen des letzten wird verweigert).
> Die Berechtigung bestehender Konten lässt sich im Panel per Auswahl ändern
> (`POST /api/users/:id/role`).

### Neue Konten per Einladungslink (QR)

Beim Anlegen eines Kontos wird **kein Passwort** mehr vergeben. Stattdessen erzeugt
der Server einen **einmaligen Login-Link**, der als **QR-Code** und als kopierbarer
Link angezeigt wird. Der Link ist **bis zum Ende des heutigen Tages** und **genau
einmal** gültig. Die eingeladene Person scannt den QR (oder öffnet den Link), bestätigt
die Anmeldung und wird dann **zwingend aufgefordert, ein eigenes Passwort zu setzen**,
bevor die App nutzbar ist. Für bestehende Konten (z. B. Passwort vergessen) lässt sich
über „Link" jederzeit ein neuer Einmal-Link erzeugen.

Der QR-Code wird **serverseitig ohne externe Bibliothek** erzeugt (`qr.js`, Byte-Modus,
Fehlerkorrektur-Level M) und als SVG ausgeliefert – passend zur strikten CSP der App.
Der vollständige Link wird im Browser aus der aktuell aufgerufenen Adresse gebildet und
funktioniert daher auch hinter dem NPMplus-Proxy.

## 5. Backup / Wiederherstellung

- Alle Daten liegen in `DATA_DIR` (`db.json`, `.session_secret`).
- Backup: `data/`-Verzeichnis sichern (z. B. per CheckMK-Host-Backupjob).
- Wiederherstellen: Dienst stoppen, `db.json` zurückspielen, Dienst starten.

## 6. Update

Dateien in `/opt/kkk58` ersetzen (nicht `data/`), dann
`sudo systemctl restart kkk58`.

---

## Sicherheitshinweise / Grenzen (ehrlich)

- Passwörter: scrypt mit Salt, konstantzeitiger Vergleich. Session-Cookie
  HMAC-signiert, `HttpOnly`, `SameSite=Lax`, `Secure` (hinter HTTPS).
- CSRF: zustandsändernde Aufrufe verlangen den Header `X-Requested-With: fetch`
  (per Fetch gesetzt, Cross-Site ohne CORS nicht setzbar). Kein Token-Verfahren.
- Konfliktbehandlung: Zähler werden als **Deltas** übertragen (addierend, keine
  verlorenen Klicks); Text-/Punktfelder sind **last-write-wins** pro Feld.
  Bei paralleler Bearbeitung *desselben* Feldes gewinnt der letzte Stand.
- Kein HA/Clustering, eine Instanz, eine JSON-Datei – für einen Verein
  ausreichend, aber nicht für hohe Last ausgelegt.

---

## Spielerstamm, Archiv & Statistik

### Spielerstamm (Personen ≠ Login-Konten)
Der **Spielerstamm** ist eine Liste von *Personen* (Kegler, auch Gäste ohne Login).
Er ist bewusst **getrennt von den Login-Konten**: Logins regeln, *wer die Liste bearbeiten darf*;
der Stamm regelt, *wer angeschrieben wird*. So braucht nicht jeder Kegler ein eigenes Konto.

- Zur Liste können **nur Spieler hinzugefügt werden, die im Stamm gelistet sind**.
  Man wählt sie über das Namensfeld (Vorschlagsliste aus dem Stamm).
- Tippt man einen **Namen, der noch nicht im Stamm steht**, erscheint eine Rückfrage
  „… zum Stamm hinzufügen und anschreiben?". Erst bei Bestätigung wird die Person angelegt
  und aufgenommen – ohne Bestätigung passiert nichts (kein stilles Anlegen mehr).
- **Neue Spieler anlegen** (über diese Rückfrage oder das Stamm-Panel) darf **jedes Mitglied**.
- **Umbenennen, Deaktivieren und Löschen** im Stamm nur mit **Verwaltungsrecht** (Admin, Kassenwart, Mitglied; Panel „Spielerstamm").
- **Inaktive Spieler**: Wird eine als inaktiv markierte Person angeschrieben (sie erscheint in der
  Vorschlagsliste mit dem Zusatz „(inaktiv)"), erscheint eine **Warnung** und sie wird erst nach
  Bestätigung aufgenommen.
- **Austrittsdatum**: Beim Deaktivieren kann ein Datum „ausgeschieden am" angegeben werden
  (nachträglich änderbar über „Austrittsdatum"); beim Reaktivieren wird es wieder entfernt.
  Gespeichert als `roster[].leftAt` (`YYYY-MM-DD` | null).
- Die Statistik gruppiert über die feste Spieler-ID. Umbenennen oder Löschen im Stamm
  zerstört daher **keine** früheren Auswertungen (archivierte Spiele speichern den Namen mit).

### Reihenfolge des Eintreffens
Die Reihenfolge, in der Spieler zur Liste hinzugefügt werden, ist die **Ankunftsreihenfolge**
(sie spiegelt das Eintreffen der Mitglieder wider). Sie wird **nicht** verändert und mit jedem
Spiel ins Archiv übernommen.

- In der aktiven Liste schaltet der **Umschalter „Reihenfolge: Eintreffen | Punkte"** die
  Anzeige zwischen Ankunftsreihenfolge und absteigenden Punkten um. Das ist eine reine
  **Anzeige-Einstellung pro Person** – sie ändert weder die gespeicherte Reihenfolge noch die
  Ansicht der anderen. (Die frühere feste Umsortierung „nach Platz" entfällt dadurch.)
- In der Punkte-Ansicht wird beim Umschalten sortiert; während des Eintippens springen die
  Zeilen nicht. Erneutes Antippen von „Punkte" sortiert neu.
- Im Archiv-Detail zeigt die Spalte **„Ank."** die gespeicherte Ankunftsposition.

### Ein Spiel speichern (Archiv)
- Button **„💾 Spiel speichern"** legt die aktuelle Liste als **Snapshot** ins Archiv
  (mit Datum, Anlass, allen Werten, Ankunftsreihenfolge, Kasse und Auswertung). Das darf **jedes Mitglied**.
- Die **Live-Liste bleibt nach dem Speichern stehen**. Es folgt die Abfrage
  „Neues Spiel beginnen?" – bestätigt man, wird die Liste geleert (Op `newGame`),
  bricht man ab, kann weitergespielt werden.
- Im Tab **„Archiv"** werden alle gespeicherten Spiele (neueste zuerst) als Karten gezeigt;
  ein Klick öffnet die schreibgeschützte Detailansicht. **Löschen aus dem Archiv** nur **Admin**.
- Der Button **„⬇ Alle Spiele als HTML exportieren"** (oben im Archiv-Tab) lädt eine
  **eigenständige HTML-Datei** herunter (`KKk58-Archiv-JJJJ-MM-TT.html`, CSS eingebettet,
  offline nutzbar und druckbar). Sie enthält eine Kopf-Zusammenfassung, die Gesamtstatistik
  und alle Spiele chronologisch mit voller Detailtabelle (inkl. Ankunft und Kasse).
  Der Export wird **serverseitig** aus denselben Daten erzeugt (`GET /api/export`).

### Statistik
Tab **„Statistik"** wertet **alle** archivierten Spiele je Spieler aus:

| Spalte | Bedeutung |
|---|---|
| Sp. | Anzahl gespielter Spiele |
| Ø Pkt | Durchschnittspunkte je Spiel |
| Best | bestes Gesamtergebnis in einem Spiel |
| Beste Bo / Beste Sc | bester Einzelwurf je Bahn (aus Spielen mit dieser Bahn; „–" = nie gespielt) |
| 9 / ⑧ / Pump | Summe Neuner / Kränze / Pumpen |
| Ⓢ / Ⓟ | Anzahl Silberkegel- / Pumpenkegel-Siege |
| Siege | Anzahl 1. Plätze |
| Ø Ank. | durchschnittliche Ankunftsposition (1 = kam immer zuerst) |
| 1. da | wie oft als Erster eingetroffen |
| Kasse | insgesamt gezahlter Kassenbetrag |

Über der Tabelle schaltet **„Rangliste: Ø Punkte | Beste"** die Sortierung um – nach
Durchschnittspunkten oder nach dem jemals besten Gesamtergebnis; die Spalte **#** zeigt den
zugehörigen Rang (bei Gleichstand geteilt). Der Umschalter wirkt lokal und ohne Server-Abruf.

Oben eine Zusammenfassung (Anzahl Spiele, Zeitraum, Gesamtkasse, Spieleranzahl).
Alle Berechnungen laufen **serverseitig** (eine Quelle der Wahrheit); der Browser zeigt nur an.
Hinweis: **Ø Ank.** hängt von der Teilnehmerzahl je Abend ab (bei mehr Spielern sind höhere
Positionen möglich).

### Datenmodell (Ergänzung in `data/db.json`)
- `roster: [{id, name, active}]` – Spielerstamm, `seqRoster`
- `sheet.players[].rosterId` – Verweis vom Listenspieler auf den Stamm
- `archive: [{id, savedAt, savedBy, event, date, lanes, priceNK, pricePump, pumpen, note,
  players:[{rosterId, name, c9, cK, cP, b1, b2, s1, s2}]}]` – gespeicherte Spiele, `seqArchive`

Neue Operationen (alle live-synchronisiert): `addRoster`, `renameRoster` (Admin),
`setRosterActive` (Admin), `removeRoster` (Admin), `saveGame`, `deleteGame` (Admin), `newGame`.
Neue Lese-Endpunkte: `GET /api/roster`, `/api/archive`, `/api/archive/:id`, `/api/stats`.

---

## Login-Konten mit Personen verknüpfen & Änderungsverlauf

### Optionale Zuordnung Konto ↔ Stamm-Person
Ein Login-Konto kann **optional** einer Person aus dem Spielerstamm zugeordnet werden.
Die Zuordnung ist freiwillig: Gäste ohne Login und Konten ohne zugeordnete Person bleiben möglich.

- Im Admin-Panel „Login-Konten" gibt es je Konto eine Auswahl **Person (Stamm)**;
  auch beim Anlegen eines Kontos lässt sich direkt eine Person wählen.
- Die Zuordnung ist **eindeutig** (1:1): eine Person kann höchstens einem Konto zugeordnet sein
  (Versuch einer Doppelzuordnung → Fehlermeldung).
- Wird eine Person aus dem Stamm gelöscht, wird eine bestehende Konto-Zuordnung automatisch gelöst.
- Technisch: `users[].rosterId` (Number | null). Endpunkt `POST /api/users/:id/link`
  mit `{ "rosterId": <id|null> }`.

### Änderungsverlauf
Der Server protokolliert **jede Änderung an der Liste** (wer, wann, was) in `data/db.json`
unter `log` (Ringpuffer, max. 400 Einträge). Angezeigt wird der Verlauf im aufklappbaren
Panel **„Änderungsverlauf"** – **für alle angemeldeten Mitglieder** sichtbar (nicht Admin-only).

- Pro Eintrag: Zeitpunkt, handelnde **Person** (Login in Klammern; nur Login, falls keine Person
  zugeordnet) und eine kurze Beschreibung (z. B. „Anna Meier: B1 = 150", „Spiel gespeichert").
- Live: neue Einträge erscheinen sofort bei allen (über denselben SSE-Kanal wie die Listen-Updates).
- Wirkungslose Aktionen (z. B. ein Zähler-Minus, der bei 0 nichts ändert) werden nicht protokolliert.
- Endpunkt `GET /api/log` (neueste zuerst, letzte 200).

### Einladungslinks, QR & Erstanmeldung (Technik)

- `POST /api/users` legt ein Konto **ohne Passwort** an (Server vergibt intern ein
  Zufallspasswort, Flag `mustChangePassword=true`) und liefert `{ user, invite:{ token, expires } }`.
- `POST /api/users/:id/invite` erzeugt für ein **bestehendes** Konto einen neuen Einmal-Link.
- Einladungen liegen in `data/db.json` unter `invites` (`{ token, userId, expires, used }`);
  abgelaufene/verbrauchte werden beim Laden verworfen. `token` = 16 Zufalls-Bytes (base64url),
  `expires` = heute 23:59:59 lokaler Zeit, Einlösung ist **einmalig**.
- `GET /api/invite/check?token=…` (ohne Login) liefert den Benutzernamen für den Bestätigungs-Screen,
  **ohne** die Einladung zu verbrauchen. `POST /api/invite/redeem { token }` löst ein, meldet an
  und setzt `mustChangePassword`. Zum Schutz gegen Link-Vorschau wird erst nach bewusstem Klick eingelöst.
- `POST /api/me/password { newPassword, currentPassword? }`: Bei erzwungener Erständerung ist kein
  aktuelles Passwort nötig; sonst wird es geprüft. Danach ist das Flag gelöscht.
- `GET /api/qr?data=…` (angemeldet) rendert beliebigen Text als QR-SVG über `qr.js`.
- Der QR-Encoder `qr.js` ist eigenständig (keine Abhängigkeit) und wurde Zelle für Zelle gegen
  eine Referenzbibliothek (Versionen 1–10, alle Masken) sowie per Decoder-Roundtrip verifiziert.

## Kasse / Kassenbuch

Den Reiter **„Kasse"** können **alle angemeldeten Konten sehen** (auch „Mitglied" und
„beschränkt") – die Ansicht ist reines Lesen. **Buchen und Einstellungen sind ausschließlich
Admin und Kassenwart** vorbehalten (`canCash`); für Nur-Lese-Rollen sind sämtliche Aktionen
(Zahlung, Anfangsbestand, Korrektur, Abwesenheit buchen, Storno, Einstellungen) ausgeblendet
und werden serverseitig mit 403 abgewiesen. Die **offenen Abwesenheiten** sind dagegen auch
für Nur-Lese-Rollen sichtbar (nur ohne den „buchen"-Button). Der **automatische Beitragslauf** läuft nur bei
einem Zugriff mit Schreibrecht mit – ein Nur-Lese-Aufruf verändert die Daten nie. Alle Beträge
werden intern in **Cent (ganzzahlig)** gespeichert, um Rundungsfehler zu vermeiden.

### Zwei Kennzahlen
- **Kassenbestand (Bargeld):** Anfangsbestand der Kasse **+ eingegangene Zahlungen**.
  Das ist das real vorhandene Geld – offene Forderungen zählen hier **nicht** mit.
- **Offene Forderungen:** Summe aller positiven Personen-Salden (was Mitglieder noch schulden).

### Personen-Saldo
Pro Stamm-Person ein laufender Saldo = Anfangsbestand + Monatsbeiträge + Abwesenheits-Strafen
+ Spielabrechnungen − Zahlungen. Positiv = die Person schuldet dem Verein; negativ = Guthaben.

### Beitragspflicht (`duesLiable`)
Jede Stamm-Person hat im Stamm-Panel ein Flag **„Beitrag ein/aus"** (Vorgabe: ein).
Nur **aktive, beitragspflichtige** Personen erhalten Monatsbeiträge und Abwesenheits-Vorschläge –
so bleiben Gäste außen vor.

### Automatischer Monatsbeitrag
Beim Öffnen der Kasse (und bei Server-Start) werden für jede aktive, beitragspflichtige Person
alle noch **offenen Monate ab dem Startmonat** mit dem Beitrag (Vorgabe 20 €) gebucht
(Buchungsart `fee`, `meta.month` als Doppelbuchungsschutz). Ist kein Startmonat gesetzt, wird
er beim ersten Lauf auf den **aktuellen** Monat gesetzt (kein rückwirkendes Nachbuchen).
Für ausgetretene Personen endet die Buchung im Austrittsmonat.
Automatische Beiträge lassen sich **nicht einzeln stornieren** (sie würden neu gebucht) –
stattdessen eine **Korrektur** buchen oder die Beitragspflicht deaktivieren.

### Abwesenheits-Strafe (vorschlagen → bestätigen)
Ein **Kegeltermin** = ein Datum mit mindestens einem archivierten Spiel. Anwesend ist, wer an
diesem Datum in einem Spiel stand. Die Kasse schlägt je Termin die **abwesenden** aktiven,
beitragspflichtigen Mitglieder vor; per Klick bucht der Kassenwart die Strafe (Vorgabe 1 €,
Buchungsart `absence`, `meta.date`, Doppelbuchungsschutz). Bereits nach Austritt liegende
Termine werden ausgenommen. Storniert man eine Strafe, taucht der Termin wieder als Vorschlag auf.

### Spielabrechnung (automatisch)
Beim **Speichern eines Spiels** wird die Spielkasse jeder teilnehmenden Person (9er/Kränze der
anderen + eigene Pumpen) automatisch ihrem Konto belastet (Buchungsart `game`, `meta.archiveId`).
Wird das Spiel im Archiv **gelöscht**, werden diese Buchungen automatisch **storniert**.
Einzeln (außerhalb des Archivs) sind `game`-Buchungen nicht löschbar.

### Anfangsbestände
- **Pro Person:** „Anfang" im Mitglieder-Bereich – positiver Betrag = Startschuld,
  negativer = Startguthaben (Buchungsart `opening`, pro Person genau einer, erneutes Setzen ersetzt).
- **Gesamtkasse:** in den Einstellungen „Anfangsbestand Kasse setzen" (Buchungsart `openingCash`,
  `rosterId=null`, genau einer).

### Zahlungen & Korrekturen
- **Zahlung** (`payment`): Betrag > 0, mit Datum und optionaler Notiz. Reduziert den Saldo der
  Person und **erhöht den Kassenbestand**.
- **Korrektur** (`adjust`): frei vorzeichenbehaftete Buchung auf ein Personenkonto (z. B. Kulanz).

### Endpunkte (`GET /api/cash` = alle Angemeldeten lesend; Schreibzugriffe nur `canCash` = Admin/Kassenwart, same-origin)
- `GET  /api/cash` – Übersicht (löst den Beitragslauf aus): `settings`, `cashOnHand`, `openClaims`,
  `persons[]`, `entries[]` (letzte 80), `absence[]` (offene Vorschläge).
- `POST /api/cash/payment { rosterId, euro, date?, note? }`
- `POST /api/cash/opening { rosterId|null, euro, note? }`
- `POST /api/cash/adjust  { rosterId, euro, note }`
- `POST /api/cash/absence { date, rosterIds? }` – bucht offene Abwesende des Termins (optional Teilmenge)
- `POST /api/cash/settings { duesEuro?, absenceEuro?, duesStartMonth? }`
- `DELETE /api/cash/entry/:id` – Storno (lehnt `fee` und `game` mit 422 ab)

### Datenmodell (Ergänzung in `data/db.json`)
- `ledger[]`: `{ id, ts, date, rosterId, kind, amount(Cent), note, by, meta? }`
  mit `kind ∈ {opening, openingCash, fee, absence, game, payment, adjust}`.
  `amount` = Wirkung auf den Personen-Saldo (Zahlung negativ).
- `seqLedger`, `cashSettings { duesCent, absenceCent, duesStartMonth }`.
- Stamm-Einträge zusätzlich: `duesLiable` (Vorgabe `true`).

## Fokus-Modus (nur die Liste – für Smartphone/Tablet)

Im Reiter **„Anschreiben"** gibt es den Button **„⛶ Nur Liste"**. Er blendet Kopfzeile,
Menü, Bahn-/Preis-Einstellungen, Spielkasse und alle Panels aus, sodass nur noch die
**Anschreib-Tabelle**, die Silber-/Pumpenkegel-Leiste und die Zeile zum Hinzufügen von
Spielern sichtbar sind – ideal zum Eintragen auf dem Tablet.

Oben erscheint eine schmale, mitscrollende Leiste mit Anlass/Datum sowie den Buttons
**„💾 Speichern"** und **„✕ Menü"** (Fokus verlassen). Der Modus wird pro Gerät im Browser
gemerkt (`localStorage`), sodass ein Tablet nach dem Neuladen direkt wieder im Eintrag-Modus
startet. Ein Wechsel in einen anderen Reiter beendet den Fokus-Modus automatisch.

## GnuCash-Export

In der Kasse gibt es den Button **„⬇ GnuCash-Export (.gnucash)"**. Er ist für **alle
angemeldeten Rollen** verfügbar (reiner Lese-Export, verändert nichts) und lädt die Kasse als
**unkomprimierte GnuCash-XML-Datei** herunter, die GnuCash direkt öffnen kann.

Der Export bildet die Kasse als **doppelte Buchführung** ab (jede Buchung balanciert auf 0):

- **Aktiva → Kasse (Bargeld)** – der Bargeldbestand.
- **Aktiva → Forderungen an Mitglieder → [je Person ein Konto]** – der Saldo jeder Person.
- **Erträge → Mitgliedsbeiträge / Abwesenheitsstrafen / Spielabrechnung / Korrekturen**.
- **Eigenkapital → Anfangsbestände** – für die dokumentierten Anfangsbestände.

Zuordnung der Buchungen: Beitrag/Strafe/Spiel/Korrektur = Forderung an die Person gegen das
jeweilige Ertragskonto; Zahlung = Kasse gegen Forderung; Anfangsbestand (Person bzw. Kasse) =
Konto gegen Eigenkapital. Beträge stehen als Cent-Brüche (`…/100`). Endpunkt:
`GET /api/cash/gnucash` (alle Angemeldeten). Der Export ist ein Momentaufnahme-Snapshot und
stößt **keinen** automatischen Beitragslauf an.

> Hinweis: Die Datei wurde strukturell und buchhalterisch geprüft (wohlgeformtes XML, jede
> Transaktion ausgeglichen, Salden identisch mit der App-Ansicht). Ein finaler Gegencheck durch
> tatsächliches Öffnen in GnuCash wird empfohlen.

## Ausgaben aus der Kasse (z. B. Kegelfahrt)

Admin und Kassenwart können in der Kasse über **„＋ Ausgabe buchen"** eine Ausgabe erfassen
(Betrag, Datum, Zweck). Die Ausgabe **verringert den Bargeldbestand** und wird als Aufwand
gebucht (Buchungsart `expense`, `rosterId=null`).

Im Dialog lässt sich angeben, **wer von der Ausgabe profitiert hat** (Mehrfachauswahl aus dem
Spielerstamm). Das dient ausschließlich der **Statistik** – die Begünstigten werden **nicht**
belastet (keine Umlage). Der Ausgabebetrag wird für die Nutzen-Statistik gleichmäßig auf die
gewählten Begünstigten verteilt; die Kasse zeigt unter **„Ausgaben & Nutzen"** je Person die
Summe des Nutzens (für alle Rollen sichtbar). Eine dritte Kennzahl **„Ausgaben gesamt"** ergänzt
Kassenbestand und offene Forderungen.

Für den Ausgabebetrag gibt es eine einstellbare Vorgabe (Standard 35 €), die den Dialog vorbelegt (Einstellung „Standard-Ausgabe"). Eine bereits gebuchte Ausgabe lässt sich von Admin/Kassenwart nachträglich bearbeiten (Betrag erhöhen/senken, Zweck, Datum und Begünstigte) – Bargeldbestand und Nutzen-Statistik werden dabei automatisch neu berechnet.

Endpunkt: `POST /api/cash/expense { euro, date?, note, beneficiaries?[] }` (nur `canCash`). Bearbeiten: `POST /api/cash/expense/:id { euro, date?, note?, beneficiaries?[] }`.
Ausgaben lassen sich im Kassenbuch einzeln stornieren. Im **GnuCash-Export** erscheinen sie als
Buchung **Ausgaben (EXPENSE) gegen Kasse**; die Begünstigten stehen in der Buchungsbeschreibung.
