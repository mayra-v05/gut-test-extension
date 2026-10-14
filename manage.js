const testNameInput = document.getElementById('testName');
const sitesInput = document.getElementById('sitesInput');
const formTitle = document.getElementById('formTitle');
const saveTestBtn = document.getElementById('saveTestBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const testListEl = document.getElementById('testList');
const emptyStateEl = document.getElementById('emptyState');
const goPopupHint = document.getElementById('goPopupHint');

let editingTestId = null;

goPopupHint.addEventListener('click', () => window.close());

document.addEventListener('DOMContentLoaded', renderList);

saveTestBtn.addEventListener('click', async () => {
  const name = testNameInput.value.trim();
  const sitesText = sitesInput.value;
  const { tests } = await GTE.getState();

  if (editingTestId && tests[editingTestId]) {
    tests[editingTestId] = GTE.updateTestSites(tests[editingTestId], name, sitesText);
  } else {
    const test = GTE.createTest(name, sitesText);
    if (test.sites.length === 0) {
      alert('Voeg minstens één geldige URL toe.');
      return;
    }
    tests[test.id] = test;
    const { activeTestId } = await GTE.getState();
    if (!activeTestId) await GTE.setActiveTestId(test.id);
  }

  await GTE.saveTests(tests);
  resetForm();
  renderList();
});

cancelEditBtn.addEventListener('click', resetForm);

function resetForm() {
  editingTestId = null;
  testNameInput.value = '';
  sitesInput.value = '';
  formTitle.textContent = 'Nieuwe test aanmaken';
  saveTestBtn.textContent = 'Test opslaan';
  cancelEditBtn.hidden = true;
}

function startEdit(test) {
  editingTestId = test.id;
  testNameInput.value = test.name;
  sitesInput.value = GTE.sitesToText(test.sites);
  formTitle.textContent = `Test bewerken: ${test.name}`;
  saveTestBtn.textContent = 'Wijzigingen opslaan';
  cancelEditBtn.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function renderList() {
  const { tests, activeTestId } = await GTE.getState();
  const list = Object.values(tests).sort((a, b) => b.updatedAt - a.updatedAt);
  testListEl.innerHTML = '';
  emptyStateEl.hidden = list.length > 0;

  for (const test of list) {
    const rated = GTE.ratedCount(test);
    const card = document.createElement('div');
    card.className = 'gte-card gte-test-card';

    const main = document.createElement('div');
    main.className = 'gte-test-main';
    const title = document.createElement('h3');
    title.textContent = test.name;
    if (test.id === activeTestId) {
      const badge = document.createElement('span');
      badge.className = 'gte-badge gte-active-badge';
      badge.textContent = 'Actief';
      badge.style.marginLeft = '8px';
      title.appendChild(badge);
    }
    const meta = document.createElement('div');
    meta.className = 'gte-meta';
    meta.textContent = `${test.sites.length} sites · ${rated}/${test.sites.length} beoordeeld · aangemaakt ${GTE.formatDate(test.createdAt)}`;
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'gte-actions';

    const startBtn = mkBtn('Start Gut Test', 'gte-btn-primary', async () => {
      await GTE.setActiveTestId(test.id);
      startBtn.disabled = true;
      chrome.runtime.sendMessage({ command: 'openIntro', testId: test.id }, (resp) => {
        startBtn.disabled = false;
        if (resp?.success) renderList();
        else alert('Kon de test niet starten.');
      });
    });
    const reviewBtn = mkBtn('Beoordelen', 'gte-btn-ghost', async () => {
      await GTE.setActiveTestId(test.id);
      reviewBtn.disabled = true;
      chrome.runtime.sendMessage({ command: 'startReview', testId: test.id }, (resp) => {
        reviewBtn.disabled = false;
        if (resp?.success) renderList();
        else alert('Kon de review-pagina niet openen.');
      });
    });
    const dashboardBtn = mkBtn('Dashboard', 'gte-btn-ghost', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?test=${test.id}`) });
    });
    const editBtn = mkBtn('Bewerken', 'gte-btn-ghost', () => startEdit(test));
    const dupBtn = mkBtn('Dupliceren', 'gte-btn-ghost', async () => {
      const newName = prompt('Naam voor de kopie:', `${test.name} (kopie)`);
      if (newName === null) return;
      const { tests: latest } = await GTE.getState();
      const clone = GTE.duplicateTest(latest[test.id], newName);
      latest[clone.id] = clone;
      await GTE.saveTests(latest);
      renderList();
    });
    const delBtn = mkBtn('Verwijderen', 'gte-btn-danger', async () => {
      if (!confirm(`Weet je zeker dat je "${test.name}" wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
      const { tests: latest, activeTestId: curActive } = await GTE.getState();
      delete latest[test.id];
      await GTE.saveTests(latest);
      if (curActive === test.id) await GTE.setActiveTestId(null);
      renderList();
    });

    [startBtn, reviewBtn, dashboardBtn, editBtn, dupBtn, delBtn].forEach((b) => { b.classList.add('gte-btn-sm'); actions.appendChild(b); });

    card.appendChild(main);
    card.appendChild(actions);
    testListEl.appendChild(card);
  }
}

function mkBtn(text, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `gte-btn ${cls}`;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}
