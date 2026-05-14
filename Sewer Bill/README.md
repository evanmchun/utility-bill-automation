# NEORSD sewer bill downloader

Downloads current NEORSD bill PDFs from the Kubra portal and files them into month folders.

## Setup

Create `.env` from `.env.example`, then enter the NEORSD username, password, and security-question answers.

Install dependencies once:

```powershell
npm install
```

If Playwright asks for a browser install:

```powershell
npx playwright install chromium
```

## Run on demand

From this folder:

```powershell
node .\download-sewer-bills.mjs
```

Run for a specific month:

```powershell
node .\download-sewer-bills.mjs --month 2026-05
```

Download all bill links currently visible on the dashboard:

```powershell
node .\download-sewer-bills.mjs --all
```

Show the browser while it runs:

```powershell
node .\download-sewer-bills.mjs --month 2026-05 --visible
```

If Kubra asks a security question, run this once and answer the prompt in the browser:

```powershell
node .\download-sewer-bills.mjs --month 2026-05 --visible --manual-security
```

## Files

- `.env` stores the local NEORSD username and password.
- `.browser-profile` stores the trusted browser session so Kubra can remember "Do not ask me security questions at this browser."
- `YYYY-MM\*.pdf` folders contain the downloaded bills.
- `.env`, `.browser-profile`, and `node_modules` are ignored by Git.
