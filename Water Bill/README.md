# Cleveland Water bill downloader

Downloads current Cleveland Water bill PDFs from `my.clevelandwater.com` and files them into month folders.

## Run on demand

From this folder:

```powershell
node .\download-water-bills.mjs --month 2026-05
```

Use the current month by omitting `--month`:

```powershell
node .\download-water-bills.mjs
```

Download all bill links currently visible on the Kubra dashboard:

```powershell
node .\download-water-bills.mjs --all
```

Show the browser while it runs:

```powershell
node .\download-water-bills.mjs --month 2026-05 --visible
```

## View recent water usage

Show daily usage for roughly the past week across all water accounts:

```powershell
npm run usage
```

Double-click `view-water-usage.bat` to show the past 30 available daily usage days, the past 3 days of hourly usage, and open a webpage report.

Change the number of days, filter to one account, or save CSV output:

```powershell
node .\download-water-usage.mjs --days 10
node .\download-water-usage.mjs --account 8513827190
node .\download-water-usage.mjs --output .\water-usage.csv
node .\download-water-usage.mjs --days 30 --hourly-days 3 --html .\water-usage-report.html
node .\download-water-usage.mjs --days 30 --hourly-days 3 --summary .\water-usage-summary.md
```

## Email alerts for unusually high usage

The usage script sends a Gmail alert when the latest hourly usage reaches 150 gallons or the latest daily usage goes above 200 gallons. Daily alerts repeat at 300, 400, 500 gallons, and every additional 100-gallon level. Each property, reading, and level is recorded so the same event is not emailed twice. The prior 14-day median is included with daily alerts for context but does not change the thresholds.

Turn on two-step verification for the sending Google account and create a Google App Password. Add these lines to `.env`:

```text
WATER_ALERTS_ENABLED=true
ALERT_EMAIL_FROM=your-email@gmail.com
ALERT_EMAIL_TO=recipient@example.com
GMAIL_APP_PASSWORD=your-16-digit-app-password
WATER_ALERT_DAILY_LIMIT_GALLONS=200
WATER_ALERT_HOURLY_LIMIT_GALLONS=150
WATER_ALERT_INCREMENT_GALLONS=100
```

Optional threshold settings are documented in `.env.example`. Sent alert history is stored in `.water-usage-alert-state.json`, preventing duplicate messages for the same property and date.

Run `check-water-usage-alerts.bat` manually or schedule it in Windows Task Scheduler. It checks usage, updates `water-usage-report.html`, and records output in `water-usage-alerts.log` without opening a browser window.

## Run every three hours with GitHub Actions

The repository workflow at `.github/workflows/water-usage-monitor.yml` runs the monitor every three hours and can also be started manually. Configure these repository secrets before enabling email alerts:

- `CLEVELANDWATER_USERNAME`
- `CLEVELANDWATER_PASSWORD`
- `ALERT_EMAIL_FROM`
- `ALERT_EMAIL_TO`
- `GMAIL_APP_PASSWORD`

The workflow retains alert history in a GitHub Actions cache, uploads the refreshed HTML report as a private run artifact, and reports a failed portal login or script run as a failed workflow.

Set `WATER_ALERT_REPEAT_EVERY_RUN=true` in a scheduled environment to send another email every time the monitor runs while the current reading remains above an alert threshold. The GitHub workflow enables this repeat-until-normal behavior.

Each successful GitHub Actions run also writes a private online run summary containing the latest and highest daily and hourly readings for every property. The detailed HTML remains available as a private downloadable artifact.

## Files

- `.env` stores the local Cleveland Water username and password.
- `YYYY-MM\*.pdf` folders contain the downloaded bills.
- `.env` and `node_modules` are ignored by Git.
- `.water-usage-alert-state.json` records alerts already delivered and is ignored by Git.
