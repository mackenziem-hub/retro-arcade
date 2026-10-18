# Checks the arcade's update channel and installs newer menu/app files before the arcade starts.
# Only the arcade's own code is updated this way; games, saves and emulators never come over the internet.
# No internet, or anything unexpected: the arcade just starts as it is.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $AppDir
try {
    $cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
    if (-not $cfg.updateUrl) { return }
    $base = $cfg.updateUrl.TrimEnd('/') + '/'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    $wc.Headers['Cache-Control'] = 'no-cache'
    $manifest = $wc.DownloadString($base + 'manifest.json?t=' + [DateTime]::UtcNow.Ticks) | ConvertFrom-Json

    $verFile = Join-Path $AppDir 'version.txt'
    $local = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '' }
    if ($manifest.version -eq $local) { return }

    # Only these files may ever be replaced by an update.
    $allowed = '^(app/(web/[A-Za-z0-9._-]+|server\.ps1|updater\.ps1|fetch-covers\.ps1)|READ ME FIRST\.txt|Copy to Drive\.ps1)$'
    $sha = [Security.Cryptography.SHA256]::Create()
    $staged = @()
    foreach ($f in $manifest.files) {
        if ($f.path -notmatch $allowed -or $f.path -match '\.\.') { throw "Update lists a file it may not change: $($f.path)" }
        $dest = Join-Path $Root ($f.path -replace '/', '\')
        if ((Test-Path $dest) -and ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($dest))) -replace '-', '') -eq $f.sha256) { continue }
        $bytes = $wc.DownloadData($base + ([Uri]::EscapeUriString($f.path)))
        if (([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '') -ne $f.sha256) { throw "Download did not match for $($f.path)" }
        $staged += @{ dest = $dest; bytes = $bytes }
    }
    # Everything downloaded and checked; now swap the files in.
    foreach ($s in $staged) {
        New-Item -ItemType Directory -Force (Split-Path $s.dest) | Out-Null
        if (Test-Path $s.dest) { Copy-Item $s.dest "$($s.dest).old" -Force }
        [IO.File]::WriteAllBytes($s.dest, $s.bytes)
    }
    Set-Content $verFile $manifest.version -Encoding ASCII
    Write-Host "Retro Arcade updated to $($manifest.version) ($($staged.Count) files)."
} catch {
    Write-Host "Update check skipped: $($_.Exception.Message)"
}
