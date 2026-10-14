// Gut Test Extension — on-page overlay.
//
// Two parts, both shown while a test is running (or during a single-site
// recheck):
//  - A progress bar at the top center of the screen: "Website 3 van 10",
//    one segment per site, and the current site's segment fills up with the
//    countdown — so it's obvious at a glance where in the test you are and
//    how long this site stays on screen.
//  - A wide control bar at the bottom center with the site's label,
//    prev/next arrows, screenshot / phone-QR / music buttons and the
//    pause / +10s controls. Rating buttons only appear outside the viewing
//    pass (a single-site recheck from the dashboard): during the gut test
//    itself the client only looks — rating happens afterwards on the review
//    page.
(() => {
  // Background re-injects this file via chrome.scripting.executeScript on
  // almost every overlay update, as a safety net for tabs whose automatic
  // content-script injection hasn't happened yet. Without this guard each
  // re-injection would be a *fresh* script execution — re-creating the
  // overlay and, worse, adding another copy of the window-level keydown/
  // message listeners below, so a single keypress would fire multiple
  // ratings. Once this file has fully run once for a document, every later
  // injection becomes a no-op.
  if (window.__gteRatingOverlayLoaded) return;
  window.__gteRatingOverlayLoaded = true;

  // Texts follow the language the client picked on the intro slide.
  const T = (nl, en) => (typeof GTE !== 'undefined' ? GTE.t(nl, en) : nl);
  let builtLang = null;
  if (typeof GTE !== 'undefined') {
    GTE.loadLang();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.clientLang) GTE.lang = changes.clientLang.newValue === 'en' ? 'en' : 'nl';
    });
  }

  const OVERLAY_ID = 'gte-rating-overlay';
  const PROGRESS_ID = 'gte-progress-top';
  const RATING_MIN = 1;
  const RATING_MAX = 10;

  // Sequential single-hue (blue) ramp — lightest for a low score, darkest for
  // a high score. Matches the dataviz palette's sequential blue steps.
  const BLUE_LOW = [158, 197, 244];   // ~ step 200 (#9ec5f4)
  const BLUE_HIGH = [24, 79, 149];    // ~ step 600 (#184f95)

  function ratingColor(value) {
    const t = (value - RATING_MIN) / (RATING_MAX - RATING_MIN);
    const rgb = BLUE_LOW.map((c, i) => Math.round(c + (BLUE_HIGH[i] - c) * t));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, title, onClick) {
    const btn = el('button', className, text);
    btn.type = 'button';
    if (title) btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  let els = null; // lazily-built element references
  let currentRating = null;
  let isPaused = false;
  let musicOn = true;
  let phoneUrl = null;
  let renderedQrFor = null;

  function build() {
    // --- Top progress bar ---
    const top = el('div');
    top.id = PROGRESS_ID;
    const topRow = el('div', 'gte-top-row');
    const phase = el('span', 'gte-phase');
    const count = el('span', 'gte-count');
    const topLabel = el('span', 'gte-top-label');
    const countdown = el('span', 'gte-countdown');
    topRow.append(phase, count, topLabel, countdown);
    const segments = el('div', 'gte-segments');
    top.append(topRow, segments);

    // --- Bottom-right panel ---
    const root = el('div');
    root.id = OVERLAY_ID;

    const header = el('div', 'gte-header');
    const navPrev = button('gte-nav', '‹', T('Vorige site', 'Previous site'), () => sendStep('prev'));
    const info = el('div', 'gte-info');
    const label = el('span', 'gte-label');
    const dot = el('span', 'gte-dot');
    info.append(label, dot);
    const navNext = button('gte-nav', '›', T('Volgende site', 'Next site'), () => sendStep('next'));
    const ratingCaption = el('div', 'gte-rating-caption', T('Cijfer', 'Score'));
    const ratingRow = el('div', 'gte-rating-row');
    const buttons = [];
    for (let v = RATING_MIN; v <= RATING_MAX; v++) {
      const btn = button('gte-rating-btn', String(v), T(`Geef een ${v}`, `Give a ${v}`), () => sendRating(v));
      btn.dataset.value = String(v);
      ratingRow.appendChild(btn);
      buttons.push(btn);
    }

    const toolbar = el('div', 'gte-toolbar');
    const screenshotBtn = button('gte-toolbar-btn', '📷 Screenshot', T('Sla een screenshot van deze site op — te zien in het dashboard', 'Save a screenshot of this site — shown in the dashboard'), async () => {
      if (screenshotBtn.disabled) return;
      screenshotBtn.disabled = true;
      let ok = false;
      try {
        const res = await chrome.runtime.sendMessage({ command: 'captureScreenshot' });
        ok = !!(res && res.success);
      } catch (e) { ok = false; }
      screenshotBtn.textContent = ok ? T('✓ Opgeslagen', '✓ Saved') : T('⚠ Mislukt', '⚠ Failed');
      setTimeout(() => { screenshotBtn.textContent = '📷 Screenshot'; screenshotBtn.disabled = false; }, 1400);
    });
    const phoneBtn = button('gte-toolbar-btn gte-phone-btn', T('📱 Telefoon', '📱 Phone'), T('Notities maken op je telefoon (QR-code)', 'Take notes on your phone (QR code)'), () => {
      root.classList.toggle('show-qr');
      renderQr();
    });
    const musicBtn = button('gte-toolbar-btn gte-music-btn', T('🎵 Muziek', '🎵 Music'), T('Achtergrondmuziek aan/uit', 'Background music on/off'), () => {
      musicOn = !musicOn;
      musicBtn.classList.toggle('off', !musicOn);
      chrome.runtime.sendMessage({ command: 'toggleMusic', on: musicOn }).catch(() => {});
    });
    toolbar.append(screenshotBtn, phoneBtn, musicBtn);

    const qrPanel = el('div', 'gte-qr-panel');
    const qrBox = el('div', 'gte-qr-box');
    const qrText = el('div', 'gte-qr-text', T('Scan met je telefoon en typ je notities daar. Ze komen vanzelf bij de site die op dat moment in beeld is.', 'Scan with your phone and type your notes there. They are automatically added to the site on screen at that moment.'));
    qrPanel.append(qrBox, qrText);

    const timerControls = el('div', 'gte-timer-controls');
    const pauseBtn = button('gte-timer-btn gte-pause-btn', T('⏸ Pauze', '⏸ Pause'), T('Klok stilzetten', 'Pause the timer'), () => {
      chrome.runtime.sendMessage({ command: isPaused ? 'resumeJudging' : 'pauseJudging' }).catch(() => {});
    });
    const extendBtn = button('gte-timer-btn', '+10s', T('Geef 10 seconden extra tijd voor deze site', 'Give 10 extra seconds for this site'), () => {
      chrome.runtime.sendMessage({ command: 'extendJudging', seconds: 10 }).catch(() => {});
    });
    timerControls.append(pauseBtn, extendBtn);

    const hint = el('div', 'gte-hint', T('← → = wissel site', '← → = switch site'));
    const toast = el('div', 'gte-toast');

    // One wide bar: ‹ label | tools | pause/+10s ›
    header.append(navPrev, info, toolbar, timerControls, navNext);
    const ratingBlock = el('div', 'gte-rating-block');
    ratingBlock.append(ratingCaption, ratingRow);

    root.append(qrPanel, header, ratingBlock, hint, toast);
    document.documentElement.append(top, root);

    builtLang = typeof GTE !== 'undefined' ? GTE.lang : null;
    els = { top, phase, count, topLabel, countdown, segments, root, label, dot, buttons, hint, phoneBtn, musicBtn, qrBox, pauseBtn, toast };
  }

  function remove() {
    if (els) { els.root.remove(); els.top.remove(); els = null; }
    currentRating = null;
    renderedQrFor = null;
  }

  function ensureBuilt() {
    // Some single-page sites wipe <html>'s children on navigation — rebuild if so.
    if (els && (!els.root.isConnected || !els.top.isConnected)) remove();
    // Language changed since the overlay was built — rebuild it in the new language.
    if (els && typeof GTE !== 'undefined' && builtLang !== GTE.lang) remove();
    if (!els) build();
  }

  function renderQr() {
    if (!els || !phoneUrl || renderedQrFor === phoneUrl) return;
    els.qrBox.replaceChildren();
    try {
      els.qrBox.appendChild(GTE.buildQrSvg(phoneUrl));
      renderedQrFor = phoneUrl;
    } catch (e) {
      els.qrBox.textContent = T('QR niet beschikbaar', 'QR not available');
    }
  }

  function renderSegments(data) {
    const total = data.total || data.siteTotal || 0;
    const seg = els.segments;
    if (seg.childElementCount !== total) {
      seg.replaceChildren();
      for (let i = 0; i < total; i++) {
        const s = el('div', 'gte-seg');
        s.appendChild(el('div', 'gte-seg-fill'));
        seg.appendChild(s);
      }
    }
    Array.from(seg.children).forEach((s, i) => {
      const n = i + 1;
      s.classList.toggle('done', !!data.index && n < data.index);
      s.classList.toggle('current', n === data.index);
      if (n !== data.index) s.firstChild.style.width = '';
    });
  }

  function render(data) {
    if (!data.show) { remove(); return; }
    ensureBuilt();

    const viewing = !!data.viewingPhase && !data.reviewMode;
    els.phase.textContent = viewing ? T('Bekijken', 'Viewing') : T('Opnieuw bekijken', 'Viewing again');
    els.count.textContent = (data.index && data.total) ? T(`Website ${data.index} van ${data.total}`, `Website ${data.index} of ${data.total}`) : '';
    els.topLabel.textContent = data.label || '';
    els.top.classList.toggle('single', !viewing && data.total === 1);
    renderSegments(data);

    els.label.textContent = data.label || '';
    els.dot.className = `gte-dot status-${data.scrollStatus || 'unknown'}`;
    // No rating during the gut test itself — only afterwards.
    els.root.classList.toggle('can-rate', !viewing);
    els.hint.textContent = viewing ? T('← → = wissel site · beoordelen doe je na de test', '← → = switch site · you rate after the test') : T('Toets 1-9, 0 = cijfer · ← → = wissel site', 'Keys 1-9, 0 = score · ← → = switch site');

    currentRating = typeof data.rating === 'number' ? data.rating : null;
    els.buttons.forEach((btn) => {
      const v = Number(btn.dataset.value);
      const selected = v === currentRating;
      btn.classList.toggle('selected', selected);
      btn.style.background = selected ? ratingColor(v) : '';
      btn.style.color = selected ? '#fff' : '';
    });

    const showTimer = !!data.showTimer;
    els.top.classList.toggle('show-timer', showTimer);
    els.root.classList.toggle('show-timer', showTimer);
    if (!showTimer) els.countdown.textContent = '';

    isPaused = !!data.paused;
    els.top.classList.toggle('gte-paused', isPaused);
    els.root.classList.toggle('gte-paused', isPaused);
    els.pauseBtn.textContent = isPaused ? T('▶ Hervat', '▶ Resume') : T('⏸ Pauze', '⏸ Pause');
    if (isPaused) els.countdown.textContent = T('Gepauzeerd', 'Paused');

    if (typeof data.musicOn === 'boolean') {
      musicOn = data.musicOn;
      els.musicBtn.classList.toggle('off', !musicOn);
    }

    phoneUrl = data.phoneUrl || null;
    els.phoneBtn.hidden = !phoneUrl;
    if (!phoneUrl) els.root.classList.remove('show-qr');
    else if (els.root.classList.contains('show-qr')) renderQr();
  }

  function updateTimer(progress, remainingSec) {
    if (!els || !els.top.classList.contains('show-timer')) return;
    const current = els.segments.querySelector('.gte-seg.current .gte-seg-fill');
    if (current) current.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    if (!isPaused && typeof remainingSec === 'number') {
      els.countdown.textContent = T(`nog ${remainingSec}s`, `${remainingSec}s left`);
    }
  }

  let toastTimer = null;
  function showToast(text) {
    if (!els) return;
    els.toast.textContent = text;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (els) els.toast.classList.remove('show'); }, 3200);
  }

  function sendRating(value) {
    if (!els || !els.root.classList.contains('can-rate')) return;
    chrome.runtime.sendMessage({ command: 'rateSite', rating: value }).catch(() => {});
  }
  function sendStep(direction) {
    if (!els) return;
    chrome.runtime.sendMessage({ command: 'manualStep', direction }).catch(() => {});
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  window.addEventListener('keydown', (e) => {
    if (!els || isTypingTarget(e.target)) return;
    if (e.key === 'ArrowLeft') { sendStep('prev'); return; }
    if (e.key === 'ArrowRight') { sendStep('next'); return; }
    if (/^[0-9]$/.test(e.key)) {
      const value = e.key === '0' ? 10 : Number(e.key);
      sendRating(value);
    }
  }, { capture: true });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    switch (request.command) {
      case 'updateOverlay':
        render(request);
        if (typeof sendResponse === 'function') sendResponse({ status: 'updated' });
        return false;
      case 'updateTimer':
        if (request.progress !== undefined) updateTimer(request.progress, request.remainingSec);
        return false;
      case 'phoneNoteToast':
        showToast(`${T('📱 Notitie ontvangen', '📱 Note received')}${request.label ? ` · ${request.label}` : ''}`);
        return false;
      case 'hideForCapture':
        // Screenshots should show the site, not our overlay. Answer once the
        // hidden state has actually been painted.
        if (els) { els.root.style.visibility = 'hidden'; els.top.style.visibility = 'hidden'; }
        requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ hidden: true })));
        setTimeout(() => sendResponse({ hidden: true }), 150);
        return true;
      case 'showAfterCapture':
        if (els) { els.root.style.visibility = ''; els.top.style.visibility = ''; }
        return false;
      default:
        return false;
    }
  });

  window.addEventListener('beforeunload', () => { remove(); });
})();
