const form = document.querySelector('#config');
const message = document.querySelector('#message');
const statusText = document.querySelector('#status');
const autoLaunch = document.querySelector('#autoLaunch');

function renderStatus(status) {
  statusText.textContent = status.message;
  statusText.className = status.running ? 'ok' : 'error';
}

function setForm(config) {
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') field.checked = config[field.name] !== false && config[field.name] !== 'false';
    else if (config[field.name] !== undefined) field.value = config[field.name];
  }
  autoLaunch.checked = Boolean(config.AUTO_LAUNCH);
}

Promise.all([window.klixa.getConfig(), window.klixa.getStatus()]).then(([config, status]) => {
  setForm(config);
  renderStatus(status);
});
window.klixa.onStatus(renderStatus);

autoLaunch.addEventListener('change', async () => {
  autoLaunch.checked = await window.klixa.setAutoLaunch(autoLaunch.checked);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
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
