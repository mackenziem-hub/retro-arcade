# Publishes the arcade's code from C:\Users\Owner\RetroArcade to the update channel (this repo).
# Every arcade copy picks the new version up the next time it starts.
# Usage: powershell -ExecutionPolicy Bypass -File publish.ps1 "what changed"
param([string]$Message = 'Arcade update')
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = 'C:\Users\Owner\RetroArcade'

# Same list the updater accepts. Games, saves, covers and emulators are never published.
$files = @(Get-ChildItem "$Src\app\web" -File | Where-Object Extension -ne '.old' | ForEach-Object { "app/web/$($_.Name)" }) +
         'app/server.ps1', 'app/updater.ps1', 'app/fetch-covers.ps1', 'READ ME FIRST.txt', 'PHONE SETUP (Android).txt', 'Copy to Drive.ps1'

$sha = [Security.Cryptography.SHA256]::Create()
$list = foreach ($f in $files) {
    $from = Join-Path $Src ($f -replace '/', '\')
    $to = Join-Path $Repo ($f -replace '/', '\')
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item $from $to -Force
    [ordered]@{ path = $f; sha256 = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($to))) -replace '-', '') }
}
# The phone web app (docs/, served by GitHub Pages) shares the computer arcade's look.
Copy-Item "$Src\app\web\style.css" (Join-Path $Repo 'docs\style.css') -Force
foreach ($shared in 'player.js', 'nav.js', 'menu.js') { Copy-Item "$Src\app\web\$shared" (Join-Path $Repo "docs\$shared") -Force }
$version = Get-Date -Format 'yyyy.MM.dd.HHmm'
[IO.File]::WriteAllText((Join-Path $Repo 'manifest.json'), (ConvertTo-Json ([ordered]@{ version = $version; files = @($list) }) -Depth 4))
# The publishing machine is already current.
Set-Content "$Src\app\version.txt" $version -Encoding ASCII

git -C $Repo add -A
git -C $Repo commit -m "$Message ($version)"
git -C $Repo push
Write-Host "Published $version"
