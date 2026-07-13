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
const pairingSection = document.querySelector('#pairingSection');
const integrations = document.querySelector('#integrations');
const smokeSection = document.querySelector('#section-smoke');
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

// Le panneau pairing/integrations se base sur la config PERSISTEE (CLOUD_WS_URL
// present ou non), pas sur le statut WS live : sauver la config ou appairer Hue
// redemarre tout le runtime (donc coupe puis rouvre la liaison cloud un instant), et
// piloter la visibilite des sections sur ce flottement faisait sauter toute la page
// en haut a chaque sauvegarde. Le statut live (cloud:status) reste reserve au texte
// du header et aux features tenant (ex. machine a fumee).
function renderPairingUi() {
  const linked = Boolean(lastConfig.CLOUD_WS_URL);
  pairingSection.hidden = linked;
  integrations.hidden = !linked;
  disconnectBtn.hidden = !linked;
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
  smokeSection.hidden = !(lastCloudStatus.connected && lastCloudStatus.features?.smoke === true);
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
  const button = document.querySelector('#saveBtn');
  button.disabled = true;
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
  const integrationId = pendingConnections.size === 1 ? [...pendingConnections][0] : undefined;
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
    button.disabled = false;
  }
});
