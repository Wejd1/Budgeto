# Budżet domowy

Wspólny budżet dla dwojga z naciskiem na **ograniczanie wydatków**. Działa jako aplikacja na Androidzie (PWA) i w przeglądarce na PC. Dane trzymacie we własnym Arkuszu Google. Aplikacja nie ma serwera ani bazy u nikogo trzeciego.

**Co potrafi:**
- **Pulpit „ile zostało”.** Kwota do wydania, bezpieczny limit na dziś, prognoza na koniec okresu i tempo wydawania w porównaniu z upływem miesiąca.
- **Ostrzeżenie *przed* zapisem wydatku.** Gdy wydatek przekroczy limit kategorii albo cały budżet, aplikacja pokazuje to, zanim klikniesz „Zapisz”.
- **Limity na kategorie** z propozycją ze średniej z 3 miesięcy, kopiowaniem z poprzedniego okresu i bilansem planu (przychody − oszczędności − limity).
- **Podział na niezbędne i zachcianki** oraz raport, ile idzie na zachcianki.
- **Raporty:** trend 6 okresów, zmiany wobec poprzedniego okresu, struktura wydatków, największe wydatki, kto ile wydał.
- **Praca offline.** Wydatki dodane bez internetu wysyłają się same, gdy sieć wróci.
- **Okres budżetowy od dowolnego dnia**, np. od dnia wypłaty.
- **Eksport do CSV.**

---

## Krok 0. Zobacz aplikację bez konfiguracji

Otwórz aplikację i kliknij **„Najpierw wypróbuj w trybie demo”**. Zobaczysz przykładowe dane, zapisane tylko w tej przeglądarce.

Lokalnie wystarczy Python. W folderze projektu uruchom:

```
python -m http.server 8080
```

Potem otwórz w przeglądarce http://localhost:8080

---

## Krok 1. Wrzuć aplikację na GitHub Pages (ok. 10 min)

1. Załóż konto na https://github.com (jeśli nie masz).
2. Kliknij **New repository**:
   - nazwa np. `budzet`,
   - widoczność **Public** (darmowe GitHub Pages wymagają publicznego repo; publiczny jest tylko kod, wasze dane są w arkuszu),
   - kliknij **Create repository**.
3. Na stronie repozytorium kliknij **uploading an existing file** (albo **Add file → Upload files**). Przeciągnij **całą zawartość** folderu `budzet`, czyli pliki i podfoldery `css`, `js`, `icons`, `tests`. Kliknij **Commit changes**.
   - Sprawdź, że plik `index.html` leży w głównym katalogu repo, a nie w podfolderze.
4. Wejdź w **Settings → Pages**. W sekcji **Source** wybierz **Deploy from a branch**, branch `main`, folder `/ (root)`, i kliknij **Save**.
5. Po 1–2 minutach aplikacja będzie pod adresem `https://TWOJ-LOGIN.github.io/budzet/`.

---

## Krok 2. Projekt w Google Cloud, czyli zgoda na logowanie (ok. 15 min, jednorazowo)

Google wymaga „zarejestrowania” aplikacji, która ma dostęp do arkuszy. Jest to darmowe.

1. Wejdź na https://console.cloud.google.com i zaloguj się swoim kontem Google.
2. U góry kliknij wybór projektu → **Nowy projekt**, nazwij go np. `Budzet domowy` i kliknij **Utwórz**. Upewnij się, że ten projekt jest wybrany.
3. **Włącz API arkuszy.** W menu wybierz **Interfejsy API i usługi → Biblioteka**, wyszukaj **Google Sheets API** i kliknij **Włącz**.
4. **Ekran zgody** (w nowszym interfejsie nazywa się **Google Auth Platform**):
   - **Branding / Informacje o aplikacji:** nazwa `Budżet domowy`, e-mail pomocy i e-mail dewelopera to Twój adres.
   - **Odbiorcy (Audience):** typ **Zewnętrzny (External)**, stan publikacji **Testowanie (Testing)**.
   - W **Użytkownicy testowi** dodaj **swój adres Gmail i adres żony**. Tylko te konta będą mogły się zalogować.
   - **Dostęp do danych (Data access / Zakresy):** dodaj zakres `https://www.googleapis.com/auth/spreadsheets`. Można to pominąć, bo aplikacja i tak poprosi o niego przy logowaniu.
5. **Klient OAuth.** Wejdź w **Klienci (Clients)** albo **Dane logowania → Utwórz dane logowania → Identyfikator klienta OAuth**:
   - typ aplikacji: **Aplikacja internetowa**,
   - w **Autoryzowane źródła JavaScript** dodaj dwa adresy:
     - `https://TWOJ-LOGIN.github.io` (sama domena, **bez** `/budzet` i bez ukośnika na końcu),
     - `http://localhost:8080` (do testów na komputerze),
   - **Identyfikatory URI przekierowania** zostaw puste,
   - kliknij **Utwórz** i skopiuj **Identyfikator klienta**, czyli tekst kończący się na `.apps.googleusercontent.com`.
6. **Wklej Client ID do aplikacji.** W repozytorium na GitHubie otwórz `js/config.js`, kliknij ołówek (Edit) i zamień `WKLEJ_TUTAJ_CLIENT_ID.apps.googleusercontent.com` na swój identyfikator. Kliknij **Commit changes**.

> Client ID nie jest tajny i może być publicznie w kodzie. Działa tylko z adresów wpisanych w punkcie 5.

**Ostrzeżenie „Google nie zweryfikował tej aplikacji”** przy logowaniu jest normalne dla aplikacji prywatnych. Kliknij **Zaawansowane → Przejdź do Budżet domowy** i zaznacz zgodę na dostęp do arkuszy.

> **Wskazówka:** w trybie „Testowanie” Google może co kilka dni prosić o ponowną zgodę. Jeśli będzie to uciążliwe, w **Odbiorcy** kliknij **Opublikuj aplikację**. Weryfikacja nie jest potrzebna, a dla kilku osób aplikacja działa bez niej (ostrzeżenie przy pierwszym logowaniu zostaje).

---

## Krok 3. Pierwsze uruchomienie

**Ty:**
1. Otwórz `https://TWOJ-LOGIN.github.io/budzet/` i kliknij **Zaloguj się kontem Google**.
2. Wybierz **Utwórz nowy arkusz**. Na Twoim Dysku powstanie arkusz „Budżet domowy — dane aplikacji” z kategoriami startowymi.
3. Wejdź w **Budżet**, wpisz planowane przychody, cel oszczędności i limity na kategorie, potem kliknij **Zapisz budżet**.

**Udostępnienie żonie:**
1. W aplikacji wejdź w **Ustawienia → Otwórz w Arkuszach Google**, kliknij **Udostępnij**, wpisz jej adres i wybierz rolę **Edytujący**.
2. Wyślij jej link do aplikacji i link do arkusza (przycisk **Kopiuj link** w Ustawieniach).
3. Ona otwiera aplikację, loguje się **swoim** kontem, wybiera **Dołączam do istniejącego** i wkleja link do arkusza.
4. Jej adres musi być na liście użytkowników testowych z kroku 2.4.

---

## Krok 4. Instalacja na telefonie z Androidem

1. Otwórz adres aplikacji w **Chrome**.
2. Kliknij menu ⋮ → **Zainstaluj aplikację** (albo **Dodaj do ekranu głównego**).
3. Ikona pojawi się na ekranie głównym, a aplikacja otworzy się na pełnym ekranie, bez paska przeglądarki.
4. Przytrzymaj palec na ikonie, żeby mieć skrót **Dodaj wydatek**.

Na PC w Chrome lub Edge możesz ją zainstalować tak samo (ikona instalacji w pasku adresu) albo po prostu używać jej w karcie.

---

## Jak działa synchronizacja

- Każdy wydatek zapisuje się od razu na urządzeniu, a potem do arkusza. Pastylka u góry pokazuje stan: **✓ Aktualne**, **Czeka: N**, **Offline**, **Niepołączone**.
- Logowanie Google wygasa po godzinie. Wtedy pojawia się pasek **Połącz**. Jedno kliknięcie i wszystko, co czekało, się wysyła. Dodawać wydatki można cały czas, także offline.
- Zmiany drugiej osoby pobierają się po powrocie do aplikacji albo po kliknięciu pastylki.

## Arkusz Google: co wolno, a czego nie

- ✅ Przeglądać, filtrować (najlepiej przez **Dane → Widoki filtrów**), robić wykresy w osobnych zakładkach.
- ✅ Poprawić kwotę, opis albo kategorię w istniejącym wierszu.
- ❌ **Nie sortować i nie usuwać wierszy** w zakładkach danych. Do usuwania służy aplikacja: wiersz dostaje wtedy znacznik w kolumnie `usunieto` i znika z widoków.
- ❌ Nie przestawiać kolumn.

Arkusz ma zakładki: `Transakcje`, `Kategorie`, `Budzety` (limit na kategorię na okres), `Okresy` (planowane przychody, cel oszczędności) i `Meta` (ustawienia wspólne, np. dzień startu okresu).

## Wprowadzanie zmian w kodzie

- Wszystko to zwykłe pliki HTML, CSS i JS. Nie ma kroku budowania, więc edytujesz plik na GitHubie i po minucie zmiana jest na stronie.
- **Po każdej zmianie podbij `VERSION` w `sw.js`** (np. `budzet-v1.0.1`), żeby telefony pobrały nową wersję. Czasem trzeba zamknąć i otworzyć aplikację dwa razy.
- Testy logiki budżetu: `node --test tests/*.test.js` (wymaga Node.js 18 lub nowszego).

| Plik | Co zawiera |
|---|---|
| `js/config.js` | Client ID Google — jedyne miejsce do uzupełnienia |
| `js/budget.js` | obliczenia: okresy, „zostało”, limit dzienny, tempo, prognoza, propozycje limitów |
| `js/app.js` | interfejs: pulpit, dodawanie, historia, budżet, raporty, ustawienia |
| `js/store.js` | stan, pamięć podręczna, kolejka offline, synchronizacja |
| `js/sheets.js` | komunikacja z Google Sheets API |
| `js/auth.js` | logowanie Google |
| `js/schema.js` | układ kolumn arkusza |
| `js/seed.js` | kategorie startowe |
| `js/demo.js` | tryb demo |
| `sw.js`, `manifest.webmanifest` | instalacja jako aplikacja i działanie offline |

## Pomysły na kolejne etapy

- Wydatki cykliczne (czynsz, abonamenty) z przypomnieniem i zestawieniem rocznym.
- Import wyciągów CSV z banku z automatycznym przypisaniem kategorii.
- Cele oszczędnościowe długoterminowe z paskiem postępu.

## Rozwiązywanie problemów

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `Error 400: redirect_uri_mismatch` albo `origin_mismatch` | Adres strony nie jest w **Autoryzowanych źródłach JavaScript**. Wpisz samą domenę `https://login.github.io`, bez ścieżki. Zmiany w Google działają po kilku minutach. |
| `Error 403: access_denied` | Konto nie jest na liście użytkowników testowych (krok 2.4). |
| „Brak dostępu do arkusza” | Arkusz nie jest udostępniony temu kontu z rolą **Edytujący**. |
| Okno logowania się nie otwiera | Przeglądarka zablokowała wyskakujące okno. Zezwól na nie dla tej strony. |
| Na telefonie stara wersja | Podbij `VERSION` w `sw.js`, potem zamknij i otwórz aplikację. |
