// Final review — the last step of a gut test session ("eerst alle 10 laten
// zien, daarna pas review"). One page with every site as a small but real,
// scrollable website (an iframe rendered at desktop size and scaled down),
// and next to each one the 1-10 rating, the notes and any notes that came in
// from the client's phone.
//
// All writes go through background.js (setRating / setNote) so they can't
// collide with phone notes arriving at the same moment. Changes made
// elsewhere (phone notes, the overlay) come back in via storage.onChanged.

const testId = new URLSearchParams(location.search).get('test');

const brandEl = document.getElementById('brand');
const progressText = document.getElementById('progressText');
const segmentsEl = document.getElementById('segments');
const sitesEl = document.getElementById('sites');
const emptyState = document.getElementById('emptyState');
const phoneBtn = document.getElementById('phoneBtn');
const musicBtn = document.getElementById('musicBtn');
const qrPop = document.getElementById('qrPop');
const qrEl = document.getElementById('qr');
const finishText = document.getElementById('finishText');
const finishButtons = [document.getElementById('finishTop'), document.getElementById('finishBottom')];

// Desktop size the mini-sites are rendered at before scaling down.
const FRAME_W = 1440;
const FRAME_H = 900;
const NOTE_SAVE_DELAY_MS = 600;

const BLUE_LOW = [158, 197, 244];
const BLUE_HIGH = [24, 79, 149];
function ratingColor(value) {
  const t = (value - 1) / 9;
  const rgb = BLUE_LOW.map((c, i) => Math.round(c + (BLUE_HIGH[i] - c) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

let test = null;
const rows = new Map(); // siteId -> { section, ratingButtons, textareas, phoneList, phoneBox, segment, saved }
let currentSiteId = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage({ ...message, testId }).catch(() => null);
}

// Ratings and notes normally go through background.js (one writer, no
// collisions with phone notes). If that ever fails — e.g. the service worker
// was restarting — write directly so nothing the client entered is lost.
async function saveDirect(siteId, mutate) {
  const { tests } = await GTE.getState();
  const t = tests[testId];
  const s = t && t.sites.find((x) => x.id === siteId);
  if (!s) return false;
  mutate(s);
  t.updatedAt = Date.now();
  await GTE.saveTests(tests);
  return true;
}

// Static texts from review.html, in the language the client picked.
function applyStaticTexts() {
  const t = GTE.t;
  document.documentElement.lang = GTE.lang;
  phoneBtn.title = t('Notities op je telefoon (QR-code)', 'Notes on your phone (QR code)');
  musicBtn.title = t('Achtergrondmuziek aan/uit', 'Background music on/off');
  finishButtons[0].textContent = t('Afronden →', 'Finish →');
  finishButtons[1].textContent = t('Afronden en ranking bekijken →', 'Finish and see the ranking →');
  document.getElementById('qrText').textContent = t('Scan met je telefoon om notities te typen. Ze komen bij de website die nu in het midden van je scherm staat.',
    'Scan with your phone to type notes. They are added to the website in the middle of your screen.');
  document.getElementById('heroTitle').replaceChildren(t('Alle websites gezien.', 'You have seen every website.'), document.createElement('br'), t('Nu beoordelen.', 'Time to rate.'));
  const kbd = (k) => el('kbd', '', k);
  document.getElementById('heroText').replaceChildren(
    t('Hieronder staat elke website nog een keer, klein maar echt: je kunt erin scrollen. Geef per site een cijfer van 1 tot 10. Notities zijn optioneel. Sneltoetsen: ',
      'Below is every website once more, small but real: you can scroll through it. Give each site a score from 1 to 10. Notes are optional. Shortcuts: '),
    kbd('1'), '–', kbd('9'), t(' en ', ' and '), kbd('0'),
    t(' (= 10) geven de website in beeld een cijfer.', ' (= 10) score the website on screen.'));
  emptyState.textContent = t('Deze test kon niet worden geladen.', "This test couldn't be loaded.");
  document.getElementById('finishTitle').textContent = t('Klaar?', 'Done?');
  finishText.textContent = t('Rond af om de ranking te bekijken.', 'Finish to see the ranking.');
}

function showSaved(siteId, ok) {
  const row = rows.get(siteId);
  if (!row) return;
  row.saved.textContent = ok ? GTE.t('✓ Opgeslagen', '✓ Saved') : GTE.t('⚠ Niet opgeslagen — probeer het opnieuw', '⚠ Not saved — please try again');
  row.saved.classList.toggle('error', !ok);
  clearTimeout(row.savedTimer);
  if (ok) row.savedTimer = setTimeout(() => { row.saved.textContent = ''; }, 1500);
}

document.addEventListener('DOMContentLoaded', async () => {
  await GTE.loadLang();
  applyStaticTexts();
  test = testId ? await GTE.getTest(testId) : null;
  if (!test || !test.sites || !test.sites.length) {
    emptyState.hidden = false;
    document.getElementById('finishSection').hidden = true;
    return;
  }
  document.title = `${test.name} — ${GTE.t('beoordelen', 'rating')}`;
  brandEl.textContent = `Gut test · ${test.name}`;

  const heroKeys = test.sites.map((s) => GTE.heroKey(s.id));
  const heroes = await chrome.storage.local.get(heroKeys);

  test.sites.forEach((site, i) => buildRow(site, i, heroes[GTE.heroKey(site.id)] || null));
  updateProgress();
  observeCurrentSite();
  setupSessionControls();
  setInterval(() => send({ command: 'reviewHeartbeat' }), 20000);
});

// --- One row per site --------------------------------------------------------

function buildRow(site, index, heroShot) {
  const section = el('section', 'site');
  section.id = `site-${index + 1}`;
  section.dataset.siteId = site.id;

  // Left: a small browser window with the live site.
  const browser = el('div', 'browser');
  const bar = el('div', 'browser-bar');
  const dots = el('div', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  const url = el('div', 'url', site.url.replace(/^https?:\/\//, ''));
  const toggle = el('div', 'view-toggle');
  const liveBtn = el('button', 'active', 'Live');
  const shotBtn = el('button', '', 'Screenshot');
  liveBtn.type = shotBtn.type = 'button';
  toggle.append(liveBtn, shotBtn);
  const open = el('a', 'open-link', GTE.t('Open ↗', 'Open ↗'));
  open.href = site.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  bar.append(dots, url, toggle, open);

  const viewport = el('div', 'viewport');
  const frame = document.createElement('iframe');
  frame.src = site.url;
  frame.loading = index < 2 ? 'eager' : 'lazy';
  frame.title = site.label;
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  // No allow-top-navigation: a site's "break out of frames" script can't
  // hijack the review page.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  const shot = el('div', 'shot');
  if (heroShot) {
    const img = document.createElement('img');
    img.src = heroShot;
    img.alt = GTE.t(`Screenshot van ${site.label}`, `Screenshot of ${site.label}`);
    shot.appendChild(img);
  } else {
    shot.appendChild(el('div', 'no-shot', GTE.t('Geen screenshot van deze site — die wordt automatisch gemaakt tijdens de kijkronde.', 'No screenshot of this site — one is taken automatically during the viewing round.')));
  }
  viewport.append(frame, shot);
  browser.append(bar, viewport);

  const help = el('div', 'frame-help', GTE.t('Blijft de website leeg of geeft hij een foutmelding? Klik op "Screenshot" of open hem in een eigen tabblad.', 'Is the website blank or showing an error? Click "Screenshot" or open it in its own tab.'));
  const left = el('div');
  left.append(browser, help);

  liveBtn.addEventListener('click', () => {
    viewport.classList.remove('show-shot');
    liveBtn.classList.add('active');
    shotBtn.classList.remove('active');
  });
  shotBtn.addEventListener('click', () => {
    viewport.classList.add('show-shot');
    shotBtn.classList.add('active');
    liveBtn.classList.remove('active');
  });

  // Scale the 1440px-wide site down to whatever width the column has.
  // Applied in the next frame and only on a real width change, so setting
  // the height doesn't re-trigger the observer in the same frame.
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    requestAnimationFrame(() => {
      const scale = width / FRAME_W;
      frame.style.transform = `scale(${scale})`;
      viewport.style.height = `${Math.round(FRAME_H * scale)}px`;
    });
  }).observe(viewport);

  // Right: number, label, rating, notes.
  const panel = el('div', 'panel');
  const head = el('div', 'panel-head');
  head.appendChild(el('div', 'panel-num', String(index + 1).padStart(2, '0')));
  const title = el('div', 'panel-title');
  title.append(el('h2', '', site.label), el('div', '', GTE.hostnameLabel(site.url)));
  head.appendChild(title);

  const ratingWrap = el('div');
  const ratingLabel = el('div', 'label');
  ratingLabel.appendChild(el('span', '', GTE.t('Cijfer', 'Score')));
  const clearBtn = el('button', '', GTE.t('wissen', 'clear'));
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => setRating(site.id, null));
  ratingLabel.appendChild(clearBtn);
  const rating = el('div', 'rating');
  const ratingButtons = [];
  for (let v = 1; v <= 10; v++) {
    const b = el('button', '', String(v));
    b.type = 'button';
    b.dataset.value = String(v);
    b.addEventListener('click', () => setRating(site.id, v));
    rating.appendChild(b);
    ratingButtons.push(b);
  }
  ratingWrap.append(ratingLabel, rating);

  const notes = GTE.getSiteNotes(site);
  const textareas = {};
  const saved = el('div', 'saved');
  const makeField = (field) => {
    const wrap = el('div');
    const label = el('div', 'label');
    label.appendChild(el('span', '', GTE.fieldText(field, 'label')));
    const ta = document.createElement('textarea');
    ta.placeholder = GTE.fieldText(field, 'placeholder');
    ta.value = notes[field.key] || '';
    ta.rows = field.key === 'algemeen' ? 3 : 2;
    let timer = null;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!ta.dataset.dirty) return;
      delete ta.dataset.dirty;
      const value = ta.value;
      send({ command: 'setNote', siteId: site.id, key: field.key, value }).then(async (res) => {
        let ok = !!(res && res.success);
        if (!ok) {
          ok = await saveDirect(site.id, (s) => {
            const n = GTE.getSiteNotes(s);
            n[field.key] = value;
            s.notes = n;
            if (field.key === 'algemeen') s.note = value;
          }).catch(() => false);
        }
        showSaved(site.id, ok);
      });
    };
    ta.addEventListener('input', () => {
      ta.dataset.dirty = '1';
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, NOTE_SAVE_DELAY_MS);
    });
    ta.addEventListener('blur', flush);
    textareas[field.key] = ta;
    wrap.append(label, ta);
    return wrap;
  };

  const editable = GTE.NOTE_FIELDS.filter((f) => f.key !== 'telefoon');
  const mainField = makeField(editable[0]);
  const more = document.createElement('details');
  const otherFields = editable.slice(1);
  if (otherFields.some((f) => (notes[f.key] || '').trim())) more.open = true;
  more.appendChild(el('summary', '', `${GTE.t('Meer notities', 'More notes')} (${otherFields.map((f) => GTE.fieldText(f, 'short').toLowerCase()).join(', ')})`));
  const moreBody = el('div', 'more');
  otherFields.forEach((f) => moreBody.appendChild(makeField(f)));
  more.appendChild(moreBody);

  const phoneBox = el('div', 'phone-notes');
  const phoneLabel = el('div', 'label');
  phoneLabel.appendChild(el('span', '', GTE.t('📱 Van de telefoon', '📱 From the phone')));
  const phoneList = el('ul');
  phoneBox.append(phoneLabel, phoneList);

  panel.append(head, ratingWrap, saved, phoneBox, mainField, more);
  section.append(left, panel);
  sitesEl.appendChild(section);

  const segment = el('button');
  segment.type = 'button';
  segment.title = `${index + 1}. ${site.label}`;
  segment.addEventListener('click', () => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  segmentsEl.appendChild(segment);

  rows.set(site.id, { section, ratingButtons, textareas, phoneList, phoneBox, segment, saved, savedTimer: null });
  renderRating(site.id, site.rating);
  renderPhoneNotes(site.id, notes.telefoon);
}

function renderRating(siteId, value) {
  const row = rows.get(siteId);
  if (!row) return;
  row.ratingButtons.forEach((b) => {
    const v = Number(b.dataset.value);
    const selected = v === value;
    b.classList.toggle('selected', selected);
    b.style.background = selected ? ratingColor(v) : '';
  });
  row.segment.classList.toggle('rated', typeof value === 'number');
}

function renderPhoneNotes(siteId, text) {
  const row = rows.get(siteId);
  if (!row) return;
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  row.phoneBox.hidden = lines.length === 0;
  row.phoneList.replaceChildren(...lines.map((line) => {
    const li = el('li');
    const m = line.match(/^\[(\d{1,2}:\d{2})\]\s*(.*)$/);
    if (m) {
      li.append(el('time', '', m[1]), document.createTextNode(m[2]));
    } else {
      li.textContent = line;
    }
    return li;
  }));
}

async function setRating(siteId, value) {
  const site = test.sites.find((s) => s.id === siteId);
  if (site) site.rating = value;
  renderRating(siteId, value);
  updateProgress();
  const res = await send({ command: 'setRating', siteId, rating: value });
  let ok = !!(res && res.success);
  if (!ok) {
    ok = await saveDirect(siteId, (s) => { s.rating = value; s.ratedAt = value === null ? null : Date.now(); }).catch(() => false);
  }
  showSaved(siteId, ok);
}

function updateProgress() {
  const rated = GTE.ratedCount(test);
  const total = test.sites.length;
  progressText.textContent = GTE.t(`${rated} van ${total} beoordeeld`, `${rated} of ${total} rated`);
  const left = total - rated;
  finishText.textContent = left === 0
    ? GTE.t('Alles heeft een cijfer. Rond af om de ranking te bekijken.', 'Everything has a score. Finish to see the ranking.')
    : GTE.t(`Nog ${left} website${left === 1 ? '' : 's'} zonder cijfer. Je kunt ook nu al afronden.`,
      `${left} website${left === 1 ? '' : 's'} still without a score. You can also finish now.`);
}

// --- Which site is "on screen" -----------------------------------------------
// The site closest to the middle of the viewport counts as current: number
// keys rate it, and phone notes without an explicit site go to it.

function observeCurrentSite() {
  const visible = new Map();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => visible.set(e.target.dataset.siteId, e.isIntersecting ? e.intersectionRatio : 0));
    let best = null;
    let bestRatio = 0;
    visible.forEach((ratio, id) => { if (ratio > bestRatio) { best = id; bestRatio = ratio; } });
    if (best && best !== currentSiteId) setCurrent(best);
  }, { rootMargin: '-35% 0px -35% 0px', threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] });
  rows.forEach((row) => observer.observe(row.section));
  if (test.sites[0]) setCurrent(test.sites[0].id);
}

function setCurrent(siteId) {
  currentSiteId = siteId;
  rows.forEach((row, id) => {
    row.section.classList.toggle('current', id === siteId);
    row.segment.classList.toggle('current', id === siteId);
  });
  send({ command: 'reviewFocus', siteId });
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input' || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key) && currentSiteId) {
    setRating(currentSiteId, e.key === '0' ? 10 : Number(e.key));
  }
});

// --- Live updates (phone notes, ratings from elsewhere) ----------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tests || !test) return;
  const fresh = (changes.tests.newValue || {})[testId];
  if (!fresh) return;
  fresh.sites.forEach((site) => {
    const row = rows.get(site.id);
    if (!row) return;
    renderRating(site.id, site.rating);
    const notes = GTE.getSiteNotes(site);
    renderPhoneNotes(site.id, notes.telefoon);
    Object.entries(row.textareas).forEach(([key, ta]) => {
      // Never overwrite what someone is typing right now.
      if (document.activeElement === ta || ta.dataset.dirty) return;
      if (ta.value !== (notes[key] || '')) ta.value = notes[key] || '';
    });
  });
  test = fresh;
  updateProgress();
});

// --- Phone QR, music, finish -------------------------------------------------

async function setupSessionControls() {
  const info = await send({ command: 'getSessionInfo' });
  if (info && info.phoneUrl) {
    qrEl.appendChild(GTE.buildQrSvg(info.phoneUrl));
    phoneBtn.hidden = false;
  }
  if (info) musicBtn.setAttribute('aria-pressed', info.musicOn ? 'true' : 'false');
  if (!info || !info.sessionActive) musicBtn.hidden = true;
}

phoneBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  qrPop.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!qrPop.contains(e.target)) qrPop.classList.remove('open');
});

musicBtn.addEventListener('click', async () => {
  const on = musicBtn.getAttribute('aria-pressed') !== 'true';
  musicBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  await send({ command: 'toggleMusic', on });
});

async function finish() {
  // Make sure a note that's still being typed gets saved first.
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') document.activeElement.blur();
  finishButtons.forEach((b) => { b.disabled = true; });
  await send({ command: 'finishReview' });
  location.href = chrome.runtime.getURL(`dashboard.html?test=${encodeURIComponent(testId)}`);
}
finishButtons.forEach((b) => b.addEventListener('click', finish));
