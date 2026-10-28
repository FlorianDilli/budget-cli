# Local-First Browser App Plan (final candidate)

Status: platform, scope, the budget definition (Decision 18), and the month-level activity rule (Decision 19) are decided. The Python CLI is legacy and is not changed. Only the current remote `main` counts as the editor reference. `FlorianDilli/budget-cli` is public. The budget editor is on remote `main` as `index.html` (commit `f229586`) with synthetic sample values. The original figures remain in older public history and on the live page, so Immediate Actions 1-2 must be decided before the repository is treated as clean.

## Immediate Actions (Before Any Commit Or Deploy)

1. Remove your figures from the live page `https://floriandilli.github.io/TOML-Editor/`. Verified: its served script contains the financial sample (`amount = 3400.00`, `MAINGAU Energie GmbH`). This is your action; this plan cannot change that deployment.
2. The repository is public. After `git fetch origin`, check every branch for your figures: `git log --all -S "MAINGAU" --oneline` and `git log --all -S "3400.00" --oneline`. If matches exist, removing them from public history requires a rewrite and force-push. Do not do that without your explicit approval.
3. Run `git fetch origin`. The workspace's local `main` (`856fde0`) is behind remote `main` (`f229586`).

Done: remote `main` `index.html` (commit `f229586`) is the budget version with synthetic `SAMPLE_TEMPLATES.financials` values. It is the porting reference: read it from `origin/main`, and do not copy the original attachment into the repo. Verified by public raw URL: no `MAINGAU` or `3400` in the file.

## Scope

In scope, all current CLI features except forecasting and simulation:
- Overview: month summary, available to spend ("left"), budget alerts, top 10 transactions and categories (core.py:927-987, 1250-1296).
- Transactions: month list and month detail with match flags (main.py:492-645; core.py:1298-1303).
- Insights: Months at a glance including averages (core.py:1077-1095; main.py:731-820); total-money chart (main.py:1005-1045 uses plotille; web uses a chart library).
- CSV import with duplicate skipping (importer.py).
- Edit `settings.toml` and `financials.toml` as TOML in the app. Saving re-applies configuration and recategorizes (core.py:1459-1535).
- Visual Budget from the budget editor on `main`: the monthly budget view and editing surface (Decision 18).
- Delete one month; full reset (core.py:1309-1330).
- Change password (core.py:1340).

Out of scope: Budget Forecast (core.py:1098), Simulate the future (core.py:1535-1630), transaction editing, form-based editing of recurring entries, category rules, or cash, the terminal theme (`[theme]`), iCloud sync, SQLite migration, and changes to the Python CLI (legacy). Tree View, Format, and Share are not in the current editor and are not in scope.

## Data Flow And Boundaries

- Inputs: CSV files (file picker), `settings.toml` and `financials.toml` (editor or file open), `.budget` (restore).
- Parse and validate, then the shared TypeScript domain layer (plan, transaction calculations, categorization, duplicate detection) produces the active snapshot.
- The active snapshot is encrypted and stored in IndexedDB. Decrypted data exists in memory only while unlocked.
- Outputs: `.budget` (same envelope), TOML download (raw text of the active version), and the UI.
- Boundaries: changes only under `web/`, `.gitignore`, and a GitHub Actions workflow. The Python CLI (`main.py`, `app/`), FAQ.md, and the example TOML files are not modified. The reference HTML is a porting reference only and is not shipped.

## TOML Studio Editor (Reference On Remote `main`)

Source: `index.html` on remote `main` (commit `f229586`), titled "moonli TOML Studio & Budget Inspector". Verified features:
- Editor (CodeMirror 5), split and single view modes, symbol bar (`[ ] [[ ]] { } " ' = # ,` and Tab), Clear, Copy, undo and redo, search, line wrap, drag-and-drop and Open for files, Download.
- Visual Budget, plan-only: `calculateMonthBudget` (line 3138) and `getEffectiveTransactionForMonth` (line 2803). It reads recurring entries and cash from the TOML and never uses imported transactions.
- Hand-written `Toml11Parser` (line 2028).
- Error banner with "Jump to line".
- Sample templates: `financials` (budget), Cargo, pyproject, config, fly. The `financials` sample is synthetic on `main`.

Shared findings:
- No `fetch`, XHR, analytics, or beacon calls. External requests: Google Fonts, cdnjs (CodeMirror 5.65.16), jsDelivr (Lucide 0.469.0). Bundle all assets; no runtime CDN.
- Persistence: the editor autosaves the full document to `localStorage` (`moonli_toml_content`) on every change. Unencrypted; must not be carried into the merged app. Preferences (dark mode, line wrap, currency, sort) may stay in `localStorage`.
- `intuitive_name` is the display name, and `category` defaults to "General" (lines 2860-2862). The engine uses neither.
- `logo.svg` is referenced (favicon and header) but is not in the repository.

Merge rules:
1. Keep: CodeMirror editor, symbol bar, search, undo and redo, line wrap, error banner with jump to line, drag-and-drop open, Open, Download, Copy, Clear, and Visual Budget (month strip, KPIs, Sankey, month diff, cash banner, sorting, currency).
2. Drafts: keep unsaved edits in memory. Only a valid Save changes the active version (Decision 15). The editor saves every keystroke, so this behavior is replaced.
3. Assets: bundle CodeMirror, Lucide, and fonts through npm. Consider CodeMirror 6, since CodeMirror 5 is legacy; verify mobile behavior.
4. Parser: replace `Toml11Parser` with one tested TOML 1.0 library that still reports line and column. Accept quoted and native TOML dates, and normalize both to `YYYY-MM-DD` internally.
5. Samples: synthetic budget sample only; first-run content is labeled as sample and is not saved as user data unless the user saves it. Drop the non-budget samples (Open Question 2).
6. Budget logic: the Visual Budget and the Overview "left" figure use one shared TypeScript plan function.
7. Port by rewriting into `web/src`; do not ship the reference HTML.

## Budget Definition (Decided)

- Decision 18: The `financials.toml` plan is the monthly budget. Left for a month = plan budget + non-recurring transactions + recurring deviations (FAQ.md:37-43; core.py:967, 1052).
- Decision 19: Month-level activity. An entry counts in month M if it is active on any day of M: it starts on or before the last day of M, and it does not end before the first day of M. Your rule: "as soon as the scheduled transaction begins at any date in this month, it is counted in this month's budget."
- Plan price for month M: the most recent `amount_history` entry whose `from` is on or before the last day of M. Inferred from Decision 19 and matching the editor's behavior; confirm at golden-test review.
- Transaction matching and alerts keep transaction-date pricing (core.py:483-490, 546-590), so a mid-month price change does not raise a false mismatch on payments made before it. Inferred; confirm at golden-test review.
- The Python plan rules (first-day activity, first-day price; core.py:467-479, 1047-1048) are legacy and are not the reference.

## Plan Rules: Edge Cases (Recommended Defaults)

Adopted unless changed during golden-test review:
- No `start_date`: active from the earliest `amount_history` date when history exists, otherwise from the beginning. This is the editor's behavior.
- History only (no base `amount`): before the first `from`, the entry is not active.
- Missing `recurrence_months`: default 1.

## Engine Behavior To Port

- Monthly budget: sum of each recurring entry active in the month (Decision 19), `amount / recurrence_months`, with the price per the Budget Definition.
- Recurring matching: description substring, amount, and `payment_month`. Flags AMOUNT_MISMATCH, WRONG_MONTH, and VERIFIED, plus alerts including missing payments (core.py:524-675).
- Available to spend = budget + non-recurring spending + recurring deviations (core.py:967, 1052).
- Categories: first matching keyword in `category_rules`, otherwise "Uncategorized" (core.py:1113-1130).
- Duplicates: SHA-256 of `date-description-amount-occurrence`, with occurrence counted per file; existing hashes are skipped (crypto.py:127-132; importer.py:282-308).
- Account = importer format name. Total money = account snapshot adjusted by transactions, plus cash (core.py:822-1011).
- Date-dependent logic uses `datetime.now()` (core.py:934, 1022). The port must inject `now`.

## Differences Between The Sample TOML And The Engine

- `recurrence_months`: described as optional (default 1), but the engine rejects a missing value (core.py:328-330). Port: default to 1.
- `description`: described as optional, but the engine requires it (core.py:486, 541, 1214, 673). Port: must not crash; behavior follows Decision 13.
- `intuitive_name` and recurring `category`: not used by the engine. Port: parse, store, and display. Category behavior is deferred (Open Question 4).
- `[theme]`: terminal colors. Ignored by the web app; preserved in the raw text (Decision 16).

## Decisions

1. Local-only: no server. All data stays in the browser, and no network request carries user data. Stack: Vite + React + TypeScript PWA in `web/`, deployed to GitHub Pages by GitHub Actions after merge to `main`. No runtime CDN.
2. Navigation: Overview, Transactions, Insights, Settings. Bottom bar on phones; sidebar on wider screens.
3. Password required. No recovery: a forgotten password makes the data unreadable. State this on the setup screen.
4. Encryption: Argon2id key derivation via a pinned WASM library (Web Crypto does not provide Argon2; e.g. hash-wasm, verify at implementation). AES-256-GCM via Web Crypto. Fresh random salt and nonce per save. Header stores format version and KDF parameters, at least the CLI's values (time 2, memory 19 MiB, parallelism 1).
5. Local store: one encrypted snapshot in IndexedDB, written atomically. It holds the raw text of `settings.toml` and `financials.toml`, plus imported transactions.
6. Backup: one `.budget` file using the same envelope plus metadata (format version, created time). Contains the same data as the local snapshot. Original CSVs are not included. Export uses the editor's Download-style file save; on iPhone, the browser's download flow saves to Files.
7. Restore: replaces local data after confirmation. Show both timestamps and warn when the backup is older than local data (Open Question 5).
8. Money: exact decimal arithmetic. No JavaScript floats.
9. Time: all date logic takes an injected `now`.
10. CSV import: same rules as importer.py (BOM, per-format delimiter, 10 MB limit, date formats, decimal and thousands separators). Flow: select, preview, confirm, commit per file. A file with errors commits nothing. Duplicate rule is identical to the CLI, so re-importing is idempotent.
11. Schema version stored in IndexedDB and in `.budget`. Refuse newer unknown versions; migrate older ones.
12. Service worker precaches the app shell only. It never caches uploaded files, decrypted data, or backups. Prompt the user when a new version is ready.
13. Recurring entries without `description` count in budget totals and are never matched to imported transactions automatically (decision recorded earlier; not re-opened).
14. Editing: `settings.toml` and `financials.toml` are edited as raw TOML in the same in-app editor (rebuilt on bundled assets).
15. Save rule: validate first. Invalid TOML or entries are reported with the line or entry name, and the last valid version stays active. A valid save stores the text, then re-applies configuration and recategorizes all transactions (equivalent of the CLI's "Apply changes"). CSV format changes apply to the next import.
16. Raw text is the source of truth; parsed values are derived from it. Comments, formatting, and unknown keys survive export unchanged.
17. Drafts: unsaved edits stay in memory until Save. Only a valid Save changes the active version. The editor autosaves each keystroke to `localStorage`; that behavior is replaced.
18. Budget: the `financials.toml` plan is the monthly budget, and the editor is where it is maintained. Left = plan budget + non-recurring transactions + recurring deviations. Visual Budget and Overview use the same shared plan function.
19. Activity is month-level: an entry counts in every month where it is active on any day. Start and end dates are compared at month granularity. Plan price = most recent `from` on or before the month's last day. Transaction matching keeps transaction-date pricing. This applies to the web app only; the Python CLI is legacy.

## iOS And PWA Storage (Verified)

- A Home Screen web app has its own storage, separate from Safari. Data entered in Safari does not appear in the installed app, and the reverse. Use one entry point per device and transfer data with `.budget`.
- Safari tab data is subject to ITP: script storage is deleted after 7 days without user interaction. Installed Home Screen apps are exempt.
- Recommendation: use the installed app on iPhone and iPad, and export a backup after each import or edit session.
- Sources: WebKit "Tracking Prevention in WebKit"; WebKit bug 181849; WebKit Safari 17.2 release notes.

## Ordered Tasks

1. Decide and complete Immediate Actions 1-3.
2. Create `feat/local-first-web-app` from `origin/main` (remote `main` `f229586` at this writing), not from local `main` (`856fde0`) and not from `kilo/empty-path-81k`. Scaffold `web/` with Vite, React, TypeScript, routing, and the responsive shell.
3. Build the pure TypeScript domain layer: CSV and TOML parsers, data model, shared plan function (Decision 19), transaction calculations, categorization, duplicate detection. No UI.
4. Add golden tests: Python-engine outputs for matching, duplicates, categories, and total money; Decision 19 fixtures for plan rules.
5. Build the crypto envelope and IndexedDB store: create, unlock, lock, change password, reset.
6. Build `.budget` export and restore with error handling.
7. Build the CSV import flow: select, detect format, preview, correct mapping, confirm, summary.
8. Build screens: Overview; Transactions; Insights (history, months at a glance, total-money chart); Settings (editors for `settings.toml` and `financials.toml`); Data (delete month, full reset, change password).
9. Build the save-and-apply flow (Decision 15) and the draft model (Decision 17).
10. Port the editor into Settings and the Visual Budget view, from `origin/main:index.html`, using synthetic sample data. Replace the parser and the CDN assets.
11. Add the PWA manifest, service worker, install prompt, and offline behavior.
12. Add GitHub Actions for build, test, and Pages deploy. Set the Pages source to "GitHub Actions" in repository settings. Use the repository name for the Vite base path.
13. Write in-app help text for the activity and price rules. Leave FAQ.md (CLI documentation) unchanged.
14. Update repository hygiene (below).

## Repository Hygiene

- Current `.gitignore` covers `userdata/`, `*.db`, and `.kilo/`. Add `*.budget`, `*.salt`, `*.csv`, `statements/`, and real `settings.toml` and `financials.toml`. Allow synthetic fixtures under `web/test/fixtures/`.
- `.kilo/` is git-ignored, so this plan is not versioned. Move it to a tracked location if it should be committed.
- The repository is public: commit only synthetic data, and run the secret scan below before every push.

## Validation

- Golden tests: Python-engine outputs on synthetic data (`BUDGET_DATA_PATH` set to a temp directory, fixed clock) for matching, duplicates, categories, and total money. Compare exactly.
- Plan fixtures: one per rule in Decision 19 and each edge case above, with the expected result written from the decision, not from Python output.
- Unit tests: parser errors name the key or entry; every field in the sample TOML parses; defaults apply; quoted and native dates both parse.
- Parser conformance: the TypeScript parser passes a TOML 1.0 test suite (e.g. toml-test) and parses every synthetic sample file.
- Editor tests: invalid TOML never replaces the last valid version; drafts are not persisted before Save; each entry error reports its entry name.
- Crypto tests: round trip, wrong password, tampered ciphertext, truncated file, unknown version.
- Import tests: re-importing adds zero rows; a failing file commits nothing.
- E2E (Playwright): phone and desktop widths, navigation, editor, upload and download, offline reload, restore into a fresh profile.
- Network: only app assets are requested; no user data appears in any request; no third-party origins.
- Secret scan before each push: `git log --all -S "MAINGAU"` and `git log --all -S "3400.00"` return nothing, and the built `dist/` contains neither value.

## Failure Modes

- Wrong password: show an error; change no data.
- Tampered or truncated backup: reject before local data changes.
- Invalid TOML save: keep the last valid version active.
- Storage eviction: detect missing data, offer restore, show last-backup date.
- Stale device: warn when a restored backup is older than local data.
- Forgotten password: data is unrecoverable.
- Sample figures publicly served: the live TOML-Editor page exposes them now (Immediate Action 1); the public repository holds them in history (Immediate Action 2).
- Existing `localStorage` content from the standalone TOML Studio is on a different origin and is not migrated. Download the file from the old page first.

## Rollout

Feature branch from `origin/main`, pull request, merge, Pages deploy. No SQLite migration. The Python CLI is unchanged.

## Open Questions

1. Resolved: the Python CLI is legacy and is not changed.
2. Sample templates: drop the non-budget samples (Cargo, pyproject, config, fly). Default: drop.
3. Logo: resolved. `logo.svg` is on remote `main` (512x512 SVG, moonli mark). Use it for the favicon and header; bundle it with the app.
4. Recurring `category` on matched transactions: deferred. Default: store and display it; transactions keep `category_rules` results.
5. Restore: replace local data (default), with a warning when the backup is older. Merge is not planned.
6. Repository visibility: resolved. `FlorianDilli/budget-cli` is public, so Immediate Actions 1-2 apply, and GitHub Pages is available without a paid plan.
7. Auto-lock: lock after 10 minutes of inactivity (default), configurable later.
8. Brand name: keep "moonli" (default).

Resolved:
- Only the current remote `main` counts as the editor reference. Tree View, Format, and Share are out of scope.
- `settings.toml` uses the same editor as `financials.toml` (Decision 14).
- Plan versus actual: the `financials.toml` plan is the budget, and "left" is calculated from it (Decision 18).
- Plan-rule conflicts: Decision 19 defines activity and price for the web app.
