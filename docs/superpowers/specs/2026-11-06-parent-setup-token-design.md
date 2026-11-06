# Kod konfiguracji pierwszego PIN-u rodzica (#307)

Decyzja właściciela z 2026-11-06: wariant „token z env”.

## Problem

`POST /api/v1/parent/setup` działał bez sesji i bez żadnego sekretu. Na świeżej
instancji wystawionej przez Coolify pierwszy odwiedzający mógł ustawić PIN
i przejąć panel rodzica (postępy dzieci, usuwanie profili).

## Rozwiązanie

- `UMIEM_SETUP_TOKEN` w env procesu web, bez wartości domyślnej
  (`config-defaults.ts` go nie zna). `composition.ts` przekazuje go jako
  `Services.parentSetupToken`.
- Przypadek użycia `setupParentWithToken` (`family/auth.ts`): brak kodu →
  `setup_disabled` (403); błędny kod → `invalid_setup_token` (403) i porażka
  w limicie prób logowania (5 w 15 min, wspólny z loginem; po ustawieniu PIN-u setup od razu zwraca `already_configured`, więc nie blokuje logowania); porównanie skrótów
  sha256 przez `timingSafeEqual`; poprawny kod → dotychczasowy `setupParent`.
- `setupParent` zostaje operacją zaufaną (testy integracyjne, skrypty); jedynym
  wywołującym HTTP jest router (`auth.setup`), który woła `setupParentWithToken`.
- Kontrakt Parent API (wewnętrzny dla `apps/web`): `setup` przyjmuje
  `{ secret, setupToken }`. Formularz pierwszego uruchomienia ma pole
  „Kod konfiguracji”.

## Poza zakresem

Brama dostępu spoza domu i autoryzacja Kid API (osobna decyzja, arch §13).
Kod chroni wyłącznie pierwsze ustawienie PIN-u.

## Wpływ API → MCP → skill

Brak: Parent API nie jest wystawione przez MCP ani opisane w `SKILL.md`.
