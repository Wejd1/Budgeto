import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occurrencesBetween, addMonthsClamped, periodOccurrences, isPending, withSkip, nextOccurrence, annualCost, daysUntil,
} from '../js/planned.js';
import { summarize, impactOf } from '../js/budget.js';

const plan = (o) => ({ id: 'p1', nazwa: 'Czynsz', kwota: 2000, kategoria_id: 'mieszkanie', cykl: 'miesiac', data: '2026-01-10', data_koniec: '', pominiete: '', usunieto: false, ...o });

test('addMonthsClamped: 31-go w krótszym miesiącu', () => {
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsClamped('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonthsClamped('2026-11-15', 3), '2027-02-15');
});

test('terminy miesięczne, kwartalne, tygodniowe i jednorazowe', () => {
  assert.deepEqual(occurrencesBetween(plan(), '2026-10-01', '2026-12-31'), ['2026-10-10', '2026-11-10', '2026-12-10']);
  assert.deepEqual(occurrencesBetween(plan({ data: '2026-01-31' }), '2026-02-01', '2026-02-28'), ['2026-02-28']);
  assert.deepEqual(occurrencesBetween(plan({ cykl: 'kwartal' }), '2026-01-01', '2026-12-31'), ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
  assert.deepEqual(occurrencesBetween(plan({ cykl: 'tydzien', data: '2026-10-01' }), '2026-10-01', '2026-10-20'), ['2026-10-01', '2026-10-08', '2026-10-15']);
  assert.deepEqual(occurrencesBetween(plan({ cykl: 'jednorazowo', data: '2026-11-03' }), '2026-11-01', '2026-11-30'), ['2026-11-03']);
  assert.deepEqual(occurrencesBetween(plan({ cykl: 'jednorazowo', data: '2026-12-03' }), '2026-11-01', '2026-11-30'), []);
});

test('terminy nie wychodzą przed start ani za datę końca', () => {
  assert.deepEqual(occurrencesBetween(plan({ data: '2026-11-10' }), '2026-10-01', '2026-10-31'), []);
  assert.deepEqual(occurrencesBetween(plan({ data_koniec: '2026-11-30' }), '2026-10-01', '2027-03-31'), ['2026-10-10', '2026-11-10']);
});

test('statusy terminów: zapłacony, pominięty, po terminie, zaplanowany', () => {
  const plans = [
    plan(),
    plan({ id: 'p2', nazwa: 'Netflix', kwota: 50, kategoria_id: 'abonamenty', data: '2026-01-25' }),
    withSkip(plan({ id: 'p3', nazwa: 'Siłownia', kwota: 120, kategoria_id: 'rozrywka', data: '2026-01-20' }), '2026-10-20', true),
    plan({ id: 'p4', nazwa: 'Przegląd', kwota: 300, kategoria_id: 'transport', cykl: 'jednorazowo', data: '2026-10-05' }),
  ];
  const txs = [{ id: 't1', data: '2026-10-09', kwota: 2010, kategoria_id: 'mieszkanie', typ: 'wydatek', plan_id: 'p1', plan_data: '2026-10-10' }];
  const occ = periodOccurrences(plans, txs, '2026-10', 1, '2026-10-15');
  const st = Object.fromEntries(occ.map((o) => [o.plan.id, o.status]));
  assert.deepEqual(st, { p1: 'paid', p2: 'planned', p3: 'skipped', p4: 'overdue' });
  assert.deepEqual(occ.filter(isPending).map((o) => o.plan.id), ['p4', 'p2']);
});

test('nextOccurrence pomija zapłacone i pominięte, annualCost liczy 12 miesięcy', () => {
  const p = withSkip(plan(), '2026-11-10', true);
  const txs = [{ id: 't', plan_id: 'p1', plan_data: '2026-10-10' }];
  assert.equal(nextOccurrence(p, txs, '2026-10-01').date, '2026-12-10');
  assert.equal(annualCost(plan(), '2026-10-30'), 24000);
  assert.equal(annualCost(plan({ cykl: 'rok', kwota: 1200 }), '2026-10-30'), 1200);
  assert.equal(daysUntil('2026-11-02', '2026-10-30'), 3);
});

test('zaplanowane płatności rezerwują limity i zmniejszają „zostało”', () => {
  const cats = [{ id: 'mieszkanie', nazwa: 'Mieszkanie', rodzaj: 'staly' }, { id: 'jedzenie', nazwa: 'Jedzenie', rodzaj: 'zmienny' }, { id: 'transport', nazwa: 'Transport', rodzaj: 'zmienny' }];
  const budgets = [
    { okres: '2026-10', kategoria_id: 'mieszkanie', limit: 2000 },
    { okres: '2026-10', kategoria_id: 'jedzenie', limit: 1000 },
    { okres: '2026-10', kategoria_id: 'transport', limit: 200 },
  ];
  const txs = [{ id: 'a', data: '2026-10-05', kwota: 310, kategoria_id: 'jedzenie', typ: 'wydatek' }];
  const planned = [
    { kategoria_id: 'mieszkanie', amount: 2000 },
    { kategoria_id: 'transport', amount: 300 },
  ];
  const s = summarize({ transactions: txs, budgets, categories: cats, key: '2026-10', today: '2026-10-11', planned });
  assert.equal(s.planned, 2300);
  assert.equal(s.remaining, 3200 - 310 - 2300);
  const tr = s.cats.find((c) => c.cat.id === 'transport');
  assert.equal(tr.status, 'over');
  assert.equal(tr.overByPlan, true);
  assert.equal(tr.remaining, -100);
  assert.equal(s.cats.find((c) => c.cat.id === 'mieszkanie').status, 'ok');
  // prognoza: mieszkanie 2000 + transport 300 (w całości) + jedzenie liniowo 310/11*31
  assert.equal(s.forecast, Math.round((2000 + 300 + (310 / 11) * 31) * 100) / 100);
  // dopisanie wydatku do transportu pokazuje przekroczenie z uwzględnieniem planu
  const im = impactOf(s, 'transport', 50);
  assert.equal(im.catRemainingAfter, -150);
  assert.equal(im.overCat, true);
});
