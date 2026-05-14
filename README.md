# Utility bill automation

Runs the water and sewer bill downloaders together.

## Run both for the current month

Double-click:

```text
Download All Utility Bills.bat
```

Or run from PowerShell:

```powershell
cd "C:\Users\Jay Chun\Documents\MEL Heritage Properties\Real Estate\Automation"
.\download-all-utility-bills.ps1
```

## Run both for a specific month

```powershell
.\download-all-utility-bills.ps1 -Month 2026-05
```

## Download all bills currently visible in both portals

```powershell
.\download-all-utility-bills.ps1 -All
```

## Show browsers while running

```powershell
.\download-all-utility-bills.ps1 -Month 2026-05 -Visible
```

## Create Gmail Drafts

Create one Gmail draft with water PDFs and one Gmail draft with sewer PDFs.

First create `.env` from `.env.example`, then add your Gmail app password.

Install the root email dependencies once:

```powershell
npm install
```

Then run:

```powershell
npm run drafts -- --month 2026-05
```

Or double-click:

```text
Create Gmail Drafts for Utility Bills.bat
```
