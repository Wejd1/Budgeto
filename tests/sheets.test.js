// Test warstwy Google Sheets na atrapie API (bez sieci).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };
localStorage.setItem('bud.token', JSON.stringify({ token: 'T', exp: Date.now() + 3600e3 }));

const sheets = {
  Transakcje: [['id', 'data', 'kwota', 'typ', 'kategoria_id', 'opis', 'potrzeba', 'osoba', 'utworzono', 'zmodyfikowano', 'usunieto'],
    ['a1', '2026-10-01', 12.5, 'wydatek', 'jedzenie', 'Chleb', 'niezbedny', 'Damian', '', '', ''],
    ['a2', 46296, '30,5', 'Przychód', 'inne_przychody', '', '', 'Żona', '', '', '']],
  Kategorie: [['id'], ['jedzenie', 'Zakupy', '🛒', '#3f8f5b', 'wydatek', 'zmienny', 'niezbedny', 'TAK', 1]],
  Budzety: [['okres'], ['2026-10', 'jedzenie', 1000, '']],
  Okresy: [['okres']],
  Meta: [['klucz'], ['wersja_schematu', 1]],
};
const calls = [];
const rowOf = (range) => Number(range.match(/![A-Z](\d+)/)[1]);
globalThis.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(url);
  calls.push(`${opts.method} ${u.replace('https://sheets.googleapis.com/v4/spreadsheets/', '')}`);
  const body = opts.body ? JSON.parse(opts.body) : null;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.endsWith('?fields=sheets.properties.title')) {
    return ok({ sheets: Object.keys(sheets).map((title) => ({ properties: { title } })) });
  }
  if (u.endsWith(':batchUpdate') && !u.includes('values:')) {
    for (const r of body.requests) if (r.addSheet) sheets[r.addSheet.properties.title] = [[]];
    return ok({});
  }
  if (u.includes('values:batchGet')) {
    const ranges = [...u.matchAll(/ranges=(\w+)!/g)].map((m) => m[1]);
    return ok({ valueRanges: ranges.map((t) => ({ values: (sheets[t] || []).slice(1) })) });
  }
  if (u.includes(':append')) {
    const t = u.match(/values\/(\w+)!/)[1];
    sheets[t].push(...body.values);
    return ok({});
  }
  if (u.includes('values:batchUpdate')) {
    for (const d of body.data) sheets[d.range.split('!')[0]][rowOf(d.range) - 1] = d.values[0];
    return ok({});
  }
  const m = u.match(/values\/(\w+)!A2:([A-Z])/);
  if (m && opts.method === 'GET') return ok({ values: sheets[m[1]].slice(1).map((r) => r.slice(0, m[2].charCodeAt(0) - 64)) });
  throw new Error('nieobsłużone: ' + u);
};

const { SheetsBackend, parseSpreadsheetId } = await import('../js/sheets.js');

test('parseSpreadsheetId', () => {
  assert.equal(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(parseSpreadsheetId('nie link'), null);
});

test('loadAll normalizuje dane wpisane ręcznie w arkuszu', async () => {
  const d = await new SheetsBackend('X').loadAll();
  assert.equal(d.transactions.length, 2);
  assert.deepEqual(
    { data: d.transactions[1].data, kwota: d.transactions[1].kwota, typ: d.transactions[1].typ },
    { data: '2026-10-01', kwota: 30.5, typ: 'przychod' },
  );
  assert.equal(d.categories[0].aktywna, true);
  assert.equal(d.meta.wersja_schematu, 2); // podniesiona przez migrację
});

test('upsert aktualizuje istniejący wiersz, a nowy dopisuje', async () => {
  const b = new SheetsBackend('X');
  await b.apply({ kind: 'upsert', sheet: 'Transakcje', objs: [{ id: 'a1', data: '2026-10-01', kwota: 15, typ: 'wydatek', kategoria_id: 'jedzenie', usunieto: true }] });
  assert.equal(sheets.Transakcje[1][2], 15);
  assert.equal(sheets.Transakcje[1][10], 'TAK');
  await b.apply({ kind: 'upsert', sheet: 'Budzety', objs: [{ okres: '2026-10', kategoria_id: 'jedzenie', limit: 900 }, { okres: '2026-11', kategoria_id: 'jedzenie', limit: 800 }] });
  assert.equal(sheets.Budzety[1][2], 900);
  assert.equal(sheets.Budzety.length, 3);
  await b.apply({ kind: 'append', sheet: 'Transakcje', objs: [{ id: 'a3', data: '2026-10-05', kwota: 7, typ: 'wydatek', kategoria_id: 'jedzenie' }] });
  assert.equal(sheets.Transakcje.length, 4);
});

test('arkusz ze starszej wersji dostaje zakładkę Planowane i nowe nagłówki', async () => {
  assert.equal(sheets.Planowane[0][0], 'id');
  assert.equal(sheets.Transakcje[0][11], 'plan_id');
  assert.ok(sheets.Meta.some((r) => r[0] === 'wersja_schematu' && r[1] === 2));
  const b = new SheetsBackend('X');
  await b.apply({ kind: 'append', sheet: 'Planowane', objs: [{ id: 'p1', nazwa: 'Czynsz', kwota: 2300, kategoria_id: 'mieszkanie', cykl: 'miesiac', data: '2026-11-01' }] });
  const d = await b.loadAll();
  assert.equal(d.plans.length, 1);
  assert.deepEqual({ cykl: d.plans[0].cykl, kwota: d.plans[0].kwota, usunieto: d.plans[0].usunieto }, { cykl: 'miesiac', kwota: 2300, usunieto: false });
  assert.equal(d.transactions[0].plan_id, '');
});
