# Appareils LAN Klixa (Raspberry Pi, ESP...)

Ce dossier contient le SDK de référence permettant à n'importe quel script/appareil du
LAN (Raspberry Pi, ESP32...) de se connecter au compagnon Klixa et de s'annoncer avec
ses **éléments pilotables** (un relais on/off, dans le cas de la machine à fumée — mais
le mécanisme est générique, à toi de piloter ce que tu veux). Protocole complet :
[`../protocol/devices-messages.md`](../protocol/devices-messages.md).

**C'est CE script qui se connecte au compagnon**, jamais l'inverse : pas de port à ouvrir 
sur le Raspberry Pi, pas besoin que le compagnon connaisse son IP à l'avance.

## Machine à fumée (exemple de référence)

- `klixa_device_agent.py` — le SDK (générique, une seule dépendance : `websockets`).
- `examples/smoke_relay.py` — pilote le relais GPIO de la machine à fumée. Câblage sur
  **GPIO 17** (BCM), comme le script d'origine.
- `examples/smoke_relay.env.example`, `examples/klixa-smoke-relay.service`.

### Installation

```bash
sudo apt update && sudo apt install -y python3 python3-pip
mkdir -p /home/rpi_user/klixa-device-agent && cd /home/rpi_user/klixa-device-agent
# Copier klixa_device_agent.py, examples/smoke_relay.py et requirements.txt ici
# (les deux scripts .py doivent être dans le MÊME dossier)
pip3 install -r requirements.txt --break-system-packages
```

### Générer un token

Le token se génère **depuis l'IHM du compagnon** 
app Klixa Companion → page « Appareils LAN » → Générer un token) : donne-lui l'identifiant
que tu vas mettre dans `DEVICE_ID` (ex. `smoke-machine`), le token n'est affiché qu'une 
seule fois, à copier immédiatement.

### Configuration

Créer `/home/rpi_user/klixa-device-agent/.env` (voir
`examples/smoke_relay.env.example`) :

```bash
COMPANION_URL=ws://<ip-du-compagnon>:8786/devices/ws
DEVICE_TOKEN=le-token-genere-ci-dessus
DEVICE_ID=smoke-machine
DEVICE_NAME=Machine à fumée
SMOKE_GPIO_PIN=17
SMOKE_MIN_MS=50
SMOKE_MAX_MS=1500
SMOKE_DEFAULT_MS=300
```

### Lancer en service (systemd)

```bash
sudo cp examples/klixa-smoke-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now klixa-smoke-relay
journalctl -u klixa-smoke-relay -f
```

Si le script fonctionne le device apparaît « connectés » dans le compagnon.

## Écrire son propre agent (autre matériel)

Copie `klixa_device_agent.py` à côté de ton script, puis :

```python
from klixa_device_agent import DeviceAgent

agent = DeviceAgent(
    companion_url="ws://<ip-du-compagnon>:8786/devices/ws",
    token="kxd_...",       # généré depuis l'IHM du compagnon
    device_id="mon-appareil",
    name="Mon appareil",
)

@agent.action("relay", "on")
def turn_on(payload, data):
    ...  # ton code (GPIO, HTTP local, ce que tu veux)

@agent.action("relay", "off")
def turn_off(payload, data):
    ...

agent.run()
```

Un handler peut être une fonction normale (exécutée dans un thread — ne bloque jamais la
connexion, même s'il fait un `sleep()`) ou une coroutine `async def`. `payload` est
structuré (construit par Klixa depuis le schéma `params`, optionnel) ; `data` est un
champ JSON libre jamais interprété ni par Klixa ni par le compagnon — sa forme
t'appartient entièrement. Voir la docstring de `klixa_device_agent.py` pour le détail.

## Garde-fous

- **Token par appareil** (généré depuis l'IHM du compagnon, jamais un secret choisi à la
  main) : un token compromis ne permet de se faire passer que pour CET appareil précis,
  jamais de piloter le reste du compagnon. Révoquer un token coupe la connexion
  **immédiatement**, pas seulement sa prochaine tentative de reconnexion.
- Durée bornée à `[SMOKE_MIN_MS, SMOKE_MAX_MS]` (défaut 50–1500 ms) dans
  `examples/smoke_relay.py` — le relais ne peut pas rester bloqué « on » via une
  commande.
- Impulsion unique : une commande reçue pendant une impulsion en cours échoue clairement
  (`"Impulsion déjà en cours"`) plutôt que de mettre en file ou d'ignorer.
- Le relais repasse à `off` dans le `finally` de chaque impulsion (même en cas d'erreur
  pendant le `sleep`) — pas de garde supplémentaire sur un arrêt brutal du process
  (`kill -9`), identique à l'ancien service sur ce point précis.
- Ce script/ce matériel doit rester accessible uniquement sur le LAN et ne jamais être
  exposé à Internet.
