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
import {
  CYCLES, cycleLabel, isRecurring, periodOccurrences, occurrencesInRange, occurrencesBetween, isPending, occKey,
  withSkip, nextOccurrence, annualCost, activePlans, addDays, daysUntil,
} from './planned.js';

const VERSION = '1.1.0';
const root = document.getElementById('app');
const PLACEHOLDER = GOOGLE_CLIENT_ID.startsWith('WKLEJ');

const ui = {
  phase: 'boot', // boot | setup-client | signin | pick-sheet | app
  mode: localStorage.getItem('bud.mode'), // 'google' | 'demo' | null
  view: 'pulpit',
  period: null,
  form: null, // otwarty formularz transakcji
  catForm: null, // otwarty formularz kategorii
  planForm: null, // otwarty formularz wydatku planowanego
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

/** Niezapłacone i niepominięte terminy planów w okresie — rezerwują limity. */
function pendingPlanned(key, txs = state.transactions, { excludeOcc = null, excludePlanId = null } = {}) {
  const plans = excludePlanId ? state.plans.filter((p) => p.id !== excludePlanId) : state.plans;
  return periodOccurrences(plans, txs, key, startDay(), today()).filter((o) => isPending(o) && o.key !== excludeOcc);
}

function getSummary(key = period(), { excludeTxId = null, excludeOcc = null, excludePlanId = null } = {}) {
  const txs = excludeTxId ? state.transactions.filter((t) => t.id !== excludeTxId) : state.transactions;
  return summarize({
    transactions: txs,
    planned: pendingPlanned(key, txs, { excludeOcc, excludePlanId }),
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
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

/** Pasek postępu; plannedFrac = część zarezerwowana na zaplanowane płatności (kreskowana). */
function bar(frac, status, tick = null, plannedFrac = 0) {
  const w = Math.max(0, Math.min(100, (frac || 0) * 100));
  const pw = Math.max(0, Math.min(100 - w, (plannedFrac || 0) * 100));
  return `<div class="bar s-${status}"><i style="width:${w}%"></i>${pw > 0 ? `<i class="pl" style="left:${w}%;width:${pw}%"></i>` : ''}${tick !== null && tick > 0 && tick < 1 ? `<b style="left:${tick * 100}%" title="dzisiaj"></b>` : ''}</div>`;
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
  ui.view = ['pulpit', 'historia', 'planowane', 'budzet', 'raporty', 'ustawienia'].includes(v) ? v : 'pulpit';
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
  if (ui.planForm) updatePlanPreview();
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

  const showPeriod = ['pulpit', 'historia', 'planowane', 'budzet', 'raporty'].includes(ui.view);
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
    ${item('planowane', 'calendar', 'Planowane')}
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
        <p class="muted">Wydano dotąd <b>${zl(s.spent)}</b>${s.planned ? `, zaplanowano <b>${zl(s.planned)}</b>` : ''}. Ustal limity na kategorie, a aplikacja pokaże, ile możecie jeszcze wydać — każdego dnia.</p>
        <a class="primary" href="#/budzet">Ustal budżet</a>
      </section>`;
  } else {
    const st = s.remaining < 0 ? 'over' : s.spentFrac >= 0.9 || (tick !== null && s.spentFrac > tick + 0.1) ? 'warn' : 'ok';
    const label = s.state === 'past' ? (s.remaining < 0 ? 'Budżet przekroczony o' : 'Zostało na koniec okresu') : s.remaining < 0 ? 'Budżet przekroczony o' : 'Zostało do wydania';
    hero = `
      <section class="card hero s-${st}">
        <div class="hero-label">${label}</div>
        <div class="hero-amount">${zl(Math.abs(s.remaining))}</div>
        <div class="hero-sub">wydano ${zl(s.spent)}${s.planned ? ` + zaplanowano <a href="#/planowane">${zl(s.planned)}</a>` : ''} z ${zl(s.totalLimit)}</div>
        ${bar(s.spentFrac, st, tick, s.plannedFrac)}
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
        <div class="tile-sub">dziennie przez ${days(s.daysLeft)}${s.planned ? ' · po odłożeniu na planowane' : ''}</div>
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
    if (c.status === 'over') {
      alerts.push(c.overByPlan
        ? `<div class="alert s-over"><b>${c.cat.ikona} ${esc(c.cat.nazwa)}</b>: razem z zaplanowanymi płatnościami limit zostanie przekroczony o ${zl(-c.remaining)}</div>`
        : `<div class="alert s-over"><b>${c.cat.ikona} ${esc(c.cat.nazwa)}</b>: limit przekroczony o ${zl(-c.remaining)}</div>`);
    }
  }
  for (const c of s.cats) {
    if (c.paceWarn) alerts.push(`<div class="alert s-warn"><b>${c.cat.ikona} ${esc(c.cat.nazwa)}</b>: wydano już ${pct(c.pct)} limitu, a minęło ${pct(s.elapsedFrac)} okresu — zwolnijcie.</div>`);
  }
  if (s.totalLimit && s.unbudgetedSpent + s.unbudgetedPlanned > 0) {
    alerts.push(`<div class="alert s-warn">Wydatki${s.unbudgetedPlanned ? ' (i planowane)' : ''} bez limitu: <b>${zl(s.unbudgetedSpent + s.unbudgetedPlanned)}</b> — też zmniejszają kwotę „zostało”. <a href="#/budzet">Dodaj limity</a></div>`);
  }
  const overdue = s.state === 'current' ? pendingPlanned(period()).filter((o) => o.status === 'overdue') : [];
  if (overdue.length) {
    alerts.unshift(`<div class="alert s-over">${overdue.length === 1 ? `Płatność „${esc(overdue[0].plan.nazwa)}” jest po terminie` : `${overdue.length} planowane płatności są po terminie`} (${zl(overdue.reduce((a, o) => a + o.amount, 0))}). <a href="#/planowane">Zobacz</a></div>`);
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
          ${c.limit ? bar(c.pct, c.paceWarn ? 'warn' : c.status, c.cat.rodzaj === 'staly' ? null : tick, c.plannedPct) : bar(1, 'nolimit')}
          <span class="cat-nums">${zl(c.spent)}${c.planned ? ` + plan ${zl(c.planned)}` : ''}${c.limit ? ` z ${zl(c.limit)} · ${pct((c.spent + c.planned) / c.limit)}` : ''}</span>
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
        ${plannedCard(cm)}
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
        <span class="tx-title">${esc(t.opis || c.nazwa)}${t.plan_id ? '<em class="plan-tag">plan</em>' : ''}${t.potrzeba === 'zachcianka' && !inc ? '<em class="want">zachcianka</em>' : ''}</span>
        <span class="tx-meta">${meta}</span>
      </span>
      <span class="tx-amt ${inc ? 'inc' : ''}">${inc ? '+' : '−'}${zl(t.kwota)}</span>
    </button>`;
}

// ───────────────────────── PLANOWANE ─────────────────────────

/** Terminy do zapłaty: niezapłacone w okresie + (dla bieżącego okresu) przypomnienia na 3 dni naprzód. */
function upcomingOccurrences() {
  const key = period();
  const td = today();
  const list = periodOccurrences(state.plans, state.transactions, key, startDay(), td).filter(isPending);
  if (key === currentKey()) {
    const r = periodRange(key, startDay());
    list.push(...occurrencesInRange(state.plans, state.transactions, addDays(r.end, 1), addDays(td, 3), td).filter(isPending));
  }
  return list;
}

function whenLabel(o) {
  if (o.status === 'paid') return { txt: `zapłacono ${zl(o.tx.kwota)} · ${dateShort(o.tx.data)}`, cls: 't-ok' };
  if (o.status === 'skipped') return { txt: `pominięto · ${dateShort(o.date)}`, cls: '' };
  const d = daysUntil(o.date, today());
  if (d < 0) return { txt: `po terminie · ${dateShort(o.date)}`, cls: 't-over' };
  if (d === 0) return { txt: 'dzisiaj', cls: 't-warn' };
  if (d === 1) return { txt: 'jutro', cls: 't-warn' };
  if (d <= 3) return { txt: `za ${d} dni · ${dateShort(o.date)}`, cls: 't-warn' };
  return { txt: dateShort(o.date), cls: '' };
}

function occRow(o, cm, full = false) {
  const c = cm.get(o.kategoria_id) || { nazwa: o.kategoria_id || 'Bez kategorii', ikona: '❔', kolor: '#888' };
  const w = whenLabel(o);
  const ds = `data-plan="${esc(o.plan.id)}" data-date="${esc(o.date)}"`;
  let act = '';
  if (isPending(o)) act = `${full ? `<button class="mini" data-act="skip-occ" ${ds} title="Pomiń ten termin">Pomiń</button>` : ''}<button class="mini primary" data-act="pay-occ" ${ds}>Zapłać</button>`;
  else if (o.status === 'skipped' && full) act = `<button class="mini" data-act="unskip-occ" ${ds}>Przywróć</button>`;
  else if (o.status === 'paid') act = `<button class="mini ghost" data-act="edit-tx" data-id="${esc(o.tx.id)}" title="Pokaż płatność">✓</button>`;
  return `
    <div class="tx occ st-${o.status}${full && o.status !== 'paid' ? ' full' : ''}">
      <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
      <button class="tx-main plain" data-act="edit-plan" data-id="${esc(o.plan.id)}">
        <span class="tx-title">${esc(o.plan.nazwa || c.nazwa)}</span>
        <span class="tx-meta"><span class="${w.cls}">${w.txt}</span> · ${esc(c.nazwa)}${isRecurring(o.plan) ? ` · ${cycleLabel(o.plan.cykl)}` : ''}</span>
      </button>
      <span class="tx-amt">${zl(o.amount)}</span>
      <span class="occ-act">${act}</span>
    </div>`;
}

function plannedCard(cm) {
  const list = upcomingOccurrences();
  if (!list.length) return '';
  const total = round2(list.reduce((a, o) => a + o.amount, 0));
  const shown = list.slice(0, 5);
  return `
    <section class="card">
      <div class="card-head"><h2>Do zapłaty</h2><a href="#/planowane" class="small-link">Planowane</a></div>
      <p class="muted small">Czeka ${zl(total)}. Płatności z tego okresu są już odjęte od kwoty „zostało”.</p>
      <div class="tx-list">${shown.map((o) => occRow(o, cm)).join('')}</div>
      ${list.length > shown.length ? `<a class="small-link" href="#/planowane">+ jeszcze ${list.length - shown.length}</a>` : ''}
    </section>`;
}

function viewPlanowane() {
  if (!state.hasData) return `<div class="empty">Wczytywanie danych…</div>`;
  const key = period();
  const sd = startDay();
  const td = today();
  const cm = catMap();
  const occ = periodOccurrences(state.plans, state.transactions, key, sd, td);
  const paid = round2(occ.filter((o) => o.status === 'paid').reduce((a, o) => a + o.tx.kwota, 0));
  const pending = round2(occ.filter(isPending).reduce((a, o) => a + o.amount, 0));
  const plans = activePlans(state.plans);
  const ico = (p) => cm.get(p.kategoria_id) || { nazwa: p.kategoria_id || 'Bez kategorii', ikona: '❔', kolor: '#888' };

  const rec = plans.filter(isRecurring)
    .map((p) => ({ p, next: nextOccurrence(p, state.transactions, td), year: annualCost(p, td) }))
    .sort((a, b) => (a.next ? 0 : 1) - (b.next ? 0 : 1) || (a.next?.date || '').localeCompare(b.next?.date || '') || b.year - a.year);
  const curStart = periodRange(currentKey(), sd).start;
  const once = plans.filter((p) => !isRecurring(p) && p.data >= curStart)
    .map((p) => ({ p, o: occurrencesInRange([p], state.transactions, p.data, p.data, td)[0] }))
    .filter((x) => x.o)
    .sort((a, b) => a.p.data.localeCompare(b.p.data));
  const yearTotal = round2(rec.reduce((a, x) => a + x.year, 0));

  const planRow = (p, meta, right) => {
    const c = ico(p);
    return `
      <button class="tx" data-act="edit-plan" data-id="${esc(p.id)}">
        <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
        <span class="tx-main"><span class="tx-title">${esc(p.nazwa || c.nazwa)}</span><span class="tx-meta">${meta}</span></span>
        <span class="plan-right">${right}</span>
      </button>`;
  };

  return `
    <div class="grid-dash">
      <div class="col">
        <button class="primary wide add-plan" data-act="add-plan">${icon('plus')}Dodaj planowany wydatek</button>
        <section class="card">
          <h2>Terminy w okresie ${periodLabel(key, sd).toLowerCase()}</h2>
          ${occ.length ? `
          <div class="plan-sum">
            <div><small>Do zapłaty</small><b class="${pending ? '' : 't-ok'}">${zl(pending)}</b></div>
            <div><small>Zapłacono</small><b>${zl(paid)}</b></div>
          </div>
          <div class="tx-list">${occ.map((o) => occRow(o, cm, true)).join('')}</div>
          <p class="muted small">Niezapłacone terminy rezerwują pieniądze w limitach kategorii, więc pulpit pokazuje, ile naprawdę zostaje na resztę. „Zapłać” zapisuje wydatek powiązany z terminem, „Pomiń” — zwalnia rezerwację tylko dla tego terminu.</p>`
            : `<p class="muted">Brak planowanych płatności w tym okresie.</p>
          <p class="muted small">Dodaj opłaty, które się powtarzają (czynsz, abonamenty, ubezpieczenie), albo znane wydatki w przyszłości (przegląd auta, prezent, wakacje). Pojawią się na pulpicie jako planowane i od razu zmniejszą kwotę do wydania w swoim miesiącu.</p>`}
        </section>
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Cykliczne</h2><button class="small-link" data-act="add-plan" data-kind="cykl">+ Nowy</button></div>
          ${rec.length ? `<div class="tx-list">${rec.map(({ p, next, year }) => planRow(
            p,
            `${cycleLabel(p.cykl)} · ${next ? `następny ${dateShort(next.date)}` : 'zakończony'}`,
            `<b>${zl(p.kwota)}</b><small>${zl(year)} / rok</small>`,
          )).join('')}</div>` : '<p class="muted">Brak. Np. czynsz, prąd, Netflix, przedszkole.</p>'}
        </section>
        <section class="card">
          <div class="card-head"><h2>Jednorazowe</h2><button class="small-link" data-act="add-plan" data-kind="raz">+ Nowy</button></div>
          ${once.length ? `<div class="tx-list">${once.map(({ p, o }) => {
            const w = whenLabel(o);
            return planRow(p, `<span class="${w.cls}">${w.txt}</span>`, `<b>${zl(p.kwota)}</b>`);
          }).join('')}</div>` : '<p class="muted">Brak. Np. przegląd auta, prezent, wyjazd.</p>'}
        </section>
        ${rec.length ? `
        <section class="card">
          <h2>Zestawienie roczne</h2>
          <p>Opłaty cykliczne w ciągu 12 miesięcy: <b>${zl(yearTotal)}</b> — średnio <b>${zl(round2(yearTotal / 12))}</b> miesięcznie.</p>
          <div class="struct">${[...rec].sort((a, b) => b.year - a.year).map(({ p, year }) => `
            <div class="st-row">
              <span class="st-name">${ico(p).ikona} ${esc(p.nazwa || ico(p).nazwa)}</span>
              <span class="st-bar"><i style="width:${yearTotal ? (year / yearTotal) * 100 : 0}%;background:${esc(ico(p).kolor || '#888')}"></i></span>
              <span class="st-val">${zl(year)} <small>${pct(yearTotal ? year / yearTotal : 0)}</small></span>
            </div>`).join('')}</div>
        </section>` : ''}
      </div>
    </div>`;
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

/** Suma planowanych płatności (bez pominiętych) w okresie, wg kategorii — do ustalania limitów. */
function plannedForBudget(key) {
  const m = new Map();
  for (const o of periodOccurrences(state.plans, state.transactions, key, startDay(), today())) {
    if (o.status !== 'skipped') m.set(o.kategoria_id, round2((m.get(o.kategoria_id) || 0) + o.amount));
  }
  return m;
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
  const plannedCat = plannedForBudget(key);

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
            <li>Wydatki z zakładki <b>Planowane</b> rezerwują limit swojej kategorii — limit powinien je pokryć.</li>
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
            ${plannedCat.size ? '<button data-act="plan-limits" title="Podnieś limity tam, gdzie nie pokrywają planowanych płatności">Pokryj planowane</button>' : ''}
          </div>
          <div class="limits">
            ${cats.map((c) => `
              <label class="limit-row">
                <span class="cat-ico" style="--c:${esc(c.kolor)}">${c.ikona}</span>
                <span class="limit-main">
                  <span class="cat-name">${esc(c.nazwa)}${c.rodzaj === 'staly' ? ' <em>stały</em>' : ''}</span>
                  <small>${[
                    plannedCat.get(c.id) ? `<span class="${(parseAmount(d.limits[c.id] || '') || 0) < plannedCat.get(c.id) ? 't-warn' : ''}">plan: ${zl(plannedCat.get(c.id))}</span>` : '',
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

const VIEWS = { pulpit: viewPulpit, historia: viewHistoria, planowane: viewPlanowane, budzet: viewBudzet, raporty: viewRaporty, ustawienia: viewUstawienia };

// ───────────────────────── FORMULARZ TRANSAKCJI ─────────────────────────

function openForm(tx = null, preset = {}) {
  const sd = startDay();
  const r = periodRange(period(), sd);
  const defDate = inRange(today(), r) ? today() : r.end; // przeglądając stary miesiąc, domyślnie jego ostatni dzień
  ui.form = tx
    ? { ...tx, kwotaStr: String(tx.kwota).replace('.', ','), isNew: false, potrzebaTouched: true }
    : { id: store.newId(), typ: 'wydatek', kwotaStr: '', kategoria_id: '', potrzeba: 'niezbedny', data: defDate, opis: '', osoba: userName(), isNew: true, potrzebaTouched: false, usunieto: false, plan_id: '', plan_data: '', ...preset };
  renderModal();
  setTimeout(() => {
    const el = $('#f-amount');
    if (el && ui.form?.isNew) el.focus();
  }, 60);
}

function closeModal() {
  ui.form = null;
  ui.catForm = null;
  ui.planForm = null;
  renderModal();
}

function sortedCats(typ, selected = ui.form?.kategoria_id) {
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const use = {};
  for (const t of state.transactions) if (!t.usunieto && t.data >= since) use[t.kategoria_id] = (use[t.kategoria_id] || 0) + 1;
  return state.categories
    .filter((c) => c.typ === typ && (c.aktywna || c.id === selected))
    .sort((a, b) => (use[b.id] || 0) - (use[a.id] || 0) || a.kolejnosc - b.kolejnosc);
}

function renderModal() {
  const m = $('#modal');
  if (!m) return;
  if (ui.catForm) return renderCatModal(m);
  if (ui.planForm) return renderPlanModal(m);
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
      ${f.plan_id ? `<div class="plan-link">${icon('calendar')}<span>Płatność planowana: <b>${esc(state.plans.find((p) => p.id === f.plan_id)?.nazwa || '—')}</b> · termin ${dateShort(f.plan_data)}</span></div>` : ''}
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
    const s = getSummary(key, { excludeTxId: f.isNew ? null : f.id, excludeOcc: f.plan_id ? occKey(f.plan_id, f.plan_data) : null });
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
    utworzono: f.utworzono || '', usunieto: false, plan_id: f.plan_id || '', plan_data: f.plan_data || '',
  };
  const isNew = f.isNew;
  store.saveTransaction(tx, isNew);
  closeModal();
  if (isNew) {
    const saved = state.transactions.find((t) => t.id === tx.id);
    toast(tx.plan_id ? `Zapłacono ${zl(amount)} — termin rozliczony` : `Zapisano ${zl(amount)}`, { label: 'Cofnij', fn: () => store.deleteTransaction(saved) });
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

// ───────────────────────── FORMULARZ WYDATKU PLANOWANEGO ─────────────────────────

function openPlanForm(p = null, kind = 'cykl') {
  ui.planForm = p
    ? { ...p, kwotaStr: String(p.kwota).replace('.', ','), isNew: false, rodzaj: isRecurring(p) ? 'cykl' : 'raz', cyklSel: isRecurring(p) ? p.cykl : 'miesiac', potrzebaTouched: true }
    : {
      id: store.newId(), nazwa: '', kwotaStr: '', kategoria_id: '', potrzeba: 'niezbedny', rodzaj: kind, cyklSel: 'miesiac',
      data: kind === 'raz' ? addDays(today(), 7) : today(), data_koniec: '', pominiete: '', osoba: userName(), isNew: true, potrzebaTouched: false, usunieto: false,
    };
  renderModal();
  setTimeout(() => {
    if (ui.planForm?.isNew) $('#p-amount')?.focus();
  }, 60);
}

/** Plan zbudowany z formularza (bez walidacji) — do podglądu terminów i zapisu. */
function planFromForm(f) {
  return {
    id: f.id, nazwa: (f.nazwa || '').trim(), kwota: parseAmount(f.kwotaStr), kategoria_id: f.kategoria_id, potrzeba: f.potrzeba,
    cykl: f.rodzaj === 'cykl' ? f.cyklSel : 'jednorazowo', data: f.data, data_koniec: f.rodzaj === 'cykl' ? f.data_koniec || '' : '',
    pominiete: f.pominiete || '', osoba: f.osoba || userName(), utworzono: f.utworzono || '', usunieto: false,
  };
}

function renderPlanModal(m) {
  const f = ui.planForm;
  document.body.classList.add('modal-open');
  const seg = (field, v, l) => `<button class="${f[field] === v ? 'on' : ''}" data-act="p-set" data-field="${field}" data-v="${v}">${l}</button>`;
  const cyc = f.rodzaj === 'cykl';
  m.innerHTML = `
    <div class="overlay" data-act="close"></div>
    <div class="sheet" role="dialog" aria-label="Wydatek planowany">
      <div class="sheet-head">
        <div class="seg">${seg('rodzaj', 'cykl', 'Cykliczny')}${seg('rodzaj', 'raz', 'Jednorazowy')}</div>
        <button class="icon-btn" data-act="close" aria-label="Zamknij">${icon('close')}</button>
      </div>
      <div class="amount">
        <input id="p-amount" inputmode="decimal" placeholder="0" value="${esc(f.kwotaStr)}" autocomplete="off" enterkeyhint="next">
        <span>zł</span>
      </div>
      <input id="p-name" placeholder="${cyc ? 'Nazwa, np. Czynsz, Netflix, przedszkole' : 'Nazwa, np. Przegląd auta, prezent dla mamy'}" value="${esc(f.nazwa)}" autocomplete="off" maxlength="80">
      <div class="cat-grid">
        ${sortedCats('wydatek', f.kategoria_id).map((c) => `
          <button class="cg ${f.kategoria_id === c.id ? 'on' : ''}" data-act="p-cat" data-id="${esc(c.id)}" style="--c:${esc(c.kolor)}">
            <span>${c.ikona}</span><small>${esc(c.nazwa)}</small>
          </button>`).join('')}
      </div>
      <div class="seg small">${seg('potrzeba', 'niezbedny', 'Niezbędny')}${seg('potrzeba', 'zachcianka', 'Zachcianka')}</div>
      ${cyc ? `
      <div class="row2 plan-dates">
        <label class="field"><span>Powtarzaj</span>
          <select id="p-cycle">${Object.entries(CYCLES).filter(([k]) => k !== 'jednorazowo').map(([k, c]) => `<option value="${k}" ${f.cyklSel === k ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <label class="field"><span>Pierwszy termin</span><input id="p-date" type="date" value="${esc(f.data)}"></label>
      </div>
      <label class="field"><span>Do kiedy (puste = bez końca)</span><input id="p-end" type="date" value="${esc(f.data_koniec)}"></label>`
      : `<label class="field"><span>Termin płatności</span><input id="p-date" type="date" value="${esc(f.data)}"></label>`}
      <div id="p-preview" class="impact"></div>
      <div class="sheet-foot">
        ${f.isNew ? '' : `<button class="danger-outline" data-act="p-delete">Usuń</button>`}
        <button class="primary" data-act="p-save">${f.isNew ? 'Dodaj do planu' : 'Zapisz'}</button>
      </div>
    </div>`;
  updatePlanPreview();
}

function updatePlanPreview() {
  const f = ui.planForm;
  const el = $('#p-preview');
  if (!f || !el) return;
  const p = planFromForm(f);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.data || '')) {
    el.innerHTML = '<span class="muted">Podaj termin</span>';
    return;
  }
  const td = today();
  const from = p.data > td ? p.data : td;
  const next = occurrencesBetween(p, from, addDays(from, 800)).slice(0, 3);
  const lines = [];
  if (isRecurring(p)) {
    lines.push(next.length ? `<span class="muted">Najbliższe terminy: <b>${next.map(dateShort).join(', ')}</b>${Number.isFinite(p.kwota) && p.kwota > 0 ? ` · rocznie ${zl(annualCost(p, td))}` : ''}</span>` : '<span class="t-warn">Brak terminów od dziś — sprawdź daty.</span>');
  } else if (p.data < td) {
    lines.push('<span class="t-warn">Termin już minął — taki wydatek lepiej dodać zwykłym „+”.</span>');
  }
  const amount = Number.isFinite(p.kwota) ? p.kwota : 0;
  const first = next[0];
  if (first && p.kategoria_id && amount > 0) {
    const key = periodKeyFor(first, startDay());
    const s = getSummary(key, { excludePlanId: p.id });
    const inPeriod = round2(occurrencesBetween(p, periodRange(key, startDay()).start, periodRange(key, startDay()).end).filter((d) => d >= td).length * amount);
    const im = impactOf(s, p.kategoria_id, inPeriod);
    const cat = catMap().get(p.kategoria_id);
    const lab = periodLabel(key, startDay()).toLowerCase();
    if (im.overCat) lines.push(`<span class="t-over">⚠ W okresie ${lab} limit „${esc(cat?.nazwa)}” zostanie przekroczony o <b>${zl(-im.catRemainingAfter)}</b></span>`);
    else if (im.hasLimit) lines.push(`<span class="t-ok">✓ ${lab}: w limicie „${esc(cat?.nazwa)}” zostanie <b>${zl(im.catRemainingAfter)}</b> z ${zl(im.limit)}</span>`);
    else lines.push(`<span class="t-warn">„${esc(cat?.nazwa)}” nie ma limitu w okresie ${lab}${s.totalLimit ? ` · w budżecie zostanie ${zl(im.totalRemainingAfter)}` : ''}</span>`);
  }
  el.innerHTML = lines.join('<br>');
}

function savePlanForm() {
  const f = ui.planForm;
  const p = planFromForm(f);
  if (!Number.isFinite(p.kwota) || p.kwota <= 0) return shake('#p-amount', 'Wpisz kwotę');
  if (!p.kategoria_id) return shake('.cat-grid', 'Wybierz kategorię');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.data || '')) return shake('#p-date', 'Podaj termin');
  if (p.data_koniec && p.data_koniec < p.data) return shake('#p-end', 'Data końca jest przed pierwszym terminem');
  if (!p.nazwa) p.nazwa = catMap().get(p.kategoria_id)?.nazwa || 'Wydatek planowany';
  const isNew = f.isNew;
  store.savePlan(p, isNew);
  closeModal();
  toast(isNew ? `Dodano do planu: ${p.nazwa}` : 'Zapisano zmiany');
}

function syncPlanInputs() {
  const f = ui.planForm;
  if (!f) return;
  const map = { 'p-amount': 'kwotaStr', 'p-name': 'nazwa', 'p-cycle': 'cyklSel', 'p-date': 'data', 'p-end': 'data_koniec' };
  for (const [id, field] of Object.entries(map)) {
    const el = $(`#${id}`);
    if (el) f[field] = el.value;
  }
}

const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

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
  // planowane
  'add-plan': (el) => openPlanForm(null, el.dataset.kind || 'cykl'),
  'edit-plan': (el) => {
    const p = state.plans.find((x) => x.id === el.dataset.id);
    if (p) openPlanForm(p);
  },
  'p-set': (el) => {
    const f = ui.planForm;
    syncPlanInputs();
    f[el.dataset.field] = el.dataset.v;
    if (el.dataset.field === 'potrzeba') f.potrzebaTouched = true;
    renderModal();
  },
  'p-cat': (el) => {
    const f = ui.planForm;
    syncPlanInputs();
    f.kategoria_id = el.dataset.id;
    if (!f.potrzebaTouched) f.potrzeba = catMap().get(f.kategoria_id)?.domyslna_potrzeba || 'niezbedny';
    renderModal();
  },
  'p-save': () => {
    syncPlanInputs();
    savePlanForm();
  },
  'p-delete': () => {
    const p = state.plans.find((x) => x.id === ui.planForm.id);
    closeModal();
    if (!p) return;
    store.deletePlan(p);
    toast('Usunięto z planu', { label: 'Cofnij', fn: () => store.restorePlan(p) });
  },
  'pay-occ': (el) => {
    const p = state.plans.find((x) => x.id === el.dataset.plan);
    if (!p) return;
    const due = el.dataset.date;
    const td = today();
    openForm(null, {
      kwotaStr: String(p.kwota).replace('.', ','), kategoria_id: p.kategoria_id, potrzeba: p.potrzeba, potrzebaTouched: true,
      opis: p.nazwa, data: due <= td ? due : td, plan_id: p.id, plan_data: due,
    });
  },
  'skip-occ': (el) => {
    const p = state.plans.find((x) => x.id === el.dataset.plan);
    if (!p) return;
    store.savePlan(withSkip(p, el.dataset.date, true), false);
    toast(`Pominięto termin ${dateShort(el.dataset.date)}`, { label: 'Cofnij', fn: () => store.savePlan(withSkip(state.plans.find((x) => x.id === p.id), el.dataset.date, false), false) });
  },
  'unskip-occ': (el) => {
    const p = state.plans.find((x) => x.id === el.dataset.plan);
    if (p) store.savePlan(withSkip(p, el.dataset.date, false), false);
  },
  'plan-limits': () => {
    const d = budgetDraftFor(period());
    let changed = 0;
    for (const [cid, v] of plannedForBudget(period())) {
      const cur = parseAmount(d.limits[cid] || '') || 0;
      if (cur < v) {
        d.limits[cid] = String(Math.ceil(v));
        changed++;
      }
    }
    if (!changed) return toast('Limity już pokrywają planowane wydatki');
    d.dirty = true;
    renderApp();
    toast(`Podniesiono ${changed} ${plural(changed, 'limit', 'limity', 'limitów')} — sprawdź i zapisz`);
  },
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
  if (ui.planForm && ['p-amount', 'p-name', 'p-cycle', 'p-date', 'p-end'].includes(t.id)) {
    syncPlanInputs();
    if (t.id !== 'p-name') updatePlanPreview();
    return;
  }
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
  if (e.key === 'Enter' && ui.planForm && ['p-amount', 'p-name'].includes(e.target.id)) {
    e.preventDefault();
    if (e.target.id === 'p-amount') return $('#p-name')?.focus();
    e.target.blur();
    if (ui.planForm.kategoria_id) ACTIONS['p-save']();
  }
  if (e.key === 'Escape' && (ui.form || ui.catForm || ui.planForm)) closeModal();
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
