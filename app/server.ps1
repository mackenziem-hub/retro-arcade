# Retro Arcade local server. Serves the web app, the game library and the saves folder.
# Runs on http://localhost only. No admin rights needed.
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root    = Split-Path -Parent $AppDir
$cfgPath = Join-Path $Root 'config.json'
$cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$port = if ($cfg.port) { [int]$cfg.port } else { 8642 }
$gamesDir = if ($cfg.gamesDir) { $cfg.gamesDir } else { 'games' }
if (-not [IO.Path]::IsPathRooted($gamesDir)) { $gamesDir = Join-Path $Root $gamesDir }

$State = [hashtable]::Synchronized(@{
    Web    = Join-Path $AppDir 'web'
    Games  = [IO.Path]::GetFullPath($gamesDir)
    Saves  = Join-Path $Root 'saves'
    Covers = Join-Path $Root 'covers'
    Users  = Join-Path $Root 'users.json'
})
# BIOS files live with the games (games\BIOS) so they move together.
$State.Bios = Join-Path $State.Games 'BIOS'
foreach ($d in $State.Saves, $State.Covers, $State.Bios) { New-Item -ItemType Directory -Force $d | Out-Null }

# Open the arcade in its own app-style window (no tabs or address bar) when Chrome or Edge is present.
function Open-Arcade {
    $url = "http://localhost:$port/"
    $browsers = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    $b = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($b) { Start-Process $b -ArgumentList "--app=$url", '--start-maximized' } else { Start-Process $url }
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch {
    # Already running (second double-click): just open the browser.
    if (-not $NoBrowser) { Open-Arcade }
    exit
}
Write-Host "Retro Arcade is running at http://localhost:$port/"
Write-Host "Games folder: $($State.Games)"
Write-Host "Keep this window open while you play. Close it to stop the arcade."
if (-not $NoBrowser) { Open-Arcade }

$handler = {
    param($ctx, $S)
    $req = $ctx.Request; $res = $ctx.Response
    $mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.css'='text/css'; '.json'='application/json';
               '.wasm'='application/wasm'; '.png'='image/png'; '.jpg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon';
               '.webmanifest'='application/manifest+json' }
    # Folder name in the library -> EmulatorJS system id
    $systems = [ordered]@{
        'Game Boy'='gb'; 'Game Boy Color'='gb'; 'Game Boy Advance'='gba'; 'Nintendo DS'='nds'; 'NES'='nes';
        'SNES'='snes'; 'Nintendo 64'='n64'; 'PlayStation'='psx'; 'PSP'='psp'; 'Sega Genesis'='segaMD';
        'GameCube & Wii'='gc'; 'PlayStation 2'='ps2'; 'Nintendo 3DS'='3ds'
    }
    $exts = @{ gb='.gb .gbc'; gba='.gba'; nds='.nds'; nes='.nes'; snes='.sfc .smc'; n64='.z64 .n64 .v64';
               psx='.bin .chd .pbp .iso'; psp='.iso .cso'; segaMD='.md .gen .bin';
               gc='.iso .rvz .gcm .gcz .wbfs .ciso .wia'; ps2='.iso .chd .cso .bin'; '3ds'='.3ds .cci .cxi .3dsx' }
    # Systems too heavy for the browser open in a bundled desktop emulator instead.
    $Emu = Join-Path (Split-Path -Parent $S.Web) '..\emulators'
    $native = @{ gc = @{ exe = 'Dolphin\Dolphin.exe'; args = '-b -e "{0}"' }
                 ps2 = @{ exe = 'PCSX2\pcsx2-qt.exe'; args = '-batch "{0}"' }
                 '3ds' = @{ exe = 'Azahar\azahar.exe'; args = '"{0}"' } }
    # 3DS games installed from .cia files live inside Azahar; known titles get a friendly name.
    $ctrTitles = @{ '0011c400' = 'Pokemon Omega Ruby (USA)'; '0011c500' = 'Pokemon Alpha Sapphire (USA)';
                    '00055d00' = 'Pokemon X (USA)'; '00055e00' = 'Pokemon Y (USA)';
                    '00164800' = 'Pokemon Sun (USA)'; '00175e00' = 'Pokemon Moon (USA)' }

    function GetLibrary() {
        $list = @()
        foreach ($folder in $systems.Keys) {
            $dir = Join-Path $S.Games $folder
            if (-not (Test-Path $dir)) { continue }
            $sys = $systems[$folder]; $ok = $exts[$sys] -split ' '
            Get-ChildItem $dir -Recurse -File | Where-Object { $ok -contains $_.Extension.ToLower() } | ForEach-Object {
                $rel = $_.FullName.Substring($S.Games.Length).TrimStart('\') -replace '\\', '/'
                $list += (Entry ([IO.Path]::GetFileNameWithoutExtension($_.Name) -replace '\.nkit$', '') $sys $folder $_.FullName $rel $_.Length)
            }
        }
        $titles = Join-Path $Emu 'Azahar\user\sdmc\Nintendo 3DS\00000000000000000000000000000000\00000000000000000000000000000000\title\00040000'
        if (Test-Path $titles) {
            Get-ChildItem $titles -Directory | ForEach-Object {
                $boot = Get-ChildItem (Join-Path $_.FullName 'content') -Filter *.app -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
                if (-not $boot) { return }
                $name = if ($ctrTitles[$_.Name]) { $ctrTitles[$_.Name] } else { "3DS game $($_.Name)" }
                if ($list | Where-Object { $_.id -eq (SafeName $name) }) { return }
                $list += (Entry $name '3ds' 'Nintendo 3DS' $boot.FullName $null $boot.Length)
            }
        }
        $list
    }
    function Entry($title, $sys, $folder, $full, $rel, $len) {
        $cover = Join-Path $S.Covers ((SafeName $title) + '.png')
        [ordered]@{
            id = SafeName $title; title = $title; system = $sys; folder = $folder; native = [bool]$native[$sys]; path = $full
            url = if ($rel) { '/games/' + (($rel -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/') } else { $null }
            cover = if (Test-Path $cover) { '/covers/' + [Uri]::EscapeDataString((SafeName $title) + '.png') } else { $null }
            mb = [math]::Round($len / 1MB)
        }
    }

    function Send($code, $bytes, $type) {
        $res.StatusCode = $code
        if ($type) { $res.ContentType = $type }
        if ($bytes) { $res.ContentLength64 = $bytes.Length; $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    }
    function SendJson($obj) { Send 200 ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $obj -Depth 6 -Compress))) 'application/json' }
    function SendFile($path) {
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
        $fs = [IO.File]::OpenRead($path)
        try { $res.ContentLength64 = $fs.Length; $fs.CopyTo($res.OutputStream, 1MB) } finally { $fs.Dispose() }
    }
    # Resolve a relative path under a base folder, refusing anything that escapes it.
    function Under($base, $rel) {
        $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
        $b = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
        if ($full.StartsWith($b, [StringComparison]::OrdinalIgnoreCase)) { $full } else { $null }
    }
    function SafeName($s) { ($s -replace '[^A-Za-z0-9 ._()\-]', '').Trim() }
    function ReadBody() { $ms = New-Object IO.MemoryStream; $req.InputStream.CopyTo($ms); ,$ms.ToArray() }

    try {
        $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
        $res.AddHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        $res.AddHeader('Cross-Origin-Resource-Policy', 'same-origin')
        $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
        $q = $req.QueryString

        if ($path -eq '/api/library') {
            $res.AddHeader('Cache-Control', 'no-store')
            # Same list minus the on-disk path, which the browser does not need.
            $list = @(GetLibrary | ForEach-Object { $g = $_; $o = [ordered]@{}; foreach ($k in $g.Keys) { if ($k -ne 'path') { $o[$k] = $g[$k] } }; $o })
            SendJson @{ games = $list; biosPsx = (Test-Path (Join-Path $S.Bios 'scph5501.bin')) }
        }
        elseif ($path -eq '/api/launch' -and $req.HttpMethod -eq 'POST') {
            $user = SafeName $q['user']; $g = GetLibrary | Where-Object { $_.id -eq $q['game'] } | Select-Object -First 1
            if (-not $g -or -not $g.native) { Send 404 $null; return }
            $n = $native[$g.system]; $exe = [IO.Path]::GetFullPath((Join-Path $Emu $n.exe))
            if (-not (Test-Path $exe)) { SendJson @{ ok = $false; error = "Emulator missing: $($n.exe)" }; return }
            if ($g.system -eq 'ps2') {
                # Point PCSX2 at the arcade's bios folder wherever the arcade lives (drive letters change).
                $ini = Join-Path (Split-Path $exe) 'inis\PCSX2.ini'
                if (Test-Path $ini) {
                    $txt = [IO.File]::ReadAllText($ini) -creplace '(?m)^Bios = .*$', ('Bios = ' + $S.Bios)
                    [IO.File]::WriteAllText($ini, $txt)
                }
            }
            Start-Process $exe -ArgumentList ($n.args -f $g.path) -WorkingDirectory (Split-Path $exe)
            if ($user) {
                # Marker so the game shows under "Continue playing" (the emulator keeps its own saves).
                $dir = Join-Path $S.Saves $user; New-Item -ItemType Directory -Force $dir | Out-Null
                [IO.File]::WriteAllText((Join-Path $dir "$($g.id).native"), (Get-Date -Format o))
            }
            SendJson @{ ok = $true }
        }
        elseif ($path -eq '/api/users') {
            $res.AddHeader('Cache-Control', 'no-store')
            if ($req.HttpMethod -eq 'POST') {
                $body = [Text.Encoding]::UTF8.GetString((ReadBody))
                $null = $body | ConvertFrom-Json   # reject anything that is not JSON
                [IO.File]::WriteAllText($S.Users, $body, [Text.Encoding]::UTF8)
                SendJson @{ ok = $true }
            } elseif (Test-Path $S.Users) {
                Send 200 ([IO.File]::ReadAllBytes($S.Users)) 'application/json'
            } else { SendJson @() }
        }
        elseif ($path -eq '/api/save') {
            # kind: sram (in-game save), state (auto-save snapshot)
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $game = SafeName $q['game']; $kind = $q['kind']
            if (-not $user -or -not $game -or @('sram', 'state') -notcontains $kind) { Send 400 $null; return }
            $dir = Join-Path $S.Saves $user
            $file = Join-Path $dir "$game.$kind"
            if ($req.HttpMethod -eq 'POST') {
                New-Item -ItemType Directory -Force $dir | Out-Null
                $data = ReadBody
                if ($data.Length -gt 0) {
                    # Write to a temp file first so a crash mid-write never corrupts the last good save.
                    [IO.File]::WriteAllBytes("$file.tmp", $data)
                    if (Test-Path $file) { Copy-Item $file "$file.bak" -Force }
                    Move-Item "$file.tmp" $file -Force
                }
                SendJson @{ ok = $true; bytes = $data.Length }
            } elseif (Test-Path $file) {
                $res.AddHeader('X-Saved-At', ([DateTimeOffset](Get-Item $file).LastWriteTimeUtc).ToUnixTimeMilliseconds())
                SendFile $file
            } else { Send 404 $null }
        }
        elseif ($path -eq '/api/recent') {
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $dir = Join-Path $S.Saves $user
            $out = @()
            if ($user -and (Test-Path $dir)) {
                Get-ChildItem $dir -File | Where-Object { $_.Extension -in '.sram', '.state', '.native' } |
                    Group-Object { $_.BaseName } | ForEach-Object {
                        $out += @{ id = $_.Name; at = ([DateTimeOffset]($_.Group | Sort-Object LastWriteTimeUtc | Select-Object -Last 1).LastWriteTimeUtc).ToUnixTimeMilliseconds() }
                    }
            }
            SendJson @{ recent = @($out | Sort-Object { $_.at } -Descending) }
        }
        elseif ($path.StartsWith('/games/')) {
            $f = Under $S.Games $path.Substring(7)
            if ($f -and (Test-Path $f -PathType Leaf)) { SendFile $f } else { Send 404 $null }
        }
        elseif ($path.StartsWith('/covers/')) {
            $f = Under $S.Covers $path.Substring(8)
            if ($f -and (Test-Path $f -PathType Leaf)) { $res.AddHeader('Cache-Control', 'max-age=86400'); SendFile $f } else { Send 404 $null }
        }
        elseif ($path.StartsWith('/bios/')) {
            $f = Under $S.Bios $path.Substring(6)
            if ($f -and (Test-Path $f -PathType Leaf)) { SendFile $f } else { Send 404 $null }
        }
        else {
            if ($path -eq '/') { $path = '/index.html' }
            if (-not $path.StartsWith('/emulatorjs/')) { $res.AddHeader('Cache-Control', 'no-cache') }
            $f = Under $S.Web $path.TrimStart('/')
            if ($f -and (Test-Path $f -PathType Leaf)) { SendFile $f } else { Send 404 $null }
        }
    } catch {
        try { Send 500 ([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)) 'text/plain' } catch {}
    } finally {
        try { $res.Close() } catch {}
    }
}

# A small pool so a big game download does not block saves or the menu.
$pool = [RunspaceFactory]::CreateRunspacePool(1, 6); $pool.Open()
$jobs = New-Object Collections.ArrayList
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($State)
    [void]$jobs.Add(@{ ps = $ps; h = $ps.BeginInvoke() })
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
        if ($jobs[$i].h.IsCompleted) { $jobs[$i].ps.EndInvoke($jobs[$i].h); $jobs[$i].ps.Dispose(); $jobs.RemoveAt($i) }
    }
}
