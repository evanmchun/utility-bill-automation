param(
    [string]$Month = "",
    [switch]$All,
    [switch]$Visible
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jobs = @(
    @{
        Name = "Water"
        Dir = Join-Path $root "Water Bill"
        Script = "download-water-bills.mjs"
    },
    @{
        Name = "Sewer"
        Dir = Join-Path $root "Sewer Bill"
        Script = "download-sewer-bills.mjs"
    }
)

foreach ($job in $jobs) {
    Write-Host ""
    Write-Host "=== Downloading $($job.Name) bills ==="

    Push-Location $job.Dir
    try {
        $argsList = @(".\$($job.Script)")

        if ($All) {
            $argsList += "--all"
        } elseif ($Month) {
            $argsList += @("--month", $Month)
        }

        if ($Visible) {
            $argsList += "--visible"
        }

        & node @argsList
        if ($LASTEXITCODE -ne 0) {
            throw "$($job.Name) downloader failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Done."
