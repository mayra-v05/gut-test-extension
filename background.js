// Gut Test Extension — background service worker.
//
// A gut test session runs in three steps, all in one browser window:
//  1. Intro slide (intro.html) — what's about to happen; nothing starts
//     until the client presses the start button.
//  2. Viewing pass — every site is shown once, in its own tab, with an
//     interval-based auto-switch + optional autoscroll. The client can
//     already rate along the way via the on-page overlay, but doesn't have to.
//  3. Final review (review.html) — one page with every site's hero as a
//     small, scrollable live site, with the rating and notes next to it.
//
// Alongside that, for the whole session:
//  - background music + the live link to the client's phone, both hosted in
//    an offscreen document (offscreen.html) since a service worker can't
//    play audio or keep a stream open;
//  - notes typed on the phone are routed to the right site;
//  - a hero screenshot of every site is taken during the viewing pass, as a
//    fallback for sites that refuse to load inside the review page.
//
// "Review Mode" from the dashboard's ↻ button still reopens a single site in
// a tab with the overlay (manual, no countdown).
//
// Because MV3 service workers can be killed and restarted at any time while
// an alarm-based cycle is still "running", the small bits of state needed to
// resume (current window, current test, tab<->site mapping) are persisted to
// chrome.storage.local and reloaded at the top of every listener via
// ensureRestored().

importScripts('gte_data.js');

const ALARM_NAME = 'tab_cycler_alarm';
const KEEPALIVE_ALARM = 'gte_session_keepalive';
const FRAME_RULE_ID = 1;
const FRAME_TAB_RULE_ID = 2;

let currentWindowId = null;
let tabOrderMap = new Map();     // tabId -> position in the cycle (0-based)
let tabSiteMap = new Map();      // tabId -> site.id within the active test
let startTabId = null;
let isExtensionRunning = false;
let isReviewModeActive = false;
let activeTestId = null;
let tabScrollStatusCache = new Map();
let cycleTimerIntervalId = null;
let cycleStartTime = 0;
let currentIntervalSeconds = 20;
let restored = false;
let selfInitiatedActivationTabId = null; // set right before we ourselves activate a tab, so onActivated can ignore it
let pendingJudgeTabId = null;            // tab we're waiting to finish loading before the judging period (timer+alarm+autoscroll) starts
let pendingJudgeFallbackId = null;       // setTimeout handle for the "page never said complete" safety net
const JUDGE_LOAD_FALLBACK_MS = 8000;
let isJudgePaused = false;               // client hit "Pauze" — alarm/timer/autoscroll are all frozen
let judgePausedRemainingMs = 0;          // ms left on the clock at the moment of pausing
let judgePausedTotalMs = 0;              // the progress bar's total at that same moment (carries any earlier "+10s" extensions)
let isViewingPhaseActive = false;        // "eerst alle 10 laten zien, daarna pas review" — true only during the automatic first pass of a normal Start Gut Test run
let isFinalReviewActive = false;         // the one-page review (review.html) is open as the last step of a session
let reviewTabId = null;
let phoneTopic = null;                   // ntfy topic of the active test (see GTE.ensurePhoneTopic)
let phoneSince = null;                   // unix seconds — oldest phone note this session still picks up
let phoneCurrentSiteId = null;           // the site on screen right now (where untargeted phone notes go)

const DEFAULT_SETTINGS = {
  interval: 20,
  refresh: false,
  autoscroll: true,
  scrollSpeed: 5,
  enableTopDelay: true,
  topDelaySeconds: 3,
  reviewRefresh: false,
  musicEnabled: true,
  musicVolume: 0.5,
  phonePageUrl: ''
};

// One-time migration: the default switch interval used to be 10s, now 20s.
// Reloading an unpacked extension in chrome://extensions doesn't reliably
// fire onInstalled with reason "update" (it varies), so instead of relying
// on that, this runs unconditionally every time the background script loads
// and forces the bump exactly once, tracked by its own flag — a value the
// user later deliberately changes back to 10 is never touched again.
(async () => {
  try {
    const { interval, intervalMigratedTo20 } = await chrome.storage.local.get(['interval', 'intervalMigratedTo20']);
    if (!intervalMigratedTo20) {
      if (interval === 10 || interval === undefined) {
        await chrome.storage.local.set({ interval: 20, intervalMigratedTo20: true });
        console.log('BG_LOG: migrated switch interval 10s -> 20s (one-time).');
      } else {
        await chrome.storage.local.set({ intervalMigratedTo20: true });
      }
    }
  } catch (e) { console.warn('BG_WARN: interval migration failed', e); }
})();

// --- Session persistence (survives service-worker restarts) ---------------

async function persistSession() {
  await chrome.storage.local.set({
    _session: {
      currentWindowId,
      activeTestId,
      tabSiteMapObj: Object.fromEntries(tabSiteMap),
      isRunning: isExtensionRunning,
      reviewMode: isReviewModeActive,
      viewingPhase: isViewingPhaseActive,
      finalReview: isFinalReviewActive,
      reviewTabId,
      phoneTopic,
      phoneSince,
      phoneCurrentSiteId,
      startTabId
    }
  }).catch(() => {});
}

async function ensureRestored() {
  if (restored) return;
  restored = true;
  try {
    const { _session } = await chrome.storage.local.get('_session');
    if (_session) {
      currentWindowId = _session.currentWindowId ?? null;
      activeTestId = _session.activeTestId ?? null;
      tabSiteMap = new Map(Object.entries(_session.tabSiteMapObj || {}).map(([k, v]) => [Number(k), v]));
      isExtensionRunning = !!_session.isRunning;
      isReviewModeActive = !!_session.reviewMode;
      isViewingPhaseActive = !!_session.viewingPhase;
      isFinalReviewActive = !!_session.finalReview;
      reviewTabId = _session.reviewTabId ?? null;
      phoneTopic = _session.phoneTopic ?? null;
      phoneSince = _session.phoneSince ?? null;
      phoneCurrentSiteId = _session.phoneCurrentSiteId ?? null;
      startTabId = _session.startTabId ?? null;
    }
  } catch (e) { console.warn('BG_WARN: restore session failed', e); }
}

// --- Settings & tests -------------------------------------------------------

async function getSettings() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...data };
}

async function getActiveTest() {
  if (!activeTestId) return null;
  return GTE.getTest(activeTestId);
}

// Every write to `tests` from here goes through this queue. Ratings, notes
// from the review page, notes from the phone and favicons can all arrive at
// the same moment; without serializing them, two read-modify-write cycles
// would overlap and the later save would silently drop the earlier change.
let testsWriteChain = Promise.resolve();

function updateSite(testId, siteId, mutate) {
  const run = testsWriteChain.then(async () => {
    const { tests } = await GTE.getState();
    const test = tests[testId];
    const site = test ? test.sites.find((s) => s.id === siteId) : null;
    if (!site) return null;
    if (mutate(site, test) === false) return null;
    test.updatedAt = Date.now();
    await GTE.saveTests(tests);
    return site;
  });
  testsWriteChain = run.catch(() => {});
  return run;
}

function saveSiteRating(testId, siteId, rating) {
  return updateSite(testId, siteId, (site) => {
    site.rating = rating;
    site.ratedAt = rating === null ? null : Date.now();
  });
}

function saveSiteNote(testId, siteId, key, value) {
  if (!GTE.NOTE_FIELDS.some((f) => f.key === key)) return Promise.resolve(null);
  return updateSite(testId, siteId, (site) => {
    const notes = GTE.getSiteNotes(site);
    notes[key] = String(value ?? '');
    site.notes = notes;
    if (key === 'algemeen') site.note = notes.algemeen;
  });
}

function saveSiteFavicon(testId, siteId, favIconUrl) {
  if (!favIconUrl) return Promise.resolve(null);
  return updateSite(testId, siteId, (site) => {
    if (site.favicon === favIconUrl) return false;
    site.favicon = favIconUrl;
  });
}

// --- Screenshots ---------------------------------------------------------
//
// "📷" in the overlay grabs the currently-visible tab and stores a resized,
// compressed copy against the site, so a handful of these per site stays
// well within chrome.storage.local's quota (manifest declares
// "unlimitedStorage" as extra headroom, but keeping each shot small is what
// actually matters for a snappy dashboard).

const SCREENSHOT_MAX_WIDTH = 480;
const SCREENSHOT_JPEG_QUALITY = 0.6;
const MAX_SCREENSHOTS_PER_SITE = 8;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Service workers have OffscreenCanvas/createImageBitmap available, so the
// resize happens right here instead of needing a content-script round trip.
async function resizeScreenshotDataUrl(dataUrl, maxWidth = SCREENSHOT_MAX_WIDTH) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_JPEG_QUALITY });
  const buf = await outBlob.arrayBuffer();
  return `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
}

function saveSiteScreenshot(testId, siteId, dataUrl) {
  return updateSite(testId, siteId, (site) => {
    if (!Array.isArray(site.screenshots)) site.screenshots = [];
    site.screenshots.push({ id: GTE.generateId(), dataUrl, takenAt: Date.now() });
    if (site.screenshots.length > MAX_SCREENSHOTS_PER_SITE) {
      site.screenshots = site.screenshots.slice(site.screenshots.length - MAX_SCREENSHOTS_PER_SITE);
    }
  });
}

// Captures the visible tab with our own overlay hidden for that moment, so
// screenshots show the site itself and not the rating panel/progress bar.
async function captureCleanTab(tabId, maxWidth) {
  try {
    await chrome.tabs.sendMessage(tabId, { command: 'hideForCapture' });
  } catch (e) { /* no overlay on this page — fine */ }
  try {
    const raw = await chrome.tabs.captureVisibleTab(currentWindowId, { format: 'jpeg', quality: 85 });
    return await resizeScreenshotDataUrl(raw, maxWidth);
  } finally {
    chrome.tabs.sendMessage(tabId, { command: 'showAfterCapture' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
  }
}

async function captureScreenshotForTab(tabId) {
  const siteId = tabSiteMap.get(tabId);
  if (!activeTestId || !siteId || !currentWindowId) return false;
  try {
    const dataUrl = await captureCleanTab(tabId, SCREENSHOT_MAX_WIDTH);
    await saveSiteScreenshot(activeTestId, siteId, dataUrl);
    return true;
  } catch (error) {
    console.warn('BG_WARN: screenshot capture failed', error);
    return false;
  }
}

// Hero shot: the top of the page right after it loaded, taken automatically
// once per site during the viewing pass. The review page shows it when the
// live mini-site can't be embedded.
const HERO_MAX_WIDTH = 1280;
const HERO_CAPTURE_DELAY_MS = 450;

async function captureHeroShot(tabId) {
  const siteId = tabSiteMap.get(tabId);
  if (!siteId || !currentWindowId) return;
  await new Promise((r) => setTimeout(r, HERO_CAPTURE_DELAY_MS));
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
    if (!active || active.id !== tabId || !isExtensionRunning) return;
    const dataUrl = await captureCleanTab(tabId, HERO_MAX_WIDTH);
    await chrome.storage.local.set({ [GTE.heroKey(siteId)]: dataUrl });
  } catch (error) {
    console.warn('BG_WARN: hero capture failed', error);
  }
}

// --- Offscreen document: music + phone relay -------------------------------
//
// A service worker has no audio output and gets killed when idle, so both
// the background music and the live connection to the client's phone run in
// a hidden "offscreen document" (offscreen.html) for the whole session.
// Chrome may still close that document (e.g. ~30s after the music stops),
// so a keepalive alarm re-creates it and reconnects the relay every 30s; the
// relay resumes from the last note it saw, so nothing typed in between is lost.

let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  try {
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  } catch (e) { /* hasDocument not available on this Chrome version — fall through and try to create */ }
  if (creatingOffscreenPromise) { await creatingOffscreenPromise; return; }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'Speelt achtergrondmuziek af en houdt de live verbinding met de telefoon van de klant open tijdens de gut test'
  });
  try {
    await creatingOffscreenPromise;
  } catch (e) {
    // Most likely: another call already created it in the meantime. Fine.
  } finally {
    creatingOffscreenPromise = null;
  }
}

function sendToOffscreen(message) {
  chrome.runtime.sendMessage({ ...message, target: 'offscreen' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
}

function isSessionActive() {
  return isExtensionRunning || isReviewModeActive || isFinalReviewActive;
}

// (Re)starts everything a session needs in the offscreen document. Safe to
// call as often as you like: both music and relay ignore a repeat start.
async function ensureSessionServices() {
  if (!isSessionActive()) return;
  try {
    await ensureOffscreenDocument();
    const settings = await getSettings();
    if (settings.musicEnabled) sendToOffscreen({ command: 'playMusic', volume: settings.musicVolume });
    if (phoneTopic) {
      const { phoneLastId } = await chrome.storage.local.get('phoneLastId');
      sendToOffscreen({ command: 'startRelay', topic: phoneTopic, since: phoneLastId || phoneSince || '10m' });
    }
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) { console.warn('BG_WARN: could not start session services', e); }
}

function stopSessionServices() {
  sendToOffscreen({ command: 'stopMusic' });
  sendToOffscreen({ command: 'stopRelay' });
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
}

async function setMusicEnabled(enabled) {
  await chrome.storage.local.set({ musicEnabled: !!enabled });
  if (enabled && isSessionActive()) {
    await ensureOffscreenDocument();
    const settings = await getSettings();
    sendToOffscreen({ command: 'playMusic', volume: settings.musicVolume });
  } else {
    sendToOffscreen({ command: 'stopMusic' });
  }
  return !!enabled;
}

// --- Phone notes -------------------------------------------------------------

const PHONE_SEEN_LIMIT = 300;
let phoneSeenIds = null;
let lastPublishedPhoneState = '';

async function markPhoneMessageSeen(id) {
  if (!phoneSeenIds) {
    const { phoneSeenIds: stored } = await chrome.storage.local.get('phoneSeenIds');
    phoneSeenIds = Array.isArray(stored) ? stored : [];
  }
  if (phoneSeenIds.includes(id)) return false;
  phoneSeenIds.push(id);
  if (phoneSeenIds.length > PHONE_SEEN_LIMIT) phoneSeenIds = phoneSeenIds.slice(-PHONE_SEEN_LIMIT);
  await chrome.storage.local.set({ phoneSeenIds, phoneLastId: id });
  return true;
}

// Tells the phone page which site is on screen and which sites exist, so it
// can label the note field ("Nu op scherm: 3 · voorbeeld.nl") and offer a
// site picker. Only sent when something actually changed.
async function publishPhoneState(mode) {
  if (!phoneTopic) return;
  const test = await getActiveTest();
  if (!test) return;
  await GTE.loadLang();
  const body = JSON.stringify({
    t: 'state',
    v: 1,
    lang: GTE.lang,
    test: test.name,
    mode: mode || (isFinalReviewActive ? 'review' : (isSessionActive() ? 'viewing' : 'done')),
    current: phoneCurrentSiteId,
    sites: test.sites.map((s, i) => ({ id: s.id, n: i + 1, label: s.label }))
  });
  if (body === lastPublishedPhoneState) return;
  lastPublishedPhoneState = body;
  fetch(`${GTE.PHONE_RELAY}/${phoneTopic}-s`, { method: 'POST', body }).catch(() => {});
}

async function setPhoneCurrentSite(siteId) {
  if (!siteId || siteId === phoneCurrentSiteId) return;
  phoneCurrentSiteId = siteId;
  await persistSession();
  await publishPhoneState();
}

function formatNoteTime(unixSeconds) {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// A note from the phone. The phone page sends JSON ({ t: 'note', siteId,
// text }); anything else (e.g. typed in ntfy's own app) is plain text. Plain
// text may start with "#3 " to target site 3 — otherwise it goes to the site
// that's on screen.
async function handlePhoneMessage({ id, time, message }) {
  if (!id || typeof message !== 'string') return;
  if (!activeTestId) return;
  if (!(await markPhoneMessageSeen(id))) return;

  let text = message;
  let siteId = null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') {
      if (parsed.t !== 'note') return;
      text = String(parsed.text || '');
      siteId = parsed.siteId || null;
    }
  } catch (e) { /* plain text */ }
  text = text.trim().slice(0, 3000);
  if (!text) return;

  const test = await getActiveTest();
  if (!test || !test.sites.length) return;
  const numbered = text.match(/^#(\d{1,2})\s+([\s\S]+)$/);
  if (!siteId && numbered && test.sites[Number(numbered[1]) - 1]) {
    siteId = test.sites[Number(numbered[1]) - 1].id;
    text = numbered[2].trim();
  }
  if (!siteId || !test.sites.some((s) => s.id === siteId)) {
    siteId = phoneCurrentSiteId && test.sites.some((s) => s.id === phoneCurrentSiteId) ? phoneCurrentSiteId : test.sites[0].id;
  }

  const line = `[${formatNoteTime(time)}] ${text}`;
  const site = await updateSite(activeTestId, siteId, (s) => {
    const notes = GTE.getSiteNotes(s);
    notes.telefoon = notes.telefoon ? `${notes.telefoon}\n${line}` : line;
    s.notes = notes;
  });

  if (site && currentWindowId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
      if (active && tabSiteMap.has(active.id)) {
        chrome.tabs.sendMessage(active.id, { command: 'phoneNoteToast', label: site.label }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
      }
    } catch (e) { /* ignore */ }
  }
}

// --- Embedding sites in the review page ------------------------------------
//
// Most sites send X-Frame-Options / CSP frame-ancestors, which would leave
// the review page's mini-sites blank. This session rule strips those two
// headers — only for frames loaded by this extension's own pages (and,
// when known, for every frame inside the review tab, so clicking through to
// another page within a mini-site keeps working). Nothing else in the
// browser is affected.

const STRIP_FRAME_HEADERS = {
  type: 'modifyHeaders',
  responseHeaders: [
    { header: 'x-frame-options', operation: 'remove' },
    { header: 'content-security-policy', operation: 'remove' }
  ]
};

async function ensureFrameRules(reviewTab = null) {
  const addRules = [{
    id: FRAME_RULE_ID,
    priority: 1,
    action: STRIP_FRAME_HEADERS,
    condition: { resourceTypes: ['sub_frame'], initiatorDomains: [chrome.runtime.id] }
  }];
  if (reviewTab) {
    addRules.push({
      id: FRAME_TAB_RULE_ID,
      priority: 1,
      action: STRIP_FRAME_HEADERS,
      condition: { resourceTypes: ['sub_frame'], tabIds: [reviewTab] }
    });
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FRAME_RULE_ID, FRAME_TAB_RULE_ID],
      addRules
    });
  } catch (e) { console.warn('BG_WARN: could not set frame rules', e); }
}

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`BG_LOG: Gut Test Extension installed, v${chrome.runtime.getManifest().version}.`);
  const settings = await getSettings();
  // The default switch interval used to be 10s. Bump existing installs that
  // never changed it away from that up to the new 20s default — but leave a
  // deliberately-chosen custom value alone.
  if (details.reason === 'update' && settings.interval === 10) {
    settings.interval = DEFAULT_SETTINGS.interval;
  }
  await chrome.storage.local.set(settings);
  await chrome.alarms.clearAll();
  await ensureFrameRules();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('BG_LOG: Browser startup — resetting any running session.');
  await stopCyclingLogic(true);
  await ensureFrameRules();
});

// --- Alarm-driven cycling ------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureRestored();
  if (alarm.name === KEEPALIVE_ALARM) {
    if (isSessionActive()) await ensureSessionServices();
    else await chrome.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  if (!isExtensionRunning || !currentWindowId || isReviewModeActive) {
    stopTimerInterval();
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  try {
    await chrome.windows.get(currentWindowId);
    const settings = await getSettings();
    await switchTab('next', settings);
  } catch (error) {
    if (!error.message?.includes('No window with id') && !error.message?.includes('Invalid window ID')) {
      console.error('BG_ERROR: alarm execution error', error);
    }
    await stopCyclingLogic(true);
    await syncStatusWithPopup();
  }
});

// cycleDurationMs is the current judging period's total length for the
// progress-bar's denominator. It starts out equal to the interval setting,
// but can grow independently of it — via extendTimerDuration() ("+10 sec")
// or a pause/resume round trip that preserves the original total — without
// touching currentIntervalSeconds (which is what future judging periods use).
let cycleDurationMs = 0;

function runTimerLoop(tabId) {
  cycleTimerIntervalId = setInterval(async () => {
    const elapsed = Date.now() - cycleStartTime;
    const progress = Math.min(100, (elapsed / cycleDurationMs) * 100);
    const remainingSec = Math.max(0, Math.ceil((cycleDurationMs - elapsed) / 1000));
    try {
      const activeTabs = await chrome.tabs.query({ active: true, windowId: currentWindowId });
      if (activeTabs.length > 0 && activeTabs[0].id === tabId && isExtensionRunning && !isReviewModeActive) {
        chrome.tabs.sendMessage(tabId, { command: 'updateTimer', progress, remainingSec }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
      } else {
        stopTimerInterval();
      }
    } catch (e) { stopTimerInterval(); }
  }, 250);
}

function startTimerInterval(tabId, intervalSeconds) {
  stopTimerInterval();
  if (!isExtensionRunning || isReviewModeActive || !tabId || intervalSeconds <= 0) return;
  currentIntervalSeconds = intervalSeconds;
  cycleDurationMs = intervalSeconds * 1000;
  cycleStartTime = Date.now();
  runTimerLoop(tabId);
}

// Restarts the progress bar after a pause so it picks up exactly where it
// left off (same % filled) and reaches 100% after `remainingMs` more real
// time, by backdating cycleStartTime as if the paused time never happened.
function resumeTimerInterval(tabId, remainingMs, totalMs) {
  stopTimerInterval();
  if (!isExtensionRunning || isReviewModeActive || !tabId || remainingMs <= 0) return;
  cycleDurationMs = totalMs;
  cycleStartTime = Date.now() - (totalMs - remainingMs);
  runTimerLoop(tabId);
}

// "+10 sec": stretch the denominator so the bar's fill % drops back to
// reflect the newly-added time, without touching cycleStartTime (so the
// elapsed real time so far stays exactly what it was).
function extendTimerDuration(extraMs) {
  if (cycleDurationMs > 0) cycleDurationMs += extraMs;
}

function stopTimerInterval() {
  if (cycleTimerIntervalId) { clearInterval(cycleTimerIntervalId); cycleTimerIntervalId = null; cycleStartTime = 0; cycleDurationMs = 0; }
}

// --- Starting a test ----------------------------------------------------------

// Step 1: the intro slide, in its own (maximized) window. Nothing else starts
// until the client presses the button on that slide, which sends 'start'.
async function openIntro(testId) {
  const test = testId ? await GTE.getTest(testId) : null;
  if (!test || !test.sites || test.sites.length === 0) return false;
  activeTestId = testId;
  await GTE.setActiveTestId(testId);
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`intro.html?test=${encodeURIComponent(testId)}`),
      focused: true,
      state: 'maximized'
    });
    return true;
  } catch (error) {
    console.error('BG_ERROR: failed to open intro', error);
    return false;
  }
}

// Step 2: the viewing pass. When started from the intro slide, the sites
// open in that same window and the slide's tab is closed — so the whole
// session stays in one window, like a presentation.
async function startGutTest(testId, introTab = null) {
  console.log('BG_LOG: startGutTest', testId);
  await chrome.storage.local.remove('lastCompletedTestId').catch(() => {});
  if (isSessionActive() || currentWindowId) {
    await stopCyclingLogic(true);
    await new Promise((r) => setTimeout(r, 100));
  }

  const test = await GTE.getTest(testId);
  if (!test || !test.sites || test.sites.length === 0) {
    console.warn('BG_WARN: test has no sites', testId);
    return false;
  }

  activeTestId = testId;
  await GTE.setActiveTestId(testId);

  let windowId;
  let tabs = [];
  try {
    if (introTab && introTab.windowId !== undefined) {
      windowId = introTab.windowId;
      for (const site of test.sites) {
        tabs.push(await chrome.tabs.create({ windowId, url: site.url, active: false }));
      }
    } else {
      const win = await chrome.windows.create({ url: test.sites.map((s) => s.url), focused: true, state: 'maximized' });
      windowId = win.id;
      tabs = win.tabs && win.tabs.length ? win.tabs : await chrome.tabs.query({ windowId });
    }
  } catch (error) {
    console.error('BG_ERROR: failed to open test window', error);
    return false;
  }
  tabs = tabs.filter((t) => t.id !== undefined).sort((a, b) => a.index - b.index);

  tabSiteMap = new Map();
  tabScrollStatusCache = new Map();
  tabs.forEach((tab, i) => {
    if (test.sites[i]) {
      tabSiteMap.set(tab.id, test.sites[i].id);
      tabScrollStatusCache.set(tab.id, 'unknown');
    }
  });

  const firstTab = tabs[0];
  if (introTab) {
    // Activate the first site ourselves (flagged, so onActivated ignores
    // it), then drop the intro slide's tab.
    selfInitiatedActivationTabId = firstTab.id;
    try { await chrome.tabs.update(firstTab.id, { active: true }); } catch (e) { /* ignore */ }
    try { await chrome.tabs.remove(introTab.id); } catch (e) { /* already closed */ }
  }

  currentWindowId = windowId;
  await updateAndGetTabOrder(currentWindowId);
  startTabId = firstTab?.id ?? null;

  phoneTopic = await GTE.ensurePhoneTopic(testId);
  phoneSince = Math.floor(Date.now() / 1000) - 15 * 60; // also picks up notes typed during the intro
  phoneCurrentSiteId = test.sites[0].id;
  lastPublishedPhoneState = '';

  const settings = await getSettings();
  currentIntervalSeconds = settings.interval || 20;
  isExtensionRunning = true;
  isReviewModeActive = false;
  isFinalReviewActive = false;
  isViewingPhaseActive = true; // "eerst alle 10 laten zien, daarna pas review"
  await chrome.storage.local.set({ isRunning: true, reviewMode: false });
  await persistSession();
  await ensureFrameRules();
  ensureSessionServices();
  publishPhoneState();

  // Show the overlay right away, but only start the countdown/alarm/
  // autoscroll once the page has actually loaded (armJudgePeriod waits for
  // that) so load time doesn't eat into judging time.
  if (firstTab) {
    clearPendingJudge();
    await refreshOverlayForTab(firstTab.id, { showTimer: false });
    await armJudgePeriod(firstTab.id, settings);
  }

  console.log('BG_LOG: startGutTest successful, window', currentWindowId);
  return true;
}

async function stopGutTest() {
  console.log('BG_LOG: Stopping Gut Test.');
  return stopCyclingLogic(true);
}

// Step 3: the one-page review. Called automatically after the last site of
// the viewing pass (in the same window, replacing the site tabs), or directly
// from the popup / "Tests beheren" to (re)review a test on its own.
async function openFinalReview(testId, { windowId = null } = {}) {
  console.log('BG_LOG: opening final review for', testId);
  const test = await GTE.getTest(testId);
  if (!test || !test.sites || test.sites.length === 0) return false;

  stopTimerInterval();
  clearPendingJudge();
  try { await chrome.alarms.clear(ALARM_NAME); } catch (e) { /* ignore */ }

  const siteTabIds = [...tabSiteMap.keys()];
  const startedFresh = !isSessionActive();
  if (startedFresh && currentWindowId) {
    await stopCyclingLogic(true);
    await new Promise((r) => setTimeout(r, 100));
  }

  activeTestId = testId;
  await GTE.setActiveTestId(testId);
  await ensureFrameRules();

  // Leave "running" before the review tab exists, so its activation isn't
  // mistaken for a site tab that needs a countdown.
  isExtensionRunning = false;
  isReviewModeActive = false;
  isViewingPhaseActive = false;
  isFinalReviewActive = true;
  isJudgePaused = false;

  const url = chrome.runtime.getURL(`review.html?test=${encodeURIComponent(testId)}`);
  let tab;
  try {
    if (windowId) {
      tab = await chrome.tabs.create({ windowId, url, active: true });
    } else {
      const win = await chrome.windows.create({ url, focused: true, state: 'maximized' });
      windowId = win.id;
      tab = win.tabs && win.tabs[0];
    }
  } catch (error) {
    console.error('BG_ERROR: failed to open review page', error);
    isFinalReviewActive = false;
    return false;
  }

  currentWindowId = windowId;
  reviewTabId = tab ? tab.id : null;
  if (reviewTabId) await ensureFrameRules(reviewTabId);
  tabSiteMap = new Map();
  tabOrderMap = new Map();
  tabScrollStatusCache = new Map();
  if (!phoneTopic || startedFresh) {
    phoneTopic = await GTE.ensurePhoneTopic(testId);
    phoneSince = Math.floor(Date.now() / 1000) - 15 * 60;
  }
  phoneCurrentSiteId = test.sites[0].id;
  await chrome.storage.local.set({ isRunning: false, reviewMode: true });
  await persistSession();

  // The site tabs are no longer needed (the review page embeds every site
  // itself) — close them so they stop playing videos/sound and free memory.
  if (siteTabIds.length) {
    try { await chrome.tabs.remove(siteTabIds); } catch (e) { /* some already gone */ }
  }

  ensureSessionServices();
  publishPhoneState();
  await syncStatusWithPopup();
  return true;
}

// "Afronden" on the review page: end the session (music fades out, phone
// link closes). The review page then navigates itself to the dashboard.
async function finishFinalReview(testId) {
  const finishedTestId = testId || activeTestId;
  await stopCyclingLogic(true);
  if (finishedTestId) {
    await chrome.storage.local.set({ lastCompletedTestId: finishedTestId, lastCompletedAt: Date.now() }).catch(() => {});
  }
  chrome.runtime.sendMessage({ command: 'testCompleted', testId: finishedTestId }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
  return true;
}

// Reopens a single site from a finished (or in-progress) test for a quick
// recheck — "wacht, die site wil ik nog een keer bekijken" — without
// restarting the whole test or disturbing any other site's rating. Behaves
// like review mode (manual only, no countdown/auto-switch): rating it just
// updates that one site's score in place via the normal handleRating path.
async function openSingleSiteReview(testId, siteId) {
  console.log('BG_LOG: Single-site review for', testId, siteId);
  if (isSessionActive() || currentWindowId) {
    await stopCyclingLogic(true);
    await new Promise((r) => setTimeout(r, 100));
  }

  const test = await GTE.getTest(testId);
  if (!test) return false;
  const site = test.sites.find((s) => s.id === siteId);
  if (!site) return false;

  activeTestId = testId;
  await GTE.setActiveTestId(testId);

  let win;
  try {
    win = await chrome.windows.create({ url: site.url, focused: true });
  } catch (error) {
    console.error('BG_ERROR: failed to open single-site review window', error);
    return false;
  }
  let tabs = win.tabs;
  if (!tabs || tabs.length === 0) tabs = await chrome.tabs.query({ windowId: win.id });
  const tab = tabs.find((t) => t.id !== undefined);
  if (!tab) return false;

  currentWindowId = win.id;
  tabSiteMap = new Map([[tab.id, site.id]]);
  tabScrollStatusCache = new Map([[tab.id, 'unknown']]);
  await updateAndGetTabOrder(currentWindowId);

  isExtensionRunning = false;
  isReviewModeActive = true;
  isViewingPhaseActive = false;
  phoneTopic = null; // a quick recheck doesn't need the phone link
  await chrome.storage.local.set({ isRunning: false, reviewMode: true });
  await persistSession();
  ensureSessionServices();

  await refreshOverlayForTab(tab.id, { showTimer: false, reviewMode: true });
  await syncStatusWithPopup();
  return true;
}

async function stopCyclingLogic(updateStorage = true) {
  const oldWindowId = currentWindowId;
  const wasActive = isSessionActive();
  const hadPhone = !!phoneTopic;

  if (wasActive && hadPhone) await publishPhoneState('done');

  isExtensionRunning = false;
  isReviewModeActive = false;
  isViewingPhaseActive = false;
  isFinalReviewActive = false;
  isJudgePaused = false;
  judgePausedRemainingMs = 0;
  judgePausedTotalMs = 0;
  stopTimerInterval();
  clearPendingJudge();
  try { await chrome.alarms.clearAll(); } catch (e) { /* ignore */ }
  if (wasActive) stopSessionServices();

  if (wasActive && oldWindowId) {
    try {
      const activeTabs = await chrome.tabs.query({ active: true, windowId: oldWindowId });
      if (activeTabs.length > 0 && activeTabs[0].id && activeTabs[0].id !== reviewTabId) {
        await stopScrollingInTab(activeTabs[0].id);
        await sendOverlayUpdate(activeTabs[0].id, { show: false });
      }
    } catch (e) { /* ignore */ }
  }

  if (updateStorage) {
    try { await chrome.storage.local.set({ isRunning: false, reviewMode: false }); } catch (e) { /* ignore */ }
  }

  currentWindowId = null;
  startTabId = null;
  reviewTabId = null;
  phoneTopic = null;
  phoneSince = null;
  phoneCurrentSiteId = null;
  lastPublishedPhoneState = '';
  tabOrderMap.clear();
  tabSiteMap.clear();
  tabScrollStatusCache.clear();
  await persistSession();
  return true;
}

// --- Judging period (timer + alarm + autoscroll) --------------------------
//
// The "N seconds to judge this site" clock — the alarm that triggers the
// next auto-switch, the visible countdown bar, and autoscroll — must only
// start once the page has actually finished loading. Otherwise load time
// silently eats into the client's judging time. armJudgePeriod() checks
// whether the tab is already loaded; if not, it waits for the tabs.onUpdated
// "complete" event (with a fallback timeout in case a page never reports
// complete, e.g. it errors out).

function clearPendingJudge() {
  if (pendingJudgeFallbackId) { clearTimeout(pendingJudgeFallbackId); pendingJudgeFallbackId = null; }
  pendingJudgeTabId = null;
}

async function beginJudgingPeriod(tabId, settings) {
  isJudgePaused = false;
  judgePausedRemainingMs = 0;
  judgePausedTotalMs = 0;
  currentIntervalSeconds = settings.interval || 20;
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: currentIntervalSeconds / 60 });
  startTimerInterval(tabId, currentIntervalSeconds);
  await refreshOverlayForTab(tabId, { showTimer: true, reviewMode: false });

  // Grab the hero (top of the freshly loaded page) before autoscroll moves
  // it — the review page falls back to this when a site can't be embedded.
  if (isViewingPhaseActive) await captureHeroShot(tabId);

  if (settings.autoscroll) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (tab.url && !isRestrictedUrl(tab.url)) {
      const delay = (settings.enableTopDelay && settings.topDelaySeconds) ? settings.topDelaySeconds : 0;
      startScrollingInTab(tabId, settings.scrollSpeed, delay);
    } else {
      tabScrollStatusCache.set(tabId, 'unscrollable');
      await refreshOverlayForTab(tabId, { showTimer: true, reviewMode: false });
    }
  } else {
    await stopScrollingInTab(tabId);
  }
}

async function armJudgePeriod(tabId, settings, { forcedReload = false } = {}) {
  clearPendingJudge();
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }

  if (!forcedReload && tab.status === 'complete') {
    await beginJudgingPeriod(tabId, settings);
    return;
  }

  // Still loading (or we just triggered a reload) — wait for onUpdated's
  // "complete" event to actually start the clock. See the fallback timer
  // below for pages that never report complete.
  pendingJudgeTabId = tabId;
  pendingJudgeFallbackId = setTimeout(async () => {
    if (pendingJudgeTabId === tabId) {
      console.log('BG_LOG: page never reported complete — starting judging period anyway', tabId);
      clearPendingJudge();
      await beginJudgingPeriod(tabId, settings);
    }
  }, JUDGE_LOAD_FALLBACK_MS);
}

// --- Pause / resume / extend the judging period -----------------------------
//
// "Pauze" freezes everything the judging period drives — the auto-switch
// alarm, the visible countdown bar, and autoscroll — in place, so a client
// who steps away doesn't come back to find the site already switched or the
// page scrolled somewhere they didn't choose. "+10 sec" just gives the
// current site more time without otherwise disturbing anything.

async function pauseJudging(tabId) {
  if (!isExtensionRunning || isReviewModeActive || isJudgePaused) return;
  const totalMs = cycleDurationMs > 0 ? cycleDurationMs : currentIntervalSeconds * 1000;
  let remainingMs = Math.max(0, totalMs - (Date.now() - cycleStartTime));
  try {
    // The alarm is the actual source of truth for when the auto-switch
    // fires; prefer it over the timer bar's own estimate when available.
    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (alarm && alarm.scheduledTime) remainingMs = Math.max(0, alarm.scheduledTime - Date.now());
  } catch (e) { /* keep the timer-bar-derived estimate */ }

  judgePausedRemainingMs = remainingMs;
  judgePausedTotalMs = totalMs;
  isJudgePaused = true;
  await chrome.alarms.clear(ALARM_NAME);
  stopTimerInterval();
  await pauseScrollingInTab(tabId);
  await refreshOverlayForTab(tabId, { showTimer: true, reviewMode: false });
}

async function resumeJudging(tabId) {
  if (!isExtensionRunning || isReviewModeActive || !isJudgePaused) return;
  isJudgePaused = false;
  const remainingMs = Math.max(500, judgePausedRemainingMs);
  const totalMs = Math.max(remainingMs, judgePausedTotalMs);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: remainingMs / 60000 });
  resumeTimerInterval(tabId, remainingMs, totalMs);
  try {
    const settings = await getSettings();
    if (settings.autoscroll) await resumeScrollingInTab(tabId);
  } catch (e) { /* ignore */ }
  await refreshOverlayForTab(tabId, { showTimer: true, reviewMode: false });
}

async function extendJudging(tabId, extraSeconds) {
  if (!isExtensionRunning || isReviewModeActive) return;
  const extraMs = Math.max(0, Number(extraSeconds) || 0) * 1000;
  if (!extraMs) return;

  if (isJudgePaused) {
    judgePausedRemainingMs += extraMs;
    judgePausedTotalMs += extraMs;
    return;
  }

  try {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    const remainingMs = alarm && alarm.scheduledTime ? Math.max(0, alarm.scheduledTime - Date.now()) : currentIntervalSeconds * 1000;
    await chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: (remainingMs + extraMs) / 60000 });
    extendTimerDuration(extraMs);
  } catch (e) { /* ignore */ }
}

// --- Switching tabs (alarm-driven "next", or manual prev/next) --------------

async function switchTab(direction, settings) {
  stopTimerInterval();
  const tabs = await updateAndGetTabOrder(currentWindowId);
  if (!tabs || tabs.length <= 1) { await stopCyclingLogic(true); await syncStatusWithPopup(); return; }

  const activeTabs = tabs.filter((t) => t.active);
  if (!activeTabs.length) { await stopCyclingLogic(true); await syncStatusWithPopup(); return; }
  const currentTab = activeTabs[0];
  const currentIndex = tabOrderMap.get(currentTab.id);
  if (currentIndex === undefined) { await stopCyclingLogic(true); await syncStatusWithPopup(); return; }

  const size = tabOrderMap.size;

  // Every site has now been shown once ("eerst alle 10 laten zien, daarna
  // pas review"): instead of wrapping back to site 1, move on to the
  // one-page review in this same window.
  if (direction !== 'prev' && currentIndex === size - 1 && isExtensionRunning && !isReviewModeActive) {
    await openFinalReview(activeTestId, { windowId: currentWindowId });
    return;
  }
  // Going back from site 1 during the viewing pass does nothing (there's no
  // "previous" yet); in a single-site recheck there's only one tab anyway.
  if (direction === 'prev' && currentIndex === 0 && isExtensionRunning) {
    await armJudgePeriod(currentTab.id, settings);
    return;
  }

  const nextIndex = direction === 'prev' ? (currentIndex - 1 + size) % size : (currentIndex + 1) % size;
  let nextTab = null;
  for (const [tabId, index] of tabOrderMap.entries()) {
    if (index === nextIndex) { nextTab = tabs.find((t) => t.id === tabId); break; }
  }
  if (!nextTab) { await stopCyclingLogic(true); await syncStatusWithPopup(); return; }

  const doRefresh = isReviewModeActive ? settings.reviewRefresh : settings.refresh;
  let didReload = false;
  if (doRefresh && nextTab.url && !isRestrictedUrl(nextTab.url)) {
    tabScrollStatusCache.set(nextTab.id, 'unknown');
    if (isReviewModeActive) {
      // Review mode has no countdown to protect — keep the original short,
      // fixed wait before scrolling back to the top.
      try { await chrome.tabs.reload(nextTab.id, { bypassCache: false }); await new Promise((r) => setTimeout(r, 300)); }
      catch (e) { /* ignore */ }
    } else {
      try { await chrome.tabs.reload(nextTab.id, { bypassCache: false }); didReload = true; }
      catch (e) { /* ignore */ }
    }
  } else if (!tabScrollStatusCache.has(nextTab.id)) {
    tabScrollStatusCache.set(nextTab.id, 'unknown');
  }

  try {
    clearPendingJudge();
    stopTimerInterval();
    selfInitiatedActivationTabId = nextTab.id;
    await chrome.tabs.update(nextTab.id, { active: true });

    if (isReviewModeActive) {
      await forceScrollTopInTab(nextTab.id);
      await refreshOverlayForTab(nextTab.id, { showTimer: false, reviewMode: true });
    } else {
      await refreshOverlayForTab(nextTab.id, { showTimer: false, reviewMode: false });
      // Waits for the page to finish loading (if it hasn't already) before
      // starting the countdown, the alarm and autoscroll — see
      // "Judging period" above.
      await armJudgePeriod(nextTab.id, settings, { forcedReload: didReload });
    }
  } catch (error) {
    console.error('BG_ERROR: failed to switch tab', error);
    await stopCyclingLogic(true);
    await syncStatusWithPopup();
  }
}

// --- Scrolling wrappers ------------------------------------------------------

async function startScrollingInTab(tabId, speed, delaySeconds = 0) {
  try {
    try { await chrome.tabs.get(tabId); } catch (e) { return; }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { command: 'startScroll', speed, delay: delaySeconds }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
  } catch (err) {
    tabScrollStatusCache.set(tabId, 'unscrollable');
    await refreshOverlayForTab(tabId, {});
  }
}
async function stopScrollingInTab(tabId) {
  try { await chrome.tabs.get(tabId); } catch (e) { return; }
  chrome.tabs.sendMessage(tabId, { command: 'stopScroll' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
}
async function pauseScrollingInTab(tabId) {
  try { await chrome.tabs.get(tabId); } catch (e) { return; }
  chrome.tabs.sendMessage(tabId, { command: 'pauseScroll' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
}
async function resumeScrollingInTab(tabId) {
  try { await chrome.tabs.get(tabId); } catch (e) { return; }
  chrome.tabs.sendMessage(tabId, { command: 'resumeScroll' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
}
async function forceScrollTopInTab(tabId) {
  try {
    try { await chrome.tabs.get(tabId); } catch (e) { return; }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { command: 'forceScrollTop' }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
  } catch (err) { /* ignore restricted pages */ }
}

// --- Rating overlay -----------------------------------------------------------

// Full recompute of what the overlay on `tabId` should show, using the
// current test/tab-order state, then sends it.
async function refreshOverlayForTab(tabId, overrides = {}) {
  const show = isExtensionRunning || isReviewModeActive;
  if (!show) { await sendOverlayUpdate(tabId, { show: false }); return; }

  // Whatever is in the active tab is "on screen" for the phone.
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
    if (active && active.id === tabId && tabSiteMap.has(tabId)) setPhoneCurrentSite(tabSiteMap.get(tabId));
  } catch (e) { /* ignore */ }
  const settings = await getSettings();

  const index = tabOrderMap.has(tabId) ? tabOrderMap.get(tabId) : null;
  const total = tabOrderMap.size || null;
  const siteId = tabSiteMap.get(tabId);
  const test = await getActiveTest();
  const site = test && siteId ? test.sites.find((s) => s.id === siteId) : null;
  const scrollStatus = tabScrollStatusCache.get(tabId) || 'unknown';
  const ratedCount = test ? GTE.ratedCount(test) : null;
  const siteTotal = test ? test.sites.length : null;

  await sendOverlayUpdate(tabId, {
    show: true,
    index: index !== null ? index + 1 : null,
    total,
    label: site ? site.label : null,
    rating: site ? site.rating : null,
    reviewMode: isReviewModeActive,
    viewingPhase: isViewingPhaseActive,
    ratedCount,
    siteTotal,
    scrollStatus,
    showTimer: isExtensionRunning && !isReviewModeActive,
    paused: isJudgePaused,
    testId: activeTestId,
    musicOn: !!settings.musicEnabled,
    phoneUrl: phoneTopic ? GTE.phoneUrl(phoneTopic, settings.phonePageUrl) : null,
    ...overrides
  });

  // Inject the overlay script/CSS so it's present even on pages that loaded
  // before the extension did (or before the content script matched).
  try {
    await chrome.tabs.get(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/qrcode.js', 'gte_data.js', 'tab_number_overlay.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['tab_number_overlay.css'] });
  } catch (e) { /* restricted page, ignore */ }
}

async function sendOverlayUpdate(tabId, payload) {
  try {
    chrome.tabs.sendMessage(tabId, { command: 'updateOverlay', ...payload }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
  } catch (e) { /* ignore */ }
}

// Rating a site only records the score — it deliberately does NOT advance
// to the next site. The client stays on the page until the judging period's
// own countdown runs out (or they use the prev/next arrows themselves), so
// clicking a number never feels like it "took the site away" mid-thought.
async function handleRating(tabId, rating) {
  if (isViewingPhaseActive) return; // rating only happens after the gut test, on the review page
  const siteId = tabSiteMap.get(tabId);
  if (!activeTestId || !siteId) return;
  const clamped = Math.max(1, Math.min(10, Math.round(rating)));
  await saveSiteRating(activeTestId, siteId, clamped);
  await refreshOverlayForTab(tabId, {});
}

// --- Sync with popup ----------------------------------------------------------

async function syncStatusWithPopup() {
  chrome.runtime.sendMessage({ command: 'syncButtonState', isRunning: isExtensionRunning, isReview: isReviewModeActive || isFinalReviewActive }, () => { if (chrome.runtime.lastError) {/* ignore */ } });
}

// --- Message listener -----------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    await ensureRestored();
    if (sender.id !== chrome.runtime.id) return;

    let success = false;
    let shouldSync = true;

    try {
      const senderPage = sender.url ? new URL(sender.url).pathname.replace(/^\//, '') : '';
      if (request.target === 'offscreen') {
        return; // meant for the offscreen document, not for us
      } else if (request.target === 'background' && senderPage === 'offscreen.html') {
        if (request.command === 'phoneMessage') await handlePhoneMessage(request);
        return;
      } else if (senderPage === 'intro.html') {
        if (request.command === 'start') {
          success = await startGutTest(request.testId, sender.tab || null);
        }
      } else if (senderPage === 'review.html') {
        shouldSync = false;
        switch (request.command) {
          case 'setRating':
            success = !!(await saveSiteRating(request.testId, request.siteId,
              request.rating === null ? null : Math.max(1, Math.min(10, Math.round(request.rating)))));
            break;
          case 'setNote':
            success = !!(await saveSiteNote(request.testId, request.siteId, request.key, request.value));
            break;
          case 'reviewFocus':
            if (isFinalReviewActive) await setPhoneCurrentSite(request.siteId);
            success = true;
            break;
          case 'reviewHeartbeat':
            if (isFinalReviewActive) await ensureSessionServices();
            success = true;
            break;
          case 'getSessionInfo': {
            const settings = await getSettings();
            const sessionForThisTest = isFinalReviewActive && activeTestId === request.testId;
            sendResponse({
              success: true,
              sessionActive: sessionForThisTest,
              musicOn: !!settings.musicEnabled,
              phoneUrl: sessionForThisTest && phoneTopic ? GTE.phoneUrl(phoneTopic, settings.phonePageUrl) : null
            });
            return;
          }
          case 'toggleMusic':
            sendResponse({ success: true, musicOn: await setMusicEnabled(!!request.on) });
            return;
          case 'finishReview':
            success = await finishFinalReview(request.testId);
            shouldSync = true;
            break;
          default:
            break;
        }
      } else if (senderPage === 'popup.html' || senderPage === 'manage.html' || senderPage === 'dashboard.html') {
        switch (request.command) {
          case 'openIntro':
            success = await openIntro(request.testId || activeTestId);
            shouldSync = false;
            break;
          case 'stop':
            success = await stopGutTest();
            break;
          case 'startReview':
            success = await openFinalReview(request.testId || activeTestId);
            break;
          case 'setMusicVolume':
            if (isSessionActive()) sendToOffscreen({ command: 'setVolume', volume: request.volume });
            success = true; shouldSync = false;
            break;
          case 'updateInterval':
            if (request.interval) currentIntervalSeconds = parseInt(request.interval, 10) || 20;
            success = true; shouldSync = false;
            break;
          case 'updateButtonState':
            await syncStatusWithPopup();
            success = true; shouldSync = false;
            break;
          case 'reviewSite':
            // "↻" button on a single dashboard row — reopen just that one
            // site for a quick recheck, without touching the rest of the
            // test's already-collected ratings.
            success = await openSingleSiteReview(request.testId, request.siteId);
            break;
          default:
            shouldSync = false;
        }
      } else if (sender.tab) {
        const tabId = sender.tab.id;
        if (request.command === 'updateScrollStatus') {
          tabScrollStatusCache.set(tabId, request.status || 'unknown');
          try {
            const activeTabs = await chrome.tabs.query({ active: true, windowId: currentWindowId });
            if (activeTabs.length > 0 && activeTabs[0].id === tabId) {
              await refreshOverlayForTab(tabId, {});
            }
          } catch (e) { /* ignore */ }
          if (sender.tab.favIconUrl && tabSiteMap.has(tabId) && activeTestId) {
            saveSiteFavicon(activeTestId, tabSiteMap.get(tabId), sender.tab.favIconUrl);
          }
          success = true; shouldSync = false;
        } else if (request.command === 'rateSite') {
          await handleRating(tabId, request.rating);
          success = true; shouldSync = false;
        } else if (request.command === 'manualStep') {
          const settings = await getSettings();
          await switchTab(request.direction === 'prev' ? 'prev' : 'next', settings);
          success = true; shouldSync = false;
        } else if (request.command === 'pauseJudging') {
          await pauseJudging(tabId);
          success = true; shouldSync = false;
        } else if (request.command === 'resumeJudging') {
          await resumeJudging(tabId);
          success = true; shouldSync = false;
        } else if (request.command === 'extendJudging') {
          await extendJudging(tabId, request.seconds || 10);
          success = true; shouldSync = false;
        } else if (request.command === 'captureScreenshot') {
          success = await captureScreenshotForTab(tabId);
          shouldSync = false;
        } else if (request.command === 'toggleMusic') {
          await setMusicEnabled(!!request.on);
          await refreshOverlayForTab(tabId, {});
          success = true; shouldSync = false;
        } else {
          shouldSync = false;
        }
      }

      if (typeof sendResponse === 'function') sendResponse({ success });
      if (shouldSync) await syncStatusWithPopup();
    } catch (error) {
      console.error(`BG_ERROR: error handling command ${request.command}:`, error);
      if (typeof sendResponse === 'function') { try { sendResponse({ success: false, error: error.message }); } catch (e) {} }
    }
  })();
  return true;
});

// --- Keyboard shortcut ---------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  await ensureRestored();
  if (command !== 'toggle-cycling') return;
  try {
    if (isSessionActive()) {
      await stopGutTest();
    } else if (activeTestId) {
      await openIntro(activeTestId);
    }
  } catch (error) {
    console.error('BG_ERROR: toggle command failed', error);
    await stopCyclingLogic(true);
  }
  await syncStatusWithPopup();
});

// --- Tab/window lifecycle ---------------------------------------------------

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await ensureRestored();
  const { tabId, windowId } = activeInfo;

  // Activations we triggered ourselves (via chrome.tabs.update in switchTab/
  // startGutTest) are already fully handled there — armJudgePeriod etc.
  // Reacting to them again here would race a second alarm/timer against the
  // first. Only genuinely external activations (the user clicking a tab in
  // Chrome's tab strip) fall through below.
  if (tabId === selfInitiatedActivationTabId) {
    selfInitiatedActivationTabId = null;
    return;
  }

  stopTimerInterval();
  if (windowId !== currentWindowId || !(isExtensionRunning || isReviewModeActive)) {
    await sendOverlayUpdate(tabId, { show: false });
    return;
  }
  await updateAndGetTabOrder(windowId);
  clearPendingJudge();

  if (isReviewModeActive) {
    const settings = await getSettings();
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (settings.reviewRefresh && tab.url && !isRestrictedUrl(tab.url)) {
      tabScrollStatusCache.set(tabId, 'unknown');
      try { await chrome.tabs.reload(tabId); await new Promise((r) => setTimeout(r, 1000)); } catch (e) { /* ignore */ }
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
    await forceScrollTopInTab(tabId);
    await refreshOverlayForTab(tabId, { showTimer: false, reviewMode: true });
  } else {
    await refreshOverlayForTab(tabId, { showTimer: false, reviewMode: false });
    const settings = await getSettings();
    await armJudgePeriod(tabId, settings);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureRestored();
  const isTrackedWindow = tab.windowId === currentWindowId;
  if (!isTrackedWindow || !(isExtensionRunning || isReviewModeActive)) return;

  if (changeInfo.status === 'loading' || changeInfo.url) {
    if (tab.active && isExtensionRunning && !isReviewModeActive) {
      stopTimerInterval();
      await chrome.alarms.clear(ALARM_NAME);
    }
    tabScrollStatusCache.set(tabId, 'unknown');
    await stopScrollingInTab(tabId);
    await refreshOverlayForTab(tabId, { showTimer: false });
  } else if (changeInfo.status === 'complete') {
    if (changeInfo.favIconUrl && tabSiteMap.has(tabId) && activeTestId) {
      saveSiteFavicon(activeTestId, tabSiteMap.get(tabId), changeInfo.favIconUrl);
    }
    if (!tab.active) return;
    if (isExtensionRunning && !isReviewModeActive) {
      // Either this is the tab armJudgePeriod is waiting on (normal case:
      // page finished loading, now start the countdown), or nothing is
      // pending and this is an independent reload of the current site (e.g.
      // the user hit F5 themselves) — either way, (re)start a fresh judging
      // period. A "complete" for some other, unrelated tab is ignored.
      if (pendingJudgeTabId === null || pendingJudgeTabId === tabId) {
        clearPendingJudge();
        const settings = await getSettings();
        await beginJudgingPeriod(tabId, settings);
      }
    } else if (isReviewModeActive) {
      await refreshOverlayForTab(tabId, { showTimer: false, reviewMode: true });
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureRestored();
  if (tabId === reviewTabId && isFinalReviewActive) {
    // Review page closed without pressing "Afronden" — still end the session
    // so the music and phone link don't keep running.
    console.log('BG_LOG: review tab closed — ending session.');
    await stopCyclingLogic(true);
    await syncStatusWithPopup();
    return;
  }
  if (!removeInfo.isWindowClosing && removeInfo.windowId === currentWindowId) {
    tabScrollStatusCache.delete(tabId);
    tabSiteMap.delete(tabId);
    if (tabOrderMap.has(tabId)) await updateAndGetTabOrder(removeInfo.windowId);
    if (tabId === startTabId) startTabId = null;
    if ((isExtensionRunning || isReviewModeActive) && tabOrderMap.size <= 1) {
      await stopCyclingLogic(true);
      await syncStatusWithPopup();
    } else {
      await persistSession();
    }
  } else if (!removeInfo.isWindowClosing && tabOrderMap.has(tabId)) {
    tabScrollStatusCache.delete(tabId);
    tabSiteMap.delete(tabId);
    tabOrderMap.delete(tabId);
  }
});

chrome.windows.onRemoved.addListener(async (closedWindowId) => {
  await ensureRestored();
  if (closedWindowId === currentWindowId) {
    console.log(`BG_LOG: Tracked window ${currentWindowId} closed.`);
    await stopCyclingLogic(true);
    await syncStatusWithPopup();
  }
});

// --- Utilities ----------------------------------------------------------

function isRestrictedUrl(url) {
  if (!url) return true;
  try {
    const p = new URL(url);
    if (['chrome:', 'chrome-extension:', 'about:', 'file:', 'edge:'].includes(p.protocol)) return true;
    if (p.hostname === 'chrome.google.com' && p.pathname.startsWith('/webstore')) return true;
  } catch (e) { return true; }
  return false;
}

async function updateAndGetTabOrder(windowId) {
  if (!windowId) { tabOrderMap.clear(); return null; }
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const valid = tabs.filter((t) => t.id !== undefined && t.id !== null).sort((a, b) => a.index - b.index);
    tabOrderMap = new Map();
    valid.forEach((t, i) => tabOrderMap.set(t.id, i));
    if (startTabId && !tabOrderMap.has(startTabId)) startTabId = null;
    return valid;
  } catch (e) {
    console.error(`BG_ERROR: failed to read tab order for window ${windowId}`, e);
    tabOrderMap.clear();
    if (windowId === currentWindowId) { currentWindowId = null; startTabId = null; }
    return null;
  }
}
