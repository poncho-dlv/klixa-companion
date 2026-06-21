#!/usr/bin/env python3
"""Service GPIO de la machine à fumée — tourne sur le Raspberry Pi.

Écoute en HTTP sur le réseau local et déclenche le relais à la demande du
compagnon Klixa (sur le NAS). RÉCEPTION SEULE : aucune connexion sortante,
aucune exposition Internet. Garde-fous : durée bornée et impulsion unique
(rejet si une impulsion est déjà en cours) pour ne jamais bloquer le relais "on".
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import sleep

from gpiozero import OutputDevice

PIN = int(os.environ.get("SMOKE_GPIO_PIN", "17"))
PORT = int(os.environ.get("SMOKE_PORT", "8787"))
TOKEN = os.environ.get("SMOKE_SERVICE_TOKEN", "")
MIN_MS = int(os.environ.get("SMOKE_MIN_MS", "50"))
MAX_MS = int(os.environ.get("SMOKE_MAX_MS", "1500"))
DEFAULT_MS = int(os.environ.get("SMOKE_DEFAULT_MS", "300"))

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

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "pin": PIN, "maxMs": MAX_MS})
        else:
            self._send(404, {"ok": False, "error": "Route inconnue"})

    def do_POST(self):
        if self.path != "/smoke/trigger":
            self._send(404, {"ok": False, "error": "Route inconnue"})
            return
        if TOKEN and self.headers.get("x-smoke-token") != TOKEN:
            self._send(401, {"ok": False, "error": "Token invalide"})
            return

        length = int(self.headers.get("Content-Length") or 0)
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
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[smoke] Service GPIO sur le port {PORT} (pin {PIN}, max {MAX_MS} ms)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        relais.off()
        server.server_close()


if __name__ == "__main__":
    main()
