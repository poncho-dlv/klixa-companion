#!/usr/bin/env python3
"""Machine à fumée — relais piloté par Klixa via le compagnon.

Exemple de référence pour klixa_device_agent.py (voir ce fichier, dans le même
dossier) : sert de modèle pour piloter TON matériel (n'importe quel relais/GPIO), pas
seulement une machine à fumée — copie les deux fichiers côte à côte.

Variables d'environnement (cf. .env.example) :
  COMPANION_URL   ws://<ip-du-compagnon>:8786/devices/ws
  DEVICE_TOKEN    token généré depuis l'IHM du compagnon (page « Appareils LAN »)
  DEVICE_ID       DOIT correspondre à l'identifiant choisi à la génération du token
  DEVICE_NAME     nom affiché côté Klixa (optionnel)
  SMOKE_GPIO_PIN, SMOKE_MIN_MS, SMOKE_MAX_MS, SMOKE_DEFAULT_MS
"""
import os
import threading
from time import sleep

from gpiozero import OutputDevice

from klixa_device_agent import DeviceAgent

PIN = int(os.environ.get("SMOKE_GPIO_PIN", "17"))
MIN_MS = int(os.environ.get("SMOKE_MIN_MS", "50"))
MAX_MS = int(os.environ.get("SMOKE_MAX_MS", "1500"))
DEFAULT_MS = int(os.environ.get("SMOKE_DEFAULT_MS", "300"))

relais = OutputDevice(PIN, active_high=True, initial_value=False)

# Une seule impulsion à la fois (rejet si occupé) — pour ne jamais bloquer le relais
# « on » sur des commandes qui se chevauchent.
_lock = threading.Lock()


def clamp_ms(value):
    try:
        ms = int(value)
    except (TypeError, ValueError):
        ms = DEFAULT_MS
    return max(MIN_MS, min(MAX_MS, ms))


agent = DeviceAgent(
    companion_url=os.environ["COMPANION_URL"],
    token=os.environ["DEVICE_TOKEN"],
    device_id=os.environ.get("DEVICE_ID", "smoke-machine"),
    name=os.environ.get("DEVICE_NAME", "Machine à fumée"),
)


@agent.action(
    "relay", "trigger",
    element_name="Relais fumée",
    params={"durationMs": {"min": MIN_MS, "max": MAX_MS, "default": DEFAULT_MS}},
)
def trigger(payload, data):
    duration_ms = clamp_ms(payload.get("durationMs"))
    if not _lock.acquire(blocking=False):
        raise RuntimeError("Impulsion déjà en cours")
    try:
        relais.on()
        sleep(duration_ms / 1000.0)
    finally:
        relais.off()
        _lock.release()
    return {"durationMs": duration_ms}


if __name__ == "__main__":
    agent.run()
