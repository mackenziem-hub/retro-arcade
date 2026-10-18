# Packs a complete, self-contained copy of the arcade onto an external drive (or any folder).
# The copy carries its own games, covers, players and saves, so it runs on any Windows PC.
# Usage: right-click > Run with PowerShell, then type the drive letter (for example E).
param([string]$Target)

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $Here 'config.json') -Raw | ConvertFrom-Json
$games = $cfg.gamesDir
if (-not [IO.Path]::IsPathRooted($games)) { $games = Join-Path $Here $games }

if (-not $Target) { $Target = Read-Host 'Drive letter or folder to copy the arcade to (for example E)' }
if ($Target -match '^[A-Za-z]:?$') { $Target = $Target.Substring(0, 1) + ':\Retro Arcade' }
New-Item -ItemType Directory -Force $Target | Out-Null
Write-Host "Copying the arcade to $Target ..."

# App, emulators and covers (robocopy only copies what changed, so re-running to update is quick).
# The desktop emulators keep their saves inside their own folders; skip those on an update too.
$emuSaves = 'Dolphin\User\GC', 'Dolphin\User\Wii', 'Dolphin\User\StateSaves', 'PCSX2\memcards', 'PCSX2\sstates', 'Azahar\user\sdmc', 'Azahar\user\nand', 'Azahar\user\states' |
    Where-Object { Test-Path (Join-Path $Target "emulators\$_") } | ForEach-Object { Join-Path $Here "emulators\$_" }
robocopy $Here $Target /E /XD games saves @emuSaves /XF config.json users.json /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
# Players and saves only go over the first time. On an update, the other computer's saves are never touched.
if (-not (Test-Path (Join-Path $Target 'users.json')) -and (Test-Path (Join-Path $Here 'users.json'))) { Copy-Item (Join-Path $Here 'users.json') $Target }
if (-not (Test-Path (Join-Path $Target 'saves'))) { robocopy (Join-Path $Here 'saves') (Join-Path $Target 'saves') /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }
# Games: only the systems the arcade can play.
foreach ($folder in 'BIOS', 'Game Boy', 'Game Boy Color', 'Game Boy Advance', 'Nintendo DS', 'NES', 'SNES', 'Nintendo 64', 'PlayStation', 'PSP', 'Sega Genesis', 'GameCube & Wii', 'PlayStation 2', 'Nintendo 3DS') {
    $src = Join-Path $games $folder
    # .cia files are skipped: installed 3DS games already travel inside emulators\Azahar.
    if (Test-Path $src) { robocopy $src (Join-Path $Target "games\$folder") /E /XF *.cia /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }
}
# The copy reads games from its own folder.
$c = [ordered]@{ port = 8642; gamesDir = 'games'; updateUrl = $cfg.updateUrl; cloud = $cfg.cloud; familyCode = $cfg.familyCode }
ConvertTo-Json $c | Set-Content (Join-Path $Target 'config.json') -Encoding ASCII

# PokeMMO extras for the other computer and an Android phone.
$mmo = Join-Path $env:LOCALAPPDATA 'Programs\PokeMMO'
if (Test-Path $mmo) { robocopy $mmo (Join-Path $Target 'Extras\PokeMMO (Windows)') /E /XD log /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }

Write-Host "Done. On the other computer, open '$Target' and double-click 'Play Retro Arcade.bat'."
