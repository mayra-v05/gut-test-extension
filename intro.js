// Intro slide — the first thing the client sees, in its own window, opened
// by background.js (openIntro) when "Start Gut Test" is pressed. It explains
// what's about to happen and shows the phone QR code. Nothing starts until
// the start button (or Enter) is pressed: that sends 'start', and
// background.js opens the sites in this same window and closes this tab.
//
// The client picks NL or EN here (top right); the choice is saved as
// `clientLang` and every later screen of the test follows it.

const testNameEl = document.getElementById('testName');
const qrEl = document.getElementById('qr');
const qrLink = document.getElementById('qrLink');
const phoneBox = document.getElementById('phoneBox');
const startBtn = document.getElementById('startBtn');
const musicToggle = document.getElementById('musicToggle');
const introError = document.getElementById('introError');
const langButtons = document.querySelectorAll('.lang-switch button');

const testId = new URLSearchParams(location.search).get('test');
let starting = false;
let siteCount = 10;
let seconds = 20;

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

// Fills every text on the slide in the current language.
function renderTexts() {
  const t = GTE.t;
  document.documentElement.lang = GTE.lang;
  langButtons.forEach((b) => b.setAttribute('aria-pressed', b.dataset.lang === GTE.lang ? 'true' : 'false'));

  setText('title', t('Wat is je eerste gevoel?', "What's your first impression?"));

  const lead = document.getElementById('lead');
  const strong = (text) => { const s = document.createElement('strong'); s.textContent = text; return s; };
  lead.replaceChildren(
    t('Een gut test meet je onderbuikgevoel. Je ziet zo ', 'A gut test measures your gut feeling. You are about to see '),
    strong(`${siteCount} websites`),
    t(', elk ', ', each for '),
    strong(t(`${seconds} seconden`, `${seconds} seconds`)),
    t('. Niet te lang nadenken: kijk wat je aanspreekt en wat niet.', ". Don't overthink it: notice what appeals to you and what doesn't.")
  );

  setText('step1Title', t('Kijken', 'Watch'));
  setText('step1Text', t('De websites wisselen vanzelf. Bovenin zie je hoe ver je bent. Alleen kijken, nog geen cijfers.',
    'The websites change automatically. At the top you can see how far along you are. Just look, no scores yet.'));
  setText('step2Title', t('Beoordelen', 'Rate'));
  setText('step2Text', t('Daarna staan alle websites op één pagina. Je scrolt er nog even doorheen en geeft elke site een cijfer van 1 tot 10.',
    'Afterwards all websites appear on one page. Scroll through them once more and give each site a score from 1 to 10.'));
  setText('step3Title', t('Resultaat', 'Result'));
  setText('step3Text', t('Jouw cijfers worden een ranking: welke stijl past het best bij jou?',
    'Your scores become a ranking: which style suits you best?'));

  setText('phoneHead', t('Notities op je telefoon', 'Notes on your phone'));
  setText('phoneText', t('Scan de QR-code en typ tijdens de test wat je opvalt. Je notitie komt vanzelf bij de website die op dat moment in beeld is.',
    'Scan the QR code and type what stands out to you during the test. Your note is automatically added to the website on screen at that moment.'));

  if (!starting) startBtn.textContent = t('Start de gut test →', 'Start the gut test →');
  const kbd = document.createElement('kbd');
  kbd.textContent = 'Enter';
  document.getElementById('startNote').replaceChildren(
    t('De test begint pas als je op de knop drukt (of ', "The test only starts when you press the button (or "), kbd, ').');
  setMusicButton(musicToggle.getAttribute('aria-pressed') === 'true');
  introError.textContent = t('Deze test kon niet worden gestart. Sluit dit venster en probeer het opnieuw via het extensiemenu.',
    "This test couldn't be started. Close this window and try again from the extension menu.");
}

document.addEventListener('DOMContentLoaded', async () => {
  await GTE.loadLang();
  renderTexts();
  if (!testId) { showError(); return; }
  const test = await GTE.getTest(testId);
  if (!test || !test.sites || test.sites.length === 0) { showError(); return; }

  testNameEl.textContent = `Gut test · ${test.name}`;
  siteCount = test.sites.length;

  const { interval, musicEnabled, phonePageUrl } = await chrome.storage.local.get(['interval', 'musicEnabled', 'phonePageUrl']);
  seconds = interval ?? 20;
  setMusicButton(musicEnabled ?? true);
  renderTexts();

  try {
    const topic = await GTE.ensurePhoneTopic(testId);
    const url = GTE.phoneUrl(topic, phonePageUrl);
    qrEl.appendChild(GTE.buildQrSvg(url));
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = url;
    qrLink.appendChild(a);
  } catch (e) {
    phoneBox.hidden = true;
  }

  startBtn.focus();
});

langButtons.forEach((b) => b.addEventListener('click', async () => {
  await GTE.setLang(b.dataset.lang);
  renderTexts();
  // Keep Enter working to start the test after switching language.
  startBtn.focus();
}));

function setMusicButton(on) {
  musicToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  musicToggle.textContent = on ? GTE.t('🎵 Muziek aan', '🎵 Music on') : GTE.t('🎵 Muziek uit', '🎵 Music off');
}

musicToggle.addEventListener('click', async () => {
  const on = musicToggle.getAttribute('aria-pressed') !== 'true';
  setMusicButton(on);
  await chrome.storage.local.set({ musicEnabled: on });
});

function start() {
  if (!testId || starting) return;
  starting = true;
  startBtn.disabled = true;
  startBtn.textContent = GTE.t('Daar gaan we…', "Here we go…");
  chrome.runtime.sendMessage({ command: 'start', testId }, (response) => {
    // On success background.js closes this tab, so we normally never get here.
    if (chrome.runtime.lastError || !response?.success) {
      if (!chrome.runtime.lastError || !/closed|receiving end/i.test(chrome.runtime.lastError.message || '')) showError();
      starting = false;
      startBtn.disabled = false;
      startBtn.textContent = GTE.t('Start de gut test →', 'Start the gut test →');
    }
  });
}

startBtn.addEventListener('click', start);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target === document.body) start();
});

function showError() {
  introError.style.display = 'block';
  startBtn.disabled = true;
}
