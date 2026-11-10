#!/usr/bin/env bash
# Update der KKk58 Vereinsdatenbank. Als root ausführen.
#   kkk58-update            # neuester Commit des Branches (Standard: main)
#   kkk58-update <ref>      # bestimmter Tag/Commit/Branch
#
# Ablauf: git-Checkout in $KKK_SRC (Standard /opt/kkk58-src, wird beim ersten Lauf
# angelegt) -> Inhalt von kkk58/ nach $KKK_DIR (Standard /opt/kkk58) übertragen.
# data/, *.env, backup/ und matrix-store/ werden nie angefasst.
# Vorher: Sicherung von Code, Daten und Konfiguration nach $KKK_DIR/backup.
# Startet die neue Version nicht, wird Code + data/ aus der Sicherung zurückgespielt.
set -euo pipefail

APP_DIR=${KKK_DIR:-/opt/kkk58}
SRC_DIR=${KKK_SRC:-/opt/kkk58-src}
REPO=${KKK_REPO:-https://github.com/Simon0Harms/KKK58-Kegel-Vereinsdatenbank.git}
SVC=kkk58
SIDECAR=kkk58-matrix-sync
SVC_USER=kkk58
REF=${1:-}
KEEP=10

die() { echo "!! $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Bitte als root ausführen."
for c in git curl tar; do command -v "$c" >/dev/null || die "'$c' fehlt (apt install $c)."; done
[ -f "$APP_DIR/server.js" ] || die "$APP_DIR/server.js nicht gefunden – ist KKk58 dort installiert? (KKK_DIR setzen)"

GIT="git -c safe.directory=$SRC_DIR -C $SRC_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
STATE="$SRC_DIR/.deployed"          # zuletzt nach APP_DIR übertragener Commit
EXCLUDES=(--exclude=./data --exclude=./backup --exclude=./matrix-store --exclude='*.env'
          --exclude=__pycache__ --exclude='*.pyc')

# --- Quell-Checkout anlegen/prüfen ---
if [ ! -d "$SRC_DIR/.git" ]; then
  echo ">> Erster Lauf: klone $REPO nach $SRC_DIR"
  git clone -q "$REPO" "$SRC_DIR"
fi
if [ -n "$($GIT status --porcelain --untracked-files=no)" ]; then
  $GIT status --short --untracked-files=no >&2
  die "Lokale Änderungen in $SRC_DIR – bitte erst verwerfen (git -C $SRC_DIR checkout -- .)."
fi

# --- Health-Check-Ziel aus kkk58.env (nur KEY=WERT, keine Inline-Kommentare) ---
envval() { # envval KEY DEFAULT
  local v=""
  [ -f "$APP_DIR/kkk58.env" ] && v=$(sed -n "s/^[[:space:]]*$1=//p" "$APP_DIR/kkk58.env" | tail -n1)
  echo "${v:-$2}"
}
PORT=$(envval PORT 3000)
BASE=$(envval BASE_PATH /kkk58); BASE="/${BASE#/}"; BASE="${BASE%/}"
HEALTH_URL="http://127.0.0.1:${PORT}${BASE}/"

health() {
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    systemctl is-active -q "$SVC" && curl -fsS -o /dev/null "$HEALTH_URL" && return 0
  done
  return 1
}

# --- Ziel-Commit bestimmen ---
OLD=$(cat "$STATE" 2>/dev/null || true)
$GIT fetch -q --tags origin
if [ -n "$REF" ]; then
  $GIT checkout -q "$REF"
  # Branch-Name angegeben -> auf den Stand von origin bringen
  if $GIT symbolic-ref -q HEAD >/dev/null; then $GIT pull -q --ff-only origin "$REF"; fi
else
  BRANCH=$($GIT symbolic-ref --short -q HEAD || echo main)
  $GIT checkout -q "$BRANCH"
  $GIT pull -q --ff-only origin "$BRANCH"
fi
NEW=$($GIT rev-parse HEAD)
if [ "$OLD" = "$NEW" ]; then echo ">> Bereits aktuell ($($GIT describe --always --tags))"; exit 0; fi

# --- Sicherung: Code + Daten + Konfiguration ---
install -d -m 700 "$APP_DIR/backup"
BK="$APP_DIR/backup/kkk58-$STAMP.tar.gz"
echo ">> Sicherung nach $BK"
tar -czf "$BK" -C "$APP_DIR" --exclude=./backup --exclude=./matrix-store --exclude='__pycache__' .
# shellcheck disable=SC2012
ls -1t "$APP_DIR"/backup/kkk58-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm --

if [ -n "$OLD" ] && $GIT cat-file -e "$OLD^{commit}" 2>/dev/null; then
  echo ">> $($GIT log --oneline -1 "$OLD") -> $($GIT log --oneline -1 "$NEW")"
  changed() { ! $GIT diff --quiet "$OLD" "$NEW" -- "$@"; }
else
  echo ">> Erstes Update über das Skript -> $($GIT log --oneline -1 "$NEW")"
  OLD=""
  changed() { return 0; }   # unbekannter Ausgangsstand: alles als geändert behandeln
fi

# --- Übertragen ---
tar -C "$SRC_DIR/kkk58" "${EXCLUDES[@]}" -cf - . | tar -C "$APP_DIR" --no-same-owner -xf -
# im Repo gelöschte Dateien auch im Ziel entfernen (nur bei bekanntem Ausgangsstand)
if [ -n "$OLD" ]; then
  $GIT diff --name-only --diff-filter=D "$OLD" "$NEW" -- kkk58/ | sed 's#^kkk58/##' | while read -r f; do
    case "$f" in data/*|backup/*|*.env) continue ;; esac
    [ -n "$f" ] && rm -f -- "$APP_DIR/$f"
  done
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
chown -R root:root "$APP_DIR/backup"

# --- systemd-Units (Symlink aus der README oder Kopie in /etc) ---
sync_unit() { # sync_unit <unitname> <quelle im APP_DIR>
  local dst="/etc/systemd/system/$1.service"
  [ -L "$dst" ] && return 0                         # Symlink zeigt bereits auf die neue Datei
  [ -f "$dst" ] && ! cmp -s "$2" "$dst" && install -m 644 "$2" "$dst"
  return 0
}
sync_unit "$SVC" "$APP_DIR/kkk58.service"
[ -e "/etc/systemd/system/$SIDECAR.service" ] && sync_unit "$SIDECAR" "$APP_DIR/matrix-backup/kkk58-matrix-sync.service"
systemctl daemon-reload

echo ">> Neustart $SVC…"
systemctl restart "$SVC"
if health; then
  echo "$NEW" > "$STATE"
  [ -f "$APP_DIR/update.sh" ] && install -m 755 "$APP_DIR/update.sh" /usr/local/bin/kkk58-update
  if systemctl is-active -q "$SIDECAR" && changed kkk58/matrix-backup; then
    echo ">> Matrix-Sidecar geändert – Neustart $SIDECAR"
    systemctl restart "$SIDECAR"
  fi
  if changed kkk58/kkk58.env.example kkk58/matrix-backup/env.example; then
    echo ">> Hinweis: Env-Vorlagen geändert – ggf. neue Optionen übernehmen:"
    if [ -n "$OLD" ]; then $GIT --no-pager diff "$OLD" "$NEW" -- kkk58/kkk58.env.example kkk58/matrix-backup/env.example
    else echo "   (Vergleich mit $APP_DIR/kkk58.env manuell prüfen)"; fi
  fi
  echo ">> Aktualisiert auf $($GIT describe --always --tags)"
else
  echo "!! Neue Version antwortet nicht unter $HEALTH_URL – stelle Sicherung $BK wieder her" >&2
  journalctl -u "$SVC" -n 30 --no-pager >&2 || true
  systemctl stop "$SVC" || true
  # Code und data/ zurück (data/ wegen evtl. schon migrierter db.json); *.env bleiben unangetastet
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name backup ! -name matrix-store ! -name '*.env' -exec rm -rf -- {} +
  tar -xzf "$BK" -C "$APP_DIR"
  chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"; chown -R root:root "$APP_DIR/backup"
  [ -L "/etc/systemd/system/$SVC.service" ] || install -m 644 "$APP_DIR/kkk58.service" "/etc/systemd/system/$SVC.service" 2>/dev/null || true
  systemctl daemon-reload
  systemctl start "$SVC" || true
  [ -n "$OLD" ] && $GIT checkout -q "$OLD" 2>/dev/null || true
  exit 1
fi
