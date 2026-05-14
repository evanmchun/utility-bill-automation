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
