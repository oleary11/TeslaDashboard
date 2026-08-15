#!/bin/sh
# One-time host setup: creates a locked-down 'teslacam' Linux user that the
# teslausb Pi rsyncs footage into over SSH. The account can ONLY run rsync
# (via a forced "command=" in authorized_keys, restricted by rrsync to
# data/dashcam) — no other commands, no port/X11/agent forwarding, no pty.
#
# IMPORTANT: the shell must be a real shell (e.g. /bin/sh), NOT nologin.
# OpenSSH's forced-command feature runs `<shell> -c "<command>"` — if the
# shell is nologin/false, it refuses to run ANYTHING, including the forced
# rrsync command, so SSH key auth succeeds but every transfer is rejected.
# The forced-command + rrsync jail is the actual security boundary here, not
# the shell, so a plain shell is safe (and required) for this pattern.
#
# By default this installs the bundled keypair's public half. Pass a
# different public key as $1 if the Pi generated its own key instead (the
# recommended approach — the private half then never leaves the Pi):
#   sudo sh setup-teslacam-user.sh "ssh-ed25519 AAAA... root@teslausb"
#
# Safe to re-run: it fixes the shell and re-installs the key on an existing
# 'teslacam' account too.
set -eu

DASHCAM_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/dashcam"
PUBKEY_FILE="$(cd "$(dirname "$0")" && pwd)/teslacam_pi_key.pub"

if [ "$(id -u)" != "0" ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

if ! id teslacam >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/teslacam --shell /bin/sh teslacam
  echo "Created user 'teslacam'."
else
  chsh -s /bin/sh teslacam
  echo "User 'teslacam' already exists; ensured its shell is /bin/sh."
fi

mkdir -p "$DASHCAM_DIR"/SavedClips "$DASHCAM_DIR"/SentryClips "$DASHCAM_DIR"/RecentClips
chown -R teslacam:teslacam "$DASHCAM_DIR"/SavedClips "$DASHCAM_DIR"/SentryClips "$DASHCAM_DIR"/RecentClips
chmod -R u+rwX,g+rX "$DASHCAM_DIR"/SavedClips "$DASHCAM_DIR"/SentryClips "$DASHCAM_DIR"/RecentClips

# rrsync locks DASHCAM_DIR itself on every run, and the account also needs to
# traverse every ancestor directory to reach it. If any ancestor (e.g. a
# private home directory like /home/joshua, mode 750) isn't world-traversable,
# grant teslacam execute-only (traverse, not list/read) access via a POSIX ACL
# instead of loosening the directory's real permissions.
if ! command -v setfacl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y acl
  else
    echo "WARNING: setfacl not found — install the 'acl' package, then run: setfacl -m u:teslacam:x <each ancestor dir of $DASHCAM_DIR>" >&2
  fi
fi
if command -v setfacl >/dev/null 2>&1; then
  ancestor="$DASHCAM_DIR"
  while [ "$ancestor" != "/" ]; do
    ancestor="$(dirname "$ancestor")"
    [ "$ancestor" = "/" ] && break
    setfacl -m u:teslacam:x "$ancestor"
  done
  echo "Granted teslacam traverse-only access to $DASHCAM_DIR's ancestor directories."
fi

mkdir -p /home/teslacam/.ssh
chmod 700 /home/teslacam/.ssh

if [ -n "${1:-}" ]; then
  PUBKEY="$1"
elif [ -f "$PUBKEY_FILE" ]; then
  PUBKEY="$(cat "$PUBKEY_FILE")"
else
  echo "No public key given and $PUBKEY_FILE is missing — pass one as \$1." >&2
  exit 1
fi

RESTRICTED="command=\"rrsync -wo $DASHCAM_DIR\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUBKEY"

# authorized_keys holds exactly this one restricted entry — replaced in full
# on every run so re-running with a new key (e.g. a rebuilt Pi) rotates
# cleanly instead of accumulating stale keys.
AUTH_KEYS=/home/teslacam/.ssh/authorized_keys
echo "$RESTRICTED" > "$AUTH_KEYS"
echo "Installed restricted forced-command key for teslacam."
chmod 600 "$AUTH_KEYS"
chown -R teslacam:teslacam /home/teslacam/.ssh

command -v rrsync >/dev/null 2>&1 || echo "WARNING: rrsync not found (usually in the rsync package) — install it or forced-command SSH will fail." >&2

echo
echo "Done. teslausb's archive target on the Pi:"
echo "  archive_host_name=$(hostname -I 2>/dev/null | awk '{print $1}')   (use the LAN IP, not the hostname — more reliable across wifi networks)"
echo "  archive_username=teslacam"
echo "  archive_dir=/"
echo "If the Pi supplied its own public key (recommended), its private half never needs to leave the Pi."
echo "Otherwise, copy dashcam-ingest/teslacam_pi_key (the PRIVATE key) onto the Pi as its archive SSH key — never commit it to git."
