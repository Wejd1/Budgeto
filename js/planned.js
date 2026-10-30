// Wydatki planowane: cykliczne (czynsz, abonamenty, ubezpieczenia) i jednorazowe w przyszłości.
// Czysta logika — bez DOM i sieci (testy: tests/planned.test.js).
//
// Każdy plan generuje „terminy” (daty płatności). Termin jest:
//  - zapłacony  — istnieje transakcja z plan_id = id planu i plan_data = data terminu,
//  - pominięty  — data terminu jest na liście `pominiete` planu,
//  - po terminie / zaplanowany — w pozostałych przypadkach (data < dziś / data ≥ dziś).
// Niezapłacone i niepominięte terminy w okresie rezerwują pieniądze w limitach tego okresu.
import { periodRange, parseDate, toDateStr, round2 } from './budget.js';

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export const CYCLES = {
  jednorazowo: { label: 'jednorazowo', unit: 'once' },
  tydzien: { label: 'co tydzień', unit: 'day', n: 7 },
  '2tygodnie': { label: 'co 2 tygodnie', unit: 'day', n: 14 },
  miesiac: { label: 'co miesiąc', unit: 'month', n: 1 },
  '2miesiace': { label: 'co 2 miesiące', unit: 'month', n: 2 },
  kwartal: { label: 'co kwartał', unit: 'month', n: 3 },
  polrocze: { label: 'co pół roku', unit: 'month', n: 6 },
  rok: { label: 'co rok', unit: 'month', n: 12 },
};

export const isRecurring = (plan) => (CYCLES[plan.cykl]?.unit || 'once') !== 'once';

export function cycleLabel(cykl) {
  return CYCLES[cykl]?.label || 'jednorazowo';
}

/** Data przesunięta o k miesięcy; 31-go w krótszym miesiącu staje się ostatnim dniem miesiąca. */
export function addMonthsClamped(dateStr, k) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const idx = y * 12 + (m - 1) + k;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

export function addDays(dateStr, n) {
  return toDateStr(parseDate(dateStr) + n * DAY);
}

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Wszystkie terminy planu w przedziale [from, to] (włącznie), rosnąco. */
export function occurrencesBetween(plan, from, to) {
  if (!validDate(plan.data) || from > to) return [];
  const c = CYCLES[plan.cykl] || CYCLES.jednorazowo;
  const end = validDate(plan.data_koniec) && plan.data_koniec < to ? plan.data_koniec : to;
  if (c.unit === 'once') return plan.data >= from && plan.data <= end ? [plan.data] : [];

  const out = [];
  let k;
  if (c.unit === 'month') {
    const [y, m] = plan.data.split('-').map(Number);
    const [fy, fm] = from.split('-').map(Number);
    k = Math.max(0, Math.floor(((fy * 12 + fm) - (y * 12 + m)) / c.n) - 1);
  } else {
    k = Math.max(0, Math.floor((parseDate(from) - parseDate(plan.data)) / DAY / c.n) - 1);
  }
  for (let guard = 0; guard < 2000; guard++, k++) {
    const d = c.unit === 'month' ? addMonthsClamped(plan.data, k * c.n) : addDays(plan.data, k * c.n);
    if (d > end) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export function skippedSet(plan) {
  return new Set(String(plan.pominiete || '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function withSkip(plan, date, skip) {
  const s = skippedSet(plan);
  if (skip) s.add(date);
  else s.delete(date);
  return { ...plan, pominiete: [...s].sort().join(',') };
}

export const occKey = (planId, date) => `${planId}|${date}`;

/** Mapa „plan|data” → transakcja, która opłaciła dany termin. */
export function paidMap(transactions) {
  const m = new Map();
  for (const t of transactions) if (!t.usunieto && t.plan_id && t.plan_data) m.set(occKey(t.plan_id, t.plan_data), t);
  return m;
}

export function activePlans(plans) {
  return (plans || []).filter((p) => !p.usunieto && Number(p.kwota) > 0);
}

/** Terminy w przedziale dat dla wszystkich planów, ze statusem. */
export function occurrencesInRange(plans, transactions, from, to, today) {
  const paid = paidMap(transactions);
  const out = [];
  for (const plan of activePlans(plans)) {
    const skipped = skippedSet(plan);
    for (const date of occurrencesBetween(plan, from, to)) {
      const key = occKey(plan.id, date);
      const tx = paid.get(key) || null;
      const status = tx ? 'paid' : skipped.has(date) ? 'skipped' : date < today ? 'overdue' : 'planned';
      out.push({ key, plan, date, amount: Number(plan.kwota), kategoria_id: plan.kategoria_id, status, tx });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.plan.nazwa).localeCompare(String(b.plan.nazwa), 'pl'));
}

export function periodOccurrences(plans, transactions, key, startDay, today) {
  const r = periodRange(key, startDay);
  return occurrencesInRange(plans, transactions, r.start, r.end, today);
}

export const isPending = (o) => o.status === 'planned' || o.status === 'overdue';

/** Najbliższy niezapłacony i niepominięty termin od `from` (w horyzoncie ~2 lat). */
export function nextOccurrence(plan, transactions, from) {
  const occ = occurrencesInRange([plan], transactions, from, addDays(from, 800), from);
  return occ.find(isPending) || null;
}

/** Ile plan kosztuje w ciągu 12 miesięcy od `from`. */
export function annualCost(plan, from) {
  const to = addDays(addMonthsClamped(from, 12), -1);
  return round2(occurrencesBetween(plan, from, to).length * (Number(plan.kwota) || 0));
}

/** Liczba dni od `today` do `date` (ujemna = po terminie). */
export function daysUntil(date, today) {
  return Math.round((parseDate(date) - parseDate(today)) / DAY);
}
