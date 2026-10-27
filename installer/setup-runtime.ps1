# Downloads the newest Node.js LTS of one major version into ..\runtime and
# installs the app's npm dependencies with it. Run this before build-installer.bat.
#
#   powershell -ExecutionPolicy Bypass -File installer\setup-runtime.ps1
#   powershell -ExecutionPolicy Bypass -File installer\setup-runtime.ps1 -Major 22
#
# The download is checked against the SHA-256 published by nodejs.org.
param(
    [int]$Major = 24
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $root "runtime"

Write-Host "Looking up the latest Node.js $Major.x LTS release..." -ForegroundColor Cyan
$index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
$release = $index | Where-Object { $_.lts -and $_.version -like "v$Major.*" } | Select-Object -First 1
if (-not $release) { throw "No LTS release found for Node.js $Major." }
$version = $release.version
$name = "node-$version-win-x64"
Write-Host "Using Node.js $version" -ForegroundColor Green

$zip = Join-Path $env:TEMP "$name.zip"
$extractDir = Join-Path $env:TEMP "sheetstoobs-node-extract"
Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip -UseBasicParsing

Write-Host "Verifying checksum..." -ForegroundColor Cyan
$sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match "\s$name\.zip$" }) -replace "\s.*$", ""
$actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected.Trim().ToLower() -ne $actual) { throw "Checksum mismatch for $name.zip - download aborted." }

Write-Host "Extracting..." -ForegroundColor Cyan
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extractDir -Force
if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -Path (Join-Path $extractDir "$name\*") -Destination $targetDir -Recurse -Force

& (Join-Path $targetDir "node.exe") -v
& (Join-Path $targetDir "npm.cmd") -v

Write-Host "Installing application dependencies..." -ForegroundColor Cyan
Push-Location $root
try {
    & (Join-Path $targetDir "npm.cmd") ci --omit=dev
} finally {
    Pop-Location
}

Write-Host "Runtime ($version) and dependencies are ready." -ForegroundColor Green
