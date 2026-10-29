// Uruchomienie: npm test   (albo: node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodKeyFor, periodRange, shiftPeriod, timeInPeriod, summarize, impactOf,
  suggestBudgets, statusFor, parseAmount, compareWithPrevious, periodTotals,
} from '../js/budget.js';

const cats = [
  { id: 'jedzenie', nazwa: 'Jedzenie', rodzaj: 'zmienny' },
  { id: 'restauracje', nazwa: 'Restauracje', rodzaj: 'zmienny' },
  { id: 'mieszkanie', nazwa: 'Mieszkanie', rodzaj: 'staly' },
  { id: 'inne', nazwa: 'Inne', rodzaj: 'zmienny' },
];
const tx = (data, kwota, kategoria_id, extra = {}) => ({ id: `${data}-${kategoria_id}-${kwota}`, data, kwota, kategoria_id, typ: 'wydatek', potrzeba: 'niezbedny', ...extra });

test('periodKeyFor: miesiąc kalendarzowy', () => {
  assert.equal(periodKeyFor('2026-10-01'), '2026-10');
  assert.equal(periodKeyFor('2026-10-31'), '2026-10');
});

test('periodKeyFor: okres od 10-go dnia, także przez Nowy Rok', () => {
  assert.equal(periodKeyFor('2026-11-09', 10), '2026-10');
  assert.equal(periodKeyFor('2026-11-10', 10), '2026-11');
  assert.equal(periodKeyFor('2027-01-05', 10), '2026-12');
});

test('shiftPeriod', () => {
  assert.equal(shiftPeriod('2026-12', 1), '2027-01');
  assert.equal(shiftPeriod('2026-01', -1), '2025-12');
  assert.equal(shiftPeriod('2026-10', -12), '2025-10');
});

test('periodRange', () => {
  assert.deepEqual(periodRange('2026-02', 1), { start: '2026-02-01', end: '2026-02-28', days: 28 });
  assert.deepEqual(periodRange('2026-10', 10), { start: '2026-10-10', end: '2026-11-09', days: 31 });
  assert.deepEqual(periodRange('2026-12', 25), { start: '2026-12-25', end: '2027-01-24', days: 31 });
});

test('timeInPeriod liczy dzisiejszy dzień do obu stron', () => {
  const r = periodRange('2026-10');
  assert.deepEqual(
    { e: timeInPeriod(r, '2026-10-01').daysElapsed, l: timeInPeriod(r, '2026-10-01').daysLeft },
    { e: 1, l: 31 },
  );
  assert.equal(timeInPeriod(r, '2026-10-31').daysLeft, 1);
  assert.equal(timeInPeriod(r, '2026-11-01').state, 'past');
  assert.equal(timeInPeriod(r, '2026-09-30').state, 'future');
});

test('statusFor', () => {
  assert.equal(statusFor(0, 0), 'none');
  assert.equal(statusFor(10, 0), 'nolimit');
  assert.equal(statusFor(50, 100), 'ok');
  assert.equal(statusFor(80, 100), 'warn');
  assert.equal(statusFor(100, 100), 'warn');
  assert.equal(statusFor(100.5, 100), 'over');
});

test('summarize: zostało, limit dzienny, wydatki bez limitu też się liczą', () => {
  const s = summarize({
    transactions: [
      tx('2026-10-02', 300, 'jedzenie'),
      tx('2026-10-05', 450, 'restauracje', { potrzeba: 'zachcianka' }),
      tx('2026-10-06', 100, 'inne'), // brak limitu
      tx('2026-10-07', 999, 'jedzenie', { usunieto: true }), // usunięte — ignorowane
      tx('2026-09-30', 500, 'jedzenie'), // poprzedni okres
      tx('2026-10-08', 5000, 'pensja', { typ: 'przychod' }),
    ],
    budgets: [
      { okres: '2026-10', kategoria_id: 'jedzenie', limit: 1200 },
      { okres: '2026-10', kategoria_id: 'restauracje', limit: 400 },
      { okres: '2026-09', kategoria_id: 'jedzenie', limit: 9999 },
    ],
    categories: cats,
    key: '2026-10',
    today: '2026-10-11',
  });
  assert.equal(s.totalLimit, 1600);
  assert.equal(s.spent, 850);
  assert.equal(s.income, 5000);
  assert.equal(s.remaining, 750);
  assert.equal(s.daysLeft, 21);
  assert.equal(s.dailySafe, 35.71);
  assert.equal(s.unbudgetedSpent, 100);
  assert.equal(s.wants, 450);
  // kolejność: przekroczone, bez limitu, ostrzeżenia, ok
  assert.deepEqual(s.cats.map((c) => [c.cat.id, c.status]), [
    ['restauracje', 'over'],
    ['inne', 'nolimit'],
    ['jedzenie', 'ok'],
  ]);
});

test('summarize: ostrzeżenie o tempie, gdy wydatki wyprzedzają upływ czasu', () => {
  const s = summarize({
    transactions: [tx('2026-10-03', 600, 'jedzenie')],
    budgets: [{ okres: '2026-10', kategoria_id: 'jedzenie', limit: 1000 }],
    categories: cats,
    key: '2026-10',
    today: '2026-10-05',
  });
  assert.equal(s.cats[0].status, 'ok'); // 60% < 75%
  assert.equal(s.cats[0].paceWarn, true); // ale minęło dopiero 16% miesiąca
});

test('summarize: prognoza traktuje stałe opłaty jako jednorazowe', () => {
  const s = summarize({
    transactions: [tx('2026-10-01', 2000, 'mieszkanie'), tx('2026-10-05', 500, 'jedzenie')],
    budgets: [
      { okres: '2026-10', kategoria_id: 'mieszkanie', limit: 2000 },
      { okres: '2026-10', kategoria_id: 'jedzenie', limit: 2000 },
    ],
    categories: cats,
    key: '2026-10',
    today: '2026-10-10',
  });
  // 2000 (stałe) + 500/10 dni * 31 dni = 3550
  assert.equal(s.forecast, 3550);
});

test('impactOf: ostrzega przed przekroczeniem limitu kategorii', () => {
  const s = summarize({
    transactions: [tx('2026-10-02', 350, 'restauracje')],
    budgets: [{ okres: '2026-10', kategoria_id: 'restauracje', limit: 400 }],
    categories: cats,
    key: '2026-10',
    today: '2026-10-11',
  });
  const ok = impactOf(s, 'restauracje', 30);
  assert.equal(ok.overCat, false);
  assert.equal(ok.catRemainingAfter, 20);
  const bad = impactOf(s, 'restauracje', 85);
  assert.equal(bad.overCat, true);
  assert.equal(bad.catRemainingAfter, -35);
  assert.equal(impactOf(s, 'inne', 10).hasLimit, false);
});

test('suggestBudgets: średnia z okresów z danymi, w górę do 10 zł', () => {
  const t = [tx('2026-09-10', 1000, 'jedzenie'), tx('2026-08-10', 1105, 'jedzenie'), tx('2026-08-11', 200, 'restauracje')];
  assert.deepEqual(suggestBudgets(t, '2026-10'), { jedzenie: 1060, restauracje: 100 });
  assert.deepEqual(suggestBudgets([], '2026-10'), {});
});

test('compareWithPrevious i periodTotals', () => {
  const t = [tx('2026-09-10', 100, 'jedzenie'), tx('2026-10-10', 250, 'jedzenie'), tx('2026-10-11', 50, 'inne')];
  assert.deepEqual(compareWithPrevious(t, '2026-10')[0], { id: 'jedzenie', cur: 250, prev: 100, diff: 150 });
  const totals = periodTotals(t, [], '2026-10', 1, 2);
  assert.deepEqual(totals.map((x) => [x.key, x.spent]), [['2026-09', 100], ['2026-10', 300]]);
});

test('parseAmount: polski zapis', () => {
  assert.equal(parseAmount('12,50'), 12.5);
  assert.equal(parseAmount('1 200 zł'), 1200);
  assert.ok(Number.isNaN(parseAmount('abc')));
});
