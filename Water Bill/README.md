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

## Files

- `.env` stores the local Cleveland Water username and password.
- `YYYY-MM\*.pdf` folders contain the downloaded bills.
- `.env` and `node_modules` are ignored by Git.
