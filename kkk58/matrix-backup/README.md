# KKk58 Matrix-Sidecar

Protokolliert jede Änderung der Vereinsdatenbank in einen Matrix-Raum und lädt nach
Änderungen ein **Ende-zu-Ende-verschlüsseltes Backup** (`db.json`, gzip) hoch – nur
für die Raummitglieder lesbar.

## Warum ein separater Dienst?

Die KKk58-App ist bewusst **abhängigkeitsfreies Node.js**. Echte E2E-Verschlüsselung
(Matrix/Olm) ist damit nicht umsetzbar. Dieser kleine **Python-Dienst** nutzt
`matrix-nio` und läuft **neben** der App. Er **liest nur** die von der App
geschriebene Datei `data/db.json` – die App selbst wird nicht verändert.

Protokolliert werden der Änderungsverlauf (`log`) und alle Kassenbuchungen (`ledger`).

## Voraussetzungen

```bash
apt install python3 python3-pip libolm-dev   # libolm ist für E2EE nötig
pip install "matrix-nio[e2e]" --break-system-packages
```

## Einrichtung (einmalig)

1. **Bot-Konto**: Lege auf eurem Homeserver einen eigenen Matrix-Nutzer an, z. B.
   `@kkk58bot:example.org` (nicht euer persönliches Konto verwenden).
2. **Raum**: Erstelle einen privaten Raum, **aktiviere die Verschlüsselung**
   (Raum-Einstellungen → Sicherheit → Verschlüsselung), und lade den Bot sowie die
   berechtigten Personen (z. B. Vorstand) ein.
3. **Konfiguration**:
   ```bash
   cp /opt/kkk58/matrix-backup/env.example /opt/kkk58/matrix-backup/kkk58-matrix.env
   nano /opt/kkk58/matrix-backup/kkk58-matrix.env      # Homeserver, Bot-User, Raum, Passwort, Pfade
   chmod 600 /opt/kkk58/matrix-backup/kkk58-matrix.env
   ln -s /opt/kkk58/matrix-backup/kkk58-matrix.env /etc/kkk58-matrix.env
   ```
4. **Erststart** (meldet sich mit Passwort an, speichert danach ein Access-Token und
   eine stabile Geräte-ID im Store):
   ```bash
   sudo -u kkk58 python3 /opt/kkk58/matrix-backup/kkk58_matrix_sync.py
   ```
   Läuft es sauber, das `KKK_MATRIX_PASSWORD` aus der env-Datei entfernen (Token bleibt).
5. **Als Dienst**:
   ```bash
   sudo cp kkk58-matrix-sync.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now kkk58-matrix-sync
   journalctl -u kkk58-matrix-sync -f
   ```

## Verhalten

- Der Dienst prüft alle `KKK_POLL_SECONDS` (Standard 15 s), ob sich `db.json` geändert
  hat, und postet dann die neuen Änderungen gesammelt als eine Nachricht.
- Ein Backup wird höchstens alle `KKK_BACKUP_MIN_INTERVAL` (Standard 300 s) hochgeladen,
  wenn es Änderungen gab – so entsteht auch bei vielen Klicks während eines Kegelabends
  kein Backup-Spam. `KKK_BACKUP_MIN_INTERVAL=0` lädt nach **jeder** Änderung hoch.
- Beim allerersten Start wird die Historie **nicht** nachgepostet (nur ab jetzt), aber
  ein initiales Voll-Backup hochgeladen.

## Wiederherstellung

Backup-Datei im Matrix-Client herunterladen (wird automatisch entschlüsselt), dann:

```bash
sudo systemctl stop kkk58            # Node-App stoppen
gunzip -c kkk58-db-JJJJMMTT-HHMMSS.json.gz > /opt/kkk58/data/db.json
sudo systemctl start kkk58
```

## Sicherheit

- **Der Raum MUSS verschlüsselt sein.** Bei `KKK_REQUIRE_ENCRYPTION=1` (Standard)
  sendet der Dienst gar nichts, falls der Raum unverschlüsselt ist.
- Das hochgeladene Backup ist **bereinigt**: Passwort-Hashes/Salts der Konten
  (`hash`/`salt`) und die Einladungs-/Einmal-Login-Tokens (`invites`) werden vor dem
  Upload entfernt (siehe `sanitize_db`); lässt sich die `db.json` ausnahmsweise nicht
  parsen, wird der Upload dieses Durchlaufs **übersprungen** statt Rohdaten hochzuladen.
  Das Backup enthält weiterhin Konten-Metadaten (Benutzername, Rolle), Namen und
  Kassendaten – beschränke die Raummitgliedschaft dennoch streng und teile die
  Verschlüsselung nur mit vertrauenswürdigen Geräten.
  Hinweis: Ohne Hashes ist das Backup **nicht ohne Weiteres für ein 1:1-Restore der
  Logins** geeignet – für eine vollständige Sicherung die Admin-Voll-Sicherung
  (`GET /api/db?full=1`) nutzen und getrennt sicher aufbewahren.
- Sichere den Ordner `KKK_MATRIX_STORE` (enthält die E2EE-Schlüssel und das Token) –
  ohne ihn kann der Bot verschlüsselte Verläufe nicht mehr lesen und muss neu
  verifiziert werden.
- Bei unverifizierten Empfängergeräten sendet der Dienst dennoch
  (`ignore_unverified_devices=True`), damit alle Raummitglieder mitlesen können. Wer
  strengere Verifikation will, kann das im Skript anpassen.

## Test-Hinweis

Die Kernlogik (Änderungserkennung, Formatierung, Backup-Erstellung, Zustand) ist mit
Unit-Tests abgedeckt. Die eigentliche Matrix-/E2EE-Kommunikation lässt sich nur gegen
einen echten Homeserver prüfen – bitte einmal mit einem Testraum verifizieren
(Nachricht kommt an, Backup ist im Client als verschlüsselte Datei herunterladbar).
