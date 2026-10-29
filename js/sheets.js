// Komunikacja z Google Sheets API v4 (zwykły fetch, bez ciężkich bibliotek).
import { getToken, clearToken, AuthError } from './auth.js';
import { SCHEMA, SCHEMA_VERSION, KEY_COLS, objToRow, keyOf, buildData, normPeriod } from './schema.js';
import { SEED_CATEGORIES } from './seed.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const colLetter = (n) => String.fromCharCode(64 + n); // wystarczy do 26 kolumn

export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call(method, url, body) {
  const token = getToken();
  if (!token) throw new AuthError();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new AuthError('Sesja Google wygasła');
  }
  if (!res.ok) {
    let msg = `Błąd Google API (${res.status})`;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch { /* odpowiedź bez JSON */ }
    if (res.status === 403 || res.status === 404) msg = 'Brak dostępu do arkusza. Sprawdź, czy arkusz jest Ci udostępniony z prawem edycji. (' + msg + ')';
    throw new ApiError(msg, res.status);
  }
  return res.status === 204 ? null : res.json();
}

/** Wyciąga ID arkusza z pełnego linku albo zwraca samo ID. */
export function parseSpreadsheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

export function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** Tworzy nowy arkusz z zakładkami, nagłówkami i kategoriami startowymi. */
export async function createSpreadsheet(title) {
  const sheets = Object.keys(SCHEMA).map((t, i) => ({
    properties: { title: t, index: i, gridProperties: { frozenRowCount: 1 } },
  }));
  const created = await call('POST', API, {
    properties: { title, locale: 'pl_PL', timeZone: 'Europe/Warsaw' },
    sheets,
  });
  const id = created.spreadsheetId;

  const data = Object.entries(SCHEMA).map(([t, cols]) => ({ range: `${t}!A1`, values: [cols] }));
  data.push({ range: 'Kategorie!A2', values: SEED_CATEGORIES.map((c) => objToRow('Kategorie', c)) });
  data.push({
    range: 'Meta!A2',
    values: [
      ['wersja_schematu', SCHEMA_VERSION],
      ['dzien_startu_okresu', 1],
      ['uwaga', 'Nie sortuj i nie usuwaj wierszy w zakładkach — aplikacja odnajduje wiersze po kolumnie A. Do przeglądania używaj widoków filtrów.'],
    ],
  });
  await call('POST', `${API}/${id}/values:batchUpdate`, { valueInputOption: 'RAW', data });

  // Pogrubione nagłówki — czysto kosmetycznie.
  await call('POST', `${API}/${id}:batchUpdate`, {
    requests: created.sheets.map((s) => ({
      repeatCell: {
        range: { sheetId: s.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 0.93 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    })),
  }).catch(() => {});
  return id;
}

export class SheetsBackend {
  constructor(spreadsheetId) {
    this.id = spreadsheetId;
  }

  async loadAll() {
    const qs = Object.keys(SCHEMA)
      .map((t) => `ranges=${encodeURIComponent(`${t}!A2:${colLetter(SCHEMA[t].length)}`)}`)
      .join('&');
    const res = await call('GET', `${API}/${this.id}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
    const rows = {};
    Object.keys(SCHEMA).forEach((t, i) => (rows[t] = res.valueRanges?.[i]?.values || []));
    const data = buildData(rows);
    if (!res.valueRanges || !rows.Meta.length) {
      throw new ApiError('To nie wygląda na arkusz tej aplikacji (brak zakładki Meta). Utwórz nowy arkusz z poziomu aplikacji.', 400);
    }
    return data;
  }

  async append(sheet, objs) {
    if (!objs.length) return;
    await call(
      'POST',
      `${API}/${this.id}/values/${encodeURIComponent(`${sheet}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: objs.map((o) => objToRow(sheet, o)) },
    );
  }

  /**
   * Wstawia lub aktualizuje wiersze. Wiersz odnajdujemy po kolumnach klucza (czytamy je świeżo z arkusza),
   * więc nawet gdy druga osoba w międzyczasie coś dopisała, trafiamy we właściwy wiersz.
   */
  async upsertMany(sheet, objs) {
    if (!objs.length) return;
    const kc = KEY_COLS[sheet];
    const res = await call('GET', `${API}/${this.id}/values/${encodeURIComponent(`${sheet}!A2:${colLetter(kc)}`)}?valueRenderOption=UNFORMATTED_VALUE`);
    const index = new Map();
    (res.values || []).forEach((r, i) => {
      const fake = {};
      SCHEMA[sheet].slice(0, kc).forEach((k, j) => (fake[k] = r[j] ?? ''));
      // klucze okresów w arkuszu mogą być zapisane jako data — normalizujemy jak przy wczytywaniu
      const key = keyOf(sheet, sheet === 'Budzety' || sheet === 'Okresy' ? { ...fake, okres: normPeriod(fake.okres) } : fake);
      index.set(key, i + 2);
    });
    const last = colLetter(SCHEMA[sheet].length);
    const updates = [];
    const appends = [];
    for (const o of objs) {
      const row = index.get(keyOf(sheet, o));
      if (row) updates.push({ range: `${sheet}!A${row}:${last}${row}`, values: [objToRow(sheet, o)] });
      else appends.push(o);
    }
    if (updates.length) await call('POST', `${API}/${this.id}/values:batchUpdate`, { valueInputOption: 'RAW', data: updates });
    await this.append(sheet, appends);
  }

  /** Wykonuje jedną operację z kolejki synchronizacji. */
  async apply(op) {
    if (op.kind === 'append') return this.append(op.sheet, op.objs);
    if (op.kind === 'upsert') return this.upsertMany(op.sheet, op.objs);
    throw new Error(`Nieznana operacja ${op.kind}`);
  }
}

