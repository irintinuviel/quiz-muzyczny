# MusicQuiz Online

Szkielet quizu muzycznego online (host + gracze przez telefon), zbudowany
na bazie logiki z `mp.py` (pygame), przeniesionej na Node.js + Socket.IO.

## Architektura

```
musicquiz-online/
├── server/
│   ├── index.js         # Express + Socket.IO, routing zdarzeń
│   ├── gameManager.js    # stan pokoi/graczy/rund, punktacja (odp. settings + game_loop)
│   └── audioService.js   # skan biblioteki + cięcie klipów ffmpeg (odp. get_all_songs + prepare_rounds)
├── public/
│   ├── host.html/js      # ekran hosta (TV/laptop) - odtwarza audio, pokazuje wyniki
│   ├── player.html/js    # kontroler gracza (telefon) - tylko przyciski z odpowiedziami
│   └── style.css
├── library/               # tu wrzucasz foldery artystów z plikami mp3 (jak MUSIC_DIR w mp.py)
└── clips/                 # auto-generowane wycięte fragmenty (jak TEMP_DIR w mp.py)
```

Model gry jak w Jackbox Party: **host** wystawia ekran (np. na TV, podłączony
do głośników) i tam leci muzyka; **gracze** wchodzą na `player.html` z telefonu,
wpisują 5-znakowy kod pokoju i tylko klikają odpowiedzi - żadnej instalacji.

## Uruchomienie lokalne

```bash
npm install
# wrzuć muzykę do library/<artysta>/*.mp3, albo ustaw MUSIC_DIR na inny folder
MUSIC_DIR="D:\Muzyka" npm start
```

Serwer wystartuje na porcie 3000:
- Host wchodzi na `http://localhost:3000/host.html`
- Gracze wchodzą na `http://<adres-hosta>:3000/player.html`

## Udostępnienie znajomym przez Tailscale

Tailscale tworzy prywatną sieć VPN między Twoimi urządzeniami i urządzeniami
znajomych bez konieczności przekierowania portów na routerze.

1. **Zainstaluj Tailscale** na komputerze, który będzie serwerem gry:
   https://tailscale.com/download — zaloguj się (Google/GitHub/Microsoft).

2. **Zaproś znajomych do swojej sieci Tailscale** (tzw. tailnet):
   - Wejdź na https://login.tailscale.com/admin/users
   - Zaproś ich e-mailem, albo skorzystaj z funkcji "Share" dla konkretnego
     urządzenia (Tailscale → Admin console → wybierz maszynę → "Share..."),
     dzięki czemu znajomi nie muszą dołączać do całej Twojej sieci - dostają
     dostęp tylko do Twojego serwera gry.
   - Każdy znajomy instaluje Tailscale na swoim telefonie/laptopie i loguje
     się linkiem z zaproszenia.

3. **Sprawdź swój adres Tailscale**:
   ```bash
   tailscale ip -4
   ```
   albo użyj MagicDNS (włączone domyślnie) — wtedy adres to np. `twoj-komputer.tailXXXX.ts.net`.

4. **Uruchom serwer** (`npm start`) i podaj znajomym:
   - Ty (host): `http://localhost:3000/host.html` (lub przez Tailscale IP, jeśli wolisz)
   - Znajomi (gracze): `http://<twoj-tailscale-ip-lub-magicdns>:3000/player.html`

5. Gotowe — nie trzeba otwierać portów na routerze, nie trzeba publicznego
   serwera. Ruch idzie przez zaszyfrowany tunel WireGuard między urządzeniami
   w Twoim tailnecie.

### Firewall

Jeśli znajomi nie mogą się połączyć mimo wspólnego tailnetu, sprawdź zaporę
systemową na komputerze-hoście — musi zezwalać na ruch przychodzący na porcie
3000 (przynajmniej z interfejsu Tailscale, `tailscale0`/`Tailscale`).

## Integracja Spotify (realne audio z całego katalogu)

Oprócz lokalnej biblioteki mp3, host może wybrać źródło "Spotify" - wtedy
gra odtwarza prawdziwe utwory z całego katalogu Spotify (nie tylko
najpopularniejsze) przez oficjalny **Web Playback SDK**. Przeglądarka hosta
staje się urządzeniem Spotify Connect; utwory streamują się na żywo, nic nie
jest pobierane ani zapisywane na dysku.

### Wymagania

- **Spotify Premium na koncie hosta** (Web Playback SDK tego wymaga - Free nie zadziała)
- Przeglądarka z pełnym wsparciem EME: Chrome/Edge/Firefox na desktopie.
  Safari na iOS ma ograniczone wsparcie - do testów polecam desktop.
- Własna aplikacja zarejestrowana na [developer.spotify.com](https://developer.spotify.com/dashboard)

### Konfiguracja

**Ważne od listopada 2025:** Spotify przestał akceptować `localhost` jako nazwę
hosta w redirect URI, a zwykłe HTTP działa **tylko** dla adresu loopback
(`127.0.0.1` / `[::1]`) - każdy inny adres (w tym adres Tailscale) wymagałby
HTTPS. Ponieważ tylko **host** loguje się do Spotify (jego przeglądarka
odtwarza muzykę), a host i serwer działają na tym samym komputerze, najprościej
jest logować się zawsze przez `127.0.0.1` - gracze i tak łączą się przez
Tailscale bez żadnych zmian, to ich nie dotyczy.

1. Załóż aplikację na [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. W ustawieniach aplikacji dodaj **dokładnie**:
   ```
   http://127.0.0.1:3000/auth/spotify/callback
   ```
   (zmień port na inny, jeśli nie używasz domyślnego 3000)
3. Skopiuj Client ID i Client Secret z dashboardu
4. Uruchom serwer:

```bash
# PowerShell
$env:SPOTIFY_CLIENT_ID="twoj_client_id"
$env:SPOTIFY_CLIENT_SECRET="twoj_client_secret"
npm start
```

`SPOTIFY_REDIRECT_URI` nie jest wymagany - serwer sam wykrywa poprawny adres
na podstawie tego, skąd host faktycznie otwiera aplikację.

5. **Host otwiera ekran hosta pod adresem `http://127.0.0.1:3000/host.html`**
   (nie `localhost`, nie adres Tailscale - Spotify odrzuci cokolwiek innego niż
   loopback po HTTP). Wybierz źródło "Spotify (wymaga Premium)", kliknij
   "Połącz ze Spotify", po zalogowaniu wyszukaj artystów i dodaj ich do puli.
6. Gracze wchodzą normalnie przez `http://<twoj-tailscale-host>:3000/player.html` -
   to ich nie dotyczy, logowanie do Spotify jest tylko po stronie hosta.

### Jak to działa technicznie

- **Wyszukiwanie artysty i przeglądanie dyskografii** (`server/spotifyCatalog.js`)
  działa na tokenie aplikacji (Client Credentials Flow) - nie wymaga logowania
  hosta. Pula bazowa budowana jest z albumów i singli artysty (nie z
  `/top-tracks`, który ogranicza się do garstki hitów). Przy dodawaniu
  artysty host wybiera **ile utworów** wziąć i **czy losowo z całej
  dyskografii, czy najpopularniejsze** (popularność dociągana osobno przez
  `/v1/tracks`, bo endpoint albumów jej nie zwraca).
- **Logowanie hosta** (`server/spotifyAuth.js`) to standardowy OAuth
  Authorization Code Flow, otwierany w osobnym okienku (popup), żeby nie
  przeładować karty hosta w trakcie trwającej gry. Token trzymany jest
  server-side w pamięci procesu, powiązany z ciasteczkiem sesji.
- **Odtwarzanie** idzie przez oficjalny Spotify Web Playback SDK
  (`public/host.js`) - przeglądarka hosta rejestruje się jako urządzenie
  Spotify Connect, a start/stop/pozycja w utworze sterowane są przez Spotify
  Web API (`PUT /v1/me/player/play` z `position_ms`, potem
  `PUT /v1/me/player/pause` po czasie ustawionym w "Czas fragmentu").

### Znane ograniczenia

- Bez dostępu do surowego dźwięku (Spotify go nie udostępnia) nie da się
  wykryć ciszy tak jak w trybie lokalnym (`ffmpeg silencedetect`). Tryb
  "losowy fragment" losuje pozycję startu z całego utworu bez żadnego
  sztucznego omijania początku/końca - czasem trafi się cichy fragment albo
  fade, to świadomy kompromis wynikający z braku dostępu do audio.
- Sesja logowania trzymana jest w pamięci procesu - restart serwera wymaga
  ponownego zalogowania hosta do Spotify (ale NIE tworzy nowego pokoju gry).
- Pobieranie dyskografii artysty z wieloma albumami może chwilę potrwać
  (jeden request API na album) - dla bardzo płodnych artystów ograniczone
  do pierwszych 25 wydawnictw.
- Logowanie hosta do Spotify działa tylko przez `127.0.0.1` (loopback) albo
  HTTPS z prawdziwą domeną - to wymóg Spotify, nie ograniczenie tej appki.
  Jeśli kiedyś zechcesz, żeby host logował się zdalnie (np. z innego
  komputera niż ten, na którym stoi serwer), potrzebny będzie reverse proxy
  z certyfikatem HTTPS (np. Caddy, albo Tailscale Funnel) - dla gry ze
  znajomymi z hostem na tej samej maszynie co serwer nie jest to potrzebne.


Zaimplementowane (przeniesione z `mp.py`):
- Tworzenie pokoju z kodem, dołączanie graczy
- Ustawienia gry (tryb, ilość rund, czas fragmentu, ilość odpowiedzi)
- Wybór aktywnych artystów w UI hosta (klikalne "chipy", zaznacz/odznacz
  wszystkich, licznik wybranych utworów) — odpowiednik `artist_selection_menu()`
- Przygotowanie rund: losowanie piosenek, cięcie fragmentów przez ffmpeg,
  generowanie błędnych odpowiedzi
- **Detekcja ciszy** przez filtr `silencedetect` w ffmpeg (próg -40dB, min.
  50ms ciszy — te same parametry co `detect_nonsilent` w mp.py), używana w
  obu trybach:
  - `losowy_fragment`: jeśli trafiony fragment jest ciszą, przesuwa start
    o 100ms (do 10 prób) — 1:1 jak pętla `while not detect_nonsilent(...)`
  - `poczatek`: startem rundy jest pierwszy wykryty nie-cichy fragment
    utworu, zamiast sztywnego 0:00
- Pełny cykl rundy: start → odpowiedzi graczy → wynik → punktacja → następna runda
- **Etykiety odpowiedzi w formacie "Tytuł - Wykonawca"** — dotyczy obu źródeł:
  w trybie lokalnym wykonawca to nazwa folderu, w trybie Spotify to nazwa
  dodanego artysty (z mapy `artistId -> nazwa`, bo pojedynczy utwór w puli
  Spotify nie niesie tej informacji sam z siebie). Tytuł i wykonawca są
  przekazywane osobno (`{title, artist}`) i wyświetlane w dwóch liniach -
  wykonawca mniejszą czcionką pod tytułem.
- **Powrót do ekranu głównego** po zakończonej grze (ten sam kod pokoju, gracze
  zostają, punkty się zerują) — celowo NIE przez przeładowanie strony, bo to
  zerwałoby połączenie Spotify Web Playback SDK i wymusiło ponowne logowanie
- **Awatary graczy** — mały, okrągły obrazek losowany z `public/avatars/*.png`
  przy dołączeniu do pokoju, widoczny wszędzie gdzie pojawia się gracz
  (lobby, status odpowiedzi, wyniki rundy, ranking). Folder ma domyślnie
  8 wygenerowanych, abstrakcyjnych awatarów w kolorystyce appki — wrzuć tam
  własne pliki `.png`, żeby je podmienić (dowolny rozmiar, przycinane do
  koła w CSS). Jeśli folder jest pusty, gracz dostaje zamiast zdjęcia
  kolorowy inicjał swojego imienia.
- Ranking na żywo (leaderboard)
- Walidacja przed startem gry (min. 1 artysta, wystarczająco utworów na
  wybraną ilość rund)
- **Integracja ze Spotify** (opcjonalne drugie źródło muzyki obok lokalnej
  biblioteki) — logowanie hosta przez OAuth w popupie, wyszukiwanie artysty
  i przeglądanie pełnej dyskografii (nie tylko top-tracków), realne
  odtwarzanie przez Web Playback SDK ze sterowaniem pozycją startu i
  automatycznym stopem po czasie fragmentu

Do dopracowania (TODO, celowo pominięte w szkielecie):
- Reconnect graczy po utracie połączenia (np. przy zmianie sieci na telefonie)
- Zabezpieczenie przed podszywaniem się pod hosta / duplikatami kodów pokoju
  w środowisku produkcyjnym (obecnie wystarczające dla gry ze znajomymi)
- Detekcja ciszy robi dodatkowy przebieg ffmpeg per utwór przy przygotowywaniu
  rund — przy bardzo dużych bibliotekach/wielu rundach można to zrównoleglić
  (`Promise.all` zamiast pętli `for...of`)
