# Retro Arcade local server. Serves the web app, the game library and the saves folder,
# and keeps saves in step with the family store when one is connected.
# Runs on http://localhost only. No admin rights needed.
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
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
    Root   = $Root
    Saves  = Join-Path $Root 'saves'
    Covers = Join-Path $Root 'covers'
    Users  = Join-Path $Root 'users.json'
    Config = $cfgPath
    Cloud  = @{ url = "$($cfg.cloud.url)"; key = "$($cfg.cloud.key)" }
    Family = "$($cfg.familyCode)"
    Device = $env:COMPUTERNAME
    Log    = Join-Path $Root 'arcade.log'
    Conflicts = [hashtable]::Synchronized(@{})   # "user|game|kind" -> device whose newer save was not overwritten
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
    # Built-in web games (title, link, cover served from app\web, date added for the NEW badge).
    $webGames = @(
        @{ title = 'Aetheria'; link = 'https://pwa-six-iota.vercel.app'; cover = '/cover-aetheria.png'; added = 1792425600000 }
        @{ title = 'Aetheria Starfall'; link = 'https://aetheria-starfall.vercel.app'; cover = '/cover-starfall.png'; added = 1792425600000 }
    )
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
    # Invoke-RestMethod turns ISO timestamps into DateTime objects on its own; handle both.
    function FromIso($s) {
        if ($s -is [DateTime]) { $d = $s; if ($d.Kind -eq 'Unspecified') { $d = [DateTime]::SpecifyKind($d, 'Utc') }; return ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }
        [DateTimeOffset]::Parse([string]$s, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds()
    }
    function Cloud($path, $method = 'GET', $body = $null, $timeout = 15, $prefer = $null) {
        $h = @{ apikey = $S.Cloud.key; Authorization = "Bearer $($S.Cloud.key)"; 'x-family' = $S.Family }
        if ($prefer) { $h['Prefer'] = $prefer }
        $p = @{ Uri = ($S.Cloud.url.TrimEnd('/') + '/rest/v1/' + $path); Method = $method; Headers = $h; TimeoutSec = $timeout; UseBasicParsing = $true }
        if ($body) { $p['Body'] = [Text.Encoding]::UTF8.GetBytes($body); $p['ContentType'] = 'application/json' }
        # Windows PowerShell hands a JSON array back as ONE object; emit the rows one by one so pipelines and @() behave.
        $r = Invoke-RestMethod @p
        if ($r -is [array]) { foreach ($x in $r) { $x } } else { $r }
    }
    function CloudUpload($user, $game, $kind, $bytes, $at) {
        $row = @{ family = (FamilyHash); player = $user; game = $game; kind = $kind; data = [Convert]::ToBase64String((Gz $bytes)); size = $bytes.Length; device = $S.Device; updated_at = (Iso $at) }
        Cloud 'arcade_saves?on_conflict=family,player,game,kind' 'POST' (ConvertTo-Json $row -Compress) 60 'resolution=merge-duplicates' | Out-Null
    }
    function CloudNewer($user, $game, $kind, $localAt) {
        $q = "arcade_saves?player=eq.$([Uri]::EscapeDataString($user))&game=eq.$([Uri]::EscapeDataString($game))&kind=eq.$kind"
        $meta = @(Cloud "$q&select=updated_at" 'GET' $null 8 | Where-Object { $null -ne $_ })
        if (-not $meta.Count -or (FromIso $meta[0].updated_at) -le ($localAt + 1000)) { return $null }
        $row = @(Cloud "$q&select=data,updated_at" 'GET' $null 60)[0]
        @{ bytes = (Ungz ([Convert]::FromBase64String($row.data))); at = (FromIso $row.updated_at) }
    }
    # ---- conflict guard ----
    # Beside each save, "<save>.base" holds the family store time this device last synced that save (downloaded or uploaded).
    # An upload only goes ahead when the store still holds that version (or one this computer wrote). Otherwise another
    # device saved newer progress in the meantime, so the local copy is kept and the store is left alone.
    function GetBase($file) { $b = "$file.base"; if (Test-Path -LiteralPath $b) { try { return [long]([IO.File]::ReadAllText($b).Trim()) } catch {} }; $null }
    function SetBase($file, $at) { try { [IO.File]::WriteAllText("$file.base", [string][long]$at) } catch {} }
    function CloudMeta($user, $game, $kind) {
        $q = "arcade_saves?player=eq.$([Uri]::EscapeDataString($user))&game=eq.$([Uri]::EscapeDataString($game))&kind=eq.$kind&select=updated_at,device"
        @(Cloud $q 'GET' $null 8 | Where-Object { $null -ne $_ })[0]
    }
    # Returns 'ok' or 'conflict'. $prevAt (time of the local copy before this write) stands in for a missing .base file once.
    function GuardedUpload($user, $game, $kind, $bytes, $at, $file, $prevAt) {
        $key = "$user|$game|$kind"
        $m = CloudMeta $user $game $kind
        if ($m) {
            $cAt = FromIso $m.updated_at; $base = GetBase $file; if ($null -eq $base) { $base = [long]$prevAt }
            if ($cAt -gt ($base + 1000) -and "$($m.device)" -ne $S.Device) {
                $S.Conflicts[$key] = if ($m.device) { "$($m.device)" } else { 'another device' }
                Log "kept local copy, family store has newer progress from $($m.device) ($user $game $kind)"
                return 'conflict'
            }
        }
        CloudUpload $user $game $kind $bytes $at
        SetBase $file $at; $S.Conflicts.Remove($key)
        'ok'
    }
    # Before a newer family copy replaces a local save that still has play not sent anywhere, keep that local copy:
    # snapshots go into the "Go back" list (On this computer), other saves into "<save>.kept".
    function KeepLocal($file, $kind) {
        if (-not (Test-Path -LiteralPath $file)) { return }
        $base = GetBase $file
        if ($null -ne $base -and (Ms $file) -le ($base + 1000)) { return }   # nothing unsent
        if ($kind -eq 'state') {
            for ($i = $SnapshotSlots - 1; $i -ge 1; $i--) { if (Test-Path -LiteralPath "$file.h$i") { Move-Item -LiteralPath "$file.h$i" "$file.h$($i + 1)" -Force } }
            Copy-Item -LiteralPath $file "$file.h1" -Force
        } else { Copy-Item -LiteralPath $file "$file.kept" -Force }
        Log "kept unsent local copy before taking newer family save ($file)"
    }
    function Log($m) { try { Add-Content $S.Log ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $m) } catch {} }
    # Player list as JSON text, always an array, never with a byte-order mark.
    function UsersJson() {
        # The file already holds JSON; re-serializing through ConvertTo-Json wraps arrays oddly on Windows PowerShell 5.1.
        $t = [IO.File]::ReadAllText($S.Users).TrimStart([char]0xFEFF).Trim()
        if (-not $t.StartsWith('[')) { throw 'users.json is not a list' }
        $null = $t | ConvertFrom-Json
        $t
    }
    function WriteUsers($arr) { [IO.File]::WriteAllText($S.Users, (ConvertTo-Json -InputObject @($arr) -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false)) }
    function ProfilesBody($at) { '{"family":"' + (FamilyHash) + '","data":' + (UsersJson) + ',"updated_at":"' + (Iso $at) + '"}' }
    # Saves made before the family store was connected (or while offline) get uploaded when they are newer than the store's copy.
    function Backfill() {
        if (-not (CloudReady) -or -not (Test-Path $S.Saves)) { return }
        $have = @{}
        $dev = @{}
        try { Cloud 'arcade_saves?select=player,game,kind,updated_at,device' 'GET' $null 20 | Where-Object { $_ } | ForEach-Object { $k = "$($_.player)|$($_.game)|$($_.kind)"; $have[$k] = (FromIso $_.updated_at); $dev[$k] = "$($_.device)" } } catch { Log "backfill list failed: $($_.Exception.Message)"; return }
        $n = 0
        foreach ($f in Get-ChildItem $S.Saves -Recurse -File | Where-Object { $_.Extension -in '.sram', '.state', '.slot1', '.slot2', '.slot3', '.native-save' }) {
            $user = $f.Directory.Name; $game = $f.BaseName; $kind = $f.Extension.TrimStart('.') -replace '^native-save$', 'native'; $at = Ms $f.FullName
            $k = "$user|$game|$kind"
            if ($have[$k] -and $have[$k] -ge ($at - 1000)) { continue }
            # Another device saved since this computer last synced: keep both, do not overwrite the store.
            $base = GetBase $f.FullName
            if ($have[$k] -and $null -ne $base -and $have[$k] -gt ($base + 1000) -and $dev[$k] -ne $S.Device) { $S.Conflicts[$k] = $dev[$k]; Log "backfill kept local copy, newer family save from $($dev[$k]) ($user $game $kind)"; continue }
            try { CloudUpload $user $game $kind ([IO.File]::ReadAllBytes($f.FullName)) $at; SetBase $f.FullName $at; $n++ } catch { Log "backfill failed ($user $game $kind): $($_.Exception.Message)" }
        }
        if ($n) { Log "backfill: uploaded $n save(s)" }
    }
    # A newer family copy replaces the local save (the local copy is kept if it held unsent play). Returns $true when it did.
    function PullNewer($user, $game, $kind, $file) {
        $local = Ms $file; $base = GetBase $file
        $m = CloudMeta $user $game $kind
        if (-not $m) { return $false }
        $cAt = FromIso $m.updated_at
        # Another device saved since this computer last synced: the family copy wins, this computer's copy is kept.
        $diverged = ($null -ne $base) -and ($cAt -gt ($base + 1000)) -and ("$($m.device)" -ne $S.Device)
        if ($cAt -gt ($local + 1000) -or $diverged) {
            $n = CloudNewer $user $game $kind -1
            if ($n) { KeepLocal $file $kind; WriteAtomic $file $n.bytes $n.at; SetBase $file $n.at; $S.Conflicts.Remove("$user|$game|$kind"); return $true }
        } elseif ($null -eq $base) {
            # First visit since the conflict guard arrived: take the store's current time as the synced version.
            SetBase $file $cAt
        }
        $false
    }

    # ---- desktop emulator saves (GameCube, PS2, 3DS) ----
    # Those emulators keep saves in their own folders, shared by everyone and on one computer only. The arcade owns them
    # instead: each player's saves for a game live in saves\<player>\<game>.native-save (a zip). They are put in place just
    # before the emulator opens, collected every minute while it runs and when it closes, versioned on this computer and
    # sent to the family store like any other save. Files are never deleted without a copy somewhere.
    $EmuFull = [IO.Path]::GetFullPath($Emu).TrimEnd('\')
    $NativeDir = Join-Path $S.Saves '_native'
    $NativeProc = @{ gc = 'Dolphin'; ps2 = 'pcsx2-qt'; '3ds' = 'azahar' }
    function ReadJson($f) { if (Test-Path -LiteralPath $f) { try { return ([IO.File]::ReadAllText($f) | ConvertFrom-Json) } catch {} }; $null }
    function WriteJson($f, $o) { New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null; [IO.File]::WriteAllText($f, (ConvertTo-Json $o -Compress)) }
    # Where a game's saves live inside the emulator folder: the folder, and which files in it belong to the game.
    function NativeSpec($g) {
        if ($g.system -eq 'gc') {
            # The disc's game ID (GALE01 = code GALE, maker 01) names its memory card files: 01-GALE-*.gci
            $ids = ReadJson (Join-Path $NativeDir 'gameids.json'); if (-not $ids) { $ids = [pscustomobject]@{} }
            $key = "$($g.path)|$((Get-Item -LiteralPath $g.path).Length)"
            $id = $ids.$key
            if (-not $id) {
                $out = & (Join-Path $EmuFull 'Dolphin\DolphinTool.exe') header -i $g.path 2>$null
                $gid = (($out | Where-Object { $_ -match '^Game ID:' }) -replace '^Game ID:\s*', '').Trim()
                $reg = (($out | Where-Object { $_ -match '^Region:' }) -replace '^Region:\s*', '').Trim()
                if ($gid.Length -ne 6) { throw "Could not read the game ID of $($g.title)" }
                $id = [pscustomobject]@{ gid = $gid; region = $reg }
                $ids | Add-Member -NotePropertyName $key -NotePropertyValue $id -Force
                WriteJson (Join-Path $NativeDir 'gameids.json') $ids
            }
            $folder = switch ($id.region) { 'PAL' { 'EUR' } 'NTSC-J' { 'JAP' } default { 'USA' } }
            $prefix = $id.gid.Substring(4, 2) + '-' + $id.gid.Substring(0, 4) + '-'
            return @{ dir = (Join-Path $EmuFull "Dolphin\User\GC\$folder\Card A"); match = { param($n) $n.StartsWith($prefix) -and $n.EndsWith('.gci') }.GetNewClosure() }
        }
        if ($g.system -eq '3ds') {
            # Installed titles: ...\title\00040000\<id>\content\*.app. Cartridge files carry the title ID in their header.
            $tid = $null
            if ($g.path -match '\\title\\00040000\\([0-9a-f]{8})\\content\\') { $tid = $Matches[1] }
            else {
                $fs = [IO.File]::OpenRead($g.path); try { $h = New-Object byte[] 0x110; $null = $fs.Read($h, 0, $h.Length) } finally { $fs.Dispose() }
                $tid = '{0:x8}' -f [BitConverter]::ToUInt32($h, 0x108)
            }
            return @{ dir = (Join-Path $EmuFull "Azahar\user\sdmc\Nintendo 3DS\00000000000000000000000000000000\00000000000000000000000000000000\title\00040000\$tid\data"); match = { param($n) $true } }
        }
        if ($g.system -eq 'ps2') { return @{ dir = (Join-Path $EmuFull 'PCSX2\memcards'); match = { param($n) $n -eq 'Mcd001.ps2' } } }
        $null
    }
    function NativeFiles($spec) {
        if (-not (Test-Path -LiteralPath $spec.dir)) { return @() }
        @(Get-ChildItem -LiteralPath $spec.dir -Recurse -File | Where-Object { & $spec.match $_.Name } | Sort-Object FullName | ForEach-Object { $_.FullName })
    }
    function NativeHash($files) {
        $sha = [Security.Cryptography.SHA256]::Create(); $ms = New-Object IO.MemoryStream
        foreach ($f in $files) { $n = [Text.Encoding]::UTF8.GetBytes($f.Substring($EmuFull.Length)); $ms.Write($n, 0, $n.Length); $b = [IO.File]::ReadAllBytes($f); $ms.Write($b, 0, $b.Length) }
        ([BitConverter]::ToString($sha.ComputeHash($ms.ToArray())) -replace '-', '')
    }
    function Pack($files) {
        $ms = New-Object IO.MemoryStream
        $zip = New-Object IO.Compression.ZipArchive($ms, [IO.Compression.ZipArchiveMode]::Create, $true)
        foreach ($f in $files) {
            $e = $zip.CreateEntry(($f.Substring($EmuFull.Length).TrimStart('\') -replace '\\', '/'), [IO.Compression.CompressionLevel]::Optimal)
            $e.LastWriteTime = (Get-Item -LiteralPath $f).LastWriteTime
            $s = $e.Open(); $b = [IO.File]::ReadAllBytes($f); $s.Write($b, 0, $b.Length); $s.Dispose()
        }
        $zip.Dispose(); ,$ms.ToArray()
    }
    function Unpack($bytes, $spec) {
        $zip = New-Object IO.Compression.ZipArchive((New-Object IO.MemoryStream(,$bytes)), [IO.Compression.ZipArchiveMode]::Read)
        $dirFull = [IO.Path]::GetFullPath($spec.dir).TrimEnd('\') + '\'
        try {
            foreach ($e in $zip.Entries) {
                if (-not $e.Name) { continue }
                $dest = [IO.Path]::GetFullPath((Join-Path $EmuFull ($e.FullName -replace '/', '\')))
                if (-not $dest.StartsWith($dirFull, [StringComparison]::OrdinalIgnoreCase)) { continue }   # only this game's save folder
                New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
                $out = New-Object IO.MemoryStream; $s = $e.Open(); $s.CopyTo($out); $s.Dispose()
                [IO.File]::WriteAllBytes($dest, $out.ToArray())
                (Get-Item -LiteralPath $dest).LastWriteTime = $e.LastWriteTime.DateTime
            }
        } finally { $zip.Dispose() }
    }
    function OwnerFile($g) { Join-Path $NativeDir "owner-$($g.system)-$($g.id).json" }
    # Collect the game's saves from the emulator folder into the player's save (only when they changed).
    function NativeCapture($user, $g) {
        $spec = NativeSpec $g; $files = NativeFiles $spec
        if (-not $files.Count) { return }
        $hash = NativeHash $files
        $file = Join-Path (Join-Path $S.Saves $user) "$($g.id).native-save"
        $o = ReadJson (OwnerFile $g)
        if ($o -and $o.user -eq $user -and $o.hash -eq $hash -and (Test-Path -LiteralPath $file)) { return }
        $bytes = Pack $files
        $prevAt = Ms $file; $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        # Older versions on this computer: one every 10 minutes at most, the last 10 kept (h1 newest).
        if (Test-Path -LiteralPath $file) {
            $h1 = "$file.h1"
            if (-not (Test-Path -LiteralPath $h1) -or ($prevAt - (Ms $h1)) -ge 600000) {
                for ($i = 9; $i -ge 1; $i--) { if (Test-Path -LiteralPath "$file.h$i") { Move-Item -LiteralPath "$file.h$i" "$file.h$($i + 1)" -Force } }
                Copy-Item -LiteralPath $file $h1 -Force
            }
        }
        WriteAtomic $file $bytes $at
        WriteJson (OwnerFile $g) @{ user = $user; hash = $hash }
        Log "saved $user $($g.id) from the emulator ($($files.Count) file(s))"
        if (CloudReady) { try { $null = GuardedUpload $user $g.id 'native' $bytes $at $file $prevAt } catch { Log "upload failed ($($g.id) native): $($_.Exception.Message)" } }
    }
    # Put the player's saves for this game in place (newest family copy first). Whatever was there is kept unless it is
    # already safely stored as someone's save.
    function NativeSwapIn($user, $g) {
        $spec = NativeSpec $g
        $file = Join-Path (Join-Path $S.Saves $user) "$($g.id).native-save"
        if (CloudReady) { try { $null = PullNewer $user $g.id 'native' $file } catch { Log "cloud check failed ($($g.id) native): $($_.Exception.Message)" } }
        $files = NativeFiles $spec
        if ($files.Count) {
            $o = ReadJson (OwnerFile $g)
            if (-not $o -or $o.hash -ne (NativeHash $files)) {
                $keep = Join-Path $S.Root ("backups\native\{0:yyyy-MM-dd-HHmmss}-{1}-{2}" -f (Get-Date), $g.system, $g.id)
                foreach ($f in $files) { $d = Join-Path $keep $f.Substring($EmuFull.Length).TrimStart('\'); New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; Copy-Item -LiteralPath $f $d -Force }
                Log "kept unclaimed emulator saves for $($g.id) in $keep"
            }
            foreach ($f in $files) { Remove-Item -LiteralPath $f -Force }
        }
        if (Test-Path -LiteralPath $file) { Unpack ([IO.File]::ReadAllBytes($file)) $spec }
        $now = NativeFiles $spec
        WriteJson (OwnerFile $g) @{ user = $user; hash = $(if ($now.Count) { NativeHash $now } else { '' }) }
    }
    function SessionFile($sys) { Join-Path $NativeDir "session-$sys.json" }
    # While the emulator runs, collect saves every minute; collect once more when it closes.
    function NativeWatch($sess, $g, $proc) {
        try {
            while (-not $proc.HasExited) { $null = $proc.WaitForExit(60000); try { NativeCapture $sess.user $g } catch { Log "save collect failed ($($g.id)): $($_.Exception.Message)" } }
            Start-Sleep -Seconds 2
            NativeCapture $sess.user $g
            Remove-Item -LiteralPath (SessionFile $g.system) -Force -ErrorAction SilentlyContinue
        } catch { Log "save collect failed ($($g.id)): $($_.Exception.Message)" }
    }
    function NativeRunning($sys) { @(Get-Process -Name $NativeProc[$sys] -ErrorAction SilentlyContinue) }
    # Daily copy of every in-game save and player list on this computer (backups\saves, last 30 days).
    function Vault() {
        $dir = Join-Path $S.Root 'backups\saves'; New-Item -ItemType Directory -Force $dir | Out-Null
        $zipPath = Join-Path $dir ("saves-{0:yyyy-MM-dd}.zip" -f (Get-Date))
        if (Test-Path $zipPath) { return }
        $fs = [IO.File]::Open("$zipPath.tmp", 'Create')
        $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $base = [IO.Path]::GetFullPath($S.Saves).TrimEnd('\')
            foreach ($f in Get-ChildItem $S.Saves -Recurse -File | Where-Object { $_.Extension -in '.sram', '.native-save', '.kept' -or $_.Name -eq 'gameids.json' }) {
                $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, ('saves/' + ($f.FullName.Substring($base.Length).TrimStart('\') -replace '\\', '/')))
            }
            if (Test-Path $S.Users) { $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $S.Users, 'users.json') }
        } finally { $zip.Dispose(); $fs.Dispose() }
        Move-Item "$zipPath.tmp" $zipPath -Force
        Get-ChildItem $dir -Filter 'saves-*.zip' | Sort-Object Name -Descending | Select-Object -Skip 30 | Remove-Item -Force
        Log "daily save backup written ($zipPath)"
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
                    $list += (Entry ([IO.Path]::GetFileNameWithoutExtension($_.Name) -replace '\.nkit$', '') $sys $folder $_.FullName $rel $_.Length ([DateTimeOffset]$_.CreationTimeUtc).ToUnixTimeMilliseconds())
                }
            }
            $titles = Join-Path $Emu 'Azahar\user\sdmc\Nintendo 3DS\00000000000000000000000000000000\00000000000000000000000000000000\title\00040000'
            if (Test-Path $titles) {
                Get-ChildItem $titles -Directory | ForEach-Object {
                    $boot = Get-ChildItem (Join-Path $_.FullName 'content') -Filter *.app -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
                    if (-not $boot) { return }
                    $name = if ($ctrTitles[$_.Name]) { $ctrTitles[$_.Name] } else { "3DS game $($_.Name)" }
                    if ($list | Where-Object { $_.id -eq (SafeName $name) }) { return }
                    $list += (Entry $name '3ds' 'Nintendo 3DS' $boot.FullName $null $boot.Length 0)
                }
            }
            # Web games open in their own window. Built-in ones ship with the arcade; more can be added as
            # Windows internet shortcuts (.url files) in games\Web Games.
            $web = @($webGames)
            $wdir = Join-Path $S.Games 'Web Games'
            if (Test-Path $wdir) {
                Get-ChildItem $wdir -Filter *.url -File | ForEach-Object {
                    $u = (Get-Content $_.FullName | Where-Object { $_ -match '^URL=' } | Select-Object -First 1) -replace '^URL=', ''
                    if ($u -match '^https?://') { $web += @{ title = $_.BaseName; link = $u.Trim(); added = ([DateTimeOffset]$_.CreationTimeUtc).ToUnixTimeMilliseconds() } }
                }
            }
            foreach ($w in $web) {
                if ($list | Where-Object { $_.id -eq (SafeName $w.title) }) { continue }
                $e = Entry $w.title 'web' 'Web Games' $null $null 0 $w.added
                $e.link = $w.link
                if ($w.cover -and -not $e.cover) { $e.cover = $w.cover }
                $list += $e
            }
            $list
        }
        function Entry($title, $sys, $folder, $full, $rel, $len, $added) {
            $cover = Join-Path $S.Covers ((SafeName $title) + '.png')
            [ordered]@{
                id = SafeName $title; title = $title; system = $sys; folder = $folder; native = [bool]$native[$sys]; path = $full
                url = if ($rel) { '/games/' + (($rel -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/') } else { $null }
                cover = if (Test-Path $cover) { '/covers/' + [Uri]::EscapeDataString((SafeName $title) + '.png') } else { $null }
                mb = [math]::Round($len / 1MB); added = $added
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
            if (-not $user) { Send 400 $null; return }
            # One game per emulator at a time, so the right player's saves are in place.
            $sf = SessionFile $g.system
            if ((NativeRunning $g.system).Count) {
                SendJson @{ ok = $false; error = 'Another game is still open in that emulator. Close it first, then try again.' }; return
            }
            # Collect the last session first if the arcade was closed before the emulator was.
            $old = ReadJson $sf
            if ($old) {
                $og = GetLibrary | Where-Object { $_.id -eq $old.game } | Select-Object -First 1
                if ($og) { NativeCapture $old.user $og }
                Remove-Item -LiteralPath $sf -Force
            }
            try { NativeSwapIn $user $g } catch { Log "save swap failed ($($g.id)): $($_.Exception.Message)"; SendJson @{ ok = $false; error = 'Could not get your saves ready for this game, so it was not opened. Your saves are safe.' }; return }
            $proc = Start-Process $exe -ArgumentList ($n.args -f $g.path) -WorkingDirectory (Split-Path $exe) -PassThru
            $sess = @{ user = $user; game = $g.id; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
            WriteJson $sf $sess
            $dir = Join-Path $S.Saves $user; New-Item -ItemType Directory -Force $dir | Out-Null
            [IO.File]::WriteAllText((Join-Path $dir "$($g.id).native"), (Get-Date -Format o))
            SendJson @{ ok = $true }
            try { $res.Close() } catch {}
            NativeWatch ([pscustomobject]$sess) $g $proc
        }
        elseif ($path -eq '/api/native' -and $q['collect']) {
            # On start: finish any session the arcade was closed during, and write the daily save backup.
            SendJson @{ ok = $true }
            try { $res.Close() } catch {}
            try { Vault } catch { Log "daily save backup failed: $($_.Exception.Message)" }
            foreach ($sys in @($NativeProc.Keys)) {
                $sess = ReadJson (SessionFile $sys); if (-not $sess) { continue }
                $g = GetLibrary | Where-Object { $_.id -eq $sess.game } | Select-Object -First 1
                if (-not $g) { Remove-Item -LiteralPath (SessionFile $sys) -Force; continue }
                $p = NativeRunning $sys
                if ($p.Count) { NativeWatch $sess $g $p[0] } else { try { NativeCapture $sess.user $g } catch { Log "save collect failed ($($g.id)): $($_.Exception.Message)" }; Remove-Item -LiteralPath (SessionFile $sys) -Force }
            }
            # Saves made before the arcade looked after them belong to whoever opened that game last.
            foreach ($g in @(GetLibrary | Where-Object { $_.native })) {
                try {
                    if ((Test-Path -LiteralPath (OwnerFile $g)) -or (Test-Path -LiteralPath (SessionFile $g.system))) { continue }
                    if (-not (NativeFiles (NativeSpec $g)).Count) { continue }
                    $last = Get-ChildItem $S.Saves -Recurse -File -Filter "$($g.id).native" -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "$($g.id).native" } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
                    if ($last) { NativeCapture $last.Directory.Name $g }
                } catch { Log "save hand-over failed ($($g.id)): $($_.Exception.Message)" }
            }
        }
        elseif ($path -eq '/api/users') {
            $res.AddHeader('Cache-Control', 'no-store')
            if ($req.HttpMethod -eq 'POST') {
                $body = [Text.Encoding]::UTF8.GetString((ReadBody))
                $null = $body | ConvertFrom-Json
                [IO.File]::WriteAllText($S.Users, $body, (New-Object Text.UTF8Encoding $false))
                $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); SetDirty $at $true
                if (CloudReady) { try { Cloud 'arcade_profiles?on_conflict=family' 'POST' (ProfilesBody $at) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $at $false } catch { Log "profiles push failed: $($_.Exception.Message)" } }
                SendJson @{ ok = $true }
            } else {
                if (CloudReady) {
                    try {
                        $m = Dirty
                        $row = @(Cloud 'arcade_profiles?select=data,updated_at' 'GET' $null 8 | Where-Object { $null -ne $_ })
                        if ($row.Count -and (FromIso $row[0].updated_at) -gt ([long]$m.at + 1000)) {
                            $list = @($row[0].data | Where-Object { $_ -and $_.id })
                            if ($list.Count -ge 1) { WriteUsers $list; SetDirty (FromIso $row[0].updated_at) $false }
                        } elseif ($m.dirty -and (Test-Path $S.Users)) {
                            Cloud 'arcade_profiles?on_conflict=family' 'POST' (ProfilesBody $m.at) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $m.at $false
                        }
                    } catch { Log "profiles sync failed: $($_.Exception.Message)" }
                }
                if (Test-Path $S.Users) { Send 200 ([IO.File]::ReadAllBytes($S.Users)) 'application/json' } else { SendJson @() }
            }
        }
        elseif ($path -eq '/api/save') {
            # kind: sram (in-game save), state (snapshot). Local first, family store second.
            $res.AddHeader('Cache-Control', 'no-store')
            $user = SafeName $q['user']; $game = SafeName $q['game']; $kind = $q['kind']
            if (-not $user -or -not $game -or @('sram', 'state', 'slot1', 'slot2', 'slot3') -notcontains $kind) { Send 400 $null; return }
            $file = Join-Path (Join-Path $S.Saves $user) "$game.$kind"
            if ($req.HttpMethod -eq 'POST') {
                $data = ReadBody
                $prevAt = Ms $file
                $ck = "$user|$game|$kind"; if ($S.Conflicts[$ck]) { $res.AddHeader('X-Conflict', $S.Conflicts[$ck]) }
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
                if ($data.Length -gt 0 -and (CloudReady)) { try { $null = GuardedUpload $user $game $kind $data $at $file $prevAt } catch { Log "upload failed ($game $kind): $($_.Exception.Message)" } }
            } else {
                $fromCloud = $false
                if (CloudReady) {
                    try { $fromCloud = PullNewer $user $game $kind $file }
                    catch { Log "cloud check failed ($game $kind): $($_.Exception.Message)"; $res.AddHeader('X-Cloud', 'unreachable') }
                }
                if (Test-Path $file) {
                    $res.AddHeader('X-Saved-At', (Ms $file)); if ($fromCloud) { $res.AddHeader('X-From-Cloud', '1') }
                    if ($q['peek']) { Send 200 $null } else { SendFile $file }
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
                    Cloud "arcade_save_history?select=id,updated_at,device&player=eq.$([Uri]::EscapeDataString($user))&game=eq.$([Uri]::EscapeDataString($game))&kind=eq.state&order=updated_at.desc" 'GET' $null 8 | Where-Object { $_ } |
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
                Get-ChildItem $dir -File | Where-Object { $_.Extension -in '.sram', '.state', '.native', '.native-save' } |
                    ForEach-Object { $k = $_.BaseName; $t = (Ms $_.FullName); if (-not $out[$k] -or $out[$k] -lt $t) { $out[$k] = $t } }
            }
            if ($user -and (CloudReady)) {
                try { Cloud "arcade_recent?select=game,updated_at&player=eq.$([Uri]::EscapeDataString($user))" 'GET' $null 8 | Where-Object { $_ } |
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
                $prevFamily = $S.Family   # a failed attempt leaves the current connection as it was
                $S.Family = $code
                if ($code) {
                    # A code only connects when a family already uses it (it has a player list or saves), so a typo
                    # cannot quietly start an empty family. Starting a new family is a separate, deliberate choice.
                    try {
                        $known = @(Cloud 'arcade_profiles?select=family' 'GET' $null 10 | Where-Object { $null -ne $_ }).Count -gt 0
                        if (-not $known) { $known = @(Cloud 'arcade_saves?select=game&limit=1' 'GET' $null 10 | Where-Object { $null -ne $_ }).Count -gt 0 }
                    } catch { $S.Family = $prevFamily; SendJson @{ ok = $false; error = 'Could not reach the family store. Check the internet connection and try again.' }; return }
                    if (-not $known -and -not $body.create) { $S.Family = $prevFamily; SendJson @{ ok = $false; unknown = $true; error = 'No family uses that code. Check it for typos. If you are starting family saves for the first time, choose Start a new family.' }; return }
                    # First connection: take the family's player list if there is one, otherwise share ours.
                    try {
                        $row = @(Cloud 'arcade_profiles?select=data,updated_at' 'GET' $null 8 | Where-Object { $null -ne $_ })
                        $list = if ($row.Count) { @($row[0].data | Where-Object { $_ -and $_.id }) } else { @() }
                        if ($list.Count -ge 1) { WriteUsers $list; SetDirty (FromIso $row[0].updated_at) $false }
                        elseif (Test-Path $S.Users) { $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Cloud 'arcade_profiles?on_conflict=family' 'POST' (ProfilesBody $at) 15 'resolution=merge-duplicates' | Out-Null; SetDirty $at $false }
                    } catch { Log "profile reconcile failed: $($_.Exception.Message)" }
                }
                $c = Get-Content $S.Config -Raw | ConvertFrom-Json
                $c | Add-Member -NotePropertyName familyCode -NotePropertyValue $code -Force
                ConvertTo-Json $c -Depth 4 | Set-Content $S.Config -Encoding ASCII
                SendJson @{ ok = $true; connected = [bool]$code }
                try { $res.Close() } catch {}
                if ($code) { Backfill }
            }
            elseif ($q['backfill']) {
                SendJson @{ ok = $true }
                try { $res.Close() } catch {}
                Backfill
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

# A small pool so a big game download does not block saves or the menu (desktop emulator games each hold one while open).
$pool = [RunspaceFactory]::CreateRunspacePool(1, 12); $pool.Open()
$jobs = New-Object Collections.ArrayList
# On startup: finish desktop emulator sessions and write the daily save backup, then push any saves the family store
# is missing (made offline, or before it was connected).
$sync = [bool]($State.Cloud.url -and $State.Family)
Start-Job -ScriptBlock { param($port, $sync) Start-Sleep 3
    try { Invoke-RestMethod "http://localhost:$port/api/native?collect=1" -TimeoutSec 5 | Out-Null } catch {}
    if ($sync) { Start-Sleep 5; try { Invoke-RestMethod "http://localhost:$port/api/sync?backfill=1" -TimeoutSec 5 | Out-Null } catch {} }
} -ArgumentList $port, $sync | Out-Null
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($State)
    [void]$jobs.Add(@{ ps = $ps; h = $ps.BeginInvoke() })
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
        if ($jobs[$i].h.IsCompleted) { $jobs[$i].ps.EndInvoke($jobs[$i].h); $jobs[$i].ps.Dispose(); $jobs.RemoveAt($i) }
    }
}
