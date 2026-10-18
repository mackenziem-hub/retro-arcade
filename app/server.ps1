# Retro Arcade local server. Serves the web app, the game library and the saves folder,
# and keeps saves in step with the family store when one is connected.
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
    Config = $cfgPath
    Cloud  = @{ url = "$($cfg.cloud.url)"; key = "$($cfg.cloud.key)" }
    Family = "$($cfg.familyCode)"
    Device = $env:COMPUTERNAME
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
Write-Host "Family saves: $(if ($State.Cloud.url -and $State.Family) { 'connected' } else { 'not connected (set the family code in the arcade)' })"
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
    $SnapshotEvery = 5 * 60 * 1000; $SnapshotSlots = 3

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
    function Under($base, $rel) {
        $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
        $b = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
        if ($full.StartsWith($b, [StringComparison]::OrdinalIgnoreCase)) { $full } else { $null }
    }
    function SafeName($s) { ($s -replace '[^A-Za-z0-9 ._()\-]', '').Trim() }
    function ReadBody() { $ms = New-Object IO.MemoryStream; $req.InputStream.CopyTo($ms); ,$ms.ToArray() }
    function Ms($file) { if (Test-Path $file) { ([DateTimeOffset](Get-Item $file).LastWriteTimeUtc).ToUnixTimeMilliseconds() } else { 0 } }
    # Write to a temp file first so a crash mid-write never corrupts the last good save.
    function WriteAtomic($file, $bytes, $at) {
        New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
        [IO.File]::WriteAllBytes("$file.tmp", $bytes)
        if (Test-Path $file) { Copy-Item $file "$file.bak" -Force }
        Move-Item "$file.tmp" $file -Force
        if ($at) { (Get-Item $file).LastWriteTimeUtc = [DateTimeOffset]::FromUnixTimeMilliseconds($at).UtcDateTime }
    }

    # ---- family store (Supabase) ----
    function CloudReady() { [bool]($S.Cloud.url -and $S.Cloud.key -and $S.Family) }
    function FamilyHash() {
        $h = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($S.Family))
        ([BitConverter]::ToString($h) -replace '-', '').ToLower()
    }
    function Gz($b) { $ms = New-Object IO.MemoryStream; $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionLevel]::Optimal); $gz.Write($b, 0, $b.Length); $gz.Dispose(); ,$ms.ToArray() }
    function Ungz($b) { $in = New-Object IO.MemoryStream(,$b); $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress); $out = New-Object IO.MemoryStream; $gz.CopyTo($out); $gz.Dispose(); ,$out.ToArray() }
    function Iso($ms) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).ToString('o') }
    function FromIso($s) { [DateTimeOffset]::Parse($s, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() }
    function Cloud($path, $method = 'GET', $body = $null, $timeout = 15, $prefer = $null) {
        $h = @{ apikey = $S.Cloud.key; Authorization = "Bearer $($S.Cloud.key)"; 'x-family' = $S.Family }
        if ($prefer) { $h['Prefer'] = $prefer }
        $p = @{ Uri = ($S.Cloud.url.TrimEnd('/') + '/rest/v1/' + $path); Method = $method; Headers = $h; TimeoutSec = $timeout; UseBasicParsing = $true }
        if ($body) { $p['Body'] = [Text.Encoding]::UTF8.GetBytes($body); $p['ContentType'] = 'application/json' }
        Invoke-RestMethod @p
    }
    function CloudUpload($user, $game, $kind, $bytes, $at) {
        $row = @{ family = (FamilyHash); player = $user; game = $game; kind = $kind; data = [Convert]::ToBase64String((Gz $bytes)); size = $bytes.Length; device = $S.Device; updated_at = (Iso $at) }
        Cloud 'arcade_saves?on_conflict=family,player,game,kind' 'POST' (ConvertTo-Json $row -Compress) 60 'resolution=merge-duplicates' | Out-Null
    }
    function CloudNewer($user, $game, $kind, $localAt) {
        $q = "arcade_saves?player=eq.$([Uri]::EscapeDataString($user))&game=eq.$([Uri]::EscapeDataString($game))&kind=eq.$kind"
        $meta = @(Cloud "$q&select=updated_at" 'GET' $null 8)
        if (-not $meta.Count -or (FromIso $meta[0].updated_at) -le ($localAt + 1000)) { return $null }
        $row = @(Cloud "$q&select=data,updated_at" 'GET' $null 60)[0]
        @{ bytes = (Ungz ([Convert]::FromBase64String($row.data))); at = (FromIso $row.updated_at) }
    }
    function Dirty() { $m = "$($S.Users).meta"; if (Test-Path $m) { Get-Content $m -Raw | ConvertFrom-Json } else { [pscustomobject]@{ at = 0; dirty = $false } } }
    function SetDirty($at, $dirty) { ConvertTo-Json @{ at = $at; dirty = $dirty } -Compress | Set-Content "$($S.Users).meta" -Encoding ASCII }

    try {
        $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
        $res.AddHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        $res.AddHeader('Cross-Origin-Resource-Policy', 'same-origin')
        $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
        $q = $req.QueryString

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

        if ($path -eq '/api/library') {
            $res.AddHeader('Cache-Control', 'no-store')
            $list = @(GetLibrary | ForEach-Object { $g = $_; $o = [ordered]@{}; foreach ($k in $g.Keys) { if ($k -ne 'path') { $o[$k] = $g[$k] } }; $o })
            SendJson @{ games = $list; biosPsx = (Test-Path (Join-Path $S.Bios 'scph5501.bin')) }
        }
        elseif ($path -eq '/api/launch' -and $req.HttpMethod -eq 'POST') {
            $user = SafeName $q['user']; $g = GetLibrary | Where-Object { $_.id -eq $q['game'] } | Select-Object -First 1
            if (-not $g -or -not $g.native) { Send 404 $null; return }
            $n = $native[$g.system]; $exe = [IO.Path]::GetFullPath((Join-Path $Emu $n.exe))
            if (-not (Test-Path $exe)) { SendJson @{ ok = $false; error = "Emulator missing: $($n.exe)" }; return }
            if ($g.system -eq 'ps2') {
                $ini = Join-Path (Split-Path $exe) 'inis\PCSX2.ini'
                if (Test-Path $ini) {
                    $txt = [IO.File]::ReadAllText($ini) -creplace '(?m)^Bios = .*$', ('Bios = ' + $S.Bios)
                    [IO.File]::WriteAllText($ini, $txt)
                }
            }
            Start-Process $exe -ArgumentList ($n.args -f $g.path) -WorkingDirectory (Split-Path $exe)
            if ($user) {
                $dir = Join-Path $S.Saves $user; New-Item -ItemType Directory -Force $dir | Out-Null
                [IO.File]::WriteAllText((Join-Path $dir "$($g.id).native"), (Get-Date -Format o))
            }
            SendJson @{ ok = $true }
        }
        elseif ($path -eq '/api/users') {
            $res.AddHeader('Cache-Control', 'no-store')
            if ($req.HttpMethod -eq 'POST') {
                $body = [Text.Encoding]::UTF8.GetString((ReadBody))
                $null = $body | ConvertFrom-Json
                [IO.File]::WriteAllText($S.Users, $body, [Text.Encoding]::UTF8)
                $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); SetDirty $at $true
                if (CloudReady) { try { Cloud 'arcade_profiles?on_conflict=family' 'POST' (ConvertTo-Json @{ family = (FamilyHash); data = ($body | ConvertFrom-Json); updated_at = (Iso $at) } -Depth 5 -Compress) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $at $false } catch { Write-Host "profiles push failed: $($_.Exception.Message)" } }
                SendJson @{ ok = $true }
            } else {
                if (CloudReady) {
                    try {
                        $m = Dirty
                        $row = @(Cloud 'arcade_profiles?select=data,updated_at' 'GET' $null 8)
                        if ($row.Count -and (FromIso $row[0].updated_at) -gt ([long]$m.at + 1000)) {
                            [IO.File]::WriteAllText($S.Users, (ConvertTo-Json $row[0].data -Depth 5 -Compress), [Text.Encoding]::UTF8); SetDirty (FromIso $row[0].updated_at) $false
                        } elseif ($m.dirty -and (Test-Path $S.Users)) {
                            Cloud 'arcade_profiles?on_conflict=family' 'POST' (ConvertTo-Json @{ family = (FamilyHash); data = (Get-Content $S.Users -Raw | ConvertFrom-Json); updated_at = (Iso $m.at) } -Depth 5 -Compress) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $m.at $false
                        }
                    } catch { Write-Host "profiles sync failed: $($_.Exception.Message)" }
                }
                if (Test-Path $S.Users) { Send 200 ([IO.File]::ReadAllBytes($S.Users)) 'application/json' } else { SendJson @() }
            }
        }
        elseif ($path -eq '/api/save') {
            # kind: sram (in-game save), state (snapshot). Local first, family store second.
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $game = SafeName $q['game']; $kind = $q['kind']
            if (-not $user -or -not $game -or @('sram', 'state') -notcontains $kind) { Send 400 $null; return }
            $file = Join-Path (Join-Path $S.Saves $user) "$game.$kind"
            if ($req.HttpMethod -eq 'POST') {
                $data = ReadBody
                if ($data.Length -gt 0) {
                    $at = if ($q['at']) { [long]$q['at'] } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
                    if ($kind -eq 'state' -and (Test-Path $file)) {
                        # Rollback snapshots: keep an older copy every few minutes (h1 newest .. h3 oldest).
                        $h1 = "$file.h1"
                        if (-not (Test-Path $h1) -or ((Ms $file) - (Ms $h1)) -ge $SnapshotEvery) {
                            for ($i = $SnapshotSlots - 1; $i -ge 1; $i--) { if (Test-Path "$file.h$i") { Move-Item "$file.h$i" "$file.h$($i + 1)" -Force } }
                            Copy-Item $file $h1 -Force
                        }
                    }
                    WriteAtomic $file $data $at
                }
                SendJson @{ ok = $true; bytes = $data.Length }
                try { $res.Close() } catch {}
                if ($data.Length -gt 0 -and (CloudReady)) { try { CloudUpload $user $game $kind $data $at } catch { Write-Host "upload failed ($game $kind): $($_.Exception.Message)" } }
            } else {
                $fromCloud = $false
                if (CloudReady) {
                    try { $n = CloudNewer $user $game $kind (Ms $file); if ($n) { WriteAtomic $file $n.bytes $n.at; $fromCloud = $true } }
                    catch { Write-Host "cloud check failed ($game $kind): $($_.Exception.Message)" }
                }
                if (Test-Path $file) {
                    $res.AddHeader('X-Saved-At', (Ms $file)); if ($fromCloud) { $res.AddHeader('X-From-Cloud', '1') }
                    SendFile $file
                } else { Send 404 $null }
            }
        }
        elseif ($path -eq '/api/history') {
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $game = SafeName $q['game']
            $file = Join-Path (Join-Path $S.Saves $user) "$game.state"
            if ($q['id']) {
                $id = $q['id']
                if ($id -match '^local:(h[1-3])$') {
                    $f = "$file.$($Matches[1])"
                    if (Test-Path $f) { $res.AddHeader('X-Saved-At', (Ms $f)); SendFile $f } else { Send 404 $null }
                } elseif ($id -match '^cloud:(\d+)$' -and (CloudReady)) {
                    $row = @(Cloud "arcade_save_history?select=data,updated_at&id=eq.$($Matches[1])" 'GET' $null 60)[0]
                    $bytes = Ungz ([Convert]::FromBase64String($row.data))
                    $res.AddHeader('X-Saved-At', (FromIso $row.updated_at)); Send 200 $bytes 'application/octet-stream'
                } else { Send 404 $null }
                return
            }
            $list = @()
            for ($i = 1; $i -le $SnapshotSlots; $i++) { $f = "$file.h$i"; if (Test-Path $f) { $list += @{ id = "local:h$i"; label = 'On this computer'; at = (Ms $f) } } }
            if (CloudReady) {
                try {
                    Cloud "arcade_save_history?select=id,updated_at,device&player=eq.$([Uri]::EscapeDataString($user))&game=eq.$([Uri]::EscapeDataString($game))&kind=eq.state&order=updated_at.desc" 'GET' $null 8 |
                        ForEach-Object { $list += @{ id = "cloud:$($_.id)"; label = 'Family store' + $(if ($_.device) { " ($($_.device))" }); at = (FromIso $_.updated_at) } }
                } catch {}
            }
            SendJson @{ history = @($list | Sort-Object { $_.at } -Descending) }
        }
        elseif ($path -eq '/api/recent') {
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $dir = Join-Path $S.Saves $user
            $out = @{}
            if ($user -and (Test-Path $dir)) {
                Get-ChildItem $dir -File | Where-Object { $_.Extension -in '.sram', '.state', '.native' } |
                    ForEach-Object { $k = $_.BaseName; $t = (Ms $_.FullName); if (-not $out[$k] -or $out[$k] -lt $t) { $out[$k] = $t } }
            }
            if ($user -and (CloudReady)) {
                try { Cloud "arcade_recent?select=game,updated_at&player=eq.$([Uri]::EscapeDataString($user))" 'GET' $null 8 |
                        ForEach-Object { $t = (FromIso $_.updated_at); if (-not $out[$_.game] -or $out[$_.game] -lt $t) { $out[$_.game] = $t } } } catch {}
            }
            SendJson @{ recent = @($out.Keys | ForEach-Object { @{ id = $_; at = $out[$_] } } | Sort-Object { $_.at } -Descending) }
        }
        elseif ($path -eq '/api/sync') {
            $res.AddHeader('Cache-Control', 'no-store')
            if ($req.HttpMethod -eq 'POST') {
                $body = [Text.Encoding]::UTF8.GetString((ReadBody)) | ConvertFrom-Json
                $code = "$($body.code)".Trim()
                if (-not $S.Cloud.url) { SendJson @{ ok = $false; error = 'This arcade has no family store set up.' }; return }
                if ($code -and $code.Length -lt 8) { SendJson @{ ok = $false; error = 'The family code needs at least 8 characters.' }; return }
                $S.Family = $code
                if ($code) {
                    try { Cloud 'arcade_recent?select=game&limit=1' 'GET' $null 10 | Out-Null } catch { $S.Family = ''; SendJson @{ ok = $false; error = 'Could not reach the family store. Check the internet connection and the code.' }; return }
                    # First connection: take the family's player list if there is one, otherwise share ours.
                    try {
                        $row = @(Cloud 'arcade_profiles?select=data,updated_at' 'GET' $null 8)
                        if ($row.Count) { [IO.File]::WriteAllText($S.Users, (ConvertTo-Json $row[0].data -Depth 5 -Compress), [Text.Encoding]::UTF8); SetDirty (FromIso $row[0].updated_at) $false }
                        elseif (Test-Path $S.Users) { $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Cloud 'arcade_profiles?on_conflict=family' 'POST' (ConvertTo-Json @{ family = (FamilyHash); data = (Get-Content $S.Users -Raw | ConvertFrom-Json); updated_at = (Iso $at) } -Depth 5 -Compress) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $at $false }
                    } catch { Write-Host "profile reconcile failed: $($_.Exception.Message)" }
                }
                $c = Get-Content $S.Config -Raw | ConvertFrom-Json
                $c | Add-Member -NotePropertyName familyCode -NotePropertyValue $code -Force
                ConvertTo-Json $c -Depth 4 | Set-Content $S.Config -Encoding ASCII
                SendJson @{ ok = $true; connected = [bool]$code }
            } else {
                SendJson @{ available = [bool]$S.Cloud.url; connected = (CloudReady); device = $S.Device }
            }
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
