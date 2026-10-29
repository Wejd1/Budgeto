// Interfejs aplikacji. Bez frameworka: widoki to funkcje zwracające HTML, zdarzenia obsługiwane delegacją.
import { GOOGLE_CLIENT_ID, SPREADSHEET_TITLE } from './config.js';
import { initAuth, signIn, signOut, getToken, getUser, AuthError } from './auth.js';
import { SheetsBackend, createSpreadsheet, parseSpreadsheetId, spreadsheetUrl } from './sheets.js';
import { DemoBackend } from './demo.js';
import * as store from './store.js';
import { state } from './store.js';
import {
  todayStr, periodKeyFor, shiftPeriod, periodRange, summarize, impactOf, suggestBudgets,
  periodTotals, compareWithPrevious, txInPeriod, parseAmount, round2, inRange,
} from './budget.js';
import { zl, zlShort, periodLabel, periodShort, dateLong, dateShort, pct, days, esc } from './format.js';

const VERSION = '1.0.0';
const root = document.getElementById('app');
const PLACEHOLDER = GOOGLE_CLIENT_ID.startsWith('WKLEJ');

const ui = {
  phase: 'boot', // boot | setup-client | signin | pick-sheet | app
  mode: localStorage.getItem('bud.mode'), // 'google' | 'demo' | null
  view: 'pulpit',
  period: null,
  form: null, // otwarty formularz transakcji
  catForm: null, // otwarty formularz kategorii
  hist: { type: 'all', q: '', cat: '' },
  draft: null, // szkic budżetu
  busy: false,
  error: '',
  toast: null,
  authReady: false,
};

// ───────────────────────── pomocnicze ─────────────────────────

const $ = (s, el = document) => el.querySelector(s);
const startDay = () => Math.min(28, Math.max(1, Number(state.meta.dzien_startu_okresu) || 1));
const today = () => todayStr();
const currentKey = () => periodKeyFor(today(), startDay());
const catMap = () => new Map(state.categories.map((c) => [c.id, c]));
const clientId = () => (PLACEHOLDER ? localStorage.getItem('bud.clientId') || '' : GOOGLE_CLIENT_ID);
const userName = () => (ui.mode === 'demo' ? 'Damian' : getUser()?.name || getUser()?.email || '');
const period = () => ui.period || currentKey();

function getSummary(key = period(), excludeId = null) {
  return summarize({
    transactions: excludeId ? state.transactions.filter((t) => t.id !== excludeId) : state.transactions,
    budgets: state.budgets,
    periods: state.periods,
    categories: state.categories,
    key,
    startDay: startDay(),
    today: today(),
  });
}

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  chart: '<path d="M4 20h16"/><path d="M6 16v-5M11 16V6M16 16v-8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

function bar(frac, status, tick = null) {
  const w = Math.max(0, Math.min(100, (frac || 0) * 100));
  return `<div class="bar s-${status}"><i style="width:${w}%"></i>${tick !== null && tick > 0 && tick < 1 ? `<b style="left:${tick * 100}%" title="dzisiaj"></b>` : ''}</div>`;
}

function toast(msg, action = null) {
  ui.toast = { msg, action, id: Date.now() };
  renderToast();
  const id = ui.toast.id;
  setTimeout(() => {
    if (ui.toast?.id === id) {
      ui.toast = null;
      renderToast();
    }
  }, action ? 6000 : 2500);
}

// ───────────────────────── start ─────────────────────────

async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('hashchange', onRoute);
  store.subscribe(onStoreChange);

  if (ui.mode === 'demo') return startDemo();
  if (!clientId()) return go('setup-client');

  prepareAuth();
  const sheetId = localStorage.getItem('bud.sheetId');
  if (sheetId) return startSheets(sheetId);
  return go(getToken() ? 'pick-sheet' : 'signin');
}

function prepareAuth() {
  if (ui.authReady) return Promise.resolve();
  return initAuth(clientId())
    .then(() => {
      ui.authReady = true;
    })
    .catch((e) => console.warn(e));
}

function go(phase) {
  ui.phase = phase;
  render();
}

function startDemo() {
  ui.mode = 'demo';
  localStorage.setItem('bud.mode', 'demo');
  store.useBackend(new DemoBackend());
  ui.phase = 'app';
  onRoute();
  store.refresh();
}

async function startSheets(id) {
  ui.mode = 'google';
  localStorage.setItem('bud.mode', 'google');
  localStorage.setItem('bud.sheetId', id);
  store.useBackend(new SheetsBackend(id));
  if (!state.hasData && !getToken()) return go('signin');
  ui.phase = 'app';
  onRoute();
  try {
    await store.refresh();
  } catch (e) {
    ui.error = e.message;
    go('pick-sheet');
  }
}

async function doSignIn() {
  ui.busy = true;
  ui.error = '';
  render();
  try {
    await prepareAuth();
    await signIn();
    ui.busy = false;
    const sheetId = localStorage.getItem('bud.sheetId');
    if (sheetId) {
      if (ui.phase !== 'app') return startSheets(sheetId);
      await store.refresh();
      toast('Połączono z Google');
    } else go('pick-sheet');
  } catch (e) {
    ui.busy = false;
    ui.error = e.message;
    render();
  }
}

// ───────────────────────── routing i odświeżanie ─────────────────────────

function onRoute() {
  const v = (location.hash.replace(/^#\/?/, '') || 'pulpit').split('?')[0];
  if (v === 'dodaj') {
    history.replaceState(null, '', '#/pulpit');
    ui.view = 'pulpit';
    render();
    return openForm();
  }
  ui.view = ['pulpit', 'historia', 'budzet', 'raporty', 'ustawienia'].includes(v) ? v : 'pulpit';
  if (ui.phase === 'app') render();
  window.scrollTo(0, 0);
}

function onStoreChange() {
  if (ui.phase !== 'app') return;
  // Nie przerysowujemy widoku, gdy ktoś właśnie wpisuje coś w pole — tylko pasek synchronizacji.
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && a.closest('#main')) {
    renderHeader();
    return;
  }
  renderApp();
  if (ui.form) updateImpact();
}

// ───────────────────────── renderowanie ─────────────────────────

function render() {
  if (ui.phase !== 'app') {
    root.innerHTML = renderSetup();
    return;
  }
  if (!$('#shell')) {
    root.innerHTML = `<div id="shell"><header id="top"></header><div id="banner"></div><main id="main"></main><nav id="nav"></nav></div><div id="modal"></div><div id="toast"></div>`;
  }
  renderApp();
}

function renderApp() {
  if (!$('#shell')) return render();
  renderHeader();
  $('#main').innerHTML = VIEWS[ui.view]();
  $('#main').dataset.view = ui.view;
  $('#nav').innerHTML = renderNav();
}

function renderHeader() {
  const s = state.sync;
  const pending = s.pending;
  let pill;
  if (s.status === 'syncing') pill = `<span class="pill s-sync">${icon('sync', 'spin')}Synchronizuję</span>`;
  else if (s.status === 'offline') pill = `<span class="pill s-warn">Offline${pending ? ` · ${pending}` : ''}</span>`;
  else if (s.status === 'auth') pill = `<span class="pill s-warn">Niepołączone${pending ? ` · ${pending}` : ''}</span>`;
  else if (s.status === 'error') pill = `<span class="pill s-over">Błąd synchr.</span>`;
  else if (pending) pill = `<span class="pill s-warn">Czeka: ${pending}</span>`;
  else pill = `<span class="pill s-ok">✓ ${ui.mode === 'demo' ? 'Demo' : 'Aktualne'}</span>`;

  const showPeriod = ['pulpit', 'historia', 'budzet', 'raporty'].includes(ui.view);
  const isCurrent = period() === currentKey();
  $('#top').innerHTML = `
    <div class="top-in">
      ${showPeriod ? `
      <div class="period-nav">
        <button class="icon-btn" data-act="period" data-d="-1" aria-label="Poprzedni okres">${icon('left')}</button>
        <button class="period-title ${isCurrent ? '' : 'not-current'}" data-act="period" data-d="0" title="Wróć do bieżącego okresu">${periodLabel(period(), startDay())}</button>
        <button class="icon-btn" data-act="period" data-d="1" aria-label="Następny okres">${icon('right')}</button>
      </div>` : `<div class="period-nav"><span class="period-title">Ustawienia</span></div>`}
      <button class="pill-btn" data-act="sync" title="Synchronizuj teraz">${pill}</button>
      <a class="icon-btn ${ui.view === 'ustawienia' ? 'active' : ''}" href="#/ustawienia" aria-label="Ustawienia">${icon('sliders')}</a>
    </div>`;

  let banner = '';
  if (ui.mode === 'demo') {
    banner = `<div class="banner demo">Tryb demo — przykładowe dane, zapisane tylko w tej przeglądarce. <button data-act="exit-demo">Zakończ demo</button></div>`;
  } else if (s.status === 'auth') {
    banner = `<div class="banner warn">${pending ? `${pending} ${pending === 1 ? 'zmiana czeka' : 'zmian czeka'} na wysłanie. ` : ''}Połącz z Google, żeby zsynchronizować. <button data-act="signin">Połącz</button></div>`;
  } else if (s.status === 'error') {
    banner = `<div class="banner over">${esc(s.message)} <button data-act="sync">Spróbuj ponownie</button></div>`;
  }
  $('#banner').innerHTML = banner;
}

function renderNav() {
  const item = (v, ic, label) => `<a href="#/${v}" class="${ui.view === v ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`;
  return `<div class="nav-in">
    ${item('pulpit', 'home', 'Pulpit')}
    ${item('historia', 'list', 'Historia')}
    <button class="fab" data-act="add" aria-label="Dodaj wydatek">${icon('plus')}<span>Dodaj</span></button>
    ${item('budzet', 'target', 'Budżet')}
    ${item('raporty', 'chart', 'Raporty')}
  </div>`;
}

// ───────────────────────── ekrany startowe ─────────────────────────

function renderSetup() {
  const err = ui.error ? `<p class="err">${esc(ui.error)}</p>` : '';
  const demo = `<button class="link" data-act="demo">Najpierw wypróbuj w trybie demo →</button>`;
  const wrap = (inner) => `<div class="setup"><div class="setup-card"><div class="logo">zł</div>${inner}</div></div>`;

  if (ui.phase === 'boot') return wrap('<p class="muted">Wczytywanie…</p>');

  if (ui.phase === 'setup-client') {
    return wrap(`
      <h1>Pierwsza konfiguracja</h1>
      <p>Brakuje <b>Client ID</b> z Google Cloud. Najlepiej wpisz go w pliku <code>js/config.js</code> w repozytorium — wtedy zadziała na każdym urządzeniu.</p>
      <p class="muted">Możesz też wkleić go tutaj (zapamiętany tylko w tej przeglądarce):</p>
      <input id="client-id" placeholder="1234…apps.googleusercontent.com" autocomplete="off">
      ${err}
      <button class="primary wide" data-act="save-client">Zapisz</button>
      ${demo}`);
  }

  if (ui.phase === 'signin') {
    return wrap(`
      <h1>Budżet domowy</h1>
      <p>Wspólny budżet dla dwojga. Dane trzymasz we własnym Arkuszu Google — nikt poza wami ich nie widzi.</p>
      ${err}
      <button class="primary wide google" data-act="signin" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Logowanie…' : 'Zaloguj się kontem Google'}</button>
      ${demo}`);
  }

  if (ui.phase === 'pick-sheet') {
    return wrap(`
      <h1>Gdzie trzymać dane?</h1>
      <p class="muted">Zalogowano jako ${esc(getUser()?.email || '')}</p>
      <div class="choice">
        <h2>Zakładam budżet</h2>
        <p>Aplikacja utworzy na Twoim Dysku arkusz „${esc(SPREADSHEET_TITLE)}”. Potem udostępnisz go żonie.</p>
        <button class="primary wide" data-act="create-sheet" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Tworzę arkusz…' : 'Utwórz nowy arkusz'}</button>
      </div>
      <div class="choice">
        <h2>Dołączam do istniejącego</h2>
        <p>Wklej link do arkusza, który został Ci udostępniony (z prawem edycji).</p>
        <input id="sheet-link" placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off">
        <button class="wide" data-act="join-sheet" ${ui.busy ? 'disabled' : ''}>Podłącz arkusz</button>
      </div>
      ${err}
      <button class="link" data-act="signout">Zaloguj się innym kontem</button>`);
  }
  return '';
}

// ───────────────────────── PULPIT ─────────────────────────

function viewPulpit() {
  if (!state.hasData) return `<div class="empty">Wczytywanie danych…</div>`;
  const s = getSummary();
  const cm = catMap();
  const tick = s.state === 'current' ? s.elapsedFrac : null;

  let hero;
  if (!s.totalLimit) {
    hero = `
      <section class="card hero s-none">
        <div class="hero-label">Nie ustalono budżetu na ten okres</div>
        <p class="muted">Wydano dotąd <b>${zl(s.spent)}</b>. Ustal limity na kategorie, a aplikacja pokaże, ile możecie jeszcze wydać — każdego dnia.</p>
        <a class="primary" href="#/budzet">Ustal budżet</a>
      </section>`;
  } else {
    const st = s.remaining < 0 ? 'over' : s.spentFrac >= 0.9 || (tick !== null && s.spentFrac > tick + 0.1) ? 'warn' : 'ok';
    const label = s.state === 'past' ? (s.remaining < 0 ? 'Budżet przekroczony o' : 'Zostało na koniec okresu') : s.remaining < 0 ? 'Budżet przekroczony o' : 'Zostało do wydania';
    hero = `
      <section class="card hero s-${st}">
        <div class="hero-label">${label}</div>
        <div class="hero-amount">${zl(Math.abs(s.remaining))}</div>
        <div class="hero-sub">wydano ${zl(s.spent)} z ${zl(s.totalLimit)}</div>
        ${bar(s.spentFrac, st, tick)}
        ${s.state === 'current' ? `<div class="hero-foot"><span>Minęło ${pct(s.elapsedFrac)} okresu</span><span>wydano ${pct(s.spentFrac)} budżetu</span></div>` : ''}
      </section>`;
  }

  let tiles = '';
  if (s.totalLimit && s.state !== 'future') {
    const over = s.forecast !== null ? round2(s.forecast - s.totalLimit) : 0;
    tiles = `<div class="tiles">
      ${s.state === 'current' ? `
      <div class="tile ${s.remaining <= 0 ? 's-over' : ''}">
        <div class="tile-label">Na dziś bezpiecznie</div>
        <div class="tile-val">${zl(s.dailySafe)}</div>
        <div class="tile-sub">dziennie przez ${days(s.daysLeft)}</div>
      </div>` : ''}
      ${s.forecast !== null ? `
      <div class="tile ${over > 0 ? 's-over' : 's-ok'}">
        <div class="tile-label">${s.state === 'past' ? 'Wynik okresu' : 'Prognoza na koniec'}</div>
        <div class="tile-val">${zl(s.forecast)}</div>
        <div class="tile-sub">${over > 0 ? `${zl(over)} ponad budżet` : `${zl(-over)} poniżej budżetu`}</div>
      </div>` : ''}
      <div class="tile">
        <div class="tile-label">Zachcianki</div>
        <div class="tile-val">${zl(s.wants)}</div>
        <div class="tile-sub">${s.spent ? `${pct(s.wants / s.spent)} wydatków` : '—'}</div>
      </div>
    </div>`;
  }

  // Alerty: najpierw przekroczenia, potem tempo
  const alerts = [];
  for (const c of s.cats) {
    if (c.status === 'over') alerts.push(`<div class="alert s-over"><b>${c.cat.ikona} ${esc(c.cat.nazwa)}</b>: limit przekroczony o ${zl(-c.remaining)}</div>`);
  }
  for (const c of s.cats) {
    if (c.paceWarn) alerts.push(`<div class="alert s-warn"><b>${c.cat.ikona} ${esc(c.cat.nazwa)}</b>: wydano już ${pct(c.pct)} limitu, a minęło ${pct(s.elapsedFrac)} okresu — zwolnijcie.</div>`);
  }
  if (s.totalLimit && s.unbudgetedSpent > 0) {
    alerts.push(`<div class="alert s-warn">Wydatki bez limitu: <b>${zl(s.unbudgetedSpent)}</b> — też zmniejszają kwotę „zostało”. <a href="#/budzet">Dodaj limity</a></div>`);
  }

  const rows = s.cats.map((c) => {
    let rest;
    if (c.status === 'over') rest = `<span class="t-over">−${zl(-c.remaining)}</span>`;
    else if (c.status === 'nolimit') rest = `<span class="t-warn">bez limitu</span>`;
    else rest = `<span>${zl(c.remaining)}</span><small>zostało</small>`;
    return `
      <button class="cat-row" data-act="cat-hist" data-id="${esc(c.cat.id)}">
        <span class="cat-ico" style="--c:${esc(c.cat.kolor || '#888')}">${c.cat.ikona}</span>
        <span class="cat-main">
          <span class="cat-name">${esc(c.cat.nazwa)}${c.cat.rodzaj === 'staly' ? ' <em>stały</em>' : ''}</span>
          ${c.limit ? bar(c.pct, c.paceWarn ? 'warn' : c.status, c.cat.rodzaj === 'staly' ? null : tick) : bar(1, 'nolimit')}
          <span class="cat-nums">${zl(c.spent)}${c.limit ? ` z ${zl(c.limit)} · ${pct(c.pct)}` : ''}</span>
        </span>
        <span class="cat-rest">${rest}</span>
      </button>`;
  });

  const recent = txInPeriod(state.transactions, period(), startDay())
    .sort((a, b) => (b.data + (b.utworzono || '')).localeCompare(a.data + (a.utworzono || '')))
    .slice(0, 6);

  return `
    <div class="grid-dash">
      <div class="col">
        ${hero}
        ${tiles}
        ${alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : ''}
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Kategorie</h2><a href="#/budzet" class="small-link">Edytuj limity</a></div>
          ${rows.length ? `<div class="cat-list">${rows.join('')}</div>` : `<p class="muted">Brak wydatków i limitów w tym okresie.</p>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>Ostatnie</h2><a href="#/historia" class="small-link">Wszystkie</a></div>
          ${recent.length ? `<div class="tx-list">${recent.map((t) => txRow(t, cm)).join('')}</div>` : `<p class="muted">Jeszcze nic. Dodaj pierwszy wydatek przyciskiem „+”.</p>`}
        </section>
      </div>
    </div>`;
}

function txRow(t, cm, showDate = true) {
  const c = cm.get(t.kategoria_id) || { nazwa: t.kategoria_id || 'Bez kategorii', ikona: '❔', kolor: '#888' };
  const inc = t.typ === 'przychod';
  const meta = [showDate ? dateShort(t.data) : '', esc(c.nazwa), t.osoba ? esc(t.osoba) : ''].filter(Boolean).join(' · ');
  return `
    <button class="tx" data-act="edit-tx" data-id="${esc(t.id)}">
      <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
      <span class="tx-main">
        <span class="tx-title">${esc(t.opis || c.nazwa)}${t.potrzeba === 'zachcianka' && !inc ? '<em class="want">zachcianka</em>' : ''}</span>
        <span class="tx-meta">${meta}</span>
      </span>
      <span class="tx-amt ${inc ? 'inc' : ''}">${inc ? '+' : '−'}${zl(t.kwota)}</span>
    </button>`;
}

// ───────────────────────── HISTORIA ─────────────────────────

function viewHistoria() {
  const cm = catMap();
  const usedCats = [...new Set(txInPeriod(state.transactions, period(), startDay()).map((t) => t.kategoria_id))]
    .map((id) => cm.get(id) || { id, nazwa: id })
    .sort((a, b) => a.nazwa.localeCompare(b.nazwa, 'pl'));
  const chip = (v, l) => `<button class="chip ${ui.hist.type === v ? 'on' : ''}" data-act="hist-type" data-v="${v}">${l}</button>`;
  return `
    <section class="card">
      <div class="hist-filters">
        <input id="h-q" type="search" placeholder="Szukaj w opisach…" value="${esc(ui.hist.q)}" autocomplete="off">
        <select id="h-cat">
          <option value="">Wszystkie kategorie</option>
          ${usedCats.map((c) => `<option value="${esc(c.id)}" ${ui.hist.cat === c.id ? 'selected' : ''}>${c.ikona || ''} ${esc(c.nazwa)}</option>`).join('')}
        </select>
      </div>
      <div class="chips">${chip('all', 'Wszystko')}${chip('wydatek', 'Wydatki')}${chip('przychod', 'Przychody')}${chip('zachcianka', 'Zachcianki')}</div>
      <div id="h-list">${histList()}</div>
    </section>`;
}

function histList() {
  const cm = catMap();
  const q = ui.hist.q.trim().toLowerCase();
  const list = txInPeriod(state.transactions, period(), startDay())
    .filter((t) => {
      if (ui.hist.type === 'wydatek' && t.typ !== 'wydatek') return false;
      if (ui.hist.type === 'przychod' && t.typ !== 'przychod') return false;
      if (ui.hist.type === 'zachcianka' && (t.typ !== 'wydatek' || t.potrzeba !== 'zachcianka')) return false;
      if (ui.hist.cat && t.kategoria_id !== ui.hist.cat) return false;
      if (q && !`${t.opis} ${cm.get(t.kategoria_id)?.nazwa || ''} ${t.osoba}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => (b.data + (b.utworzono || '')).localeCompare(a.data + (a.utworzono || '')));

  if (!list.length) return `<p class="muted center">Brak pozycji dla wybranych filtrów.</p>`;
  const exp = round2(list.filter((t) => t.typ === 'wydatek').reduce((a, t) => a + t.kwota, 0));
  const inc = round2(list.filter((t) => t.typ === 'przychod').reduce((a, t) => a + t.kwota, 0));
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.data)) groups.set(t.data, []);
    groups.get(t.data).push(t);
  }
  const td = today();
  return `
    <div class="hist-sum">${list.length} poz. · wydatki <b>${zl(exp)}</b>${inc ? ` · przychody <b class="t-ok">${zl(inc)}</b>` : ''}</div>
    ${[...groups].map(([d, items]) => {
      const dayExp = round2(items.filter((t) => t.typ === 'wydatek').reduce((a, t) => a + t.kwota, 0));
      return `<div class="day"><div class="day-head"><span>${dateLong(d, td)}</span><span>${dayExp ? zl(dayExp) : ''}</span></div>
        <div class="tx-list">${items.map((t) => txRow(t, cm, false)).join('')}</div></div>`;
    }).join('')}`;
}

// ───────────────────────── BUDŻET ─────────────────────────

function budgetDraftFor(key) {
  if (ui.draft && ui.draft.key === key) return ui.draft;
  const per = state.periods.find((p) => p.okres === key) || {};
  const limits = {};
  for (const b of state.budgets) if (b.okres === key && b.limit > 0) limits[b.kategoria_id] = String(b.limit);
  ui.draft = {
    key,
    przychody_plan: per.przychody_plan ? String(per.przychody_plan) : '',
    cel_oszczednosci: per.cel_oszczednosci ? String(per.cel_oszczednosci) : '',
    limits,
    dirty: false,
  };
  return ui.draft;
}

function draftNumbers(d) {
  const n = (v) => {
    const x = parseAmount(v);
    return Number.isFinite(x) ? x : 0;
  };
  const totalLimits = round2(Object.values(d.limits).reduce((a, v) => a + n(v), 0));
  const income = n(d.przychody_plan);
  const savings = n(d.cel_oszczednosci);
  return { totalLimits, income, savings, free: round2(income - savings - totalLimits) };
}

function bilansHtml(d) {
  const { totalLimits, income, savings, free } = draftNumbers(d);
  let msg;
  let st;
  if (!income) {
    st = 'none';
    msg = 'Wpisz planowane przychody, żeby sprawdzić, czy plan się bilansuje.';
  } else if (Math.abs(free) < 0.01) {
    st = 'ok';
    msg = 'Każda złotówka ma przydział. Tak trzymać!';
  } else if (free > 0) {
    st = 'warn';
    msg = `${zl(free)} bez przydziału — dopisz do celu oszczędności albo do kategorii.`;
  } else {
    st = 'over';
    msg = `Plan przekracza przychody o ${zl(-free)}. Zmniejsz limity.`;
  }
  return `
    <div class="bilans s-${st}">
      <div class="bil-row"><span>Planowane przychody</span><b>${zl(income)}</b></div>
      <div class="bil-row"><span>− cel oszczędności</span><b>${zl(savings)}</b></div>
      <div class="bil-row"><span>− suma limitów</span><b>${zl(totalLimits)}</b></div>
      <div class="bil-row total"><span>= bez przydziału</span><b>${zl(free)}</b></div>
      <p>${msg}</p>
    </div>`;
}

function viewBudzet() {
  if (!state.hasData) return `<div class="empty">Wczytywanie danych…</div>`;
  const key = period();
  const d = budgetDraftFor(key);
  const prevKey = shiftPeriod(key, -1);
  const sd = startDay();
  const prevSpent = {};
  for (const t of txInPeriod(state.transactions, prevKey, sd)) if (t.typ === 'wydatek') prevSpent[t.kategoria_id] = (prevSpent[t.kategoria_id] || 0) + t.kwota;
  const avg = suggestBudgets(state.transactions, key, sd, 3);
  const s = getSummary(key);
  const spentNow = new Map(s.cats.map((c) => [c.cat.id, c.spent]));
  const cats = state.categories.filter((c) => c.typ === 'wydatek' && (c.aktywna || d.limits[c.id]));

  return `
    <div class="grid-dash">
      <div class="col">
        <section class="card">
          <h2>Plan na ${periodLabel(key, sd).toLowerCase()}</h2>
          <label class="field"><span>Planowane przychody (oboje)</span>
            <input data-bf="przychody_plan" inputmode="decimal" placeholder="np. 10 000" value="${esc(d.przychody_plan)}" autocomplete="off"></label>
          <label class="field"><span>Cel oszczędności — odkładane na start</span>
            <input data-bf="cel_oszczednosci" inputmode="decimal" placeholder="np. 1 500" value="${esc(d.cel_oszczednosci)}" autocomplete="off"></label>
          <div id="b-bilans">${bilansHtml(d)}</div>
        </section>
        <section class="card tips">
          <h2>Jak ustalać limity, żeby wydawać mniej</h2>
          <ul>
            <li>Zacznij od propozycji ze średniej i <b>obetnij 10–15%</b> w kategoriach „zachcianek”.</li>
            <li>Opłatom stałym też daj limit — wtedy „zostało” na pulpicie jest prawdziwe.</li>
            <li>Cel oszczędności traktuj jak pierwszy rachunek do zapłacenia, nie resztę na koniec.</li>
          </ul>
        </section>
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Limity na kategorie</h2></div>
          <div class="btn-row">
            <button data-act="copy-prev">Skopiuj z ${periodShort(prevKey)}</button>
            <button data-act="suggest">Zaproponuj (śr. 3 mies.)</button>
          </div>
          <div class="limits">
            ${cats.map((c) => `
              <label class="limit-row">
                <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
                <span class="limit-main">
                  <span class="cat-name">${esc(c.nazwa)}${c.rodzaj === 'staly' ? ' <em>stały</em>' : ''}</span>
                  <small>${[
                    prevSpent[c.id] ? `${periodShort(prevKey)}: ${zl(round2(prevSpent[c.id]))}` : '',
                    avg[c.id] ? `śr.: ${zl(avg[c.id])}` : '',
                    spentNow.get(c.id) ? `teraz: ${zl(spentNow.get(c.id))}` : '',
                  ].filter(Boolean).join(' · ') || 'brak historii'}</small>
                </span>
                <span class="limit-input"><input data-limit="${esc(c.id)}" inputmode="decimal" placeholder="0" value="${esc(d.limits[c.id] || '')}" autocomplete="off"><span>zł</span></span>
              </label>`).join('')}
          </div>
          <div class="save-bar">
            <span id="b-dirty" class="muted">${d.dirty ? 'Niezapisane zmiany' : ''}</span>
            <button class="primary" data-act="save-budget">Zapisz budżet</button>
          </div>
        </section>
      </div>
    </div>`;
}

// ───────────────────────── RAPORTY ─────────────────────────

function viewRaporty() {
  if (!state.hasData) return `<div class="empty">Wczytywanie danych…</div>`;
  const key = period();
  const sd = startDay();
  const cm = catMap();
  const totals = periodTotals(state.transactions, state.budgets, key, sd, 6);
  const max = Math.max(1, ...totals.map((t) => Math.max(t.spent, t.limit)));
  const chart = `
    <div class="chart">
      ${totals.map((t) => {
        const over = t.limit && t.spent > t.limit;
        return `<div class="ch-col ${t.key === key ? 'cur' : ''}">
          <div class="ch-val">${zlShort(t.spent)}</div>
          <div class="ch-area">
            <div class="ch-bar ${over ? 'over' : ''}" style="height:${(t.spent / max) * 100}%">
              <div class="ch-wants" style="height:${t.spent ? (t.wants / t.spent) * 100 : 0}%"></div>
            </div>
            ${t.limit ? `<div class="ch-limit" style="bottom:${(t.limit / max) * 100}%"></div>` : ''}
          </div>
          <div class="ch-lab">${periodShort(t.key)}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="legend"><span><i class="lg-bar"></i>wydatki</span><span><i class="lg-wants"></i>w tym zachcianki</span><span><i class="lg-limit"></i>budżet</span></div>`;

  const cmp = compareWithPrevious(state.transactions, key, sd).filter((x) => x.cur || x.prev);
  const s = getSummary(key);
  const totalSpent = s.spent || 1;
  const structure = s.cats.filter((c) => c.spent > 0).sort((a, b) => b.spent - a.spent);
  const biggest = txInPeriod(state.transactions, key, sd).filter((t) => t.typ === 'wydatek').sort((a, b) => b.kwota - a.kwota).slice(0, 10);
  const people = Object.entries(s.byPerson).sort((a, b) => b[1] - a[1]);
  const prevTotals = totals[totals.length - 2];

  return `
    <div class="grid-dash">
      <div class="col">
        <section class="card">
          <h2>Ostatnie 6 okresów</h2>
          ${chart}
          ${prevTotals ? `<p class="muted small">Zachcianki: ${zl(s.wants)} teraz vs ${zl(prevTotals.wants)} w ${periodShort(prevTotals.key)} (${s.wants <= prevTotals.wants ? '<span class="t-ok">mniej</span>' : '<span class="t-over">więcej</span>'}).</p>` : ''}
        </section>
        <section class="card">
          <h2>Zmiana vs ${periodShort(shiftPeriod(key, -1))}</h2>
          ${cmp.length ? `<div class="cmp">${cmp.slice(0, 8).map((x) => {
            const c = cm.get(x.id) || { nazwa: x.id, ikona: '❔' };
            return `<div class="cmp-row"><span>${c.ikona} ${esc(c.nazwa)}</span><span class="muted">${zl(x.prev)} → ${zl(x.cur)}</span><b class="${x.diff > 0 ? 't-over' : 't-ok'}">${x.diff > 0 ? '▲' : x.diff < 0 ? '▼' : ''} ${zl(Math.abs(x.diff))}</b></div>`;
          }).join('')}</div>` : '<p class="muted">Brak danych do porównania.</p>'}
        </section>
      </div>
      <div class="col">
        <section class="card">
          <h2>Na co idą pieniądze</h2>
          ${structure.length ? `<div class="struct">${structure.map((c) => `
            <div class="st-row">
              <span class="st-name">${c.cat.ikona} ${esc(c.cat.nazwa)}</span>
              <span class="st-bar"><i style="width:${(c.spent / totalSpent) * 100}%;background:${esc(c.cat.kolor || '#888')}"></i></span>
              <span class="st-val">${zl(c.spent)} <small>${pct(c.spent / totalSpent)}</small></span>
            </div>`).join('')}</div>` : '<p class="muted">Brak wydatków.</p>'}
        </section>
        <section class="card">
          <h2>Największe wydatki</h2>
          ${biggest.length ? `<div class="tx-list">${biggest.map((t) => txRow(t, cm)).join('')}</div>` : '<p class="muted">Brak wydatków.</p>'}
        </section>
        ${people.length > 1 ? `<section class="card"><h2>Kto ile wydał</h2>${people.map(([p, v]) => `<div class="cmp-row"><span>${esc(p)}</span><span></span><b>${zl(v)}</b></div>`).join('')}</section>` : ''}
      </div>
    </div>`;
}

// ───────────────────────── USTAWIENIA ─────────────────────────

function viewUstawienia() {
  const sheetId = localStorage.getItem('bud.sheetId');
  const u = getUser();
  const sd = startDay();
  const cats = [...state.categories].sort((a, b) => (a.typ === b.typ ? a.kolejnosc - b.kolejnosc : a.typ === 'wydatek' ? -1 : 1));
  return `
    <div class="grid-dash">
      <div class="col">
        ${ui.mode === 'demo' ? `
        <section class="card">
          <h2>Tryb demo</h2>
          <p>Dane są przykładowe i zapisane tylko w tej przeglądarce.</p>
          <div class="btn-row"><button data-act="reset-demo">Wygeneruj dane od nowa</button><button class="primary" data-act="exit-demo">Zakończ demo i połącz z Google</button></div>
        </section>` : `
        <section class="card">
          <h2>Konto Google</h2>
          <p>${u ? `${esc(u.name)} <span class="muted">(${esc(u.email)})</span>` : 'Niezalogowano'}</p>
          <div class="btn-row"><button data-act="signin">Połącz ponownie</button><button data-act="signout">Wyloguj</button></div>
        </section>
        <section class="card">
          <h2>Arkusz z danymi</h2>
          ${sheetId ? `
          <div class="btn-row">
            <a class="btn" href="${spreadsheetUrl(sheetId)}" target="_blank" rel="noopener">Otwórz w Arkuszach Google</a>
            <button data-act="copy-link">Kopiuj link</button>
          </div>
          <details class="howto"><summary>Jak udostępnić budżet żonie?</summary>
            <ol>
              <li>Otwórz arkusz → przycisk <b>Udostępnij</b> → wpisz jej adres Gmail → rola <b>Edytujący</b>.</li>
              <li>Wyślij jej link do aplikacji i link do arkusza (przycisk „Kopiuj link”).</li>
              <li>Ona loguje się w aplikacji swoim kontem, wybiera „Dołączam do istniejącego” i wkleja link.</li>
              <li>Jej adres musi też być dodany jako „użytkownik testowy” w Google Cloud (patrz README).</li>
            </ol>
          </details>
          <button class="link danger" data-act="disconnect">Odłącz arkusz na tym urządzeniu</button>` : '<p>Brak podłączonego arkusza.</p>'}
        </section>`}
        <section class="card">
          <h2>Okres budżetowy</h2>
          <label class="field"><span>Okres zaczyna się dnia</span>
            <select id="start-day">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${sd === i + 1 ? 'selected' : ''}>${i + 1}.${i === 0 ? ' (miesiąc kalendarzowy)' : ''}</option>`).join('')}</select>
          </label>
          <p class="muted small">Ustaw np. na dzień wypłaty. Zmiana dotyczy obojga, bo zapisuje się w arkuszu.</p>
        </section>
        <section class="card">
          <h2>Dane</h2>
          <div class="btn-row">
            <button data-act="csv" data-scope="period">Eksport CSV — ten okres</button>
            <button data-act="csv" data-scope="all">Eksport CSV — wszystko</button>
            <button data-act="sync">Synchronizuj teraz</button>
          </div>
          <p class="muted small">Ostatnia synchronizacja: ${state.sync.lastSync ? new Date(state.sync.lastSync).toLocaleString('pl-PL') : '—'} · wersja ${VERSION}</p>
        </section>
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Kategorie</h2><button class="small-link" data-act="new-cat">+ Nowa</button></div>
          <div class="cat-admin">
            ${cats.map((c) => `
              <button class="cat-adm-row ${c.aktywna ? '' : 'off'}" data-act="edit-cat" data-id="${esc(c.id)}">
                <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
                <span class="cat-name">${esc(c.nazwa)}</span>
                <span class="muted small">${c.typ === 'przychod' ? 'przychód' : c.rodzaj === 'staly' ? 'stały' : 'zmienny'}${c.aktywna ? '' : ' · ukryta'}</span>
              </button>`).join('')}
          </div>
        </section>
      </div>
    </div>`;
}

const VIEWS = { pulpit: viewPulpit, historia: viewHistoria, budzet: viewBudzet, raporty: viewRaporty, ustawienia: viewUstawienia };

// ───────────────────────── FORMULARZ TRANSAKCJI ─────────────────────────

function openForm(tx = null) {
  const sd = startDay();
  const r = periodRange(period(), sd);
  const defDate = inRange(today(), r) ? today() : r.end; // przeglądając stary miesiąc, domyślnie jego ostatni dzień
  ui.form = tx
    ? { ...tx, kwotaStr: String(tx.kwota).replace('.', ','), isNew: false, potrzebaTouched: true }
    : { id: store.newId(), typ: 'wydatek', kwotaStr: '', kategoria_id: '', potrzeba: 'niezbedny', data: defDate, opis: '', osoba: userName(), isNew: true, potrzebaTouched: false, usunieto: false };
  renderModal();
  setTimeout(() => {
    const el = $('#f-amount');
    if (el && ui.form?.isNew) el.focus();
  }, 60);
}

function closeModal() {
  ui.form = null;
  ui.catForm = null;
  renderModal();
}

function sortedCats(typ) {
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const use = {};
  for (const t of state.transactions) if (!t.usunieto && t.data >= since) use[t.kategoria_id] = (use[t.kategoria_id] || 0) + 1;
  return state.categories
    .filter((c) => c.typ === typ && (c.aktywna || c.id === ui.form?.kategoria_id))
    .sort((a, b) => (use[b.id] || 0) - (use[a.id] || 0) || a.kolejnosc - b.kolejnosc);
}

function renderModal() {
  const m = $('#modal');
  if (!m) return;
  if (ui.catForm) return renderCatModal(m);
  const f = ui.form;
  if (!f) {
    m.innerHTML = '';
    document.body.classList.remove('modal-open');
    return;
  }
  document.body.classList.add('modal-open');
  const seg = (field, v, l) => `<button class="${f[field] === v ? 'on' : ''}" data-act="f-set" data-field="${field}" data-v="${v}">${l}</button>`;
  m.innerHTML = `
    <div class="overlay" data-act="close"></div>
    <div class="sheet" role="dialog" aria-label="${f.isNew ? 'Nowa pozycja' : 'Edycja'}">
      <div class="sheet-head">
        <div class="seg">${seg('typ', 'wydatek', 'Wydatek')}${seg('typ', 'przychod', 'Przychód')}</div>
        <button class="icon-btn" data-act="close" aria-label="Zamknij">${icon('close')}</button>
      </div>
      <div class="amount ${f.typ === 'przychod' ? 'inc' : ''}">
        <input id="f-amount" inputmode="decimal" placeholder="0" value="${esc(f.kwotaStr)}" autocomplete="off" enterkeyhint="done">
        <span>zł</span>
      </div>
      <div id="f-impact" class="impact"></div>
      <div class="cat-grid">
        ${sortedCats(f.typ).map((c) => `
          <button class="cg ${f.kategoria_id === c.id ? 'on' : ''}" data-act="f-cat" data-id="${esc(c.id)}" style="--c:${esc(c.kolor)}">
            <span>${c.ikona}</span><small>${esc(c.nazwa)}</small>
          </button>`).join('')}
      </div>
      ${f.typ === 'wydatek' ? `<div class="seg small">${seg('potrzeba', 'niezbedny', 'Niezbędny')}${seg('potrzeba', 'zachcianka', 'Zachcianka')}</div>` : ''}
      <div class="row2">
        <input id="f-date" type="date" value="${esc(f.data)}">
        <input id="f-desc" placeholder="Opis (opcjonalnie)" value="${esc(f.opis)}" autocomplete="off" maxlength="120">
      </div>
      <div class="sheet-foot">
        ${f.isNew ? '' : `<button class="danger-outline" data-act="f-delete">Usuń</button>`}
        <button id="f-save" class="primary" data-act="f-save">Zapisz</button>
      </div>
    </div>`;
  updateImpact();
}

function updateImpact() {
  const f = ui.form;
  const el = $('#f-impact');
  if (!f || !el) return;
  const btn = $('#f-save');
  const amount = parseAmount(f.kwotaStr);
  let html = '';
  let danger = false;
  if (f.typ === 'wydatek') {
    const key = periodKeyFor(f.data || today(), startDay());
    const s = getSummary(key, f.isNew ? null : f.id);
    const cat = catMap().get(f.kategoria_id);
    if (!f.kategoria_id) {
      html = s.totalLimit && s.state === 'current' ? `<span class="muted">Na dziś bezpiecznie: <b>${zl(s.dailySafe)}</b> · w okresie zostało ${zl(s.remaining)}</span>` : '<span class="muted">Wybierz kategorię</span>';
    } else {
      const im = impactOf(s, f.kategoria_id, Number.isFinite(amount) ? amount : 0);
      if (im.overCat) {
        danger = true;
        html = `<span class="t-over">⚠ Przekroczysz limit „${esc(cat?.nazwa)}” o <b>${zl(-im.catRemainingAfter)}</b></span>`;
      } else if (im.hasLimit) {
        html = `<span class="t-ok">✓ ${esc(cat?.nazwa)}: zostanie <b>${zl(im.catRemainingAfter)}</b> z ${zl(im.limit)}</span>`;
      } else {
        html = `<span class="t-warn">Ta kategoria nie ma limitu${s.totalLimit ? ` · w budżecie zostanie ${zl(im.totalRemainingAfter)}` : ''}</span>`;
      }
      if (im.overTotal && !im.overCat) {
        danger = true;
        html += `<br><span class="t-over">⚠ Cały budżet okresu będzie przekroczony o ${zl(-im.totalRemainingAfter)}</span>`;
      }
    }
  }
  el.innerHTML = html;
  if (btn) {
    btn.classList.toggle('danger', danger);
    btn.textContent = danger ? 'Zapisz mimo to' : 'Zapisz';
  }
}

function saveForm() {
  const f = ui.form;
  const amount = parseAmount(f.kwotaStr);
  if (!Number.isFinite(amount) || amount <= 0) return shake('#f-amount', 'Wpisz kwotę');
  if (!f.kategoria_id) return shake('.cat-grid', 'Wybierz kategorię');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.data || '')) return shake('#f-date', 'Podaj datę');
  const tx = {
    id: f.id, data: f.data, kwota: amount, typ: f.typ, kategoria_id: f.kategoria_id, opis: (f.opis || '').trim(),
    potrzeba: f.typ === 'przychod' ? 'niezbedny' : f.potrzeba, osoba: f.osoba || userName(),
    utworzono: f.utworzono || '', usunieto: false,
  };
  const isNew = f.isNew;
  store.saveTransaction(tx, isNew);
  closeModal();
  if (isNew) {
    const saved = state.transactions.find((t) => t.id === tx.id);
    toast(`Zapisano ${zl(amount)}`, { label: 'Cofnij', fn: () => store.deleteTransaction(saved) });
  } else toast('Zapisano zmiany');
}

function shake(sel, msg) {
  const el = $(sel);
  if (el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
  toast(msg);
}

// ───────────────────────── FORMULARZ KATEGORII ─────────────────────────

function openCatForm(cat = null) {
  ui.catForm = cat
    ? { ...cat, isNew: false }
    : { id: '', nazwa: '', ikona: '🏷️', kolor: '#5a7d9a', typ: 'wydatek', rodzaj: 'zmienny', domyslna_potrzeba: 'niezbedny', aktywna: true, kolejnosc: state.categories.length + 1, isNew: true };
  renderModal();
}

function renderCatModal(m) {
  const c = ui.catForm;
  document.body.classList.add('modal-open');
  const seg = (field, v, l) => `<button class="${String(c[field]) === String(v) ? 'on' : ''}" data-act="c-set" data-field="${field}" data-v="${v}">${l}</button>`;
  m.innerHTML = `
    <div class="overlay" data-act="close"></div>
    <div class="sheet" role="dialog" aria-label="Kategoria">
      <div class="sheet-head"><h2>${c.isNew ? 'Nowa kategoria' : 'Kategoria'}</h2><button class="icon-btn" data-act="close" aria-label="Zamknij">${icon('close')}</button></div>
      <div class="row2 cat-edit">
        <input id="c-icon" value="${esc(c.ikona)}" maxlength="4" aria-label="Ikona (emoji)">
        <input id="c-name" value="${esc(c.nazwa)}" placeholder="Nazwa" maxlength="40">
        <input id="c-color" type="color" value="${esc(c.kolor)}" aria-label="Kolor">
      </div>
      <label class="field"><span>Typ</span><div class="seg small">${seg('typ', 'wydatek', 'Wydatek')}${seg('typ', 'przychod', 'Przychód')}</div></label>
      ${c.typ === 'wydatek' ? `
      <label class="field"><span>Rodzaj</span><div class="seg small">${seg('rodzaj', 'zmienny', 'Zmienny')}${seg('rodzaj', 'staly', 'Stały (czynsz, abonament)')}</div></label>
      <label class="field"><span>Domyślnie</span><div class="seg small">${seg('domyslna_potrzeba', 'niezbedny', 'Niezbędny')}${seg('domyslna_potrzeba', 'zachcianka', 'Zachcianka')}</div></label>` : ''}
      <label class="field"><span>Widoczność</span><div class="seg small">${seg('aktywna', 'true', 'Aktywna')}${seg('aktywna', 'false', 'Ukryta')}</div></label>
      <div class="sheet-foot"><button class="primary" data-act="c-save">Zapisz</button></div>
    </div>`;
}

function saveCatForm() {
  const c = ui.catForm;
  c.nazwa = $('#c-name').value.trim();
  c.ikona = $('#c-icon').value.trim() || '🏷️';
  c.kolor = $('#c-color').value;
  if (!c.nazwa) return shake('#c-name', 'Podaj nazwę');
  if (c.isNew) {
    const base = c.nazwa.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'kategoria';
    let id = base;
    let i = 2;
    while (state.categories.some((x) => x.id === id)) id = `${base}_${i++}`;
    c.id = id;
  }
  const { isNew, ...cat } = c;
  store.saveCategory(cat);
  closeModal();
  toast(isNew ? 'Dodano kategorię' : 'Zapisano kategorię');
}

// ───────────────────────── toast ─────────────────────────

function renderToast() {
  const el = $('#toast');
  if (!el) return;
  const t = ui.toast;
  el.innerHTML = t ? `<div class="toast-in"><span>${esc(t.msg)}</span>${t.action ? `<button data-act="toast-action">${esc(t.action.label)}</button>` : ''}</div>` : '';
}

// ───────────────────────── CSV ─────────────────────────

function exportCsv(scope) {
  const cm = catMap();
  const list = (scope === 'all' ? state.transactions.filter((t) => !t.usunieto) : txInPeriod(state.transactions, period(), startDay()))
    .sort((a, b) => a.data.localeCompare(b.data));
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Data', 'Typ', 'Kwota', 'Kategoria', 'Opis', 'Potrzeba', 'Osoba'].join(';')];
  for (const t of list) {
    lines.push([t.data, t.typ === 'przychod' ? 'przychód' : 'wydatek', String(t.kwota).replace('.', ','), q(cm.get(t.kategoria_id)?.nazwa || t.kategoria_id), q(t.opis), t.potrzeba === 'zachcianka' ? 'zachcianka' : 'niezbędny', q(t.osoba)].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `budzet-${scope === 'all' ? 'wszystko' : period()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ───────────────────────── zdarzenia ─────────────────────────

const ACTIONS = {
  // start
  demo: () => startDemo(),
  'save-client': () => {
    const v = $('#client-id').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) {
      ui.error = 'To nie wygląda na Client ID (powinien kończyć się na .apps.googleusercontent.com).';
      return render();
    }
    localStorage.setItem('bud.clientId', v);
    ui.error = '';
    prepareAuth();
    go('signin');
  },
  signin: () => doSignIn(),
  signout: () => {
    signOut();
    if (ui.phase === 'app') {
      toast('Wylogowano');
      renderApp();
    } else go('signin');
  },
  'create-sheet': async () => {
    ui.busy = true;
    ui.error = '';
    render();
    try {
      const id = await createSpreadsheet(SPREADSHEET_TITLE);
      ui.busy = false;
      await startSheets(id);
      toast('Arkusz utworzony na Twoim Dysku');
    } catch (e) {
      ui.busy = false;
      if (e instanceof AuthError) return go('signin');
      ui.error = e.message;
      render();
    }
  },
  'join-sheet': async () => {
    const id = parseSpreadsheetId($('#sheet-link').value);
    if (!id) {
      ui.error = 'Nie rozpoznaję linku. Skopiuj adres arkusza z paska przeglądarki.';
      return render();
    }
    ui.busy = true;
    ui.error = '';
    render();
    try {
      await new SheetsBackend(id).loadAll(); // sprawdzamy dostęp, zanim przełączymy aplikację
      ui.busy = false;
      await startSheets(id);
      toast('Podłączono wspólny arkusz');
    } catch (e) {
      ui.busy = false;
      if (e instanceof AuthError) return go('signin');
      ui.error = e.message;
      render();
    }
  },
  // nawigacja
  period: (el) => {
    const d = Number(el.dataset.d);
    ui.period = d === 0 ? currentKey() : shiftPeriod(period(), d);
    if (ui.period === currentKey()) ui.period = null;
    renderApp();
  },
  sync: () => {
    if (state.sync.status === 'auth') return doSignIn();
    store.refresh();
  },
  add: () => openForm(),
  close: () => closeModal(),
  'edit-tx': (el) => {
    const t = state.transactions.find((x) => x.id === el.dataset.id);
    if (t) openForm(t);
  },
  'cat-hist': (el) => {
    ui.hist = { type: 'all', q: '', cat: el.dataset.id };
    location.hash = '#/historia';
  },
  'hist-type': (el) => {
    ui.hist.type = el.dataset.v;
    renderApp();
  },
  // formularz
  'f-set': (el) => {
    const f = ui.form;
    syncFormInputs();
    f[el.dataset.field] = el.dataset.v;
    if (el.dataset.field === 'potrzeba') f.potrzebaTouched = true;
    if (el.dataset.field === 'typ') f.kategoria_id = '';
    renderModal();
  },
  'f-cat': (el) => {
    const f = ui.form;
    syncFormInputs();
    f.kategoria_id = el.dataset.id;
    if (!f.potrzebaTouched) f.potrzeba = catMap().get(f.kategoria_id)?.domyslna_potrzeba || 'niezbedny';
    renderModal();
  },
  'f-save': () => {
    syncFormInputs();
    saveForm();
  },
  'f-delete': () => {
    const t = state.transactions.find((x) => x.id === ui.form.id);
    closeModal();
    if (!t) return;
    store.deleteTransaction(t);
    toast('Usunięto', { label: 'Cofnij', fn: () => store.restoreTransaction(t) });
  },
  'toast-action': () => {
    const a = ui.toast?.action;
    ui.toast = null;
    renderToast();
    a?.fn();
  },
  // budżet
  'copy-prev': () => {
    const d = budgetDraftFor(period());
    const prev = shiftPeriod(period(), -1);
    const limits = {};
    for (const b of state.budgets) if (b.okres === prev && b.limit > 0) limits[b.kategoria_id] = String(b.limit);
    if (!Object.keys(limits).length) return toast('Poprzedni okres nie miał budżetu');
    d.limits = limits;
    const pp = state.periods.find((p) => p.okres === prev);
    if (pp && !d.przychody_plan) d.przychody_plan = pp.przychody_plan ? String(pp.przychody_plan) : '';
    if (pp && !d.cel_oszczednosci) d.cel_oszczednosci = pp.cel_oszczednosci ? String(pp.cel_oszczednosci) : '';
    d.dirty = true;
    renderApp();
    toast('Skopiowano — sprawdź i zapisz');
  },
  suggest: () => {
    const d = budgetDraftFor(period());
    const sug = suggestBudgets(state.transactions, period(), startDay(), 3);
    if (!Object.keys(sug).length) return toast('Za mało historii — wpisz limity ręcznie');
    d.limits = Object.fromEntries(Object.entries(sug).map(([k, v]) => [k, String(v)]));
    d.dirty = true;
    renderApp();
    toast('Propozycja ze średniej — teraz przytnij zachcianki');
  },
  'save-budget': () => {
    const d = budgetDraftFor(period());
    const key = period();
    const n = (v) => {
      const x = parseAmount(v);
      return Number.isFinite(x) && x > 0 ? x : 0;
    };
    const existing = new Set(state.budgets.filter((b) => b.okres === key).map((b) => b.kategoria_id));
    const list = [];
    for (const [cid, v] of Object.entries(d.limits)) if (n(v) || existing.has(cid)) list.push({ okres: key, kategoria_id: cid, limit: n(v) });
    for (const cid of existing) if (!(cid in d.limits)) list.push({ okres: key, kategoria_id: cid, limit: 0 });
    store.saveBudgets(list);
    store.savePeriod({ okres: key, przychody_plan: n(d.przychody_plan), cel_oszczednosci: n(d.cel_oszczednosci) });
    ui.draft = null;
    document.activeElement?.blur();
    renderApp();
    toast('Budżet zapisany');
  },
  // ustawienia
  'copy-link': async () => {
    const id = localStorage.getItem('bud.sheetId');
    try {
      await navigator.clipboard.writeText(spreadsheetUrl(id));
      toast('Skopiowano link do arkusza');
    } catch {
      prompt('Skopiuj link:', spreadsheetUrl(id));
    }
  },
  disconnect: () => {
    if (!confirm('Odłączyć arkusz na tym urządzeniu? Dane w arkuszu zostaną nietknięte. Niezsynchronizowane zmiany z tego urządzenia przepadną.')) return;
    const id = localStorage.getItem('bud.sheetId');
    store.clearLocal(id);
    localStorage.removeItem('bud.sheetId');
    location.reload();
  },
  'exit-demo': () => {
    localStorage.removeItem('bud.mode');
    location.hash = '';
    location.reload();
  },
  'reset-demo': () => {
    DemoBackend.reset();
    store.clearLocal('demo');
    location.reload();
  },
  csv: (el) => exportCsv(el.dataset.scope),
  'new-cat': () => openCatForm(),
  'edit-cat': (el) => openCatForm(state.categories.find((c) => c.id === el.dataset.id)),
  'c-set': (el) => {
    const c = ui.catForm;
    c.nazwa = $('#c-name').value;
    c.ikona = $('#c-icon').value;
    c.kolor = $('#c-color').value;
    const v = el.dataset.v;
    c[el.dataset.field] = v === 'true' ? true : v === 'false' ? false : v;
    renderModal();
  },
  'c-save': () => saveCatForm(),
};

function syncFormInputs() {
  const f = ui.form;
  if (!f) return;
  const a = $('#f-amount');
  const d = $('#f-date');
  const o = $('#f-desc');
  if (a) f.kwotaStr = a.value;
  if (d) f.data = d.value;
  if (o) f.opis = o.value;
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el);
});

root.addEventListener('input', (e) => {
  const t = e.target;
  if (ui.form && ['f-amount', 'f-date', 'f-desc'].includes(t.id)) {
    syncFormInputs();
    if (t.id !== 'f-desc') updateImpact();
    return;
  }
  if (t.id === 'h-q') {
    ui.hist.q = t.value;
    $('#h-list').innerHTML = histList();
    return;
  }
  if (t.dataset.bf || t.dataset.limit !== undefined) {
    const d = budgetDraftFor(period());
    if (t.dataset.bf) d[t.dataset.bf] = t.value;
    else d.limits[t.dataset.limit] = t.value;
    d.dirty = true;
    $('#b-bilans').innerHTML = bilansHtml(d);
    $('#b-dirty').textContent = 'Niezapisane zmiany';
  }
});

root.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'h-cat') {
    ui.hist.cat = t.value;
    $('#h-list').innerHTML = histList();
  }
  if (t.id === 'start-day') {
    store.setMeta('dzien_startu_okresu', Number(t.value));
    ui.period = null;
    ui.draft = null;
    toast('Zmieniono początek okresu');
  }
});

root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ui.form && ['f-amount', 'f-desc'].includes(e.target.id)) {
    e.preventDefault();
    if (e.target.id === 'f-amount' && !ui.form.kategoria_id) {
      e.target.blur(); // chowa klawiaturę, widać kategorie
      return;
    }
    ACTIONS['f-save']();
  }
  if (e.key === 'Escape' && (ui.form || ui.catForm)) closeModal();
});

// Po wyjściu z pola w widoku budżetu dorysuj zaległe zmiany (np. dane od drugiej osoby).
root.addEventListener('focusout', () => {
  setTimeout(() => {
    const a = document.activeElement;
    if (ui.phase === 'app' && !(a && a.matches('input, select, textarea') && a.closest('#main'))) {
      // tylko jeśli widok mógł się zestarzeć — tani test: porównanie liczby transakcji
      if (root.dataset.txn !== String(state.transactions.length)) {
        root.dataset.txn = String(state.transactions.length);
        if (ui.view !== 'budzet') renderApp();
      }
    }
  }, 0);
});

boot();
