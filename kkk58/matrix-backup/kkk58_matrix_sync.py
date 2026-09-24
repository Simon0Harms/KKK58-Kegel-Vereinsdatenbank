#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KKk58 Matrix-Sidecar
====================
Protokolliert jede Änderung der KKk58-Vereinsdatenbank in einen Matrix-Raum und
lädt nach Änderungen ein Ende-zu-Ende-verschlüsseltes Backup (db.json) hoch.

Der Dienst LIEST nur die von der Node-App geschriebene Datei ``data/db.json`` –
die eigentliche App bleibt dadurch unverändert und abhängigkeitsfrei.

Verschlüsselung: Der Ziel-Raum muss in Matrix E2EE-aktiviert sein. Der Bot sendet
dann automatisch verschlüsselt; Dateien werden mit ``encrypt=True`` hochgeladen und
sind nur für die Raummitglieder lesbar. Ist der Raum NICHT verschlüsselt und
``KKK_REQUIRE_ENCRYPTION`` nicht auf ``0`` gesetzt, sendet der Dienst nichts
(Schutz vor versehentlichem Klartext).

Konfiguration über Umgebungsvariablen – siehe env.example und README.md.
"""

import asyncio
import gzip
import json
import os
import re
import sys
import time
from datetime import datetime

try:
    from nio import (
        AsyncClient, AsyncClientConfig, LoginResponse, RoomSendResponse,
        RoomInviteResponse, RoomMessageText, RoomMessageNotice, RoomMessageEmote,
        MegolmEvent,
    )
except ImportError:
    sys.stderr.write(
        "Fehlt: matrix-nio mit E2EE. Bitte installieren:\n"
        "  pip install \"matrix-nio[e2e]\"\n"
        "(benötigt libolm, z. B. 'apt install libolm-dev' vor der Installation)\n"
    )
    raise


# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# .env-Datei laden (damit auch ein direkter Start ohne systemd funktioniert)
# ---------------------------------------------------------------------------
def _parse_env_value(val):
    val = val.strip()
    if val[:1] in ("'", '"'):
        q = val[0]
        end = val.find(q, 1)
        return val[1:end] if end != -1 else val[1:]
    # Inline-Kommentar (Leerraum gefolgt von #) abschneiden
    out = []
    for i, ch in enumerate(val):
        if ch == "#" and (i == 0 or val[i - 1].isspace()):
            break
        out.append(ch)
    return "".join(out).strip()


def load_env_file(path):
    """Liest KEY=VALUE-Zeilen aus einer env-Datei in os.environ (bereits gesetzte
    Umgebungsvariablen haben Vorrang). Ignoriert Kommentare und Inline-Kommentare."""
    if not path or not os.path.isfile(path):
        return 0
    n = 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s[0] in "#;":
                continue
            if s.startswith("export "):
                s = s[7:]
            if "=" not in s:
                continue
            key, val = s.split("=", 1)
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = _parse_env_value(val)
                n += 1
    return n


def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and (v is None or v == ""):
        sys.stderr.write(f"Konfiguration fehlt: {name}\n")
        sys.exit(2)
    return v


class Config:
    def __init__(self):
        self.homeserver = env("KKK_MATRIX_HOMESERVER", required=True)   # https://matrix.example.org
        self.user_id = env("KKK_MATRIX_USER", required=True)            # @kkk58bot:example.org
        self.password = env("KKK_MATRIX_PASSWORD")                      # nur beim Erststart nötig
        self.room = env("KKK_MATRIX_ROOM", required=True)              # !id:server  oder  #alias:server
        self.db_file = env("KKK_DB_FILE", "/opt/kkk58/data/db.json")
        # Outbox-Spool: von der Node-App abgelegte Sende-Aufträge (Codes/Login-Links).
        # Standard: <db-Verzeichnis>/matrix-outbox
        self.outbox_dir = env("KKK_OUTBOX_DIR", os.path.join(os.path.dirname(self.db_file) or ".", "matrix-outbox"))
        self.outbox_ttl = int(env("KKK_OUTBOX_TTL", "900"))            # Aufträge älter als X Sek. verwerfen (Codes/Links sind dann ohnehin abgelaufen)
        self.outbox_max_attempts = int(env("KKK_OUTBOX_MAX_ATTEMPTS", "5"))
        # Eingangs-Spool (Gegenrichtung): Nachrichten mit Verknüpfungscode aus privaten
        # Bot-Chats; die Node-App liest und löscht sie. Muss mit deren KKK_INBOX_DIR übereinstimmen.
        self.inbox_dir = env("KKK_INBOX_DIR", os.path.join(os.path.dirname(self.db_file) or ".", "matrix-inbox"))
        self.link_max_age = int(env("KKK_LINK_MAX_AGE", "300"))  # ältere Code-Nachrichten ignorieren (Sek.)
        self.store_path = env("KKK_MATRIX_STORE", "/opt/kkk58/matrix-store")
        self.state_file = env("KKK_MATRIX_STATE", "/opt/kkk58/matrix-store/sidecar-state.json")
        self.poll_seconds = int(env("KKK_POLL_SECONDS", "15"))
        self.backup_interval = int(env("KKK_BACKUP_MIN_INTERVAL", "300"))  # Sek.; 0 = nach jeder Änderung
        self.device_name = env("KKK_MATRIX_DEVICE_NAME", "KKk58-Backup")
        self.require_encryption = env("KKK_REQUIRE_ENCRYPTION", "1") != "0"
        self.max_lines = int(env("KKK_MAX_LOG_LINES", "40"))  # max. Zeilen pro Protokoll-Nachricht
        # Nachrichten-Feed für die Webapp-Unterseite „Matrix-Raum": entschlüsselte
        # Textnachrichten des Raums werden hier (chronologisch, eine JSON-Zeile je
        # Nachricht) abgelegt. Die Node-App liest die Datei nur; muss mit deren
        # KKK_FEED_FILE übereinstimmen. Standard: <db-Verzeichnis>/matrix-feed.jsonl
        self.feed_file = env("KKK_FEED_FILE", os.path.join(os.path.dirname(self.db_file) or ".", "matrix-feed.jsonl"))
        self.feed_max = int(env("KKK_FEED_MAX", "1000"))  # max. Nachrichten im Feed (älteste werden verworfen)


# ---------------------------------------------------------------------------
# Reine Logik (ohne Matrix – testbar)
# ---------------------------------------------------------------------------
KIND_DE = {
    "fee": "Monatsbeitrag", "absence": "Abwesenheit", "game": "Spielabrechnung",
    "payment": "Zahlung", "opening": "Anfangsbestand", "openingCash": "Anfangsbestand Kasse",
    "adjust": "Korrektur", "expense": "Ausgabe",
}


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def hhmm(ms):
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%d.%m. %H:%M")
    except (OSError, OverflowError, ValueError):
        return "?"


def euro(cent):
    return f"{(cent or 0) / 100:.2f}".replace(".", ",") + " €"


def format_log_entry(e):
    who = e.get("user") or "?"
    return f"• {hhmm(e.get('ts', 0))} · {who}: {e.get('text', '')}"


def format_ledger_entry(e):
    kind = KIND_DE.get(e.get("kind"), e.get("kind", "?"))
    amt = e.get("amount", 0)
    sign = "−" if (amt < 0 or e.get("kind") == "expense") else ""
    val = euro(abs(amt))
    note = e.get("note") or ""
    by = e.get("by") or "?"
    return f"• {hhmm(e.get('ts', 0))} · Kasse [{kind}]: {sign}{val} {note} (von {by})"


def select_new(db, state):
    """Liefert die seit dem letzten Lauf neuen Log- und Ledger-Einträge sowie die
    fortgeschriebenen Marker. Beim allerersten Lauf (keine Marker) wird nichts
    nachgepostet – es werden nur die aktuellen Höchststände als Startpunkt gesetzt."""
    log = db.get("log", []) or []
    ledger = db.get("ledger", []) or []
    first_run = "log_ts" not in state and "ledger_id" not in state

    if first_run:
        markers = {
            "log_ts": max([e.get("ts", 0) for e in log], default=0),
            "ledger_id": max([e.get("id", 0) for e in ledger], default=0),
        }
        return [], [], markers

    last_log_ts = state.get("log_ts", 0)
    last_ledger_id = state.get("ledger_id", 0)
    new_log = [e for e in log if e.get("ts", 0) > last_log_ts]
    new_ledger = [e for e in ledger if e.get("id", 0) > last_ledger_id]
    new_log.sort(key=lambda e: e.get("ts", 0))
    new_ledger.sort(key=lambda e: e.get("id", 0))
    markers = {
        "log_ts": max([e.get("ts", 0) for e in log] + [last_log_ts]),
        "ledger_id": max([e.get("id", 0) for e in ledger] + [last_ledger_id]),
    }
    return new_log, new_ledger, markers


def build_message(lines, max_lines):
    if not lines:
        return None
    total = len(lines)
    if total > max_lines:
        shown = lines[-max_lines:]
        head = f"🎳 KKk58 – {total} Änderungen (letzte {max_lines}):"
        return head + "\n" + "\n".join(shown)
    head = f"🎳 KKk58 – {total} Änderung" + ("en" if total != 1 else "") + ":"
    return head + "\n" + "\n".join(lines)


ROLE_DE = {"admin": "Admin", "kassenwart": "Kassenwart", "mitglied": "Mitglied", "beschraenkt": "beschränkt"}


def _role_de(r):
    return ROLE_DE.get(r, r or "?")


def format_user_line(text):
    return "• " + hhmm(int(time.time() * 1000)) + " · Konten: " + text


def diff_users(prev_snap, current_users):
    """Vergleicht die users-Liste mit dem letzten Snapshot und meldet
    angelegte/gelöschte Konten sowie Rollenwechsel. Beim ersten Lauf (kein
    Snapshot) wird nur der Ausgangszustand festgehalten, ohne zu posten."""
    cur = {str(u.get("id")): {"username": u.get("username", "?"), "role": u.get("role", "?")}
           for u in (current_users or []) if u.get("id") is not None}
    if prev_snap is None:
        return [], cur
    lines = []
    for uid, u in cur.items():
        if uid not in prev_snap:
            lines.append(format_user_line(f"Konto angelegt: {u['username']} ({_role_de(u['role'])})"))
        elif prev_snap[uid].get("role") != u["role"]:
            lines.append(format_user_line(
                f"Rolle geändert: {u['username']}: {_role_de(prev_snap[uid].get('role'))} → {_role_de(u['role'])}"))
    for uid, u in prev_snap.items():
        if uid not in cur:
            lines.append(format_user_line(f"Konto gelöscht: {u.get('username', '?')}"))
    return lines, cur


LINK_CODE_RE = re.compile(r"KKK[\s-]*[A-Za-z0-9]{4}[\s-]*[A-Za-z0-9]{4}", re.IGNORECASE)


def is_link_candidate(body, sender, bot_id, room_id, club_room_id, members, ts_ms, now_ms, max_age_s):
    """Soll eine Nachricht als Verknüpfungscode an die Node-App weitergereicht werden?
    Nur: fremder Absender, nicht der Vereinsraum, privater Chat (<= 2 Mitglieder),
    frisch genug und mit einem Text, der wie ein KKK-Code aussieht."""
    if not body or not sender or sender == bot_id:
        return False
    if not room_id or room_id == club_room_id:
        return False
    if members is not None and members > 2:
        return False
    if ts_ms and now_ms - ts_ms > max_age_s * 1000:
        return False
    return bool(LINK_CODE_RE.search(str(body)))


def write_spool_file(directory, payload):
    """Eine JSON-Datei atomar (tmp + rename) in ein Spool-Verzeichnis schreiben."""
    os.makedirs(directory, exist_ok=True)
    mid = "%x-%s" % (int(time.time() * 1000), os.urandom(8).hex())
    tmp = os.path.join(directory, "." + mid + ".tmp")
    fin = os.path.join(directory, mid + ".json")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(dict(payload, id=mid), f)
    os.replace(tmp, fin)
    return fin


def sanitize_db(db):
    """Zugangsdaten aus dem DB-Abbild entfernen, bevor es hochgeladen wird:
    Passwort-Hashes/Salts je Konto sowie die Einladungs-/Einmal-Login-Tokens.
    Arbeitet auf einer Kopie; die Original-db.json bleibt unverändert."""
    if not isinstance(db, dict):
        return db
    clean = dict(db)
    users = clean.get("users")
    if isinstance(users, list):
        sanitized = []
        for u in users:
            if isinstance(u, dict):
                # Zugangsdaten und laufende Matrix-Verknüpfungscodes entfernen
                u = {k: v for k, v in u.items() if k not in ("hash", "salt", "matrixPending")}
            sanitized.append(u)
        clean["users"] = sanitized
    # Einladungen und Matrix-Login-Tokens sind login-fähig -> komplett weglassen
    clean.pop("invites", None)
    clean.pop("magic", None)
    return clean


def make_backup_bytes(db_path):
    """db.json einlesen, Zugangsdaten entfernen und gzip-komprimieren -> (dateiname, bytes, mimetype)."""
    with open(db_path, "rb") as f:
        raw = f.read()
    try:
        db = json.loads(raw)
        clean = sanitize_db(db)
        raw = json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError):
        # Falls die Datei ausnahmsweise nicht parsebar ist, lieber NICHT die Rohdaten
        # (mit Hashes) hochladen -> Backup dieses Durchlaufs überspringen.
        raise
    packed = gzip.compress(raw)
    fname = "kkk58-db-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json.gz"
    return fname, packed, "application/gzip"


# ---------------------------------------------------------------------------
# Matrix-Integration
# ---------------------------------------------------------------------------
class _PlaintextRefused(Exception):
    """Senden abgelehnt, weil der Zielraum nicht verschlüsselt ist."""


class MatrixSync:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = load_state(cfg.state_file)
        self.client = None
        self.room_id = None
        self.last_backup = self.state.get("last_backup", 0)
        self._stop = False
        self._outbox_attempts = {}  # id -> Anzahl Fehlversuche (nur im Speicher)
        # Dedup-Set der bereits protokollierten event_ids + nächste laufende Nummer.
        self._feed_seen, self._feed_next = self._load_feed_state()
        self._link_seen = set()          # bereits weitergereichte Code-Nachrichten (event_id)
        self._undecrypt_notice = {}      # room_id -> Zeitpunkt des letzten Hinweises

    # ---- Nachrichten-Feed für die Webapp ----
    def _load_feed_state(self):
        """event_ids der vorhandenen Nachrichten (Dedup über Neustart) und die nächste
        freie laufende Nummer (seq). seq ist stabil und bleibt beim Kürzen erhalten,
        damit die Paginierung der Webapp nicht springt."""
        seen = set()
        max_seq = -1
        try:
            with open(self.cfg.feed_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    eid = obj.get("id")
                    if eid:
                        seen.add(eid)
                    s = obj.get("seq")
                    if isinstance(s, int) and s > max_seq:
                        max_seq = s
        except OSError:
            pass
        return seen, max_seq + 1

    def _feed_append(self, entry):
        """Eine Nachricht ans Feed anhängen (atomar genug für einen Schreiber) und
        die Datei gelegentlich auf feed_max kürzen."""
        try:
            os.makedirs(os.path.dirname(self.cfg.feed_file) or ".", exist_ok=True)
            with open(self.cfg.feed_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as e:
            self.log("Feed-Schreibfehler:", repr(e))
            return
        self._feed_seen.add(entry["id"])
        # Kürzen erst mit Reserve, damit nicht bei jeder Nachricht neu geschrieben wird.
        if len(self._feed_seen) > int(self.cfg.feed_max * 1.2) + 5:
            self._feed_trim()

    def _feed_trim(self):
        try:
            with open(self.cfg.feed_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) <= self.cfg.feed_max:
                return
            keep = lines[-self.cfg.feed_max:]
            tmp = self.cfg.feed_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(keep)
            os.replace(tmp, self.cfg.feed_file)
            # Dedup-Set neu aufbauen (nur noch die behaltenen ids)
            self._feed_seen = set()
            for ln in keep:
                try:
                    eid = json.loads(ln).get("id")
                    if eid:
                        self._feed_seen.add(eid)
                except ValueError:
                    pass
        except OSError as e:
            self.log("Feed-Kürzen fehlgeschlagen:", repr(e))

    async def _on_room_message(self, room, event):
        """Callback für Textnachrichten im Vereinsraum. nio liefert verschlüsselte
        Ereignisse hier bereits entschlüsselt (sofern die Schlüssel vorliegen)."""
        try:
            if not self.room_id:
                return
            if getattr(room, "room_id", None) != self.room_id:
                self._maybe_forward_link(room, event)
                return
            eid = getattr(event, "event_id", None)
            if not eid or eid in self._feed_seen:
                return
            body = getattr(event, "body", None)
            if not body:
                return
            sender = getattr(event, "sender", "") or ""
            try:
                name = room.user_name(sender) or sender
            except Exception:
                name = sender
            entry = {
                "seq": self._feed_next,
                "id": eid,
                "sender": sender,
                "name": name,
                "ts": int(getattr(event, "server_timestamp", 0) or 0),
                "type": getattr(event, "msgtype", "m.text") or "m.text",
                "body": str(body),
            }
            self._feed_next += 1
            self._feed_append(entry)
        except Exception as e:  # ein Callback-Fehler darf den Sync nicht abbrechen
            self.log("Feed-Callback-Fehler (ignoriert):", repr(e))

    def _maybe_forward_link(self, room, event):
        """Nachricht aus einem privaten Bot-Chat mit KKK-Code in den Eingangs-Spool legen.
        Die Node-App prüft den Code, merkt sich Raum-ID + Absender und antwortet über die Outbox."""
        rid = getattr(room, "room_id", None)
        eid = getattr(event, "event_id", None)
        if not eid or eid in self._link_seen:
            return
        body = getattr(event, "body", None)
        sender = getattr(event, "sender", "") or ""
        try:
            members = int(getattr(room, "member_count", 0) or 0) or None
        except Exception:
            members = None
        ts = int(getattr(event, "server_timestamp", 0) or 0)
        if not is_link_candidate(body, sender, self.cfg.user_id, rid, self.room_id,
                                 members, ts, int(time.time() * 1000), self.cfg.link_max_age):
            return
        self._link_seen.add(eid)
        try:
            write_spool_file(self.cfg.inbox_dir, {
                "roomId": rid, "sender": sender, "body": str(body)[:500],
                "ts": ts, "members": members, "eventId": eid,
            })
            self.log("Verknüpfungscode empfangen von", sender, "in", rid)
        except OSError as e:
            self.log("Inbox-Schreibfehler:", repr(e))

    async def _on_undecryptable(self, room, event):
        """Nicht entschlüsselbare Nachricht in einem privaten Bot-Chat (typisch: vor dem
        Beitritt des Bots gesendet). Einmal je Raum und Stunde um erneutes Senden bitten."""
        try:
            rid = getattr(room, "room_id", None)
            if not rid or rid == self.room_id or getattr(event, "sender", "") == self.cfg.user_id:
                return
            if int(getattr(room, "member_count", 0) or 0) > 2:
                return
            now = time.time()
            if now - self._undecrypt_notice.get(rid, 0) < 3600:
                return
            self._undecrypt_notice[rid] = now
            await self.client.room_send(rid, "m.room.message",
                                        {"msgtype": "m.notice",
                                         "body": "🎳 KKk58: Deine Nachricht konnte ich nicht entschlüsseln "
                                                 "(vermutlich vor meinem Beitritt gesendet). Bitte schicke sie noch einmal."},
                                        ignore_unverified_devices=True)
        except Exception as e:
            self.log("Hinweis (nicht entschlüsselbar) fehlgeschlagen:", repr(e))

    def log(self, *a):
        print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)

    async def connect(self):
        try:
            os.makedirs(self.cfg.store_path, exist_ok=True)
            os.makedirs(os.path.dirname(self.cfg.state_file) or ".", exist_ok=True)
        except PermissionError:
            import getpass
            u = getpass.getuser()
            sys.stderr.write(
                "Kein Schreibrecht fuer den Schluesselspeicher:\n"
                f"  {self.cfg.store_path}\n"
                "Bitte einmalig als root anlegen und dem Dienstbenutzer uebergeben:\n"
                f"  sudo mkdir -p {self.cfg.store_path}\n"
                f"  sudo chown {u}:{u} {self.cfg.store_path}\n"
                f"  sudo chmod 700 {self.cfg.store_path}\n"
            )
            sys.exit(4)
        conf = AsyncClientConfig(store_sync_tokens=True, encryption_enabled=True)
        dev_id = self.state.get("device_id")
        self.client = AsyncClient(
            self.cfg.homeserver, self.cfg.user_id,
            device_id=dev_id or "", store_path=self.cfg.store_path, config=conf,
        )

        token = self.state.get("access_token")
        if token and dev_id:
            self.client.restore_login(self.cfg.user_id, dev_id, token)
            self.client.load_store()
            self.log("Angemeldet (wiederhergestellt) als", self.cfg.user_id, "device", dev_id)
        else:
            if not self.cfg.password:
                sys.stderr.write("Erststart benötigt KKK_MATRIX_PASSWORD (danach Token-basiert).\n")
                sys.exit(2)
            resp = await self.client.login(self.cfg.password, device_name=self.cfg.device_name)
            if not isinstance(resp, LoginResponse):
                sys.stderr.write(f"Login fehlgeschlagen: {resp}\n")
                sys.exit(1)
            self.state["device_id"] = resp.device_id
            self.state["access_token"] = resp.access_token
            save_state(self.cfg.state_file, self.state)
            self.log("Angemeldet (neu) als", self.cfg.user_id, "device", resp.device_id)

        # Raum-ID auflösen (Alias -> ID) – direkte API, vor dem ersten Sync möglich.
        room = self.cfg.room
        if room.startswith("#"):
            r = await self.client.room_resolve_alias(room)
            room = getattr(r, "room_id", None) or room
        self.room_id = room

        # Feed-Callback VOR dem ersten Sync registrieren, damit die anfänglich vom
        # Homeserver gelieferten Nachrichten des Raums bereits im Feed landen.
        self.client.add_event_callback(
            self._on_room_message,
            (RoomMessageText, RoomMessageNotice, RoomMessageEmote),
        )
        self.client.add_event_callback(self._on_undecryptable, (MegolmEvent,))

        # Ersten Sync ausführen: lädt Räume + Geräteschlüssel (und die Timeline -> Feed)
        await self.client.sync(timeout=30000, full_state=True)
        if self.client.should_upload_keys:
            await self.client.keys_upload()

        # Falls noch kein Mitglied: beitreten und erneut syncen
        if self.room_id not in self.client.rooms:
            await self.client.join(self.room_id)
            await self.client.sync(timeout=30000)

        enc = self.room_id in self.client.rooms and self.client.rooms[self.room_id].encrypted
        if not enc:
            msg = ("Der Ziel-Raum ist NICHT verschlüsselt. Aktiviere E2EE für den Raum "
                   "oder setze KKK_REQUIRE_ENCRYPTION=0 (nicht empfohlen).")
            if self.cfg.require_encryption:
                self.log("ABBRUCH:", msg)
                await self.client.close()
                sys.exit(3)
            self.log("WARNUNG:", msg)
        else:
            self.log("Raum verschlüsselt – Nachrichten und Backups sind E2E-verschlüsselt.")

    async def post_text(self, text):
        await self.client.room_send(
            self.room_id, "m.room.message",
            {"msgtype": "m.text", "body": text},
            ignore_unverified_devices=True,
        )

    async def post_backup(self):
        fname, data, mime = make_backup_bytes(self.cfg.db_file)

        def provider(_a, _b):
            return data

        resp, keys = await self.client.upload(
            provider, content_type=mime, filename=fname,
            encrypt=True, filesize=len(data),
        )
        content = {"msgtype": "m.file", "body": fname,
                   "info": {"size": len(data), "mimetype": mime}}
        if keys:  # verschlüsselter Upload -> Schlüssel im 'file'-Feld
            keys["url"] = resp.content_uri
            content["file"] = keys
        else:      # (nur falls Verschlüsselung deaktiviert wurde)
            content["url"] = resp.content_uri
        await self.client.room_send(self.room_id, "m.room.message", content,
                                    ignore_unverified_devices=True)
        self.log("Backup hochgeladen:", fname, f"({len(data)} Bytes)")

    def _read_db(self):
        with open(self.cfg.db_file, "r", encoding="utf-8") as f:
            return json.load(f)

    async def _refresh_keys(self):
        """Kurzer Sync (ohne Long-Poll) vor dem Senden – hält Raum-Mitglieder und
        E2EE-Schlüssel aktuell, ohne die dauerhaften Long-Poll-Timeouts."""
        try:
            await self.client.sync(timeout=0)
            if self.client.should_upload_keys:
                await self.client.keys_upload()
            await self._join_invites()
        except Exception as e:
            self.log("Sync-Hinweis (fahre fort):", repr(e))

    async def _join_invites(self):
        """Offene Raum-Einladungen automatisch annehmen – so kann ein Mitglied
        einen 1:1-Chat mit dem Bot starten, den der Sidecar zum Senden nutzt."""
        try:
            invited = list(getattr(self.client, "invited_rooms", {}).keys())
        except Exception:
            invited = []
        for rid in invited:
            try:
                await self.client.join(rid)
                self.log("Einladung angenommen (Raum beigetreten):", rid)
            except Exception as e:
                self.log("Beitritt fehlgeschlagen:", rid, repr(e))

    @staticmethod
    def _safe_remove(path):
        try:
            os.remove(path)
        except OSError:
            pass

    async def _send_to_room(self, room, body):
        """Textnachricht in einen beliebigen Raum senden (Alias auflösen, ggf. beitreten).
        Bei aktivierter Verschlüsselungspflicht wird NICHT in unverschlüsselte Räume gesendet."""
        rid = room
        if isinstance(rid, str) and rid.startswith("#"):
            r = await self.client.room_resolve_alias(rid)
            rid = getattr(r, "room_id", None) or rid
        if rid not in self.client.rooms:
            await self.client.join(rid)
            await self.client.sync(timeout=0)
        enc = rid in self.client.rooms and self.client.rooms[rid].encrypted
        if self.cfg.require_encryption and not enc:
            raise _PlaintextRefused(rid)
        resp = await self.client.room_send(
            rid, "m.room.message",
            {"msgtype": "m.text", "body": body},
            ignore_unverified_devices=True,
        )
        if not isinstance(resp, RoomSendResponse):
            raise RuntimeError("room_send: " + repr(resp))

    async def _leave_room(self, room, body=""):
        """Optional einen Abschiedstext senden, dann den Raum verlassen und vergessen.
        Ist der Bot gar nicht (mehr) Mitglied, gilt das als Erfolg."""
        if room not in self.client.rooms:
            return
        if body:
            try:
                await self._send_to_room(room, body)
            except Exception as e:  # Abschied ist nett, aber nicht nötig
                self.log("Abschiedsnachricht nicht gesendet:", room, repr(e))
        resp = await self.client.room_leave(room)
        if getattr(resp, "status_code", None):
            raise RuntimeError("room_leave: " + repr(resp))
        try:
            await self.client.room_forget(room)
        except Exception:
            pass

    async def _invite_to_room(self, room, mxid):
        """Eine Matrix-ID (@name:server) in einen Raum einladen. Alias auflösen und dem
        Raum bei Bedarf beitreten. Ist der Nutzer bereits Mitglied oder schon eingeladen,
        wird das als Erfolg gewertet (idempotent). Die Verschlüsselungspflicht gilt hier
        NICHT – eine Einladung ist keine (Klartext-)Nachricht."""
        rid = room
        if isinstance(rid, str) and rid.startswith("#"):
            r = await self.client.room_resolve_alias(rid)
            rid = getattr(r, "room_id", None) or rid
        if rid not in self.client.rooms:
            await self.client.join(rid)
            await self.client.sync(timeout=0)
        resp = await self.client.room_invite(rid, mxid)
        if isinstance(resp, RoomInviteResponse):
            return
        # Synapse meldet „bereits im Raum"/„bereits eingeladen" als M_FORBIDDEN – nicht neu versuchen.
        status = getattr(resp, "status_code", "") or ""
        text = (getattr(resp, "message", "") or "").lower()
        if status == "M_FORBIDDEN" and ("already" in text or "in the room" in text or "invit" in text):
            return
        raise RuntimeError("room_invite: " + repr(resp))

    async def process_outbox(self):
        """Von der Node-App abgelegte Sende-Aufträge abarbeiten (Codes/Login-Links).
        Ein Auftrag = eine JSON-Datei; nach erfolgreichem Senden wird sie gelöscht."""
        try:
            names = [n for n in os.listdir(self.cfg.outbox_dir)
                     if n.endswith(".json") and not n.startswith(".")]
        except OSError:
            return
        if not names:
            return
        names.sort()
        await self._refresh_keys()
        for name in names:
            fpath = os.path.join(self.cfg.outbox_dir, name)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    msg = json.load(f)
            except (OSError, ValueError):
                self._safe_remove(fpath)
                continue
            mid = str(msg.get("id") or name)
            action = str(msg.get("action") or "text")
            # TTL nur für zeitkritische Aufträge (Codes/Login-Links). Einladungen sind nicht
            # zeitkritisch und sollen nicht verloren gehen, wenn der Sidecar länger als
            # KKK_OUTBOX_TTL offline war – daher hier von der Altersprüfung ausgenommen.
            if action not in ("invite", "leave"):
                age = time.time() - (msg.get("createdAt", 0) / 1000)
                if age > self.cfg.outbox_ttl:
                    self.log("Outbox: Auftrag zu alt, verworfen:", name)
                    self._safe_remove(fpath)
                    self._outbox_attempts.pop(mid, None)
                    continue
            room = msg.get("roomId")
            # Sentinel der Node-App für den zentralen Vereinsraum: die App kennt dessen ID nicht
            # und legt "__club__" ab; hier durch den konfigurierten KKK_MATRIX_ROOM ersetzen.
            if room in ("__club__", "@club"):
                room = self.room_id or self.cfg.room
            if action == "leave":
                # Nie den Vereinsraum verlassen (Schutz, auch wenn die App das schon prüft)
                if not room or room in (self.room_id, self.cfg.room):
                    self._safe_remove(fpath)
                    continue
                try:
                    await self._leave_room(room, msg.get("body") or "")
                    self._safe_remove(fpath)
                    self._outbox_attempts.pop(mid, None)
                    self.log("Outbox: Raum verlassen", room)
                except Exception as e:
                    n = self._outbox_attempts.get(mid, 0) + 1
                    self._outbox_attempts[mid] = n
                    self.log("Outbox: Verlassen fehlgeschlagen (Versuch %d) %s: %s" % (n, room, repr(e)))
                    if n >= self.cfg.outbox_max_attempts:
                        self._safe_remove(fpath)
                        self._outbox_attempts.pop(mid, None)
                continue
            if action == "invite":
                mxid = msg.get("mxid")
                if not room or not mxid:
                    self._safe_remove(fpath)
                    continue
                try:
                    await self._invite_to_room(room, mxid)
                    self._safe_remove(fpath)
                    self._outbox_attempts.pop(mid, None)
                    self.log("Outbox: eingeladen", mxid, "->", room)
                except Exception as e:
                    n = self._outbox_attempts.get(mid, 0) + 1
                    self._outbox_attempts[mid] = n
                    self.log("Outbox: Einladung fehlgeschlagen (Versuch %d) %s -> %s: %s" % (n, mxid, room, repr(e)))
                    if n >= self.cfg.outbox_max_attempts:
                        self.log("Outbox: Einladung nach zu vielen Versuchen aufgegeben:", name)
                        self._safe_remove(fpath)
                        self._outbox_attempts.pop(mid, None)
                continue
            body = msg.get("body")
            if not room or not body:
                self._safe_remove(fpath)
                continue
            try:
                await self._send_to_room(room, body)
                self._safe_remove(fpath)
                self._outbox_attempts.pop(mid, None)
                self.log("Outbox: gesendet an", room)
            except _PlaintextRefused:
                self.log("Outbox: Raum", room,
                         "ist NICHT verschlüsselt – Nachricht NICHT gesendet (KKK_REQUIRE_ENCRYPTION=1). Auftrag verworfen.")
                self._safe_remove(fpath)
                self._outbox_attempts.pop(mid, None)
            except Exception as e:
                n = self._outbox_attempts.get(mid, 0) + 1
                self._outbox_attempts[mid] = n
                self.log("Outbox: Senden fehlgeschlagen (Versuch %d) an %s: %s" % (n, room, repr(e)))
                if n >= self.cfg.outbox_max_attempts:
                    self.log("Outbox: Auftrag nach zu vielen Versuchen aufgegeben:", name)
                    self._safe_remove(fpath)
                    self._outbox_attempts.pop(mid, None)

    async def process_change(self, force_backup=False):
        try:
            db = self._read_db()
        except (OSError, ValueError) as e:
            self.log("db.json nicht lesbar (übersprungen):", e)
            return
        new_log, new_ledger, markers = select_new(db, self.state)
        user_lines, user_snap = diff_users(self.state.get("users_snap"), db.get("users", []))
        lines = ([format_log_entry(e) for e in new_log]
                 + [format_ledger_entry(e) for e in new_ledger]
                 + user_lines)
        msg = build_message(lines, self.cfg.max_lines)
        await self._refresh_keys()
        if msg:
            try:
                await self.post_text(msg)
                self.log(f"Protokolliert: {len(new_log)} Log + {len(new_ledger)} Kasse + {len(user_lines)} Konten")
            except Exception as e:
                self.log("Senden fehlgeschlagen (erneuter Versuch später):", repr(e))
                return  # Marker NICHT fortschreiben -> beim nächsten Mal erneut
        # Marker fortschreiben
        self.state.update(markers)
        self.state["users_snap"] = user_snap

        now = time.time()
        due = force_backup or (now - self.last_backup >= self.cfg.backup_interval)
        if (msg or force_backup) and due:
            try:
                await self.post_backup()
                self.last_backup = now
                self.state["last_backup"] = now
            except Exception as e:  # Upload-Fehler nicht den Dienst killen lassen
                self.log("Backup fehlgeschlagen:", repr(e))
        save_state(self.cfg.state_file, self.state)

    async def poll_loop(self):
        last_mtime = 0.0
        # Beim Start immer ein aktuelles Backup sichern (die Historie im log/ledger
        # wird dabei nicht nachgepostet – nur ab jetzt entstehende Änderungen).
        await self.process_change(force_backup=True)
        try:
            os.makedirs(self.cfg.outbox_dir, exist_ok=True)
        except OSError:
            pass
        await self.process_outbox()
        try:
            last_mtime = os.path.getmtime(self.cfg.db_file)
        except OSError:
            pass
        while not self._stop:
            await asyncio.sleep(self.cfg.poll_seconds)
            # Kurzer Sync: liefert neue Raumnachrichten an den Feed-Callback.
            try:
                await self.client.sync(timeout=0)
                if self.client.should_upload_keys:
                    await self.client.keys_upload()
                # Neue 1:1-Chats sofort annehmen, damit Nutzer ihren Verknüpfungscode schicken können
                await self._join_invites()
            except Exception as e:
                self.log("Feed-Sync-Hinweis (fahre fort):", repr(e))
            # Sende-Aufträge (Codes/Login-Links) zeitnah abarbeiten
            await self.process_outbox()
            try:
                m = os.path.getmtime(self.cfg.db_file)
            except OSError:
                continue
            if m != last_mtime:
                last_mtime = m
                await self.process_change()

    async def run(self):
        await self.connect()
        # Kein dauerhaftes sync_forever (Long-Poll läuft in diesem Setup in Timeouts):
        # der Poll-Loop macht vor jedem Senden einen kurzen Sync für die E2EE-Schlüssel.
        try:
            await self.poll_loop()
        finally:
            self._stop = True
            await self.client.close()


async def _amain():
    cfg = Config()
    await MatrixSync(cfg).run()


def main():
    # env-Datei laden, falls vorhanden (Pfad via KKK_ENV_FILE, sonst Standard).
    # So funktioniert auch ein direkter Start ohne systemd/EnvironmentFile.
    load_env_file(os.environ.get("KKK_ENV_FILE", "/opt/kkk58/matrix-backup/kkk58-matrix.env"))
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
