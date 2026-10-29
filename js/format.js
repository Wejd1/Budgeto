// Formatowanie po polsku.
import { periodRange } from './budget.js';

const pln2 = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pln0 = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 });

/** 1 234 zł albo 12,50 zł — grosze tylko wtedy, gdy są. */
export function zl(x, { signed = false } = {}) {
  const v = Math.round((Number(x) || 0) * 100) / 100;
  const s = (Number.isInteger(v) ? pln0 : pln2).format(Math.abs(v));
  if (v < 0) return `−${s}`;
  return signed && v > 0 ? `+${s}` : s;
}

/** Krótko, do wykresów: 1,2 tys. */
export function zlShort(x) {
  const v = Number(x) || 0;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} tys.`;
  return Math.round(v).toLocaleString('pl-PL');
}

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const DOW = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

export function periodLabel(key, startDay = 1) {
  const [y, m] = key.split('-').map(Number);
  if (startDay === 1) return `${cap(MONTHS[m - 1])} ${y}`;
  const r = periodRange(key, startDay);
  return `${dateShort(r.start)} – ${dateShort(r.end)}`;
}

export function periodShort(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]}${m === 1 ? ` ${String(y).slice(2)}` : ''}`;
}

export function dateShort(d) {
  const [, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS_SHORT[m - 1]}`;
}

export function dateLong(d, today) {
  if (d === today) return 'Dzisiaj';
  const t = Date.parse(today) - Date.parse(d);
  if (t === 86400000) return 'Wczoraj';
  const [y, m, day] = d.split('-').map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${cap(dow)}, ${day} ${MONTHS_SHORT[m - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
}

export function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

export function days(n) {
  return n === 1 ? '1 dzień' : `${n} dni`;
}

/** Zabezpieczenie przed wstrzyknięciem HTML z danych użytkownika. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
