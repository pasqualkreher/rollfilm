# Windows counterpart of build_backend.sh: builds the self-contained backend
# bundle with PyInstaller and stages it (plus the standalone Windows exiftool)
# under electron\resources\, ready for electron-builder.
#
# Prereq: the backend venv exists with the pinned deps installed:
#   python -m venv .venv
#   .venv\Scripts\pip install -r requirements.lock --extra-index-url https://download.pytorch.org/whl/cpu
#   .venv\Scripts\pip install --no-deps -e .
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
# Pinned, like build_backend.sh: a build takes exactly this exiftool, checked
# against the SHA-256 exiftool.org publishes in checksums.txt. Overriding the
# version means giving its checksum too, or the build stops.
$EtVer = if ($env:EXIFTOOL_VERSION) { $env:EXIFTOOL_VERSION } else { "13.59" }
$EtSha = if ($env:EXIFTOOL_VERSION) { $env:EXIFTOOL_SHA256 } else {
    "44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec"
}
if (-not $EtSha) { Write-Error "EXIFTOOL_VERSION set without EXIFTOOL_SHA256" }
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
# Sanity check: a real zip starts with "PK". ([IO.File] works in both Windows
# PowerShell 5.1 and pwsh 7 - Get-Content's byte flags differ between them.)
$bytes = [System.IO.File]::ReadAllBytes($TmpZip)
if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
    Write-Error "Downloaded exiftool file is not a zip (got HTML?)"
}
# .NET's own SHA-256: Get-FileHash is not loaded in every PowerShell the
# build runs under (the Windows runner's shell has failed on it).
$Sha = [System.Security.Cryptography.SHA256]::Create()
$Got = -join ($Sha.ComputeHash([System.IO.File]::ReadAllBytes($TmpZip)) | ForEach-Object { $_.ToString("x2") })
if ($Got -ne $EtSha.ToLower()) {
    Write-Error "exiftool checksum mismatch: expected $EtSha, got $Got"
}
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
