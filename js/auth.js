// Logowanie przez Google Identity Services (przeglądarkowy „token client”, bez własnego serwera).
// Token dostępu ważny ok. 1 godziny. Trzymamy go w localStorage, żeby po ponownym otwarciu
// aplikacji w ciągu godziny nie trzeba było znowu klikać „Połącz”.

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets openid email profile';
const LS_TOKEN = 'bud.token';
const LS_USER = 'bud.user';

let tokenClient = null;
let gisPromise = null;

export class AuthError extends Error {
  constructor(msg = 'Wymagane zalogowanie') {
    super(msg);
    this.name = 'AuthError';
  }
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Nie udało się wczytać logowania Google (brak internetu?)'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export async function initAuth(clientId) {
  await loadGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: () => {},
  });
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(LS_USER)) || null;
  } catch {
    return null;
  }
}

/** Ważny token albo null. */
export function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(LS_TOKEN));
    if (t && t.exp > Date.now()) return t.token;
  } catch { /* brak lub uszkodzony wpis */ }
  return null;
}

export function clearToken() {
  localStorage.removeItem(LS_TOKEN);
}

/**
 * Otwiera okno logowania Google. MUSI być wywołane z kliknięcia (inaczej przeglądarka zablokuje okno).
 * Po pierwszej zgodzie kolejne logowania zwykle tylko mignięciem okna.
 */
export function signIn({ consent = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Logowanie Google nie jest gotowe'));
    tokenClient.callback = async (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      localStorage.setItem(LS_TOKEN, JSON.stringify({ token: resp.access_token, exp: Date.now() + (resp.expires_in - 120) * 1000 }));
      try {
        const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${resp.access_token}` },
        });
        if (r.ok) {
          const u = await r.json();
          localStorage.setItem(LS_USER, JSON.stringify({ email: u.email, name: u.given_name || u.name || u.email }));
        }
      } catch { /* nazwa użytkownika nie jest krytyczna */ }
      resolve();
    };
    tokenClient.error_callback = (e) =>
      reject(new Error(e?.type === 'popup_closed' ? 'Okno logowania zostało zamknięte' : e?.message || 'Błąd logowania'));
    const user = getUser();
    tokenClient.requestAccessToken({ prompt: consent ? 'consent' : '', login_hint: user?.email || undefined });
  });
}

export function signOut() {
  const token = getToken();
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  clearToken();
  localStorage.removeItem(LS_USER);
}
