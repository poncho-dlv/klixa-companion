#!/usr/bin/env python3
"""Service GPIO de la machine à fumée — tourne sur le Raspberry Pi.

Écoute en HTTP sur le réseau local et déclenche le relais à la demande du
compagnon Klixa (sur le NAS). RÉCEPTION SEULE : aucune connexion sortante,
aucune exposition Internet. Garde-fous : durée bornée et impulsion unique
(rejet si une impulsion est déjà en cours) pour ne jamais bloquer le relais "on".

Authentification : secret partagé `SMOKE_TOKEN`, à présenter dans le header
`X-Smoke-Token` (côté compagnon : `SMOKE_SERVICE_TOKEN`). Sans lui, n'importe
quel appareil du LAN pourrait déclencher la machine. Le service REFUSE de
démarrer s'il écoute hors loopback sans token (fail-closed).
"""
import hashlib
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import sleep

from gpiozero import OutputDevice

PIN = int(os.environ.get("SMOKE_GPIO_PIN", "17"))
PORT = int(os.environ.get("SMOKE_PORT", "8787"))
BIND = os.environ.get("SMOKE_BIND", "0.0.0.0").strip()
TOKEN = os.environ.get("SMOKE_TOKEN", "").strip()
MIN_MS = int(os.environ.get("SMOKE_MIN_MS", "50"))
MAX_MS = int(os.environ.get("SMOKE_MAX_MS", "1500"))
DEFAULT_MS = int(os.environ.get("SMOKE_DEFAULT_MS", "300"))
MAX_BODY_BYTES = int(os.environ.get("SMOKE_MAX_BODY_BYTES", str(64 * 1024)))

LOOPBACK = ("127.0.0.1", "::1", "localhost")


def token_matches(provided):
    """Comparaison à temps constant. Le SHA-256 préalable masque aussi la longueur."""
    digest = lambda value: hashlib.sha256(value.encode("utf-8")).digest()
    return hmac.compare_digest(digest(provided or ""), digest(TOKEN))


relais = OutputDevice(PIN, active_high=True, initial_value=False)

# Verrou : une seule impulsion à la fois (rejet si occupé, pas de file d'attente).
_lock = threading.Lock()


def clamp_ms(value):
    try:
        ms = int(value)
    except (TypeError, ValueError):
        ms = DEFAULT_MS
    return max(MIN_MS, min(MAX_MS, ms))


def declenche_fumee(duree_ms):
    """Impulsion bloquante. Retourne la durée appliquée, ou None si occupé."""
    duree_ms = clamp_ms(duree_ms)
    if not _lock.acquire(blocking=False):
        return None
    try:
        relais.on()
        sleep(duree_ms / 1000.0)
    finally:
        relais.off()
        _lock.release()
    return duree_ms


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _send(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Journalisation concise sur stdout (capturée par systemd).
        print("[smoke] " + (fmt % args))

    def _authorized(self):
        """Le compagnon est le SEUL client légitime. Sans token configuré, le service
        est forcément en loopback (garanti au démarrage), donc rien à vérifier."""
        if not TOKEN:
            return True
        if token_matches(self.headers.get("X-Smoke-Token")):
            return True
        self._send(401, {"ok": False, "error": "Token invalide"})
        return False

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/health":
            self._send(200, {"ok": True, "pin": PIN, "maxMs": MAX_MS})
        else:
            self._send(404, {"ok": False, "error": "Route inconnue"})

    def do_POST(self):
        if not self._authorized():
            return
        if self.path != "/smoke/trigger":
            self._send(404, {"ok": False, "error": "Route inconnue"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"ok": False, "error": "Content-Length invalide"})
            return
        if length < 0:
            self._send(400, {"ok": False, "error": "Content-Length invalide"})
            return
        if length > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "error": "Corps de requête trop volumineux"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"ok": False, "error": "JSON invalide"})
            return

        applied = declenche_fumee(payload.get("durationMs"))
        if applied is None:
            self._send(409, {"ok": False, "error": "Impulsion déjà en cours"})
            return
        self._send(200, {"ok": True, "durationMs": applied})


def main():
    # Fail-closed : écouter sur le LAN sans secret partagé exposerait le relais à tout
    # appareil du réseau. Même règle que COMPANION_LOCAL_TOKEN côté compagnon.
    if not TOKEN and BIND not in LOOPBACK:
        raise SystemExit(
            f"[smoke] SMOKE_TOKEN obligatoire lorsque le service écoute hors loopback "
            f"(SMOKE_BIND={BIND}). Générer un secret : python3 -c "
            f"\"import secrets; print(secrets.token_urlsafe(32))\""
        )

    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    auth = "token requis" if TOKEN else "sans token (loopback)"
    print(f"[smoke] Service GPIO sur {BIND}:{PORT} (pin {PIN}, max {MAX_MS} ms, {auth})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        relais.off()
        server.server_close()


if __name__ == "__main__":
    main()
