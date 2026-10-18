# Retro Arcade

Update channel for a home Retro Arcade (EmulatorJS front end with player profiles and auto-save).

This repo holds the arcade's menu and launcher code only. No games, BIOS files, saves or emulators are stored here.
Each arcade copy reads `manifest.json` on startup and replaces any changed files, checked against their SHA-256.

Publish a change: `powershell -ExecutionPolicy Bypass -File publish.ps1 "what changed"`
