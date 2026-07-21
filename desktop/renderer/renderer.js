const form = document.querySelector('#config');
const message = document.querySelector('#message');
const statusLine = document.querySelector('#status');
const statusIcon = document.querySelector('#statusIcon');
const statusMessage = document.querySelector('#statusMessage');
const autoLaunch = document.querySelector('#autoLaunch');
const pairBtn = document.querySelector('#pairBtn');
const pairCode = document.querySelector('#pairCode');
const pairCodeValue = document.querySelector('#pairCodeValue');
const pairCodeTimer = document.querySelector('#pairCodeTimer');
const pairMessage = document.querySelector('#pairMessage');
const navSmoke = document.querySelector('#navSmoke');
const disconnectBtn = document.querySelector('#disconnectBtn');
const updateBanner = document.querySelector('#updateBanner');
const updateBannerMessage = document.querySelector('#updateBannerMessage');
const updateInstallBtn = document.querySelector('#updateInstallBtn');
const hueBridgeIp = document.querySelector('#hueBridgeIp');
const hueBridgePort = document.querySelector('#hueBridgePort');
const huePairBtn = document.querySelector('#huePairBtn');
const hueMessage = document.querySelector('#hueMessage');
const hueStatus = document.querySelector('#hueStatus');
const hueUnpairBtn = document.querySelector('#hueUnpairBtn');
const smokeServiceHost = document.querySelector('#smokeServiceHost');
const smallrigStatus = document.querySelector('#smallrigStatus');
const smallrigScanBtn = document.querySelector('#smallrigScanBtn');
const smallrigFound = document.querySelector('#smallrigFound');
const smallrigPaired = document.querySelector('#smallrigPaired');
const smallrigMessage = document.querySelector('#smallrigMessage');
const obsEnabled = document.querySelector('input[name="OBS_ENABLED"]');
const obsConnectionBtn = document.querySelector('#obsConnectionBtn');
const streamerbotEnabled = document.querySelector('input[name="SB_ENABLED"]');
const streamerbotConnectionBtn = document.querySelector('#streamerbotConnectionBtn');
const smokeEnabled = document.querySelector('input[name="SMOKE_ENABLED"]');
const smokeConnectionBtn = document.querySelector('#smokeConnectionBtn');
const integrationStatusEls = new Map(
  [...document.querySelectorAll('.integration-status[data-integration]')].map((el) => [el.dataset.integration, el])
);

// Champs non-secrets (URL/hôte/port) verrouillés tant que l'intégration correspondante
// répond — même intention que le verrouillage des secrets ci-dessous : éviter une
// modification accidentelle pendant que tout marche. Le toggle *_ENABLED reste toujours
// éditable (le désactiver est l'échappatoire pour reconfigurer une intégration bloquée).
const INTEGRATION_PLAIN_FIELDS = {
  obs: [document.querySelector('input[name="OBS_WS_HOST"]'), document.querySelector('input[name="OBS_WS_PORT"]')],
  streamerbot: [document.querySelector('input[name="SB_HOST"]'), document.querySelector('input[name="SB_PORT"]')],
  smoke: [smokeServiceHost, document.querySelector('input[name="SMOKE_SERVICE_PORT"]')]
};
const INTEGRATION_ENABLED_KEYS = {
  obs: 'OBS_ENABLED',
  streamerbot: 'SB_ENABLED',
  smoke: 'SMOKE_ENABLED'
};

// Champs secrets (mot de passe / token) : jamais reaffiches en clair. Une fois
// configures cote store, le champ se verrouille sur un masque factice — cliquer
// dessus (focus) le vide et le deverrouille pour saisir une nouvelle valeur. Tant
// qu'il reste verrouille, sa valeur n'est pas envoyee a la sauvegarde (cf. submit
// plus bas), donc pas de "laisser vide pour conserver" a interpreter.
const SECRET_MASK = '••••••••';
const secretFields = [
  { input: document.querySelector('#obsWsPassword'), configuredKey: 'OBS_WS_PASSWORD_CONFIGURED', statusId: 'obs' },
  { input: document.querySelector('#sbPassword'), configuredKey: 'SB_PASSWORD_CONFIGURED', statusId: 'streamerbot' },
  { input: document.querySelector('#smokeServiceToken'), configuredKey: 'SMOKE_SERVICE_TOKEN_CONFIGURED', statusId: 'smoke' }
];

// Chemins FontAwesome (circle-check / triangle-exclamation) inlines en SVG : la CSP
// interdit de charger une police/feuille de style externe, donc pas de webfont FA.
const ICON_CHECK = 'M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zM374 145.7c-10.7-7.8-25.7-5.4-33.5 5.3L221.1 315.2 169 263.1c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9l72 72c5 5 11.8 7.5 18.8 7s13.4-4.1 17.5-9.8L379.3 179.2c7.8-10.7 5.4-25.7-5.3-33.5z';
const ICON_WARNING = 'M256 0c14.7 0 28.2 8.1 35.2 21l216 400c6.7 12.4 6.4 27.4-.8 39.5S486.1 480 472 480L40 480c-14.1 0-27.2-7.4-34.4-19.5s-7.5-27.1-.8-39.5l216-400c7-12.9 20.5-21 35.2-21zm0 352a32 32 0 1 0 0 64 32 32 0 1 0 0-64zm0-192c-18.2 0-32.7 15.5-31.4 33.7l7.4 104c.9 12.5 11.4 22.3 23.9 22.3 12.6 0 23-9.7 23.9-22.3l7.4-104c1.3-18.2-13.1-33.7-31.4-33.7z';

// Navigation en pages dediees (une section = une page), a la place de l'ancien
// empilement vertical unique. Le formulaire #config reste UNIQUE et englobe toutes
// les pages (un bouton "Enregistrer" par page ne fait que declencher le meme submit
// via son attribut form) : masquer une page via [hidden] ne retire pas ses champs de
// FormData, donc chaque "Enregistrer" sauvegarde en realite l'integralite de la
// config, quelle que soit la page affichee — sans consequence puisque les autres
// pages refletent deja l'etat persiste tant qu'elles n'ont pas ete modifiees sans
// sauvegarder.
const pageTitle = document.querySelector('#pageTitle');
const pageDescription = document.querySelector('#pageDescription');
const navButtons = new Map(
  [...document.querySelectorAll('.config-button[data-page]')].map((el) => [el.dataset.page, el])
);
const pageSections = new Map(
  [...document.querySelectorAll('.page[data-page]')].map((el) => [el.dataset.page, el])
);
const PAGE_META = {
  connexion: { title: 'Connexion Klixa', description: 'Lie ce compagnon à ta console Klixa.' },
  obs: { title: 'OBS', description: 'Contrôle OBS Studio via obs-websocket.' },
  streamerbot: { title: 'Streamer.bot', description: 'Déclenche des actions Streamer.bot.' },
  smoke: { title: 'Machine à fumée', description: 'Pilote la machine à fumée de la régie.' },
  hue: { title: 'Philips Hue', description: 'Contrôle les lumières via le bridge Hue.' },
  smallrig: { title: 'Lampes SmallRig', description: 'Gère les lampes RM75 en Bluetooth Mesh.' },
  settings: { title: 'Paramètres', description: 'Réglages généraux du compagnon.' }
};
let activePage = 'connexion';

function setActivePage(id) {
  if (!pageSections.has(id)) return;
  activePage = id;
  for (const [pid, section] of pageSections) section.hidden = pid !== id;
  for (const [pid, btn] of navButtons) btn.classList.toggle('active', pid === id);
  const meta = PAGE_META[id];
  pageTitle.textContent = meta.title;
  pageDescription.textContent = meta.description;
}

// Tant que le compagnon n'est pas lie a une console Klixa, les pages d'integration
// n'ont rien a configurer de fonctionnel (rien a connecter) : on les grise dans le
// menu et on force le retour sur la page Connexion.
function setNavLocked(locked) {
  for (const [pid, btn] of navButtons) {
    if (pid === 'connexion' || pid === 'settings') continue;
    btn.disabled = locked;
  }
  if (locked) { if (activePage !== 'settings') setActivePage('connexion'); }
  else if (activePage === 'connexion') setActivePage('obs');
}

for (const [pid, btn] of navButtons) {
  btn.addEventListener('click', () => setActivePage(pid));
}

setActivePage('connexion');

let lastStatus = { running: false, message: 'Démarrage...' };
let lastCloudStatus = { connected: false, features: {} };
let lastConfig = {};
let lastIntegrationStatus = null;
const pendingConnections = new Set();

// Le sous-titre reflete en priorite la liaison cloud (c'est ce qui interesse le
// streamer au quotidien) et retombe sur le statut du runtime local sinon.
function renderHeaderStatus() {
  const connected = Boolean(lastCloudStatus.connected);
  const ok = connected && lastStatus.running;
  statusMessage.textContent = connected ? 'Compagnon connecté' : lastStatus.message;
  statusLine.className = `status-line ${ok ? 'ok' : 'error'}`;
  statusIcon.querySelector('path').setAttribute('d', ok ? ICON_CHECK : ICON_WARNING);
}

function renderStatus(status) {
  lastStatus = status;
  renderHeaderStatus();
}

// Le verrouillage du menu se base sur la config PERSISTEE (CLOUD_WS_URL present ou
// non), pas sur le statut WS live : sauver la config ou appairer Hue redemarre tout
// le runtime (donc coupe puis rouvre la liaison cloud un instant), et piloter le menu
// sur ce flottement aurait fait sauter la page active a chaque sauvegarde. Le statut
// live (cloud:status) reste reserve au texte du header et aux features tenant (ex.
// machine a fumee).
function renderPairingUi() {
  const linked = Boolean(lastConfig.CLOUD_WS_URL);
  disconnectBtn.hidden = !linked;
  // Rien à faire sur cette page une fois lié (le "Déconnecter" de la sidebar suffit) :
  // masquée plutôt que juste désactivée, comme navSmoke pour les fonctionnalités tenant.
  navButtons.get('connexion').hidden = linked;
  setNavLocked(!linked);
}

function renderHueUi() {
  const enabled = lastConfig.HUE_ENABLED !== false && lastConfig.HUE_ENABLED !== 'false';
  const paired = Boolean(lastConfig.HUE_APP_KEY_CONFIGURED);
  const connected = Boolean(lastIntegrationStatus?.hue?.ok);
  huePairBtn.hidden = paired;
  hueUnpairBtn.hidden = !paired;
  hueBridgeIp.readOnly = connected;
  hueBridgePort.readOnly = connected;

  const icon = hueStatus.querySelector('path');
  const span = hueStatus.querySelector('span');
  if (!enabled) {
    hueStatus.className = 'integration-status status-line';
    icon.setAttribute('d', '');
    span.textContent = 'Désactivé';
  } else {
    hueStatus.className = `integration-status status-line ${connected ? 'ok' : 'error'}`;
    icon.setAttribute('d', connected ? ICON_CHECK : ICON_WARNING);
    span.textContent = connected ? 'Connecté' : 'Non connecté';
  }
}

let lastFoundLamps = [];
let lastPairedLamps = [];
let smallrigScanning = false;

// Distingue l'état local (lampes appairées) d'une vraie session Proxy active. Une
// lampe enregistrée n'est pas présentée comme joignable tant qu'aucun lien BLE ne le
// confirme.
function renderSmallrigStatus() {
  const enabled = lastConfig.SMALLRIG_ENABLED !== false && lastConfig.SMALLRIG_ENABLED !== 'false';
  const entry = lastIntegrationStatus?.smallrig;
  const icon = smallrigStatus.querySelector('path');
  const span = smallrigStatus.querySelector('span');
  if (!enabled) {
    smallrigStatus.className = 'integration-status status-line';
    icon.setAttribute('d', '');
    span.textContent = 'Désactivé';
  } else if (!entry) {
    smallrigStatus.className = 'integration-status status-line';
    icon.setAttribute('d', '');
    span.textContent = 'Vérification...';
  } else if (entry.ok === false) {
    smallrigStatus.className = 'integration-status status-line error';
    icon.setAttribute('d', ICON_WARNING);
    span.textContent = entry.error || 'Bluetooth indisponible';
  } else {
    const paired = Boolean(entry.paired ?? entry.lamps > 0);
    const proxyConnected = entry.proxyConnected === true;
    smallrigStatus.className = `integration-status status-line${proxyConnected ? ' ok' : ''}`;
    icon.setAttribute('d', proxyConnected ? ICON_CHECK : '');
    span.textContent = !paired
      ? 'Aucune lampe appairée'
      : proxyConnected
        ? `${entry.lamps} lampe(s) appairée(s) · proxy connecté`
        : `${entry.lamps} lampe(s) appairée(s) · connexion à la demande`;
  }
}

// Ligne compacte du pattern « strip list » (miroir de .el-line côté Klixa) :
// libellé en ellipse + méta discrète + actions à droite, sur UNE seule ligne.
function lampRow({ title, meta, buttonLabel, onClick, extraNode }) {
  const li = document.createElement('li');
  li.className = 'lamp-row';
  const line = document.createElement('div');
  line.className = 'lamp-line';
  const titleEl = document.createElement('span');
  titleEl.className = 'lamp-label';
  titleEl.textContent = title;
  line.appendChild(titleEl);
  if (extraNode) line.appendChild(extraNode);
  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'lamp-meta';
    metaEl.textContent = meta;
    line.appendChild(metaEl);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = buttonLabel;
  button.addEventListener('click', onClick);
  const actions = document.createElement('div');
  actions.className = 'lamp-actions';
  actions.appendChild(button);
  line.appendChild(actions);
  li.appendChild(line);
  return li;
}

function renderSmallrigFound() {
  smallrigFound.innerHTML = '';
  const unprovisioned = lastFoundLamps.filter((l) => l.kind === 'unprovisioned');
  if (unprovisioned.length === 0) {
    const li = document.createElement('li');
    li.className = 'lamp-empty';
    li.textContent = smallrigScanning ? 'Scan en cours...' : 'Aucune nouvelle lampe détectée. Lance un scan.';
    smallrigFound.appendChild(li);
    return;
  }
  for (const lamp of unprovisioned) {
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Nom (optionnel)';
    nameInput.value = lamp.name || '';
    const row = lampRow({
      title: `Lampe détectée (${lamp.bleDeviceId})`,
      meta: Number.isFinite(lamp.rssi) ? `Signal ${lamp.rssi} dBm` : '',
      buttonLabel: 'Appairer',
      extraNode: nameInput,
      onClick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Appairage en cours…';
        smallrigMessage.className = '';
        smallrigMessage.textContent = 'Appairage en cours (peut prendre quelques secondes)...';
        try {
          const result = await window.klixa.smallrigProvision(
            lamp.bleDeviceId,
            lamp.deviceUuid || null,
            nameInput.value.trim() || null
          );
          lastFoundLamps = lastFoundLamps.filter((l) => l.bleDeviceId !== lamp.bleDeviceId);
          await refreshSmallrigPaired();
          renderSmallrigFound();
          if (result?.configured === false) {
            smallrigMessage.className = 'error';
            smallrigMessage.textContent = 'Lampe appairée, mais configuration incomplète. Utilise « Reconfigurer ».';
          } else {
            smallrigMessage.className = 'ok';
            smallrigMessage.textContent = 'Lampe appairée et configurée.';
          }
        } catch (error) {
          // Le provisioning peut avoir réussi côté lampe avant une erreur de
          // configuration. Toujours rafraîchir la liste pour rendre la récupération
          // visible au lieu de laisser croire que rien ne s'est passé.
          await refreshSmallrigPaired();
          smallrigMessage.className = 'error';
          smallrigMessage.textContent = error.message;
          button.disabled = false;
          button.textContent = 'Appairer';
        }
      }
    });
    smallrigFound.appendChild(row);
  }
}

// Numérotation "commande" (LqFx, premier octet du payload envoyé) — cf.
// RM75_SPEC_DEV.md §9.4 / RM75_protocole.md §4. Reverse-engineered depuis la classe
// LqFx de SmallGoGo, PAS encore validé sur lampe reelle (§12 point 5 du spec : "Formats
// confirmés dans LqFx de SmallGoGo ; validation radio encore requise").
const FX_COMMAND_MODE_LABELS = {
  1: 'Paparazzi', 2: 'Cycle', 3: 'Éclair', 4: 'Pulsation', 5: 'SOS', 6: 'Soudure',
  7: 'Alarme', 8: 'Feu d’artifice', 9: 'Aléatoire', 10: 'Feu', 11: 'TV', 12: 'Ampoule défectueuse'
};

// Numérotation "device" (MODE_DEV_*, valeur `mode` renvoyée par LqCStatus) — DIFFERENTE
// de la numerotation commande ci-dessus (cf. memes docs). Utilisee uniquement pour
// interpreter smallrig.status, jamais pour construire une commande FX.
const FX_STATUS_MODE_LABELS = {
  1: 'RGB', 2: 'Paparazzi', 3: 'Party', 4: 'Éclair', 5: 'Ampoule défectueuse', 6: 'TV',
  7: 'Bougie', 8: 'Aléatoire', 9: 'Feu d’artifice', 10: 'Police', 11: 'Camion de pompiers',
  12: 'Ambulance', 13: 'Soudure', 14: 'SOS', 15: 'Pulsation'
};

// Traduit la réponse brute de smallrig.status (cf. lq-protocol.js#decodeStatus/
// decodeCapacity) en une ligne lisible pour le panneau de pilotage.
function describeSmallrigStatus(state, capacity) {
  const parts = [];
  if (state?.error) {
    parts.push(`Mode : lecture impossible (${state.error})`);
  } else if (state) {
    switch (state.type) {
      case 'hsi': parts.push(`Couleur · teinte ${state.hue}° · saturation ${state.sat}% · luminosité ${state.intensity}%`); break;
      case 'cct': parts.push(`Température · ${state.kelvin}K · luminosité ${state.intensity}% · teinte ${state.gm >= 0 ? '+' : ''}${state.gm}`); break;
      case 'rgbw': parts.push(`RGBW · R${state.r} V${state.g} B${state.b} · blanc ${state.w}`); break;
      case 'fx': parts.push(`Effet ${FX_STATUS_MODE_LABELS[state.mode] || state.mode} · vitesse ${state.freq} · luminosité ${state.intensity}%`); break;
      default: parts.push(`Mode ${state.type}`);
    }
  }
  if (capacity?.error) {
    parts.push(`Batterie : lecture impossible (${capacity.error})`);
  } else if (capacity) {
    const chargeLabel = { discharged: 'sur batterie', charging: 'en charge', full: 'chargée' }[capacity.chargeState] || capacity.chargeState;
    parts.push(`${capacity.poweredOn ? 'Allumée' : 'Éteinte'} · batterie ${capacity.battery}% (${chargeLabel}) · autonomie ${capacity.autonomyHours}h`);
  }
  return parts.join(' — ') || 'Aucune information disponible.';
}

// Panneau de pilotage direct d'une lampe appairée : actions immédiates (comme
// discover/provision/forget/reconfigure), independantes du formulaire de config
// persisté. Un seul mode couleur actif a la fois (HSI/CCT/RGBW/Effet), l'alimentation
// et la luminosité restent pilotables separement des le mode choisi.
function buildLampControlPanel(lamp) {
  // Wrapper animé du pattern strip list (grid-template-rows 0fr→1fr piloté par
  // .lamp-row--open sur la ligne parente, cf. styles.css) : le contenu vit dans
  // `body`, `panel` n'est que l'enveloppe de dépliage.
  const panel = document.createElement('div');
  panel.className = 'lamp-panel';
  const panelInner = document.createElement('div');
  panelInner.className = 'lamp-panel-inner';
  const body = document.createElement('div');
  body.className = 'lamp-panel-body';
  panelInner.appendChild(body);
  panel.appendChild(panelInner);

  const panelMessage = document.createElement('p');
  panelMessage.className = 'lamp-panel-message';
  panelMessage.setAttribute('role', 'status');

  async function runCommand(action) {
    panelMessage.className = '';
    panelMessage.textContent = 'Envoi…';
    try {
      await action();
      panelMessage.className = 'ok';
      panelMessage.textContent = 'Envoyé.';
    } catch (error) {
      panelMessage.className = 'error';
      panelMessage.textContent = error.message;
    }
  }

  const powerRow = document.createElement('div');
  powerRow.className = 'lamp-panel-row';
  const powerToggleLabel = document.createElement('label');
  powerToggleLabel.className = 'toggle switch-row';
  const powerToggle = document.createElement('input');
  powerToggle.type = 'checkbox';
  powerToggle.checked = true;
  const powerToggleText = document.createElement('span');
  powerToggleText.className = 'switch-label-text';
  powerToggleText.textContent = 'Allumée';
  powerToggleLabel.append(powerToggle, powerToggleText);
  const brightnessLabel = document.createElement('label');
  brightnessLabel.textContent = 'Luminosité';
  const brightnessInput = document.createElement('input');
  brightnessInput.type = 'range';
  brightnessInput.min = '1';
  brightnessInput.max = '100';
  brightnessInput.value = '85';
  brightnessLabel.appendChild(brightnessInput);
  powerRow.append(powerToggleLabel, brightnessLabel);
  body.appendChild(powerRow);

  powerToggle.addEventListener('change', () => {
    powerToggleText.textContent = powerToggle.checked ? 'Allumée' : 'Éteinte';
    runCommand(() => window.klixa.smallrigPower([lamp.uuid], powerToggle.checked, powerToggle.checked ? Number(brightnessInput.value) : undefined));
  });
  brightnessInput.addEventListener('change', () => {
    powerToggle.checked = true;
    powerToggleText.textContent = 'Allumée';
    runCommand(() => window.klixa.smallrigPower([lamp.uuid], true, Number(brightnessInput.value)));
  });

  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'Mode';
  const modeSelect = document.createElement('select');
  for (const [value, label] of [['hsi', 'Couleur'], ['cct', 'Température'], ['rgbw', 'RGBW'], ['fx', 'Effet']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    modeSelect.appendChild(option);
  }
  modeLabel.appendChild(modeSelect);
  body.appendChild(modeLabel);

  const hsiFields = document.createElement('label');
  hsiFields.textContent = 'Couleur';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#ffffff';
  hsiFields.appendChild(colorInput);
  body.appendChild(hsiFields);

  const cctFields = document.createElement('div');
  cctFields.className = 'lamp-panel-row';
  const kelvinLabel = document.createElement('label');
  const kelvinText = document.createTextNode('Température (5600K)');
  kelvinLabel.appendChild(kelvinText);
  const kelvinInput = document.createElement('input');
  kelvinInput.type = 'range';
  kelvinInput.min = '2700';
  kelvinInput.max = '10000';
  kelvinInput.step = '100';
  kelvinInput.value = '5600';
  kelvinInput.addEventListener('input', () => { kelvinText.textContent = `Température (${kelvinInput.value}K)`; });
  kelvinLabel.appendChild(kelvinInput);
  const gmLabel = document.createElement('label');
  gmLabel.textContent = 'Teinte vert/magenta';
  const gmInput = document.createElement('input');
  gmInput.type = 'range';
  gmInput.min = '-10';
  gmInput.max = '10';
  gmInput.value = '0';
  gmLabel.appendChild(gmInput);
  cctFields.append(kelvinLabel, gmLabel);
  body.appendChild(cctFields);

  const rgbwFields = document.createElement('div');
  rgbwFields.className = 'lamp-panel-row';
  function channelControl(label, defaultValue) {
    const l = document.createElement('label');
    l.textContent = label;
    const i = document.createElement('input');
    i.type = 'range';
    i.min = '0';
    i.max = '255';
    i.value = String(defaultValue);
    l.appendChild(i);
    rgbwFields.appendChild(l);
    return i;
  }
  const rInput = channelControl('Rouge', 255);
  const gInput = channelControl('Vert', 255);
  const bInput = channelControl('Bleu', 255);
  const wInput = channelControl('Blanc', 0);
  body.appendChild(rgbwFields);

  const fxFields = document.createElement('div');
  fxFields.className = 'lamp-panel-row';
  const fxModeLabel = document.createElement('label');
  fxModeLabel.textContent = 'Effet';
  const fxSelect = document.createElement('select');
  for (const [value, label] of Object.entries(FX_COMMAND_MODE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fxSelect.appendChild(option);
  }
  fxModeLabel.appendChild(fxSelect);
  // Un seul curseur "vitesse" pour param1/param2 : le mapping exact par mode n'a pas
  // été confirmé sur matériel réel (cf. index.js#restoreLightState) et la plupart des
  // modes utilisent les deux octets de façon similaire (cadence/intensité de l'effet).
  const fxSpeedLabel = document.createElement('label');
  fxSpeedLabel.textContent = 'Vitesse';
  const fxSpeedInput = document.createElement('input');
  fxSpeedInput.type = 'range';
  fxSpeedInput.min = '0';
  fxSpeedInput.max = '255';
  fxSpeedInput.value = '50';
  fxSpeedLabel.appendChild(fxSpeedInput);
  fxFields.append(fxModeLabel, fxSpeedLabel);
  body.appendChild(fxFields);

  function updateVisibleMode() {
    hsiFields.hidden = modeSelect.value !== 'hsi';
    cctFields.hidden = modeSelect.value !== 'cct';
    rgbwFields.hidden = modeSelect.value !== 'rgbw';
    fxFields.hidden = modeSelect.value !== 'fx';
  }
  modeSelect.addEventListener('change', updateVisibleMode);
  updateVisibleMode();

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'primary';
  applyBtn.textContent = 'Appliquer';
  applyBtn.addEventListener('click', () => runCommand(async () => {
    switch (modeSelect.value) {
      case 'hsi':
        await window.klixa.smallrigColor([lamp.uuid], colorInput.value, Number(brightnessInput.value));
        break;
      case 'cct':
        await window.klixa.smallrigCct([lamp.uuid], Number(kelvinInput.value), Number(brightnessInput.value), Number(gmInput.value));
        break;
      case 'rgbw':
        await window.klixa.smallrigRgbw([lamp.uuid], Number(rInput.value), Number(gInput.value), Number(bInput.value), Number(wInput.value));
        break;
      case 'fx':
        await window.klixa.smallrigFx([lamp.uuid], Number(fxSelect.value), Number(fxSpeedInput.value), Number(fxSpeedInput.value));
        break;
    }
  }));
  body.append(applyBtn, panelMessage);

  const statusBtn = document.createElement('button');
  statusBtn.type = 'button';
  statusBtn.className = 'secondary-button';
  statusBtn.textContent = 'Lire l’état actuel';
  const statusOutput = document.createElement('p');
  statusOutput.className = 'lamp-panel-message';
  statusOutput.setAttribute('role', 'status');
  statusBtn.addEventListener('click', async () => {
    statusBtn.disabled = true;
    statusOutput.className = '';
    statusOutput.textContent = 'Lecture…';
    try {
      const { state, capacity } = await window.klixa.smallrigStatus(lamp.uuid);
      statusOutput.className = '';
      statusOutput.textContent = describeSmallrigStatus(state, capacity);
    } catch (error) {
      statusOutput.className = 'error';
      statusOutput.textContent = error.message;
    } finally {
      statusBtn.disabled = false;
    }
  });
  body.append(statusBtn, statusOutput);

  return panel;
}

function renderSmallrigPaired() {
  smallrigPaired.innerHTML = '';
  if (lastPairedLamps.length === 0) {
    const li = document.createElement('li');
    li.className = 'lamp-empty';
    li.textContent = 'Aucune lampe appairée pour le moment.';
    smallrigPaired.appendChild(li);
    return;
  }
  for (const lamp of lastPairedLamps) {
    const configurationPending = lamp.configurationPending === true
      || lamp.configurationStatus === 'pending'
      || lamp.configured === false;
    const row = lampRow({
      title: lamp.name || `Lampe ${lamp.uuid.slice(0, 8)}…`,
      meta: `Adresse mesh 0x${lamp.unicastAddress.toString(16).padStart(4, '0')}${configurationPending ? ' · configuration en attente' : ''}`,
      buttonLabel: 'Oublier',
      onClick: async (event) => {
        if (!window.confirm('La lampe va recevoir un Node Reset avant la suppression locale. Continuer ?')) return;
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Réinitialisation…';
        try {
          await window.klixa.smallrigForget(lamp.uuid, false);
          smallrigMessage.className = 'ok';
          smallrigMessage.textContent = 'Lampe réinitialisée et oubliée.';
          await refreshSmallrigPaired();
        } catch (error) {
          smallrigMessage.className = 'error';
          smallrigMessage.textContent = error.message;
          button.disabled = false;
          button.textContent = 'Oublier';
          if (window.confirm('L’oubli avec Node Reset a échoué. Oublier uniquement la clé locale ? Fais-le seulement si la lampe a déjà été réinitialisée en usine ou est définitivement perdue.')) {
            try {
              await window.klixa.smallrigForget(lamp.uuid, true);
              smallrigMessage.className = 'ok';
              smallrigMessage.textContent = 'Clé locale supprimée. Un reset usine est requis avant tout nouvel appairage.';
              await refreshSmallrigPaired();
            } catch (forceError) {
              smallrigMessage.textContent = forceError.message;
            }
          }
        }
      }
    });
    const actions = row.querySelector('.lamp-actions');
    const reconfigureButton = document.createElement('button');
    reconfigureButton.type = 'button';
    reconfigureButton.textContent = configurationPending ? 'Terminer la configuration' : 'Reconfigurer';
    reconfigureButton.addEventListener('click', async () => {
      reconfigureButton.disabled = true;
      smallrigMessage.className = '';
      smallrigMessage.textContent = 'Configuration Mesh en cours…';
      try {
        await window.klixa.smallrigReconfigure(lamp.uuid);
        smallrigMessage.className = 'ok';
        smallrigMessage.textContent = 'Configuration Mesh terminée.';
        await refreshSmallrigPaired();
      } catch (error) {
        smallrigMessage.className = 'error';
        smallrigMessage.textContent = error.message;
        reconfigureButton.disabled = false;
      }
    });
    actions.prepend(reconfigureButton);

    const controlButton = document.createElement('button');
    controlButton.type = 'button';
    controlButton.textContent = 'Piloter';
    controlButton.disabled = configurationPending;
    const panel = buildLampControlPanel(lamp);
    const setOpen = (open) => {
      row.classList.toggle('lamp-row--open', open);
      controlButton.textContent = open ? 'Masquer le pilotage' : 'Piloter';
    };
    controlButton.addEventListener('click', () => setOpen(!row.classList.contains('lamp-row--open')));
    actions.appendChild(controlButton);
    row.appendChild(panel);

    // Comme sur Klixa (pattern el-line), la ligne elle-même déplie le panneau —
    // sauf clic sur un contrôle (Oublier/Reconfigurer/Piloter gèrent leur action).
    if (!configurationPending) {
      row.classList.add('lamp-row--togglable');
      row.querySelector('.lamp-line').addEventListener('click', (event) => {
        if (event.target.closest('button, input, select, label')) return;
        setOpen(!row.classList.contains('lamp-row--open'));
      });
    }

    smallrigPaired.appendChild(row);
  }
}

async function refreshSmallrigPaired() {
  try {
    const { lamps } = await window.klixa.smallrigList();
    lastPairedLamps = lamps || [];
  } catch (error) {
    // Ne pas transformer une panne du store/Bluetooth en liste vide : cela ferait
    // croire que les clés Mesh ont disparu. Garder la dernière vue et exposer la cause.
    smallrigMessage.className = 'error';
    smallrigMessage.textContent = error.message || 'Impossible de charger les lampes SmallRig.';
  }
  renderSmallrigPaired();
  renderSmallrigStatus();
}

smallrigScanBtn.addEventListener('click', async () => {
  smallrigScanning = true;
  smallrigScanBtn.disabled = true;
  smallrigScanBtn.textContent = 'Scan en cours…';
  smallrigMessage.className = '';
  smallrigMessage.textContent = '';
  renderSmallrigFound();
  try {
    const { lamps } = await window.klixa.smallrigDiscover(6000);
    lastFoundLamps = lamps || [];
  } catch (error) {
    smallrigMessage.className = 'error';
    smallrigMessage.textContent = error.message;
    lastFoundLamps = [];
  } finally {
    smallrigScanning = false;
    smallrigScanBtn.disabled = false;
    smallrigScanBtn.textContent = 'Scanner les lampes à proximité';
    renderSmallrigFound();
  }
});

renderSmallrigFound();
refreshSmallrigPaired();

// Statut connecte/deconnecte en direct par integration (OBS, Streamer.bot, fumee),
// pousse par polling depuis le process main (cf. onIntegrationStatus). Absence de
// cle = integration desactivee dans la config ; lastIntegrationStatus null = pas
// encore recu le premier statut depuis le dernier (re)demarrage du runtime.
function renderIntegrationStatus() {
  for (const [id, el] of integrationStatusEls) {
    const entry = lastIntegrationStatus?.[id];
    const span = el.querySelector('span');
    const icon = el.querySelector('path');
    if (!entry) {
      el.className = 'integration-status status-line';
      icon.setAttribute('d', '');
      const enabledKey = INTEGRATION_ENABLED_KEYS[id];
      const explicitlyDisabled = lastConfig[enabledKey] === false || lastConfig[enabledKey] === 'false';
      span.textContent = lastIntegrationStatus === null
        ? 'Vérification...'
        : (explicitlyDisabled ? 'Désactivé' : 'Non connecté');
    } else {
      el.className = `integration-status status-line ${entry.ok ? 'ok' : 'error'}`;
      icon.setAttribute('d', entry.ok ? ICON_CHECK : ICON_WARNING);
      span.textContent = entry.ok ? 'Connecté' : (entry.error || 'Non connecté');
    }
  }

  // Pas de pairing pour OBS/Streamer.bot/la fumee (juste des champs que le streamer
  // tape lui-meme) : tant qu'une integration repond, TOUS ses champs (URL/hote/port +
  // secret) se verrouillent, pour eviter une modification accidentelle pendant que tout
  // marche ; desactiver l'integration (ou une vraie coupure de service) les rend de
  // nouveau editables.
  for (const [id, fields] of Object.entries(INTEGRATION_PLAIN_FIELDS)) {
    const connected = Boolean(lastIntegrationStatus?.[id]?.ok);
    for (const field of fields) field.readOnly = connected;
  }
  for (const field of secretFields) {
    if (!field.statusId) continue;
    // Le statut live est l'unique autorite : connecte = lecture seule,
    // deconnecte = editable, meme si le masque factice est encore affiche.
    const connected = Boolean(lastIntegrationStatus?.[field.statusId]?.ok);
    field.input.readOnly = connected;
  }

  renderConnectionButton('obs', obsConnectionBtn);
  renderConnectionButton('streamerbot', streamerbotConnectionBtn);
  renderConnectionButton('smoke', smokeConnectionBtn);
}

function renderConnectionButton(id, button) {
  const connected = Boolean(lastIntegrationStatus?.[id]?.ok);
  const pending = pendingConnections.has(id);
  button.textContent = pending
    ? (connected ? 'Déconnexion en cours…' : 'Connexion en cours…')
    : (connected ? 'Déconnecter' : 'Connecter');
  button.disabled = pending;
  button.classList.toggle('disconnect-btn', connected);
}

function lockSecretField(field) {
  field.input.value = SECRET_MASK;
  field.input.classList.add('masked-secret');
  field.input.dataset.masked = 'true';
}

function unlockSecretField(field) {
  field.input.value = '';
  field.input.readOnly = false;
  field.input.classList.remove('masked-secret');
  field.input.dataset.masked = 'false';
}

function renderSecretFields(config) {
  for (const field of secretFields) {
    if (config[field.configuredKey]) lockSecretField(field);
    else unlockSecretField(field);
  }
  // Le masque indique seulement qu'un secret existe. Le statut de connexion est
  // l'unique source de verite pour savoir si le champ est editable.
  renderIntegrationStatus();
}

for (const field of secretFields) {
  field.input.addEventListener('focus', () => {
    const connected = Boolean(lastIntegrationStatus?.[field.statusId]?.ok);
    if (connected) return;
    if (field.input.dataset.masked === 'true') unlockSecretField(field);
  });
}

function renderIntegrationStatusUpdate(status) {
  lastIntegrationStatus = status || {};
  for (const [id, enabledInput] of [
    ['obs', obsEnabled],
    ['streamerbot', streamerbotEnabled],
    ['smoke', smokeEnabled]
  ]) {
    if (pendingConnections.has(id)) {
      const disconnecting = !enabledInput.checked;
      if ((disconnecting && !lastIntegrationStatus[id]) || (!disconnecting && lastIntegrationStatus[id]?.ok)) {
        pendingConnections.delete(id);
      }
    }
  }
  renderIntegrationStatus();
  renderHueUi();
  renderSmallrigStatus();
}

// Seuls `downloading`/`ready` meritent une banniere visible : `checking`/`idle` sont
// silencieux (verifications frequentes, rien a signaler la plupart du temps) et
// `error` reste dans les logs plutot que d'inquieter pour un echec transitoire
// (prochain check dans UPDATE_CHECK_INTERVAL_MS, cf. main.js).
function renderUpdateStatus(update) {
  const phase = update?.phase;
  if (phase === 'downloading') {
    updateBanner.hidden = false;
    updateInstallBtn.hidden = true;
    updateBannerMessage.textContent = `Téléchargement de la mise à jour ${update.version}...`;
  } else if (phase === 'ready') {
    updateBanner.hidden = false;
    updateInstallBtn.hidden = false;
    updateBannerMessage.textContent = `Mise à jour ${update.version} prête.`;
  } else {
    updateBanner.hidden = true;
    updateInstallBtn.hidden = true;
  }
}

updateInstallBtn.addEventListener('click', () => window.klixa.installUpdate());
window.klixa.getUpdateStatus().then(renderUpdateStatus);
window.klixa.onUpdateStatus(renderUpdateStatus);

function renderCloudStatus(cloudStatus) {
  lastCloudStatus = cloudStatus || { connected: false, features: {} };
  const smokeAvailable = Boolean(lastCloudStatus.connected && lastCloudStatus.features?.smoke === true);
  navSmoke.hidden = !smokeAvailable;
  if (!smokeAvailable && activePage === 'smoke') setActivePage('obs');
  renderHeaderStatus();
}

function setForm(config) {
  lastConfig = config;
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') field.checked = config[field.name] !== false && config[field.name] !== 'false';
    else if (config[field.name] !== undefined) field.value = config[field.name];
  }
  autoLaunch.checked = Boolean(config.AUTO_LAUNCH);
  renderPairingUi();
  renderHueUi();
  renderSmallrigStatus();
  renderSecretFields(config);
}

Promise.all([
  window.klixa.getConfig(),
  window.klixa.getStatus(),
  window.klixa.getCloudStatus(),
  window.klixa.getIntegrationStatus()
]).then(([config, status, cloudStatus, integrationStatus]) => {
  setForm(config);
  renderStatus(status);
  renderCloudStatus(cloudStatus);
  renderIntegrationStatusUpdate(integrationStatus);
});
window.klixa.onStatus(renderStatus);
window.klixa.onCloudStatus(renderCloudStatus);
window.klixa.onIntegrationStatus(renderIntegrationStatusUpdate);

function bindConnectionButton(id, enabledInput, button) {
  button.addEventListener('click', () => {
    const connected = Boolean(lastIntegrationStatus?.[id]?.ok);
    enabledInput.checked = !connected;
    if (!form.reportValidity()) {
      enabledInput.checked = connected;
      return;
    }
    pendingConnections.add(id);
    renderIntegrationStatus();
    form.requestSubmit();
    setTimeout(() => {
      if (!pendingConnections.delete(id)) return;
      renderIntegrationStatus();
    }, 12000);
  });
}

bindConnectionButton('obs', obsEnabled, obsConnectionBtn);
bindConnectionButton('streamerbot', streamerbotEnabled, streamerbotConnectionBtn);
bindConnectionButton('smoke', smokeEnabled, smokeConnectionBtn);

autoLaunch.addEventListener('change', async () => {
  autoLaunch.checked = await window.klixa.setAutoLaunch(autoLaunch.checked);
});

let pairingActive = false;
let pairCountdownTimer = null;

function stopPairCountdown() {
  if (pairCountdownTimer) clearInterval(pairCountdownTimer);
  pairCountdownTimer = null;
}

function startPairCountdown(expiresAt) {
  stopPairCountdown();
  const tick = () => {
    const remaining = Math.max(0, expiresAt - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
    pairCodeTimer.textContent = remaining > 0 ? `Expire dans ${minutes}:${seconds}` : 'Code expiré.';
    if (remaining <= 0) stopPairCountdown();
  };
  tick();
  pairCountdownTimer = setInterval(tick, 1000);
}

function resetPairingUi() {
  pairingActive = false;
  pairCode.hidden = true;
  pairCodeValue.textContent = '';
  pairCodeTimer.textContent = '';
  stopPairCountdown();
  pairBtn.disabled = false;
  pairBtn.textContent = 'Lier ce compagnon';
}

pairBtn.addEventListener('click', async () => {
  if (pairingActive) {
    await window.klixa.pairingCancel();
    resetPairingUi();
    pairMessage.className = '';
    pairMessage.textContent = '';
    return;
  }

  pairBtn.disabled = true;
  pairMessage.className = '';
  pairMessage.textContent = 'Génération du code...';
  try {
    const { userCode, expiresInMs } = await window.klixa.pairingStart({});
    pairingActive = true;
    pairCodeValue.textContent = userCode;
    pairCode.hidden = false;
    pairMessage.textContent = '';
    startPairCountdown(Date.now() + expiresInMs);
    pairBtn.textContent = 'Annuler';
  } catch (error) {
    pairMessage.className = 'error';
    pairMessage.textContent = error.message;
  } finally {
    pairBtn.disabled = false;
  }
});

// Appairage Hue : 100% local (le bridge est appelé par le process main, pas par le
// cloud). Presser le bouton physique du bridge juste avant de cliquer.
huePairBtn.addEventListener('click', async () => {
  const bridgeIp = hueBridgeIp.value.trim();
  const bridgePort = Number.parseInt(hueBridgePort.value || '443', 10);
  if (!bridgeIp) {
    hueMessage.className = 'error';
    hueMessage.textContent = 'Renseigne l\'IP du bridge.';
    return;
  }
  huePairBtn.disabled = true;
  huePairBtn.textContent = 'Connexion en cours…';
  hueMessage.className = '';
  hueMessage.textContent = 'Appairage en cours...';
  try {
    setForm(await window.klixa.hueRegister(bridgeIp, bridgePort));
    hueMessage.className = 'ok';
    hueMessage.textContent = 'Bridge appairé.';
  } catch (error) {
    hueMessage.className = 'error';
    hueMessage.textContent = error.message;
  } finally {
    huePairBtn.disabled = false;
    huePairBtn.textContent = 'Appairer (presser le bouton du bridge avant)';
  }
});

hueUnpairBtn.addEventListener('click', async () => {
  hueUnpairBtn.disabled = true;
  hueMessage.className = '';
  hueMessage.textContent = '';
  try {
    setForm(await window.klixa.hueDisconnect());
  } finally {
    hueUnpairBtn.disabled = false;
  }
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  try {
    setForm(await window.klixa.disconnect());
  } finally {
    disconnectBtn.disabled = false;
  }
});

window.klixa.onPairingStatus(async (statusUpdate) => {
  resetPairingUi();
  if (statusUpdate.phase === 'claimed') {
    pairMessage.className = 'ok';
    pairMessage.textContent = 'Compagnon lié, connexion en cours...';
    setForm(await window.klixa.getConfig());
  } else if (statusUpdate.phase === 'expired') {
    pairMessage.className = 'error';
    pairMessage.textContent = 'Code expiré, relance le pairing.';
  } else {
    pairMessage.className = 'error';
    pairMessage.textContent = statusUpdate.message || 'Erreur de pairing.';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // Un bouton "Enregistrer" par page porte data-integration : ca cible directement
  // l'integration a reconfigurer (cf. main.js) sans redemarrer tout le runtime (donc
  // sans couper la liaison cloud). Le clic sur "Connecter" appelle form.requestSubmit()
  // sans designer de submitter : on retombe alors sur pendingConnections, deja au
  // courant de l'integration visee par ce flux-la.
  const button = event.submitter;
  if (button) button.disabled = true;
  message.className = '';
  message.textContent = 'Enregistrement...';
  const data = Object.fromEntries(new FormData(form));
  for (const checkbox of form.querySelectorAll('input[name][type=checkbox]')) data[checkbox.name] = checkbox.checked;
  if (data.SB_PORT) data.SB_PORT = String(Number(data.SB_PORT));
  if (data.OBS_WS_PORT) data.OBS_WS_PORT = String(Number(data.OBS_WS_PORT));
  if (data.SMOKE_SERVICE_PORT) data.SMOKE_SERVICE_PORT = String(Number(data.SMOKE_SERVICE_PORT));
  // Un champ secret encore verrouille (masque) n'a pas ete modifie : ne pas envoyer
  // le masque factice, sinon il ecraserait le vrai secret stocke.
  for (const field of secretFields) {
    if (field.input.dataset.masked === 'true') delete data[field.input.name];
  }
  const integrationId = button?.dataset.integration || (pendingConnections.size === 1 ? [...pendingConnections][0] : undefined);
  try {
    setForm(await window.klixa.saveConfig(data, integrationId));
    if (!obsEnabled.checked) pendingConnections.delete('obs');
    if (!streamerbotEnabled.checked) pendingConnections.delete('streamerbot');
    if (!smokeEnabled.checked) pendingConnections.delete('smoke');
    message.className = 'ok';
    message.textContent = 'Configuration enregistrée.';
  } catch (error) {
    pendingConnections.clear();
    renderIntegrationStatus();
    message.className = 'error';
    message.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
});
