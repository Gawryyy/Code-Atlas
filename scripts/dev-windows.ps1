$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$logoSource = Join-Path (Get-Location) "assets\logo\logo.png"
$logoTargetDir = Join-Path (Get-Location) "src\assets\logo"
$logoTarget = Join-Path $logoTargetDir "logo.png"

if (-not (Test-Path $logoSource)) {
    throw "CodeAtlas: assets\logo\logo.png is missing."
}

New-Item -ItemType Directory -Force -Path $logoTargetDir | Out-Null
Copy-Item -Force $logoSource $logoTarget

cargo tauri dev
