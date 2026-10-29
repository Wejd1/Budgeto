// Tryb demo: ten sam interfejs co SheetsBackend, ale dane leżą tylko w przeglądarce.
// Pozwala obejrzeć aplikację, zanim skonfigurujesz Google Cloud.
import { SCHEMA_VERSION, keyOf } from './schema.js';
import { SEED_CATEGORIES } from './seed.js';
import { todayStr, shiftPeriod, toDateStr, parseDate } from './budget.js';

const LS = 'bud.demo';
const SHEET_KEYS = { Transakcje: 'transactions', Kategorie: 'categories', Budzety: 'budgets', Okresy: 'periods' };

function rand(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function generate() {
  const r = rand(42);
  const today = todayStr();
  const cur = today.slice(0, 7);
  const tx = [];
  const budgets = [];
  const periods = [];
  const people = ['Damian', 'Żona'];
  const plan = {
    jedzenie: [1500, 8, 40, 220], restauracje: [350, 3, 35, 120], transport: [600, 4, 80, 250],
    chemia: [200, 3, 20, 90], rozrywka: [250, 2, 30, 120], ubrania: [300, 1, 80, 250], dzieci: [400, 3, 30, 150], dom: [200, 1, 40, 200],
  };
  let n = 0;
  for (let p = 3; p >= 0; p--) {
    const key = shiftPeriod(cur, -p);
    const [y, m] = key.split('-').map(Number);
    const last = p === 0 ? Number(today.slice(8, 10)) : new Date(Date.UTC(y, m, 0)).getUTCDate();
    const date = (d) => toDateStr(Date.UTC(y, m - 1, Math.min(d, last)));
    const add = (d, kwota, kategoria_id, potrzeba, opis = '') =>
      tx.push({ id: `demo-${++n}`, data: date(d), kwota: Math.round(kwota * 100) / 100, typ: kategoria_id.startsWith('wyn') || kategoria_id === 'inne_przychody' ? 'przychod' : 'wydatek', kategoria_id, opis, potrzeba, osoba: people[n % 2], utworzono: '', zmodyfikowano: '', usunieto: false });
    add(1, 2300, 'mieszkanie', 'niezbedny', 'Czynsz + media');
    add(3, 129, 'abonamenty', 'zachcianka', 'Netflix, Spotify, telefon');
    add(10, 6800, 'wynagrodzenie', 'niezbedny', 'Pensja');
    add(10, 3200, 'wynagrodzenie', 'niezbedny', 'Pensja');
    const scale = p === 0 ? 1.12 : 1; // w bieżącym miesiącu trochę „za szybko” — żeby było co pokazać
    for (const [cat, [, perMonth, min, max]] of Object.entries(plan)) {
      const count = Math.max(1, Math.round(perMonth * (last / 30)));
      for (let i = 0; i < count; i++) {
        const opis = { jedzenie: 'Biedronka', restauracje: 'Pizza', transport: 'Orlen', rozrywka: 'Kino' }[cat] || '';
        add(1 + Math.floor(r() * last), (min + r() * (max - min)) * scale, cat, SEED_CATEGORIES.find((c) => c.id === cat).domyslna_potrzeba, opis);
      }
    }
    for (const [cat, [limit]] of Object.entries(plan)) budgets.push({ okres: key, kategoria_id: cat, limit });
    budgets.push({ okres: key, kategoria_id: 'mieszkanie', limit: 2300 }, { okres: key, kategoria_id: 'abonamenty', limit: 129 });
    periods.push({ okres: key, przychody_plan: 10000, cel_oszczednosci: 2000 });
  }
  tx.sort((a, b) => parseDate(a.data) - parseDate(b.data));
  return {
    transactions: tx,
    categories: SEED_CATEGORIES.map((c) => ({ ...c })),
    budgets,
    periods,
    meta: { wersja_schematu: SCHEMA_VERSION, dzien_startu_okresu: 1 },
  };
}

export class DemoBackend {
  constructor() {
    this.id = 'demo';
  }

  read() {
    try {
      const d = JSON.parse(localStorage.getItem(LS));
      if (d) return d;
    } catch { /* odtworzymy */ }
    const d = generate();
    localStorage.setItem(LS, JSON.stringify(d));
    return d;
  }

  async loadAll() {
    await new Promise((r) => setTimeout(r, 150));
    return structuredClone(this.read());
  }

  async apply(op) {
    await new Promise((r) => setTimeout(r, 120));
    const d = this.read();
    if (op.sheet === 'Meta') {
      for (const o of op.objs) d.meta[o.klucz] = o.wartosc;
    } else {
      const list = d[SHEET_KEYS[op.sheet]];
      for (const o of op.objs) {
        const i = op.kind === 'upsert' ? list.findIndex((x) => keyOf(op.sheet, x) === keyOf(op.sheet, o)) : -1;
        if (i >= 0) list[i] = { ...o };
        else list.push({ ...o });
      }
    }
    localStorage.setItem(LS, JSON.stringify(d));
  }

  static reset() {
    localStorage.removeItem(LS);
  }
}
