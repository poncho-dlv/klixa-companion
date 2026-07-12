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
const hueBridgeIp = document.querySelector('#hueBridgeIp');
const huePairBtn = document.querySelector('#huePairBtn');
const hueMessage = document.querySelector('#hueMessage');

// Chemins FontAwesome (circle-check / triangle-exclamation) inlines en SVG : la CSP
// interdit de charger une police/feuille de style externe, donc pas de webfont FA.
const ICON_CHECK = 'M256 512a256 256 0 1 1 0-512 256 256 0 1 1 0 512zM374 145.7c-10.7-7.8-25.7-5.4-33.5 5.3L221.1 315.2 169 263.1c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9l72 72c5 5 11.8 7.5 18.8 7s13.4-4.1 17.5-9.8L379.3 179.2c7.8-10.7 5.4-25.7-5.3-33.5z';
const ICON_WARNING = 'M256 0c14.7 0 28.2 8.1 35.2 21l216 400c6.7 12.4 6.4 27.4-.8 39.5S486.1 480 472 480L40 480c-14.1 0-27.2-7.4-34.4-19.5s-7.5-27.1-.8-39.5l216-400c7-12.9 20.5-21 35.2-21zm0 352a32 32 0 1 0 0 64 32 32 0 1 0 0-64zm0-192c-18.2 0-32.7 15.5-31.4 33.7l7.4 104c.9 12.5 11.4 22.3 23.9 22.3 12.6 0 23-9.7 23.9-22.3l7.4-104c1.3-18.2-13.1-33.7-31.4-33.7z';

let lastStatus = { running: false, message: 'Demarrage...' };
let lastCloudStatus = { connected: false, features: {} };

// Le sous-titre reflete en priorite la liaison cloud (c'est ce qui interesse le
// streamer au quotidien) et retombe sur le statut du runtime local sinon.
function renderHeaderStatus() {
  const connected = Boolean(lastCloudStatus.connected);
  const ok = connected && lastStatus.running;
  statusMessage.textContent = connected ? 'Compagnon connecte' : lastStatus.message;
  statusLine.className = `status-line ${ok ? 'ok' : 'error'}`;
  statusIcon.querySelector('path').setAttribute('d', ok ? ICON_CHECK : ICON_WARNING);
}

function renderStatus(status) {
  lastStatus = status;
  renderHeaderStatus();
}

// Tant que le compagnon n'est pas connecte au tenant Klixa, on n'affiche que la
// section de pairing : pas d'integrations a configurer sans savoir a quel tenant on
// parle. Une fois connecte, les features tenant (ex. machine a fumee) decident quelles
// sections supplementaires sont pertinentes pour ce tenant precis, et la section de
// pairing n'a plus lieu d'etre (le bouton de deconnexion du header prend le relais).
function renderCloudStatus(cloudStatus) {
  lastCloudStatus = cloudStatus || { connected: false, features: {} };
  const connected = Boolean(lastCloudStatus.connected);
  pairingSection.hidden = connected;
  integrations.hidden = !connected;
  smokeSection.hidden = !(connected && lastCloudStatus.features?.smoke === true);
  disconnectBtn.hidden = !connected;
  renderHeaderStatus();
}

function setForm(config) {
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') field.checked = config[field.name] !== false && config[field.name] !== 'false';
    else if (config[field.name] !== undefined) field.value = config[field.name];
  }
  autoLaunch.checked = Boolean(config.AUTO_LAUNCH);
}

Promise.all([window.klixa.getConfig(), window.klixa.getStatus(), window.klixa.getCloudStatus()]).then(([config, status, cloudStatus]) => {
  setForm(config);
  renderStatus(status);
  renderCloudStatus(cloudStatus);
});
window.klixa.onStatus(renderStatus);
window.klixa.onCloudStatus(renderCloudStatus);

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
    pairCodeTimer.textContent = remaining > 0 ? `Expire dans ${minutes}:${seconds}` : 'Code expire.';
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
  pairMessage.textContent = 'Generation du code...';
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
  if (!bridgeIp) {
    hueMessage.className = 'error';
    hueMessage.textContent = 'Renseigne l\'IP du bridge.';
    return;
  }
  huePairBtn.disabled = true;
  hueMessage.className = '';
  hueMessage.textContent = 'Appairage en cours...';
  try {
    setForm(await window.klixa.hueRegister(bridgeIp));
    hueMessage.className = 'ok';
    hueMessage.textContent = 'Bridge appairé.';
  } catch (error) {
    hueMessage.className = 'error';
    hueMessage.textContent = error.message;
  } finally {
    huePairBtn.disabled = false;
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
    pairMessage.textContent = 'Compagnon lie, connexion en cours...';
    setForm(await window.klixa.getConfig());
  } else if (statusUpdate.phase === 'expired') {
    pairMessage.className = 'error';
    pairMessage.textContent = 'Code expire, relance le pairing.';
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
  try {
    setForm(await window.klixa.saveConfig(data));
    message.className = 'ok';
    message.textContent = 'Configuration enregistree.';
  } catch (error) {
    message.className = 'error';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
