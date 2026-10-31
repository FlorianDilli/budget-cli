# Budget Tracker

Local-first personal budget tracker with encrypted browser storage, CSV imports, visual budget planning, and spending insights.

Budget Tracker is a browser app for importing bank transactions, maintaining a monthly budget, and reviewing spending over time. It is designed to keep financial data on your device rather than sending it to an application server.

## Features

- Review available-to-spend totals, monthly budget, spending, alerts, and account totals.
- Import CSV transactions with configurable column and number formats, preview, and duplicate detection.
- Edit recurring budget entries in a TOML editor and inspect them in a visual monthly budget.
- Browse transaction matches and spending insights across months.
- Export and restore password-protected `.budget` backups.
- Install the app as a PWA and use its cached app shell offline after the first load.

## Privacy And Backups

The app stores its encrypted data in this browser's IndexedDB. A password-derived Argon2id key protects it with AES-GCM encryption; the app does not send financial data to a backend. Export backups regularly because browser data can be cleared or lost; a `.budget` file can be imported into another browser profile with its password. There is no password recovery: if you forget the password, the encrypted data cannot be unlocked.

## Run Locally

Requires Node.js 22 and npm.

```sh
cd web
npm ci
npm run dev
```

Open the local URL printed by Vite. To run the checks and create a production build:

```sh
npm test
npm run build
```

Run these commands from the `web/` directory. The production build is written to `web/dist/`.

## Project Layout

- `web/src/domain/` contains budget calculations, CSV and TOML parsing, and date and money utilities.
- `web/src/crypto/` and `web/src/storage/` contain encrypted backup and browser-storage code.
- `web/src/ui/` contains the app screens and budget editor.
- `docs/` contains implementation notes and UI conventions.

GitHub Actions runs the web tests and production build for pushes and pull requests, and deploys the app to GitHub Pages from the configured deployment branch.
