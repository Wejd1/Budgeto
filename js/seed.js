// Kategorie startowe zapisywane do nowego arkusza. Później można je zmieniać w aplikacji lub w arkuszu.
// rodzaj: 'staly' = opłaty stałe (prognoza traktuje je jak jednorazowe), 'zmienny' = codzienne wydatki.
export const SEED_CATEGORIES = [
  ['jedzenie', 'Zakupy spożywcze', '🛒', '#3f8f5b', 'wydatek', 'zmienny', 'niezbedny'],
  ['restauracje', 'Restauracje i na wynos', '🍕', '#d9822b', 'wydatek', 'zmienny', 'zachcianka'],
  ['transport', 'Transport i paliwo', '⛽', '#3b6fb6', 'wydatek', 'zmienny', 'niezbedny'],
  ['mieszkanie', 'Mieszkanie i media', '🏠', '#6b5ca5', 'wydatek', 'staly', 'niezbedny'],
  ['abonamenty', 'Abonamenty', '📺', '#a04b8f', 'wydatek', 'staly', 'zachcianka'],
  ['chemia', 'Chemia i kosmetyki', '🧴', '#2a9a9a', 'wydatek', 'zmienny', 'niezbedny'],
  ['zdrowie', 'Zdrowie', '💊', '#c0443d', 'wydatek', 'zmienny', 'niezbedny'],
  ['dzieci', 'Dzieci', '🧸', '#c49a1d', 'wydatek', 'zmienny', 'niezbedny'],
  ['ubrania', 'Ubrania', '👕', '#5a7d9a', 'wydatek', 'zmienny', 'zachcianka'],
  ['rozrywka', 'Rozrywka', '🎬', '#b5563a', 'wydatek', 'zmienny', 'zachcianka'],
  ['dom', 'Dom i wyposażenie', '🛋️', '#7a6a4f', 'wydatek', 'zmienny', 'zachcianka'],
  ['prezenty', 'Prezenty', '🎁', '#d14d72', 'wydatek', 'zmienny', 'zachcianka'],
  ['inne', 'Inne', '📦', '#777777', 'wydatek', 'zmienny', 'zachcianka'],
  ['wynagrodzenie', 'Wynagrodzenie', '💼', '#2f7d4f', 'przychod', 'zmienny', 'niezbedny'],
  ['inne_przychody', 'Inne przychody', '💰', '#4a8f6a', 'przychod', 'zmienny', 'niezbedny'],
].map(([id, nazwa, ikona, kolor, typ, rodzaj, domyslna_potrzeba], i) => ({
  id, nazwa, ikona, kolor, typ, rodzaj, domyslna_potrzeba, aktywna: true, kolejnosc: i + 1,
}));
