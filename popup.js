const testSelect = document.getElementById('testSelect');
const noTestHint = document.getElementById('noTestHint');
const intervalInput = document.getElementById('interval');
const refreshCheckbox = document.getElementById('refresh');
const autoscrollCheckbox = document.getElementById('autoscroll');
const scrollSpeedInput = document.getElementById('scrollSpeed');
const scrollSpeedValueSpan = document.getElementById('scrollSpeedValue');
const enableTopDelayCheckbox = document.getElementById('enableTopDelay');
const topDelaySecondsInput = document.getElementById('topDelaySeconds');
const reviewRefreshCheckbox = document.getElementById('reviewRefresh');
const musicEnabledCheckbox = document.getElementById('musicEnabled');
const musicVolumeInput = document.getElementById('musicVolume');
const musicVolumeValue = document.getElementById('musicVolumeValue');
const phonePageUrlInput = document.getElementById('phonePageUrl');
const toggleButton = document.getElementById('toggleButton');
const reviewButton = document.getElementById('reviewButton');
const statusDiv = document.getElementById('status');
const versionDisplay = document.getElementById('versionDisplay');
const openManageBtn = document.getElementById('openManage');
const openDashboardBtn = document.getElementById('openDashboard');
const completedBanner = document.getElementById('completedBanner');
const completedText = document.getElementById('completedText');
const completedDashboardBtn = document.getElementById('completedDashboardBtn');

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const manifest = chrome.runtime.getManifest();
    if (manifest?.version) versionDisplay.textContent = `v${manifest.version}`;
  } catch (e) { /* ignore */ }

  await populateTestSelect();
  await checkCompletedBanner();

  const keys = ['interval', 'refresh', 'autoscroll', 'scrollSpeed', 'enableTopDelay', 'topDelaySeconds', 'reviewRefresh', 'musicEnabled', 'musicVolume', 'phonePageUrl', 'isRunning', 'reviewMode'];
  const data = await chrome.storage.local.get(keys);
  intervalInput.value = data.interval ?? 20;
  refreshCheckbox.checked = data.refresh ?? false;
  autoscrollCheckbox.checked = data.autoscroll ?? true;
  scrollSpeedInput.value = data.scrollSpeed ?? 5;
  scrollSpeedValueSpan.textContent = scrollSpeedInput.value;
  enableTopDelayCheckbox.checked = data.enableTopDelay ?? true;
  topDelaySecondsInput.value = data.topDelaySeconds ?? 3;
  reviewRefreshCheckbox.checked = data.reviewRefresh ?? false;
  musicEnabledCheckbox.checked = data.musicEnabled ?? true;
  musicVolumeInput.value = Math.round((data.musicVolume ?? 0.5) * 100);
  musicVolumeValue.textContent = musicVolumeInput.value;
  phonePageUrlInput.value = data.phonePageUrl ?? '';

  updateAutoscrollControls();
  updateButtonAndStatus(data.isRunning ?? false, data.reviewMode ?? false);

  chrome.runtime.onMessage.addListener((request) => {
    if (request.command === 'syncButtonState') {
      updateButtonAndStatus(request.isRunning ?? false, request.isReview ?? false);
      populateTestSelect();
    } else if (request.command === 'testCompleted' && request.testId) {
      showCompletedBanner(request.testId);
    }
  });
  chrome.runtime.sendMessage({ command: 'updateButtonState' }, () => { if (chrome.runtime.lastError) {/* ignore */} });
});

// Shows the "test finished, go to the dashboard" banner if a test just
// completed a full cycle since we last checked. Read once, then cleared,
// so it only appears the first time the popup is opened after finishing.
async function checkCompletedBanner() {
  const { lastCompletedTestId } = await chrome.storage.local.get('lastCompletedTestId');
  if (!lastCompletedTestId) return;
  await chrome.storage.local.remove('lastCompletedTestId');
  await showCompletedBanner(lastCompletedTestId);
}

async function showCompletedBanner(testId) {
  const test = await GTE.getTest(testId);
  completedText.textContent = test ? `"${test.name}" is klaar — alle sites zijn beoordeeld.` : 'Gut test klaar!';
  completedBanner.hidden = false;
  completedDashboardBtn.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?test=${testId}`) });
    window.close();
  };
}

async function populateTestSelect() {
  const { tests, activeTestId } = await GTE.getState();
  const list = Object.values(tests).sort((a, b) => b.updatedAt - a.updatedAt);
  testSelect.innerHTML = '';
  if (list.length === 0) {
    noTestHint.hidden = false;
    toggleButton.disabled = true;
    reviewButton.disabled = true;
    return;
  }
  noTestHint.hidden = true;
  for (const test of list) {
    const opt = document.createElement('option');
    opt.value = test.id;
    const rated = GTE.ratedCount(test);
    opt.textContent = `${test.name} (${rated}/${test.sites.length} beoordeeld)`;
    testSelect.appendChild(opt);
  }
  testSelect.value = (activeTestId && tests[activeTestId]) ? activeTestId : list[0].id;
}

testSelect.addEventListener('change', () => {
  GTE.setActiveTestId(testSelect.value);
});

[intervalInput, refreshCheckbox, autoscrollCheckbox, scrollSpeedInput, enableTopDelayCheckbox, topDelaySecondsInput, reviewRefreshCheckbox, musicEnabledCheckbox, musicVolumeInput, phonePageUrlInput].forEach((el) => {
  el.addEventListener('change', saveSettings);
});
musicVolumeInput.addEventListener('input', () => {
  musicVolumeValue.textContent = musicVolumeInput.value;
  chrome.runtime.sendMessage({ command: 'setMusicVolume', volume: Number(musicVolumeInput.value) / 100 }, () => { if (chrome.runtime.lastError) {/* ignore */} });
});
scrollSpeedInput.addEventListener('input', () => { scrollSpeedValueSpan.textContent = scrollSpeedInput.value; });
autoscrollCheckbox.addEventListener('change', updateAutoscrollControls);
intervalInput.addEventListener('change', () => {
  const value = parseInt(intervalInput.value, 10);
  if (!isNaN(value) && value >= 5) chrome.runtime.sendMessage({ command: 'updateInterval', interval: value });
});

async function saveSettings() {
  let intervalValue = parseInt(intervalInput.value, 10);
  if (isNaN(intervalValue) || intervalValue < 5) { intervalValue = 5; intervalInput.value = 5; }
  let delayValue = parseInt(topDelaySecondsInput.value, 10);
  if (isNaN(delayValue) || delayValue < 1) { delayValue = 1; topDelaySecondsInput.value = 1; }
  await chrome.storage.local.set({
    interval: intervalValue,
    refresh: refreshCheckbox.checked,
    autoscroll: autoscrollCheckbox.checked,
    scrollSpeed: parseInt(scrollSpeedInput.value, 10) || 5,
    enableTopDelay: enableTopDelayCheckbox.checked,
    topDelaySeconds: delayValue,
    reviewRefresh: reviewRefreshCheckbox.checked,
    musicEnabled: musicEnabledCheckbox.checked,
    musicVolume: Number(musicVolumeInput.value) / 100,
    phonePageUrl: phonePageUrlInput.value.trim()
  });
}

function updateAutoscrollControls() {
  const enabled = autoscrollCheckbox.checked;
  enableTopDelayCheckbox.disabled = !enabled;
  scrollSpeedInput.disabled = !enabled;
  topDelaySecondsInput.disabled = !enabled || !enableTopDelayCheckbox.checked;
}

toggleButton.addEventListener('click', () => {
  const isRunning = !toggleButton.classList.contains('stopped');

  // Starting a fresh test: background opens the intro slide in its own
  // window first — that slide is what actually sends 'start' once the
  // client presses its button.
  if (!isRunning) {
    if (!testSelect.value) return;
    chrome.runtime.sendMessage({ command: 'openIntro', testId: testSelect.value }, () => { if (chrome.runtime.lastError) {/* ignore */} });
    window.close();
    return;
  }

  toggleButton.disabled = true; reviewButton.disabled = true;
  chrome.runtime.sendMessage({ command: 'stop', testId: testSelect.value }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      updateStatusDiv(chrome.runtime.lastError ? 'Fout' : 'Stoppen mislukt', 'error');
      chrome.runtime.sendMessage({ command: 'updateButtonState' });
      toggleButton.disabled = false; reviewButton.disabled = false;
    } else {
      toggleButton.disabled = false; reviewButton.disabled = false;
    }
  });
});

reviewButton.addEventListener('click', () => {
  toggleButton.disabled = true; reviewButton.disabled = true;
  const isExiting = reviewButton.classList.contains('exit-review');
  const command = isExiting ? 'stop' : 'startReview';
  if (isExiting) updateStatusDiv('Review afsluiten...', 'stopped');
  else updateStatusDiv('Review starten...', 'review');
  chrome.runtime.sendMessage({ command, testId: testSelect.value }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      updateStatusDiv('Actie mislukt', 'error');
      chrome.runtime.sendMessage({ command: 'updateButtonState' });
      toggleButton.disabled = false; reviewButton.disabled = false;
    } else if (isExiting) {
      window.close();
    } else {
      toggleButton.disabled = false; reviewButton.disabled = false;
    }
  });
});

openManageBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  window.close();
});
openDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

function updateButtonAndStatus(isRunning, isReview) {
  statusDiv.classList.remove('running', 'stopped', 'review', 'error');
  toggleButton.classList.remove('running', 'stopped');
  reviewButton.classList.remove('exit-review');
  toggleButton.disabled = false; reviewButton.disabled = false;

  if (isReview) {
    toggleButton.textContent = 'Start Gut Test';
    toggleButton.classList.add('stopped');
    toggleButton.disabled = true;
    reviewButton.textContent = 'Beoordelen stoppen';
    reviewButton.classList.add('exit-review');
    updateStatusDiv('Status: Beoordelen', 'review');
  } else if (isRunning) {
    toggleButton.textContent = 'Stop Gut Test';
    toggleButton.classList.add('running');
    reviewButton.textContent = 'Alleen beoordelen (review-pagina)';
    updateStatusDiv('Status: Actief', 'running');
  } else {
    toggleButton.textContent = 'Start Gut Test';
    toggleButton.classList.add('stopped');
    reviewButton.textContent = 'Alleen beoordelen (review-pagina)';
    updateStatusDiv('Status: Gestopt', 'stopped');
  }
}
function updateStatusDiv(text, stateClass) {
  statusDiv.textContent = text;
  statusDiv.classList.remove('running', 'stopped', 'review', 'error');
  if (stateClass) statusDiv.classList.add(stateClass);
}
