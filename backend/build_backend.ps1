# Windows counterpart of build_backend.sh: builds the self-contained backend
# bundle with PyInstaller and stages it (plus the standalone Windows exiftool)
# under electron\resources\, ready for electron-builder.
#
# Prereq: the backend venv exists with deps + pyinstaller installed:
#   python -m venv .venv
#   .venv\Scripts\pip install -e . pyinstaller
#   (+ CPU torch/torchvision from the pytorch index)
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File build_backend.ps1
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

$PyInstaller = Join-Path $Here ".venv\Scripts\pyinstaller.exe"
if (-not (Test-Path $PyInstaller)) {
    Write-Error "error: $PyInstaller not found. Create the backend venv first."
}

Write-Host "==> Building backend with PyInstaller (this is slow - torch is large)"
& $PyInstaller photo_manager_backend.spec --noconfirm --clean `
    --distpath (Join-Path $Here "pyi-dist") `
    --workpath (Join-Path $Here "pyi-build")
if ($LASTEXITCODE -ne 0) { Write-Error "PyInstaller failed" }

$Dest = Join-Path $Here "..\electron\resources\backend"
Write-Host "==> Staging backend at $Dest"
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $Here "pyi-dist\photo-manager-backend\*") $Dest

Write-Host "==> Bundling standalone Windows exiftool"
# The Windows distribution is a self-contained exe (no Perl needed): a zip with
# "exiftool(-k).exe" (+ an exiftool_files dir in recent versions). The (-k)
# variant pauses for a keypress when double-clicked - renaming it to
# exiftool.exe restores normal CLI behaviour.
$EtVer = if ($env:EXIFTOOL_VERSION) { $env:EXIFTOOL_VERSION } else {
    (Invoke-WebRequest -UseBasicParsing "https://exiftool.org/ver.txt").Content.Trim()
}
$Zip = "exiftool-${EtVer}_64.zip"
$EtDir = Join-Path $Here "..\electron\resources\exiftool"
if (Test-Path $EtDir) { Remove-Item -Recurse -Force $EtDir }
New-Item -ItemType Directory -Force -Path $EtDir | Out-Null
$TmpZip = Join-Path $env:TEMP $Zip
# exiftool.org no longer serves the versioned zips (404). Fetch from the
# SourceForge *direct-download* host via curl.exe: the "/files/.../download"
# web URL can answer with an HTML interstitial page, which then explodes in
# Expand-Archive as a FileFormatException.
& curl.exe -fsSL "https://downloads.sourceforge.net/project/exiftool/$Zip" -o $TmpZip
if ($LASTEXITCODE -ne 0) { Write-Error "exiftool download failed" }
# Sanity check: a real zip starts with "PK".
$sig = [System.Text.Encoding]::ASCII.GetString((Get-Content $TmpZip -AsByteStream -TotalCount 2))
if ($sig -ne "PK") { Write-Error "Downloaded exiftool file is not a zip (got HTML?)" }
$TmpDir = Join-Path $env:TEMP "exiftool-extract"
if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
Expand-Archive -Path $TmpZip -DestinationPath $TmpDir
# Layout varies by version: the exe (and exiftool_files, if present) may sit at
# the zip root or inside a versioned folder.
$ExeSrc = Get-ChildItem -Recurse $TmpDir -Filter "exiftool(-k).exe" | Select-Object -First 1
if (-not $ExeSrc) { Write-Error "exiftool(-k).exe not found in $Zip" }
Copy-Item $ExeSrc.FullName (Join-Path $EtDir "exiftool.exe")
$FilesDir = Get-ChildItem -Recurse -Directory $TmpDir -Filter "exiftool_files" | Select-Object -First 1
if ($FilesDir) { Copy-Item -Recurse $FilesDir.FullName (Join-Path $EtDir "exiftool_files") }

Write-Host "==> Done. Bundle: $Dest ; exiftool: $EtDir"
Write-Host "Next: cd ..\electron ; npm run build:renderer ; npx electron-builder --win"
