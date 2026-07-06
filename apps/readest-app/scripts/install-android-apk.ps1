# Install an Android APK via adb push (avoids Windows path/escape issues with adb install).
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ApkPath
)

$ErrorActionPreference = "Stop"

$ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$info = Get-Item -LiteralPath $ApkPath

if ($info.Length -lt 1MB) {
    throw "APK is too small ($($info.Length) bytes). File is corrupt or incomplete."
}

$header = Get-Content -LiteralPath $ApkPath -Encoding Byte -TotalCount 2
if ($header[0] -ne 0x50 -or $header[1] -ne 0x4B) {
    throw "Not a valid APK/ZIP file (missing PK header)."
}

$androidHome = $env:ANDROID_HOME
if (-not $androidHome) {
    $androidHome = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
$apksigner = Get-ChildItem (Join-Path $androidHome "build-tools\*\apksigner.bat") -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -Last 1
if ($apksigner) {
    & $apksigner.FullName verify --verbose $ApkPath
}

$remotePath = "/data/local/tmp/readest-install.apk"
Write-Host "Pushing $ApkPath ($([math]::Round($info.Length / 1MB, 1)) MB) -> $remotePath"
adb push $ApkPath $remotePath
if ($LASTEXITCODE -ne 0) {
    throw "adb push failed"
}

adb shell pm install -r $remotePath
if ($LASTEXITCODE -ne 0) {
    throw "pm install failed"
}

adb shell rm -f $remotePath
Write-Host "Installed successfully."