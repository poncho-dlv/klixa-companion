# Service GPIO machine à fumée (Raspberry Pi)

Micro-service HTTP en réception seule qui déclenche le relais de la machine à
fumée. Piloté par le compagnon Klixa (sur le NAS) via le réseau local.

## Câblage

Relais sur **GPIO 17** (BCM), comme le script de test initial
(`OutputDevice(17, active_high=True, initial_value=False)`).

## Installation

```bash
sudo apt update && sudo apt install -y python3 python3-pip
mkdir -p /home/pi/klixa-smoke && cd /home/pi/klixa-smoke
# Copier smoke_service.py et requirements.txt ici
pip3 install -r requirements.txt --break-system-packages
```

Créer `/home/pi/klixa-smoke/.env` :

```bash
SMOKE_GPIO_PIN=17
SMOKE_PORT=8787
SMOKE_TOKEN=un-secret-partage-avec-le-compagnon
SMOKE_MIN_MS=50
SMOKE_MAX_MS=1500
SMOKE_DEFAULT_MS=300
```

> `SMOKE_TOKEN` doit être identique à `SMOKE_SERVICE_TOKEN` côté compagnon.

## Lancer en service (systemd)

```bash
sudo cp klixa-smoke.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now klixa-smoke
journalctl -u klixa-smoke -f
```

## Tester

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/smoke/trigger \
  -H "content-type: application/json" \
  -H "x-smoke-token: un-secret-partage-avec-le-compagnon" \
  -d '{"durationMs":300}'
```

## Garde-fous

- Durée bornée à `[SMOKE_MIN_MS, SMOKE_MAX_MS]` (défaut 50–1500 ms) — le relais
  ne peut pas rester bloqué « on » via une commande.
- Impulsion unique : une requête pendant une impulsion en cours reçoit `409`.
- Le relais est remis à `off` à l'arrêt du service.
