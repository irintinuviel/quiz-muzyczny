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

## Co jest szkieletem, a co trzeba dopracować

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
- Ranking na żywo (leaderboard)
- Walidacja przed startem gry (min. 1 artysta, wystarczająco utworów na
  wybraną ilość rund)

Do dopracowania (TODO, celowo pominięte w szkielecie):
- Reconnect graczy po utracie połączenia (np. przy zmianie sieci na telefonie)
- Zabezpieczenie przed podszywaniem się pod hosta / duplikatami kodów pokoju
  w środowisku produkcyjnym (obecnie wystarczające dla gry ze znajomymi)
- Detekcja ciszy robi dodatkowy przebieg ffmpeg per utwór przy przygotowywaniu
  rund — przy bardzo dużych bibliotekach/wielu rundach można to zrównoleglić
  (`Promise.all` zamiast pętli `for...of`)
