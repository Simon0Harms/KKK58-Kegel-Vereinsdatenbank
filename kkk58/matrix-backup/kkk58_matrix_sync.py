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
import sys
import time
from datetime import datetime

try:
    from nio import AsyncClient, AsyncClientConfig, LoginResponse, RoomSendResponse
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
        self.store_path = env("KKK_MATRIX_STORE", "/opt/kkk58/matrix-store")
        self.state_file = env("KKK_MATRIX_STATE", "/opt/kkk58/matrix-store/sidecar-state.json")
        self.poll_seconds = int(env("KKK_POLL_SECONDS", "15"))
        self.backup_interval = int(env("KKK_BACKUP_MIN_INTERVAL", "300"))  # Sek.; 0 = nach jeder Änderung
        self.device_name = env("KKK_MATRIX_DEVICE_NAME", "KKk58-Backup")
        self.require_encryption = env("KKK_REQUIRE_ENCRYPTION", "1") != "0"
        self.max_lines = int(env("KKK_MAX_LOG_LINES", "40"))  # max. Zeilen pro Protokoll-Nachricht


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

        # Ersten Sync ausführen: lädt Räume + Geräteschlüssel
        await self.client.sync(timeout=30000, full_state=True)
        if self.client.should_upload_keys:
            await self.client.keys_upload()

        # Raum-ID auflösen (Alias -> ID) und ggf. beitreten
        room = self.cfg.room
        if room.startswith("#"):
            r = await self.client.room_resolve_alias(room)
            room = getattr(r, "room_id", None) or room
        self.room_id = room
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
            age = time.time() - (msg.get("createdAt", 0) / 1000)
            if age > self.cfg.outbox_ttl:
                self.log("Outbox: Auftrag zu alt, verworfen:", name)
                self._safe_remove(fpath)
                self._outbox_attempts.pop(mid, None)
                continue
            room = msg.get("roomId")
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
    load_env_file(os.environ.get("KKK_ENV_FILE", "/etc/kkk58-matrix.env"))
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
