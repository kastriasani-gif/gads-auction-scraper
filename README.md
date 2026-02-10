# Google Ads Auction Insights Scraper

Automatisiert den Download von Auction Insights aus Google Ads über Playwright.

## Setup auf GitHub Codespaces

```bash
# 1. Repository erstellen und Codespace öffnen

# 2. Dependencies installieren
npm install

# 3. Chromium installieren
npm run setup

# 4. Account IDs in scraper.js konfigurieren
# Öffne scraper.js und füge deine Account IDs ein:
# accounts: ["612-310-3619", "123-456-7890"],

# 5. Erster Lauf (mit Browser-Fenster für Login)
npm start
```

## Erster Lauf

Beim ersten Start öffnet sich ein Chromium-Fenster:
1. Du wirst zur Google Ads Login-Seite weitergeleitet
2. Logge dich manuell ein
3. Das Skript speichert den Browser-State in `./browser-data/`
4. Bei weiteren Läufen bist du automatisch eingeloggt

## Konfiguration

In `scraper.js` oben im CONFIG-Block:

| Option | Beschreibung |
|--------|-------------|
| `accounts` | Array von Google Ads Account IDs (Format: "xxx-xxx-xxxx") |
| `level` | "campaign" (pro Kampagne) oder "account" (alle zusammen) |
| `dateRange` | Zeitraum: "LAST_7_DAYS", "LAST_30_DAYS", etc. |
| `headless` | `false` = Browser sichtbar, `true` = unsichtbar |

## Output

CSV-Dateien werden in `./downloads/` gespeichert:
```
downloads/
  auction_insights_612-310-3619_all-campaigns_2026-02-10.csv
  auction_insights_123-456-7890_Campaign-Name_2026-02-10.csv
```

## Für wöchentliche Automatisierung

Nach erfolgreichem Test auf einem VPS/Server deployen:

```bash
# Crontab (jeden Montag 8:00 Uhr)
0 8 * * 1 cd /path/to/gads-auction-scraper && node scraper.js >> scraper.log 2>&1
```

Oder in n8n als Execute Command Node einbinden.

## Hinweise

- Google kann Headless-Browser erkennen → `headless: false` ist sicherer
- Browser-State in `./browser-data/` aufbewahren (nicht löschen!)
- Bei 2FA: Beim ersten Login manuell durchführen
- Google Ads UI ändert sich regelmäßig → Selektoren müssen ggf. angepasst werden
