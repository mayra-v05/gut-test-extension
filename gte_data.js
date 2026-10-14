// Shared data helpers for the Gut Test Extension.
// Loaded as a plain classic script by background.js (importScripts) and by
// every extension page (popup, manage, dashboard) via <script src="gte_data.js">.
// Everything hangs off the global `GTE` object so it works the same way in
// both a service worker and a regular page, without needing ES module support.

(function (global) {
  const GTE = {};

  // --- Client language ---------------------------------------------------
  // The client picks NL or EN on the intro slide. Everything the client sees
  // (intro, overlay, review page, results, phone page) follows that choice;
  // the facilitator screens (popup, manage) stay Dutch.

  GTE.lang = 'nl';

  GTE.loadLang = async function loadLang() {
    try {
      const { clientLang } = await chrome.storage.local.get('clientLang');
      GTE.lang = clientLang === 'en' ? 'en' : 'nl';
    } catch (e) { /* keep current */ }
    return GTE.lang;
  };

  GTE.setLang = async function setLang(lang) {
    GTE.lang = lang === 'en' ? 'en' : 'nl';
    await chrome.storage.local.set({ clientLang: GTE.lang });
  };

  // GTE.t('Dutch text', 'English text') — picks the text for the current language.
  GTE.t = function t(nl, en) {
    return GTE.lang === 'en' ? en : nl;
  };

  GTE.locale = function locale() {
    return GTE.lang === 'en' ? 'en-GB' : 'nl-NL';
  };

  // Translated property of a NOTE_FIELDS entry: GTE.fieldText(field, 'label').
  GTE.fieldText = function fieldText(field, prop) {
    return (GTE.lang === 'en' && field[`${prop}En`]) || field[prop];
  };

  // --- IDs & formatting -----------------------------------------------

  GTE.generateId = function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  };

  GTE.formatDate = function formatDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleDateString(GTE.locale(), { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString(GTE.locale(), { hour: '2-digit', minute: '2-digit' });
  };

  // --- URL handling -----------------------------------------------------

  GTE.normalizeUrl = function normalizeUrl(raw) {
    let url = (raw || '').trim();
    if (!url) return null;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
      url = 'https://' + url;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.href;
    } catch (e) {
      return null;
    }
  };

  GTE.hostnameLabel = function hostnameLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  };

  // --- Structured per-site notes -----------------------------------------
  // Dashboard feedback is split into a few named angles instead of one
  // freeform box, so a client's "the color feels off" and "nice font" don't
  // get jumbled into a single note.
  GTE.NOTE_FIELDS = [
    { key: 'algemeen', label: 'Algemeen', short: 'Algemeen', placeholder: 'Algemene indruk… (meerdere zinnen kan gewoon)',
      labelEn: 'General', shortEn: 'General', placeholderEn: 'Overall impression… (multiple sentences are fine)' },
    { key: 'kleur', label: 'Kleurgebruik', short: 'Kleur', placeholder: 'Notitie over kleurgebruik…',
      labelEn: 'Use of color', shortEn: 'Color', placeholderEn: 'Note about the use of color…' },
    { key: 'typografie', label: 'Typografie / lettertype', short: 'Typografie', placeholder: 'Notitie over typografie / lettertype…',
      labelEn: 'Typography / font', shortEn: 'Typography', placeholderEn: 'Note about typography / font…' },
    { key: 'layout', label: 'Layout', short: 'Layout', placeholder: 'Notitie over layout / opbouw — wat zou de klant hier misschien niet fijn vinden?',
      labelEn: 'Layout', shortEn: 'Layout', placeholderEn: 'Note about layout / structure — what might not work for you here?' },
    // Filled from the client's phone (QR → phone page → relay → background),
    // kept apart from the fields the facilitator types in themselves.
    { key: 'telefoon', label: 'Telefoon-notities', short: 'Telefoon', placeholder: 'Notities die via de telefoon binnenkomen verschijnen hier…',
      labelEn: 'Phone notes', shortEn: 'Phone', placeholderEn: 'Notes sent from the phone appear here…' }
  ];

  // Returns a site's notes object, migrating the old single `note` string
  // (from before notes were split up) into the "algemeen" field on first read.
  GTE.getSiteNotes = function getSiteNotes(site) {
    const notes = { ...(site.notes || {}) };
    for (const field of GTE.NOTE_FIELDS) {
      if (typeof notes[field.key] !== 'string') notes[field.key] = '';
    }
    if (!notes.algemeen && site.note) notes.algemeen = site.note;
    return notes;
  };

  GTE.hasAnyNote = function hasAnyNote(site) {
    const notes = GTE.getSiteNotes(site);
    return GTE.NOTE_FIELDS.some((f) => notes[f.key] && notes[f.key].trim());
  };

  // --- Phone notes (QR) ------------------------------------------------------
  // The client scans a QR code and types notes on their own phone. There is
  // no server of our own: both sides talk through a public ntfy.sh topic with
  // a long random name (only someone with the QR can read/write it).
  //   <topic>    phone -> extension: the notes themselves
  //   <topic>-s  extension -> phone: which site is on screen right now
  // With a "telefoon-pagina" URL set in the popup (phone/index.html, hosted
  // anywhere static) the QR opens that page. Without it, the QR falls back
  // to ntfy's own web app for the same topic, where the client can still
  // type a message — it then lands on whichever site is on screen.
  GTE.PHONE_RELAY = 'https://ntfy.sh';

  GTE.randomToken = function randomToken(length) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  };

  // Returns the test's phone topic, creating (and saving) one on first use so
  // the same QR keeps working for the whole session and on a re-run.
  GTE.ensurePhoneTopic = async function ensurePhoneTopic(testId) {
    const { tests } = await GTE.getState();
    const test = tests[testId];
    if (!test) return null;
    if (!test.phoneTopic) {
      test.phoneTopic = `gte-${GTE.randomToken(22)}`;
      await GTE.saveTests(tests);
    }
    return test.phoneTopic;
  };

  GTE.phoneUrl = function phoneUrl(topic, phonePageUrl) {
    if (!topic) return null;
    const page = (phonePageUrl || '').trim();
    if (page) return `${page.replace(/#.*$/, '')}#${topic}`;
    return `${GTE.PHONE_RELAY}/${topic}`;
  };

  // Builds the QR as an <svg> purely with createElementNS — no innerHTML —
  // so it also works inside pages that enforce Trusted Types (the overlay
  // runs on arbitrary websites). Needs vendor/qrcode.js loaded.
  GTE.buildQrSvg = function buildQrSvg(text, doc) {
    const d = doc || document;
    const NS = 'http://www.w3.org/2000/svg';
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 2;
    const size = count + quiet * 2;
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    const svg = d.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = d.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(size));
    bg.setAttribute('height', String(size));
    bg.setAttribute('fill', '#ffffff');
    const fg = d.createElementNS(NS, 'path');
    fg.setAttribute('d', path);
    fg.setAttribute('fill', '#000000');
    svg.appendChild(bg);
    svg.appendChild(fg);
    return svg;
  };

  // Hero screenshots (taken automatically during the viewing pass) are
  // stored under their own key per site instead of inside `tests`, so the
  // tests object that's rewritten on every rating stays small.
  GTE.heroKey = function heroKey(siteId) { return `hero_${siteId}`; };

  // Screenshots captured via the on-page overlay's 📷 button. Each entry is
  // { id, dataUrl, takenAt }. Stored resized/compressed (see background.js)
  // so a handful per site stays well within chrome.storage.local's limits.
  GTE.getSiteScreenshots = function getSiteScreenshots(site) {
    return Array.isArray(site.screenshots) ? site.screenshots : [];
  };

  // Parses the textarea input used in manage.html.
  // Accepts one entry per line, either "https://example.com" or
  // "Label | https://example.com" (label optional, separated by | or ; or tab).
  GTE.parseSitesInput = function parseSitesInput(text) {
    const lines = (text || '').split('\n');
    const sites = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s*[|;\t]\s*/);
      let label = null;
      let urlPart = line;
      if (parts.length >= 2) {
        // Whichever part parses as a URL is the url; the other is the label.
        const maybeUrl0 = GTE.normalizeUrl(parts[parts.length - 1]);
        if (maybeUrl0) {
          urlPart = parts[parts.length - 1];
          label = parts.slice(0, -1).join(' | ').trim() || null;
        }
      }
      const url = GTE.normalizeUrl(urlPart);
      if (!url) continue;
      sites.push({
        id: GTE.generateId(),
        url,
        label: label || GTE.hostnameLabel(url),
        rating: null,
        note: '',
        notes: {},
        screenshots: [],
        ratedAt: null,
        favicon: null
      });
    }
    return sites;
  };

  // Reverse of parseSitesInput, used to prefill the edit textarea.
  GTE.sitesToText = function sitesToText(sites) {
    return (sites || []).map((s) => {
      const defaultLabel = GTE.hostnameLabel(s.url);
      if (s.label && s.label !== defaultLabel) return `${s.label} | ${s.url}`;
      return s.url;
    }).join('\n');
  };

  // --- Storage ------------------------------------------------------------

  GTE.getState = async function getState() {
    const data = await chrome.storage.local.get(['tests', 'activeTestId']);
    return { tests: data.tests || {}, activeTestId: data.activeTestId || null };
  };

  GTE.saveTests = async function saveTests(tests) {
    await chrome.storage.local.set({ tests });
  };

  GTE.setActiveTestId = async function setActiveTestId(id) {
    await chrome.storage.local.set({ activeTestId: id });
  };

  GTE.getTest = async function getTest(id) {
    const { tests } = await GTE.getState();
    return tests[id] || null;
  };

  GTE.createTest = function createTest(name, sitesInputText) {
    const now = Date.now();
    return {
      id: GTE.generateId(),
      name: (name || '').trim() || 'Naamloze test',
      createdAt: now,
      updatedAt: now,
      sites: GTE.parseSitesInput(sitesInputText)
    };
  };

  // Updates an existing test's name/site list from fresh form input while
  // preserving ratings/notes for URLs that are unchanged.
  GTE.updateTestSites = function updateTestSites(test, name, sitesInputText) {
    const previousByUrl = new Map((test.sites || []).map((s) => [s.url, s]));
    const newSites = GTE.parseSitesInput(sitesInputText).map((s) => {
      const prev = previousByUrl.get(s.url);
      if (prev) {
        return { ...s, id: prev.id, rating: prev.rating, note: prev.note, notes: prev.notes || {}, screenshots: prev.screenshots || [], ratedAt: prev.ratedAt, favicon: prev.favicon };
      }
      return s;
    });
    return { ...test, name: (name || '').trim() || test.name, sites: newSites, updatedAt: Date.now() };
  };

  GTE.duplicateTest = function duplicateTest(test, newName) {
    const now = Date.now();
    return {
      id: GTE.generateId(),
      name: newName || `${test.name} (kopie)`,
      createdAt: now,
      updatedAt: now,
      sites: (test.sites || []).map((s) => ({
        id: GTE.generateId(),
        url: s.url,
        label: s.label,
        rating: null,
        note: '',
        notes: {},
        screenshots: [],
        ratedAt: null,
        favicon: s.favicon || null
      }))
    };
  };

  GTE.ratedCount = function ratedCount(test) {
    return (test.sites || []).filter((s) => typeof s.rating === 'number').length;
  };

  GTE.averageRating = function averageRating(test) {
    const rated = (test.sites || []).filter((s) => typeof s.rating === 'number');
    if (!rated.length) return null;
    return rated.reduce((sum, s) => sum + s.rating, 0) / rated.length;
  };

  // Ranked copy of a test's sites: rated sites first (highest score first),
  // unrated sites after, in their original order.
  GTE.rankedSites = function rankedSites(test) {
    const sites = (test.sites || []).map((s, i) => ({ ...s, originalIndex: i }));
    const rated = sites.filter((s) => typeof s.rating === 'number')
      .sort((a, b) => b.rating - a.rating || a.originalIndex - b.originalIndex);
    const unrated = sites.filter((s) => typeof s.rating !== 'number');
    return rated.concat(unrated);
  };

  GTE.toCSV = function toCSV(test) {
    const rows = [['Rang', 'Site', 'URL', 'Score (1-10)', ...GTE.NOTE_FIELDS.map((f) => f.label)]];
    GTE.rankedSites(test).forEach((s, i) => {
      const notes = GTE.getSiteNotes(s);
      rows.push([
        typeof s.rating === 'number' ? String(i + 1) : '',
        s.label || '',
        s.url || '',
        typeof s.rating === 'number' ? String(s.rating) : '',
        ...GTE.NOTE_FIELDS.map((f) => notes[f.key] || '')
      ]);
    });
    return rows.map((row) => row.map((cell) => {
      const str = String(cell ?? '');
      return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')).join('\n');
  };

  global.GTE = GTE;
})(typeof self !== 'undefined' ? self : this);
