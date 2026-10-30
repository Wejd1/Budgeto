// Stan aplikacji + pamięć podręczna + kolejka zmian do wysłania (działa offline).
// Każda zmiana: 1) od razu trafia do stanu lokalnego (UI reaguje natychmiast),
// 2) ląduje w kolejce, 3) kolejka jest wysyłana do arkusza, gdy jest sieć i ważne logowanie.
import { keyOf } from './schema.js';
import { AuthError } from './auth.js';

const LIST_OF = { Transakcje: 'transactions', Kategorie: 'categories', Budzety: 'budgets', Okresy: 'periods', Planowane: 'plans' };

export const state = {
  transactions: [],
  categories: [],
  budgets: [],
  periods: [],
  plans: [],
  meta: {},
  hasData: false,
  sync: { status: 'idle', message: '', lastSync: null, pending: 0 },
};

let backend = null;
let outbox = [];
let inFlight = null;
let flushing = null;
let refreshing = null;
const listeners = new Set();
let lsKey = '';

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  state.sync.pending = outbox.reduce((a, op) => a + op.objs.length, 0);
  for (const fn of listeners) fn(state);
}

function persist() {
  try {
    localStorage.setItem(`bud.cache.${lsKey}`, JSON.stringify({
      transactions: state.transactions, categories: state.categories, budgets: state.budgets,
      periods: state.periods, plans: state.plans, meta: state.meta, lastSync: state.sync.lastSync,
    }));
    localStorage.setItem(`bud.outbox.${lsKey}`, JSON.stringify(outbox));
  } catch (e) {
    console.warn('Nie udało się zapisać pamięci podręcznej', e);
  }
}

export function useBackend(b) {
  backend = b;
  lsKey = b.id;
  outbox = [];
  Object.assign(state, { transactions: [], categories: [], budgets: [], periods: [], plans: [], meta: {}, hasData: false });
  state.sync = { status: 'idle', message: '', lastSync: null, pending: 0 };
  try {
    const c = JSON.parse(localStorage.getItem(`bud.cache.${lsKey}`));
    if (c) {
      Object.assign(state, {
        transactions: c.transactions || [], categories: c.categories || [], budgets: c.budgets || [],
        periods: c.periods || [], plans: c.plans || [], meta: c.meta || {}, hasData: true,
      });
      state.sync.lastSync = c.lastSync || null;
    }
    outbox = JSON.parse(localStorage.getItem(`bud.outbox.${lsKey}`)) || [];
  } catch { /* uszkodzona pamięć — pobierzemy od nowa */ }
  emit();
}

export function clearLocal(id) {
  localStorage.removeItem(`bud.cache.${id}`);
  localStorage.removeItem(`bud.outbox.${id}`);
}

function applyLocal(sheet, obj) {
  if (sheet === 'Meta') {
    state.meta[obj.klucz] = obj.wartosc;
    return;
  }
  const list = state[LIST_OF[sheet]];
  const k = keyOf(sheet, obj);
  const i = list.findIndex((x) => keyOf(sheet, x) === k);
  if (i >= 0) list[i] = { ...obj };
  else list.push({ ...obj });
}

function enqueue(kind, sheet, obj) {
  const k = keyOf(sheet, obj);
  // Jeśli ten sam wiersz już czeka w kolejce — podmieniamy go zamiast dokładać kolejną operację.
  for (const op of outbox) {
    if (op === inFlight || op.sheet !== sheet) continue;
    const i = op.objs.findIndex((o) => keyOf(sheet, o) === k);
    if (i >= 0) {
      op.objs[i] = { ...obj };
      return;
    }
  }
  const last = outbox[outbox.length - 1];
  if (last && last !== inFlight && last.kind === kind && last.sheet === sheet) last.objs.push({ ...obj });
  else outbox.push({ kind, sheet, objs: [{ ...obj }] });
}

function change(kind, sheet, objs) {
  for (const o of objs) {
    applyLocal(sheet, o);
    enqueue(kind, sheet, o);
  }
  persist();
  emit();
  flush();
}

const now = () => new Date().toISOString();

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}

export function saveTransaction(tx, isNew) {
  const t = { ...tx, zmodyfikowano: now() };
  if (isNew) t.utworzono = t.utworzono || now();
  change(isNew ? 'append' : 'upsert', 'Transakcje', [t]);
}

export function deleteTransaction(tx) {
  change('upsert', 'Transakcje', [{ ...tx, usunieto: true, zmodyfikowano: now() }]);
}

export function restoreTransaction(tx) {
  change('upsert', 'Transakcje', [{ ...tx, usunieto: false, zmodyfikowano: now() }]);
}

export function saveBudgets(list) {
  change('upsert', 'Budzety', list.map((b) => ({ ...b, zmodyfikowano: now() })));
}

export function savePeriod(p) {
  change('upsert', 'Okresy', [{ ...p, zmodyfikowano: now() }]);
}

export function saveCategory(c) {
  change('upsert', 'Kategorie', [c]);
}

export function saveCategories(list) {
  change('upsert', 'Kategorie', list);
}

export function savePlan(p, isNew) {
  const o = { ...p, zmodyfikowano: now() };
  if (isNew) o.utworzono = o.utworzono || now();
  change(isNew ? 'append' : 'upsert', 'Planowane', [o]);
}

export function deletePlan(p) {
  change('upsert', 'Planowane', [{ ...p, usunieto: true, zmodyfikowano: now() }]);
}

export function restorePlan(p) {
  change('upsert', 'Planowane', [{ ...p, usunieto: false, zmodyfikowano: now() }]);
}

export function setMeta(klucz, wartosc) {
  change('upsert', 'Meta', [{ klucz, wartosc }]);
}

function classify(e) {
  if (e instanceof AuthError) return { status: 'auth', message: 'Połącz z Google, aby zsynchronizować' };
  if (e instanceof TypeError || !navigator.onLine) return { status: 'offline', message: 'Brak połączenia — zmiany wyślą się później' };
  return { status: 'error', message: e.message || String(e) };
}

/** Wysyła kolejkę zmian. Zwraca true, gdy kolejka jest pusta. */
export function flush() {
  if (!backend) return Promise.resolve(false);
  if (flushing) return flushing;
  if (!outbox.length) return Promise.resolve(true);
  flushing = (async () => {
    state.sync.status = 'syncing';
    emit();
    try {
      while (outbox.length) {
        inFlight = outbox[0];
        await backend.apply(inFlight);
        outbox.shift();
        inFlight = null;
        persist();
        emit();
      }
      state.sync = { ...state.sync, status: 'idle', message: '', lastSync: new Date().toISOString() };
      persist();
      return true;
    } catch (e) {
      inFlight = null;
      Object.assign(state.sync, classify(e));
      return false;
    } finally {
      flushing = null;
      emit();
    }
  })();
  return flushing;
}

/** Wysyła lokalne zmiany, potem pobiera świeże dane z arkusza (np. to, co dodała druga osoba). */
export function refresh() {
  if (!backend) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const flushed = await flush();
      if (!flushed && ['auth', 'offline'].includes(state.sync.status)) return;
      state.sync.status = 'syncing';
      emit();
      const data = await backend.loadAll();
      Object.assign(state, data, { hasData: true });
      // Zmiany, które nadal czekają w kolejce, nakładamy na świeże dane, żeby nie „zniknęły” z ekranu.
      for (const op of outbox) for (const o of op.objs) applyLocal(op.sheet, o);
      state.sync = { ...state.sync, status: outbox.length ? state.sync.status : 'idle', message: outbox.length ? state.sync.message : '', lastSync: new Date().toISOString() };
      persist();
    } catch (e) {
      Object.assign(state.sync, classify(e));
      if (state.sync.status === 'error' && !state.hasData) throw e;
    } finally {
      refreshing = null;
      emit();
    }
  })();
  return refreshing;
}

export function pendingCount() {
  return outbox.reduce((a, op) => a + op.objs.length, 0);
}

// Automatyczna synchronizacja: po odzyskaniu sieci, po powrocie do aplikacji i co jakiś czas.
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !backend) return;
  const last = state.sync.lastSync ? Date.parse(state.sync.lastSync) : 0;
  if (Date.now() - last > 30000) refresh();
});
setInterval(() => {
  if (outbox.length && navigator.onLine) flush();
}, 30000);
