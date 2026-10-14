const testSelect = document.getElementById('testSelect');
const exportBtn = document.getElementById('exportBtn');
const manageBtn = document.getElementById('manageBtn');
const emptyStateEl = document.getElementById('emptyState');
const contentEl = document.getElementById('content');
const testTitle = document.getElementById('testTitle');
const testDate = document.getElementById('testDate');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const rankedListEl = document.getElementById('rankedList');
const sectionUnrated = document.getElementById('sectionUnrated');
const unratedListEl = document.getElementById('unratedList');

const BLUE_LOW = [158, 197, 244];
const BLUE_HIGH = [24, 79, 149];
function ratingColor(value) {
  const t = (value - 1) / 9;
  const rgb = BLUE_LOW.map((c, i) => Math.round(c + (BLUE_HIGH[i] - c) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

let currentTestId = null;

// Static texts from dashboard.html, in the language the client picked.
function applyStaticTexts() {
  const t = GTE.t;
  document.documentElement.lang = GTE.lang;
  exportBtn.textContent = t('Exporteer CSV', 'Export CSV');
  manageBtn.textContent = t('Tests beheren', 'Manage tests');
  emptyStateEl.textContent = t('Nog geen tests met resultaten. Maak er eerst een aan via "Tests beheren".', 'No tests with results yet. Create one first via "Manage tests".');
  document.getElementById('unratedTitle').textContent = t('Nog niet beoordeeld', 'Not rated yet');
}

document.addEventListener('DOMContentLoaded', async () => {
  await GTE.loadLang();
  applyStaticTexts();
  const params = new URLSearchParams(location.search);
  const requestedId = params.get('test');
  await populateTestSelect(requestedId);
  await renderDashboard();
});

testSelect.addEventListener('change', async () => {
  currentTestId = testSelect.value;
  await renderDashboard();
});

manageBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
});

exportBtn.addEventListener('click', async () => {
  const test = await GTE.getTest(currentTestId);
  if (!test) return;
  const csv = GTE.toCSV(test);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gut-test-${test.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

async function populateTestSelect(requestedId) {
  const { tests, activeTestId } = await GTE.getState();
  const list = Object.values(tests).sort((a, b) => b.updatedAt - a.updatedAt);
  testSelect.innerHTML = '';
  if (list.length === 0) {
    emptyStateEl.hidden = false;
    contentEl.hidden = true;
    return;
  }
  for (const test of list) {
    const opt = document.createElement('option');
    opt.value = test.id;
    opt.textContent = test.name;
    testSelect.appendChild(opt);
  }
  const initial = (requestedId && tests[requestedId]) ? requestedId
    : (activeTestId && tests[activeTestId]) ? activeTestId
    : list[0].id;
  testSelect.value = initial;
  currentTestId = initial;
}

async function renderDashboard() {
  const test = await GTE.getTest(currentTestId);
  if (!test) { emptyStateEl.hidden = false; contentEl.hidden = true; return; }
  emptyStateEl.hidden = true;
  contentEl.hidden = false;

  testTitle.textContent = test.name;
  testDate.textContent = `${GTE.t('Aangemaakt', 'Created')} ${GTE.formatDate(test.createdAt)}`;

  const rated = GTE.ratedCount(test);
  const total = test.sites.length;
  progressFill.style.width = total ? `${(rated / total) * 100}%` : '0%';
  progressLabel.textContent = GTE.t(`${rated} / ${total} beoordeeld`, `${rated} / ${total} rated`);

  const ranked = GTE.rankedSites(test);
  const ratedSites = ranked.filter((s) => typeof s.rating === 'number');
  const unratedSites = ranked.filter((s) => typeof s.rating !== 'number');

  rankedListEl.innerHTML = '';
  ratedSites.forEach((site, i) => renderRow(rankedListEl, site, i + 1, test.id));

  sectionUnrated.hidden = unratedSites.length === 0;
  unratedListEl.innerHTML = '';
  unratedSites.forEach((site) => renderRow(unratedListEl, site, null, test.id));
}

function renderRow(container, site, rank, testId) {
  const row = document.createElement('div');
  row.className = 'gte-card gte-rank-row' + (rank ? '' : ' unrated');

  const rankEl = document.createElement('div');
  rankEl.className = 'gte-rank-number';
  rankEl.textContent = rank ? `#${rank}` : '—';

  const favicon = document.createElement('img');
  favicon.className = 'gte-favicon';
  favicon.src = site.favicon || 'icons/icon16.png';
  favicon.onerror = () => { favicon.style.visibility = 'hidden'; };

  const info = document.createElement('a');
  info.className = 'gte-site-info';
  info.href = site.url;
  info.target = '_blank';
  info.rel = 'noopener noreferrer';
  info.title = GTE.t(`Open ${site.url} in een nieuw tabblad`, `Open ${site.url} in a new tab`);
  const labelEl = document.createElement('div');
  labelEl.className = 'gte-site-label';
  labelEl.textContent = site.label;
  const linkIcon = document.createElement('span');
  linkIcon.className = 'gte-link-icon';
  linkIcon.textContent = ' ↗';
  labelEl.appendChild(linkIcon);
  const urlEl = document.createElement('div');
  urlEl.className = 'gte-site-url';
  urlEl.textContent = site.url;
  info.appendChild(labelEl);
  info.appendChild(urlEl);

  const barTrack = document.createElement('div');
  barTrack.className = 'gte-bar-track';
  const barFill = document.createElement('div');
  barFill.className = 'gte-bar-fill';
  if (typeof site.rating === 'number') {
    barFill.style.width = `${(site.rating / 10) * 100}%`;
    barFill.style.background = ratingColor(site.rating);
  } else {
    barFill.style.width = '0%';
  }
  barTrack.appendChild(barFill);

  const ratingValue = document.createElement('div');
  ratingValue.className = 'gte-rating-value';
  ratingValue.textContent = typeof site.rating === 'number' ? site.rating : '–';

  // "Wacht, die site wil ik nog een keer bekijken" — reopens just this one
  // site (review-mode style: no countdown, manual only) so its rating can
  // be updated without touching the rest of the test.
  const recheckBtn = document.createElement('button');
  recheckBtn.type = 'button';
  recheckBtn.className = 'gte-btn gte-btn-ghost gte-btn-sm gte-recheck-btn';
  recheckBtn.textContent = '↻';
  recheckBtn.title = GTE.t('Deze site nogmaals bekijken (los van de rest van de test)', 'View this site again (separately from the rest of the test)');
  recheckBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'reviewSite', testId, siteId: site.id }).catch(() => {});
  });

  // Single "Notitie toevoegen" toggle that opens a dropdown panel with one
  // textarea per category (Algemeen / Kleur / Typografie / Layout / Telefoon), plus
  // any screenshots captured for this site via the overlay's 📷 button.
  const notes = GTE.getSiteNotes(site);
  let currentScreenshots = GTE.getSiteScreenshots(site);

  const notesPanel = document.createElement('div');
  notesPanel.className = 'gte-notes-panel';

  const screenshotsSection = document.createElement('div');
  screenshotsSection.className = 'gte-note-field gte-screenshots-section';
  const screenshotsLabel = document.createElement('label');
  screenshotsLabel.className = 'gte-label';
  screenshotsLabel.textContent = 'Screenshots';
  const screenshotsRow = document.createElement('div');
  screenshotsRow.className = 'gte-screenshots-row';

  function renderScreenshots() {
    screenshotsRow.innerHTML = '';
    if (!currentScreenshots.length) {
      const empty = document.createElement('div');
      empty.className = 'gte-screenshot-empty';
      empty.textContent = GTE.t('Nog geen screenshot — gebruik de 📷-knop op de site zelf tijdens de test.', 'No screenshot yet — use the 📷 button on the site itself during the test.');
      screenshotsRow.appendChild(empty);
      return;
    }
    currentScreenshots.forEach((shot) => {
      const thumb = document.createElement('div');
      thumb.className = 'gte-screenshot-thumb';
      const img = document.createElement('img');
      img.src = shot.dataUrl;
      img.title = GTE.formatDate(shot.takenAt);
      img.addEventListener('click', () => {
        chrome.tabs.create({ url: shot.dataUrl });
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'gte-screenshot-remove';
      removeBtn.textContent = '×';
      removeBtn.title = GTE.t('Screenshot verwijderen', 'Delete screenshot');
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { tests } = await GTE.getState();
        const t = tests[testId];
        if (!t) return;
        const s = t.sites.find((x) => x.id === site.id);
        if (!s) return;
        s.screenshots = GTE.getSiteScreenshots(s).filter((sh) => sh.id !== shot.id);
        t.updatedAt = Date.now();
        await GTE.saveTests(tests);
        currentScreenshots = s.screenshots;
        renderScreenshots();
        updateNotesToggleLabel();
      });
      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      screenshotsRow.appendChild(thumb);
    });
  }
  renderScreenshots();
  screenshotsSection.appendChild(screenshotsLabel);
  screenshotsSection.appendChild(screenshotsRow);
  notesPanel.appendChild(screenshotsSection);

  const fieldInputs = {};
  GTE.NOTE_FIELDS.forEach((field) => {
    const wrap = document.createElement('div');
    wrap.className = 'gte-note-field';
    const label = document.createElement('label');
    label.className = 'gte-label';
    label.textContent = GTE.fieldText(field, 'label');
    const input = document.createElement('textarea');
    input.className = 'gte-input gte-note-textarea';
    input.placeholder = GTE.fieldText(field, 'placeholder');
    input.value = notes[field.key] || '';
    input.rows = 3;
    input.addEventListener('change', async () => {
      const { tests } = await GTE.getState();
      const t = tests[testId];
      if (!t) return;
      const s = t.sites.find((x) => x.id === site.id);
      if (!s) return;
      const updatedNotes = GTE.getSiteNotes(s);
      updatedNotes[field.key] = input.value;
      s.notes = updatedNotes;
      if (field.key === 'algemeen') s.note = input.value; // keep legacy field mirrored, just in case
      t.updatedAt = Date.now();
      await GTE.saveTests(tests);
      updateNotesToggleLabel();
    });
    fieldInputs[field.key] = input;
    wrap.appendChild(label);
    wrap.appendChild(input);
    notesPanel.appendChild(wrap);
  });

  const notesToggle = document.createElement('button');
  notesToggle.type = 'button';
  notesToggle.className = 'gte-btn gte-btn-ghost gte-btn-sm gte-notes-toggle';
  function updateNotesToggleLabel() {
    const noteCount = GTE.NOTE_FIELDS.filter((f) => fieldInputs[f.key].value.trim()).length;
    const shotCount = currentScreenshots.length;
    const parts = [];
    if (noteCount > 0) parts.push(GTE.t(`${noteCount} notitie${noteCount > 1 ? 's' : ''}`, `${noteCount} note${noteCount > 1 ? 's' : ''}`));
    if (shotCount > 0) parts.push(`${shotCount} 📷`);
    notesToggle.textContent = parts.length ? `📝 ${parts.join(' · ')}` : GTE.t('📝 Notitie toevoegen', '📝 Add note');
  }
  updateNotesToggleLabel();
  notesToggle.addEventListener('click', () => { group.classList.toggle('notes-open'); });

  row.appendChild(rankEl);
  row.appendChild(favicon);
  row.appendChild(info);
  row.appendChild(barTrack);
  row.appendChild(ratingValue);
  row.appendChild(recheckBtn);
  row.appendChild(notesToggle);

  const group = document.createElement('div');
  group.className = 'gte-row-group';
  group.dataset.siteId = site.id;
  group.appendChild(row);

  // Phone notes are the client's own words — show them right under the
  // row instead of only inside the collapsed notes panel.
  const phoneLines = (notes.telefoon || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (phoneLines.length) {
    const phone = document.createElement('div');
    phone.className = 'gte-phone-inline';
    const title = document.createElement('div');
    title.className = 'gte-phone-inline-title';
    title.textContent = GTE.t('📱 Van de telefoon', '📱 From the phone');
    phone.appendChild(title);
    phoneLines.forEach((line) => {
      const p = document.createElement('div');
      p.className = 'gte-phone-inline-line';
      const m = line.match(/^\[(\d{1,2}:\d{2})\]\s*(.*)$/);
      if (m) {
        const time = document.createElement('span');
        time.textContent = m[1];
        p.append(time, document.createTextNode(m[2]));
      } else {
        p.textContent = line;
      }
      phone.appendChild(p);
    });
    group.appendChild(phone);
  }

  group.appendChild(notesPanel);
  container.appendChild(group);
}

// Keep the dashboard current while a test is still running or being
// reviewed (ratings and phone notes arrive in the background). Skipped while
// someone is typing in a note so their text isn't thrown away; open note
// panels stay open.
let rerenderTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tests) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(async () => {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    const open = new Set([...document.querySelectorAll('.gte-row-group.notes-open')].map((g) => g.dataset.siteId));
    await renderDashboard();
    document.querySelectorAll('.gte-row-group').forEach((g) => { if (open.has(g.dataset.siteId)) g.classList.add('notes-open'); });
  }, 300);
});
