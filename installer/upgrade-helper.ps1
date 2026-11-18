# Used by the installer when upgrading from v0.2.0 or earlier, which installed into
# "C:\Program Files\OBS Google Sheet Importer GUI" and often kept settings there.
#
#   -Stop    : stops SheetsToOBS / node.exe processes running from the given folders.
#   -Migrate : copies the user's settings from the old folder into
#              %APPDATA%\SheetsToOBS (run as the signed-in user, not as admin).
#              If settings already exist there, the old ones go into
#              %APPDATA%\SheetsToOBS\from-old-install instead, so nothing is overwritten.
#
# Exit code 0 = done (or nothing to do). Anything else = the installer keeps the old
# folder, so no settings are ever lost.
param(
    [switch]$Stop,
    [switch]$Migrate,
    [string]$OldDir = '',
    [string]$NewDir = ''
)

$ErrorActionPreference = 'Stop'

function Normalize([string]$dir) {
    if (-not $dir) { return '' }
    return ([IO.Path]::GetFullPath($dir)).TrimEnd('\') + '\'
}

try {
    if ($Stop) {
        $folders = @((Normalize $OldDir), (Normalize $NewDir)) | Where-Object { $_ }
        Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='SheetsToOBS.exe'" |
            Where-Object {
                $exe = $_.ExecutablePath
                $exe -and ($folders | Where-Object { $exe.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        exit 0
    }

    if ($Migrate) {
        if (-not $OldDir -or -not (Test-Path -LiteralPath $OldDir)) { exit 0 }
        $oldConfig = Join-Path $OldDir 'config.json'
        if (-not (Test-Path -LiteralPath $oldConfig)) { exit 0 }   # no settings kept in the old folder

        $data = Join-Path $env:APPDATA 'SheetsToOBS'
        $target = $data
        if (Test-Path -LiteralPath (Join-Path $data 'config.json')) {
            # Never overwrite settings that are already in the new place.
            $target = Join-Path $data 'from-old-install'
        }
        New-Item -ItemType Directory -Force -Path $target | Out-Null

        foreach ($name in 'config.json', 'config.json.bak', 'window-state.json') {
            $src = Join-Path $OldDir $name
            if (Test-Path -LiteralPath $src) {
                Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force
            }
        }
        foreach ($name in 'logs', 'scene-collections', 'media', 'publish') {
            $src = Join-Path $OldDir $name
            if (Test-Path -LiteralPath $src) {
                $dest = Join-Path $target $name
                New-Item -ItemType Directory -Force -Path $dest | Out-Null
                Get-ChildItem -LiteralPath $src -Force | Copy-Item -Destination $dest -Recurse -Force
            }
        }

        # Only report success when the settings file really arrived intact.
        $copied = Join-Path $target 'config.json'
        if (-not (Test-Path -LiteralPath $copied)) { exit 2 }
        if ((Get-FileHash -LiteralPath $oldConfig).Hash -ne (Get-FileHash -LiteralPath $copied).Hash) { exit 3 }
        exit 0
    }

    exit 0
} catch {
    exit 1
}
