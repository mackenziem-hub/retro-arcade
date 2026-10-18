# Downloads box art for every game in the library (needs internet once; covers are kept for offline use).
# Run with the arcade open:  powershell -ExecutionPolicy Bypass -File app\fetch-covers.ps1
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$covers = Join-Path $Root 'covers'
$cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$port = if ($cfg.port) { $cfg.port } else { 8642 }
$sets = @{ gb = 'Nintendo - Game Boy'; gba = 'Nintendo - Game Boy Advance'; nds = 'Nintendo - Nintendo DS'; nes = 'Nintendo - Nintendo Entertainment System';
           snes = 'Nintendo - Super Nintendo Entertainment System'; n64 = 'Nintendo - Nintendo 64'; psx = 'Sony - PlayStation';
           psp = 'Sony - PlayStation Portable'; segaMD = 'Sega - Mega Drive - Genesis'; gc = 'Nintendo - GameCube';
           ps2 = 'Sony - PlayStation 2'; '3ds' = 'Nintendo - Nintendo 3DS' }
$games = (Invoke-RestMethod "http://localhost:$port/api/library").games
foreach ($g in $games) {
    $out = Join-Path $covers ($g.id + '.png')
    if (Test-Path $out) { continue }
    $set = $sets[$g.system]
    if ($g.folder -eq 'Game Boy Color') { $set = 'Nintendo - Game Boy Color' }
    # Try the exact name, then the name trimmed down to its first region tag, then the bare title.
    $names = @($g.title, ($g.title -replace '^(.*?\([^)]*\)).*$', '$1'), ($g.title -replace '\s*\(.*$', '') + ' (USA)') | Select-Object -Unique
    $got = $false
    foreach ($n in $names) {
        $file = ($n -replace '[&*/:`<>?\\|"]', '_') + '.png'
        $url = "https://thumbnails.libretro.com/$([Uri]::EscapeDataString($set))/Named_Boxarts/$([Uri]::EscapeDataString($file))"
        try { Invoke-WebRequest $url -OutFile $out -UseBasicParsing -ErrorAction Stop; $got = $true; break } catch {}
    }
    "{0,-4} {1}  {2}" -f $(if ($got) { 'ok' } else { 'none' }), $g.system, $g.title
}
