const form = document.querySelector('#config');
const message = document.querySelector('#message');
const statusText = document.querySelector('#status');
const autoLaunch = document.querySelector('#autoLaunch');
const pairBtn = document.querySelector('#pairBtn');
const pairCode = document.querySelector('#pairCode');
const pairCodeValue = document.querySelector('#pairCodeValue');
const pairCodeTimer = document.querySelector('#pairCodeTimer');
const pairMessage = document.querySelector('#pairMessage');
const pairingBox = document.querySelector('.pairing');
const connectedStatus = document.querySelector('#connectedStatus');
const integrations = document.querySelector('#integrations');
const smokeSection = document.querySelector('#section-smoke');

function renderStatus(status) {
  statusText.textContent = status.message;
  statusText.className = status.running ? 'ok' : 'error';
}

// Tant que le compagnon n'est pas connecte au tenant Klixa, on n'affiche que la
// section de pairing : pas d'integrations a configurer sans savoir a quel tenant on
// parle. Une fois connecte, les features tenant (ex. machine a fumee) decident quelles
// sections supplementaires sont pertinentes pour ce tenant precis.
function renderCloudStatus(cloudStatus) {
  const connected = Boolean(cloudStatus?.connected);
  pairingBox.hidden = connected;
  connectedStatus.hidden = !connected;
  integrations.hidden = !connected;
  smokeSection.hidden = !(connected && cloudStatus?.features?.smoke === true);
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
