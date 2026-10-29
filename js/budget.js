// Czysta logika budżetowa — bez DOM i bez sieci, dzięki czemu da się ją testować (tests/budget.test.js).
// Daty to zawsze tekst 'RRRR-MM-DD', okresy to tekst 'RRRR-MM' (miesiąc, w którym okres się ZACZYNA).

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export const WARN_THRESHOLD = 0.75; // od 75% limitu kategoria robi się żółta

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toDateStr(t) {
  return new Date(t).toISOString().slice(0, 10);
}

/** Dzisiejsza data w strefie czasowej urządzenia. */
export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

const sum = (arr, f = (t) => t.kwota) => round2(arr.reduce((a, t) => a + (Number(f(t)) || 0), 0));

/** Klucz okresu dla daty. Przy starcie np. 10-go: 2026-11-05 należy do okresu 2026-10. */
export function periodKeyFor(dateStr, startDay = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (d >= startDay) return `${y}-${pad(m)}`;
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function shiftPeriod(key, n) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Zakres dat okresu (włącznie) i liczba dni. startDay ograniczony do 1–28. */
export function periodRange(key, startDay = 1) {
  const sd = Math.min(Math.max(1, startDay | 0), 28);
  const [y, m] = key.split('-').map(Number);
  const start = Date.UTC(y, m - 1, sd);
  const [ny, nm] = shiftPeriod(key, 1).split('-').map(Number);
  const nextStart = Date.UTC(ny, nm - 1, sd);
  return {
    start: toDateStr(start),
    end: toDateStr(nextStart - DAY),
    days: Math.round((nextStart - start) / DAY),
  };
}

export function inRange(dateStr, range) {
  return dateStr >= range.start && dateStr <= range.end;
}

export function activeTx(transactions) {
  return transactions.filter((t) => !t.usunieto);
}

export function txInPeriod(transactions, key, startDay = 1) {
  const r = periodRange(key, startDay);
  return activeTx(transactions).filter((t) => inRange(t.data, r));
}

export function statusFor(spent, limit, warn = WARN_THRESHOLD) {
  if (!limit) return spent > 0 ? 'nolimit' : 'none';
  if (spent > limit + 0.004) return 'over';
  if (spent / limit >= warn) return 'warn';
  return 'ok';
}

/** Czas w okresie: ile dni minęło (łącznie z dzisiejszym), ile zostało (łącznie z dzisiejszym). */
export function timeInPeriod(range, today) {
  if (today < range.start) return { daysElapsed: 0, daysLeft: range.days, elapsedFrac: 0, state: 'future' };
  if (today > range.end) return { daysElapsed: range.days, daysLeft: 0, elapsedFrac: 1, state: 'past' };
  const daysElapsed = Math.round((parseDate(today) - parseDate(range.start)) / DAY) + 1;
  return {
    daysElapsed,
    daysLeft: range.days - daysElapsed + 1,
    elapsedFrac: daysElapsed / range.days,
    state: 'current',
  };
}

/**
 * Pełne podsumowanie okresu — wszystko, czego potrzebuje pulpit.
 * Kwota „zostało” liczona jest uczciwie: suma limitów minus WSZYSTKIE wydatki,
 * także te z kategorii bez limitu.
 */
export function summarize({ transactions, budgets, periods = [], categories, key, startDay = 1, today }) {
  const range = periodRange(key, startDay);
  const time = timeInPeriod(range, today);
  const tx = txInPeriod(transactions, key, startDay);
  const exp = tx.filter((t) => t.typ === 'wydatek');
  const inc = tx.filter((t) => t.typ === 'przychod');

  const catById = new Map(categories.map((c) => [c.id, c]));
  const limits = new Map();
  for (const b of budgets) if (b.okres === key && b.limit > 0) limits.set(b.kategoria_id, Number(b.limit));
  const totalLimit = round2([...limits.values()].reduce((a, b) => a + b, 0));

  const spentByCat = new Map();
  for (const t of exp) spentByCat.set(t.kategoria_id, round2((spentByCat.get(t.kategoria_id) || 0) + t.kwota));

  const spent = sum(exp);
  const income = sum(inc);
  const per = periods.find((p) => p.okres === key) || {};
  const incomePlan = Number(per.przychody_plan) || 0;
  const savingsGoal = Number(per.cel_oszczednosci) || 0;

  const remaining = round2(totalLimit - spent);
  const dailySafe = time.daysLeft > 0 ? round2(Math.max(0, remaining) / time.daysLeft) : 0;

  // Prognoza: kategorie stałe (czynsz, abonamenty) liczymy jako max(wydano, limit),
  // zmienne — liniowo wg dotychczasowego tempa.
  let forecast = null;
  if (time.daysElapsed > 0) {
    let fixed = 0;
    let variable = 0;
    const fixedCats = new Set();
    for (const [cid, s] of spentByCat) {
      const c = catById.get(cid);
      if (c && c.rodzaj === 'staly') {
        fixed += Math.max(s, limits.get(cid) || 0);
        fixedCats.add(cid);
      } else variable += s;
    }
    for (const [cid, l] of limits) {
      const c = catById.get(cid);
      if (c && c.rodzaj === 'staly' && !fixedCats.has(cid)) fixed += l;
    }
    forecast = round2(fixed + (time.state === 'past' ? variable : (variable / time.daysElapsed) * range.days));
  }

  const ids = new Set([...limits.keys(), ...spentByCat.keys()]);
  const cats = [...ids].map((id) => {
    const cat = catById.get(id) || { id, nazwa: id || 'Bez kategorii', ikona: '❔', rodzaj: 'zmienny' };
    const limit = limits.get(id) || 0;
    const s = spentByCat.get(id) || 0;
    let status = statusFor(s, limit);
    // Opłata stała zapłacona w całości to norma, nie ostrzeżenie.
    if (cat.rodzaj === 'staly' && status === 'warn') status = 'ok';
    const pct = limit ? s / limit : null;
    const paceWarn =
      time.state === 'current' &&
      cat.rodzaj !== 'staly' &&
      limit > 0 &&
      status !== 'over' &&
      pct > time.elapsedFrac + 0.1;
    return { cat, limit, spent: s, remaining: round2(limit - s), pct, status, paceWarn };
  });
  const order = { over: 0, nolimit: 1, warn: 2, ok: 3, none: 4 };
  const fixedLast = (c) => (c.cat.rodzaj === 'staly' ? 1 : 0);
  cats.sort((a, b) => order[a.status] - order[b.status] || fixedLast(a) - fixedLast(b) || (b.pct ?? 0) - (a.pct ?? 0) || b.spent - a.spent);

  const wants = sum(exp.filter((t) => t.potrzeba === 'zachcianka'));
  const byPerson = {};
  for (const t of exp) byPerson[t.osoba || '—'] = round2((byPerson[t.osoba || '—'] || 0) + t.kwota);

  return {
    key,
    range,
    ...time,
    totalLimit,
    spent,
    income,
    incomePlan,
    savingsGoal,
    remaining,
    dailySafe,
    forecast,
    spentFrac: totalLimit ? spent / totalLimit : null,
    unbudgetedSpent: round2([...spentByCat].filter(([id]) => !limits.has(id)).reduce((a, [, v]) => a + v, 0)),
    wants,
    needs: round2(spent - wants),
    byPerson,
    cats,
    limits,
  };
}

/** Co się stanie z budżetem, jeśli dopiszę wydatek `amount` do kategorii `categoryId`. */
export function impactOf(summary, categoryId, amount) {
  const a = Number(amount) || 0;
  const c = summary.cats.find((x) => x.cat.id === categoryId);
  const limit = summary.limits.get(categoryId) || 0;
  const spent = c ? c.spent : 0;
  const catRemainingAfter = round2(limit - spent - a);
  const totalRemainingAfter = round2(summary.remaining - a);
  return {
    hasLimit: limit > 0,
    limit,
    catRemainingAfter,
    totalRemainingAfter,
    overCat: limit > 0 && catRemainingAfter < 0,
    overTotal: summary.totalLimit > 0 && totalRemainingAfter < 0,
  };
}

/** Propozycja limitów: średnia z n poprzednich okresów, zaokrąglona w górę do 10 zł. */
export function suggestBudgets(transactions, key, startDay = 1, n = 3) {
  const totals = {};
  let periodsWithData = 0;
  for (let i = 1; i <= n; i++) {
    const tx = txInPeriod(transactions, shiftPeriod(key, -i), startDay).filter((t) => t.typ === 'wydatek');
    if (tx.length) periodsWithData++;
    for (const t of tx) totals[t.kategoria_id] = (totals[t.kategoria_id] || 0) + t.kwota;
  }
  const out = {};
  if (!periodsWithData) return out;
  for (const [id, v] of Object.entries(totals)) out[id] = Math.ceil(v / periodsWithData / 10) * 10;
  return out;
}

/** Wydatki/przychody/limity dla n ostatnich okresów (do wykresu trendu). */
export function periodTotals(transactions, budgets, key, startDay = 1, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = shiftPeriod(key, -i);
    const tx = txInPeriod(transactions, k, startDay);
    const exp = tx.filter((t) => t.typ === 'wydatek');
    out.push({
      key: k,
      spent: sum(exp),
      wants: sum(exp.filter((t) => t.potrzeba === 'zachcianka')),
      income: sum(tx.filter((t) => t.typ === 'przychod')),
      limit: round2(budgets.filter((b) => b.okres === k).reduce((a, b) => a + (Number(b.limit) || 0), 0)),
    });
  }
  return out;
}

/** Porównanie kategorii: bieżący okres vs poprzedni, posortowane wg największego wzrostu. */
export function compareWithPrevious(transactions, key, startDay = 1) {
  const cur = {};
  const prev = {};
  for (const t of txInPeriod(transactions, key, startDay)) if (t.typ === 'wydatek') cur[t.kategoria_id] = (cur[t.kategoria_id] || 0) + t.kwota;
  for (const t of txInPeriod(transactions, shiftPeriod(key, -1), startDay)) if (t.typ === 'wydatek') prev[t.kategoria_id] = (prev[t.kategoria_id] || 0) + t.kwota;
  const ids = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  return [...ids]
    .map((id) => ({ id, cur: round2(cur[id] || 0), prev: round2(prev[id] || 0), diff: round2((cur[id] || 0) - (prev[id] || 0)) }))
    .sort((a, b) => b.diff - a.diff);
}

/** Parsowanie kwoty wpisanej po polsku: „12,50”, „1 200”, „12.5”. */
export function parseAmount(s) {
  if (typeof s === 'number') return s;
  const clean = String(s ?? '').replace(/\s|zł/gi, '').replace(',', '.');
  const v = Number(clean);
  return Number.isFinite(v) ? round2(v) : NaN;
}
