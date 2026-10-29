// Układ arkusza. Kolejność kolumn ma znaczenie — NIE przestawiaj kolumn w arkuszu ręcznie.
// Nowe kolumny dopisuj zawsze na końcu i podbij SCHEMA_VERSION.
export const SCHEMA_VERSION = 1;

export const SCHEMA = {
  Transakcje: ['id', 'data', 'kwota', 'typ', 'kategoria_id', 'opis', 'potrzeba', 'osoba', 'utworzono', 'zmodyfikowano', 'usunieto'],
  Kategorie: ['id', 'nazwa', 'ikona', 'kolor', 'typ', 'rodzaj', 'domyslna_potrzeba', 'aktywna', 'kolejnosc'],
  Budzety: ['okres', 'kategoria_id', 'limit', 'zmodyfikowano'],
  Okresy: ['okres', 'przychody_plan', 'cel_oszczednosci', 'zmodyfikowano'],
  Meta: ['klucz', 'wartosc'],
};

// Ile pierwszych kolumn tworzy klucz wiersza (do aktualizacji „w miejscu”).
export const KEY_COLS = { Transakcje: 1, Kategorie: 1, Budzety: 2, Okresy: 1, Meta: 1 };

const pad = (n) => String(n).padStart(2, '0');

// Gdy ktoś wpisze datę ręcznie w arkuszu, Google zamieni ją na liczbę dni od 1899-12-30.
function serialToDate(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function normDate(v) {
  if (typeof v === 'number') return serialToDate(v);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  const pl = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); // 05.10.2026
  if (pl) return `${pl[3]}-${pad(pl[2])}-${pad(pl[1])}`;
  return s;
}

export function normPeriod(v) {
  if (typeof v === 'number') return serialToDate(v).slice(0, 7);
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{1,2})/);
  return m ? `${m[1]}-${pad(m[2])}` : String(v ?? '');
}

export function normNum(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'tak', 'prawda', 'x'].includes(String(v ?? '').trim().toLowerCase());
}

function stripAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const NORMALIZERS = {
  Transakcje: (o) => ({
    ...o,
    id: String(o.id),
    data: normDate(o.data),
    kwota: normNum(o.kwota),
    typ: stripAccents(o.typ) === 'przychod' ? 'przychod' : 'wydatek',
    potrzeba: stripAccents(o.potrzeba) === 'zachcianka' ? 'zachcianka' : 'niezbedny',
    opis: String(o.opis ?? ''),
    osoba: String(o.osoba ?? ''),
    usunieto: truthy(o.usunieto),
  }),
  Kategorie: (o) => ({
    ...o,
    id: String(o.id),
    typ: stripAccents(o.typ) === 'przychod' ? 'przychod' : 'wydatek',
    rodzaj: stripAccents(o.rodzaj) === 'staly' ? 'staly' : 'zmienny',
    domyslna_potrzeba: stripAccents(o.domyslna_potrzeba) === 'zachcianka' ? 'zachcianka' : 'niezbedny',
    aktywna: o.aktywna === '' || o.aktywna === undefined ? true : truthy(o.aktywna),
    kolejnosc: normNum(o.kolejnosc),
    ikona: o.ikona || '•',
    kolor: o.kolor || '#777777',
  }),
  Budzety: (o) => ({ ...o, okres: normPeriod(o.okres), kategoria_id: String(o.kategoria_id), limit: normNum(o.limit) }),
  Okresy: (o) => ({ ...o, okres: normPeriod(o.okres), przychody_plan: normNum(o.przychody_plan), cel_oszczednosci: normNum(o.cel_oszczednosci) }),
  Meta: (o) => ({ klucz: String(o.klucz), wartosc: o.wartosc }),
};

export function rowToObj(sheet, row) {
  const o = {};
  SCHEMA[sheet].forEach((k, i) => (o[k] = row[i] ?? ''));
  return NORMALIZERS[sheet](o);
}

export function objToRow(sheet, obj) {
  return SCHEMA[sheet].map((k) => {
    const v = obj[k];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'TAK' : '';
    return v;
  });
}

export function keyOf(sheet, obj) {
  return SCHEMA[sheet].slice(0, KEY_COLS[sheet]).map((k) => String(obj[k])).join('|');
}

/** Zamienia wiersze z API na obiekty aplikacji. */
export function buildData(rowsBySheet) {
  const out = {};
  for (const sheet of Object.keys(SCHEMA)) {
    out[sheet] = (rowsBySheet[sheet] || []).filter((r) => r && r[0] !== undefined && String(r[0]).trim() !== '').map((r) => rowToObj(sheet, r));
  }
  const meta = {};
  for (const m of out.Meta) meta[m.klucz] = m.wartosc;
  return {
    transactions: out.Transakcje,
    categories: out.Kategorie.sort((a, b) => a.kolejnosc - b.kolejnosc),
    budgets: out.Budzety,
    periods: out.Okresy,
    meta,
  };
}
