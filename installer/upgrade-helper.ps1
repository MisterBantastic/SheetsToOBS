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
# folder, so no settings are ever lost. Errors are written to stderr.
#
# Only plain .NET calls are used (no PowerShell commands such as Copy-Item or
# Get-FileHash): those load modules from PSModulePath, which breaks when Windows
# PowerShell is started from PowerShell 7 and inherits its module folders.
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

function Sha256([string]$file) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($file)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
}

function Copy-Tree([string]$from, [string]$to) {
    [void][IO.Directory]::CreateDirectory($to)
    foreach ($f in [IO.Directory]::GetFiles($from)) {
        [IO.File]::Copy($f, [IO.Path]::Combine($to, [IO.Path]::GetFileName($f)), $true)
    }
    foreach ($d in [IO.Directory]::GetDirectories($from)) {
        Copy-Tree $d ([IO.Path]::Combine($to, [IO.Path]::GetFileName($d)))
    }
}

try {
    if ($Stop) {
        $folders = @((Normalize $OldDir), (Normalize $NewDir)) | Where-Object { $_ }
        foreach ($name in 'node', 'SheetsToOBS') {
            foreach ($p in [Diagnostics.Process]::GetProcessesByName($name)) {
                try {
                    $exe = $p.MainModule.FileName
                    foreach ($f in $folders) {
                        if ($exe -and $exe.StartsWith($f, [StringComparison]::OrdinalIgnoreCase)) { $p.Kill(); break }
                    }
                } catch { } # another user's process, or already gone
            }
        }
        exit 0
    }

    if ($Migrate) {
        if (-not $OldDir -or -not [IO.Directory]::Exists($OldDir)) { exit 0 }
        $oldConfig = [IO.Path]::Combine($OldDir, 'config.json')
        if (-not [IO.File]::Exists($oldConfig)) { exit 0 }   # no settings kept in the old folder

        $data = [IO.Path]::Combine([Environment]::GetEnvironmentVariable('APPDATA'), 'SheetsToOBS')
        $target = $data
        if ([IO.File]::Exists([IO.Path]::Combine($data, 'config.json'))) {
            # Never overwrite settings that are already in the new place.
            $target = [IO.Path]::Combine($data, 'from-old-install')
        }
        [void][IO.Directory]::CreateDirectory($target)

        foreach ($name in 'config.json', 'config.json.bak', 'window-state.json') {
            $src = [IO.Path]::Combine($OldDir, $name)
            if ([IO.File]::Exists($src)) { [IO.File]::Copy($src, [IO.Path]::Combine($target, $name), $true) }
        }
        foreach ($name in 'logs', 'scene-collections', 'media', 'publish') {
            $src = [IO.Path]::Combine($OldDir, $name)
            if ([IO.Directory]::Exists($src)) { Copy-Tree $src ([IO.Path]::Combine($target, $name)) }
        }

        # Only report success when the settings file really arrived intact.
        $copied = [IO.Path]::Combine($target, 'config.json')
        if (-not [IO.File]::Exists($copied)) { [Console]::Error.WriteLine("config.json was not copied to $target"); exit 2 }
        if ((Sha256 $oldConfig) -ne (Sha256 $copied)) { [Console]::Error.WriteLine('The copied config.json does not match the original.'); exit 3 }
        exit 0
    }

    exit 0
} catch {
    [Console]::Error.WriteLine("upgrade-helper: $($_.Exception.Message)")
    exit 1
}
