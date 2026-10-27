# PowerShell Script to Create Local Code-Signing Certificate and Sign Executables
$ErrorActionPreference = "Stop"

Write-Host "Creating or retrieving SheetsToOBS Code-Signing Certificate..." -ForegroundColor Cyan

# 1. Look for existing SheetsToOBS cert or create a new one
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -like "*CN=SheetsToOBS*" } | Select-Object -First 1

if (-not $cert) {
    Write-Host "Generating new self-signed Code Signing Certificate..." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate `
        -Subject "CN=SheetsToOBS Code Signing" `
        -Type CodeSigningCert `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyUsage DigitalSignature `
        -FriendlyName "SheetsToOBS Code Signing Certificate" `
        -NotAfter (Get-Date).AddYears(10)
}

Write-Host "Certificate Thumbprint: $($cert.Thumbprint)" -ForegroundColor Green

# 2. Export public certificate and import to Trusted Publisher for CurrentUser
$cerPath = Join-Path $PSScriptRoot "SheetsToOBS.cer"
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null

Write-Host "Registering Certificate in CurrentUser Trusted Publisher Store..." -ForegroundColor Cyan
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null

# 3. Sign Executables
$rootPath = Resolve-Path (Join-Path $PSScriptRoot "..")
$installerExe = Join-Path $PSScriptRoot "Output\Setup_Sheets_to_OBS_v0_1.exe"
$appExe = Join-Path $rootPath "SheetsToOBS.exe"

if (Test-Path $installerExe) {
    Write-Host "Signing Installer: $installerExe" -ForegroundColor Cyan
    Unblock-File -Path $installerExe
    $sig = Set-AuthenticodeSignature -FilePath $installerExe -Certificate $cert -HashAlgorithm SHA256
    Write-Host "Installer Signature Status: $($sig.Status)" -ForegroundColor Green
}

if (Test-Path $appExe) {
    Write-Host "Signing App Launcher: $appExe" -ForegroundColor Cyan
    Unblock-File -Path $appExe
    $sig = Set-AuthenticodeSignature -FilePath $appExe -Certificate $cert -HashAlgorithm SHA256
    Write-Host "App Launcher Signature Status: $($sig.Status)" -ForegroundColor Green
}

Write-Host "`nAll executables successfully signed!" -ForegroundColor Green
