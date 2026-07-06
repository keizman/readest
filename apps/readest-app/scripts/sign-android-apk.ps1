# Sign an unsigned Android APK with the default debug keystore for local adb install.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InputApk,
    [Parameter(Position = 1)]
    [string]$OutputApk
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InputApk)) {
    throw "Input APK not found: $InputApk"
}

$inputInfo = Get-Item $InputApk
if ($inputInfo.Length -lt 1MB) {
    throw "Input APK is too small ($($inputInfo.Length) bytes). File is likely corrupt."
}

$header = Get-Content -Path $InputApk -Encoding Byte -TotalCount 2
if ($header[0] -ne 0x50 -or $header[1] -ne 0x4B) {
    throw "Input file is not a ZIP/APK (missing PK header). Do not rename unsigned.apk manually."
}

if (-not $OutputApk) {
    if ($InputApk -like "*-unsigned.apk") {
        $OutputApk = $InputApk -replace "-unsigned\.apk$", ".apk"
    } else {
        $OutputApk = [System.IO.Path]::ChangeExtension($InputApk, ".signed.apk")
    }
}

$androidHome = $env:ANDROID_HOME
if (-not $androidHome) {
    $androidHome = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
if (-not (Test-Path $androidHome)) {
    throw "Android SDK not found. Set ANDROID_HOME."
}

$apksigner = Get-ChildItem (Join-Path $androidHome "build-tools\*\apksigner.bat") |
    Sort-Object FullName |
    Select-Object -Last 1
if (-not $apksigner) {
    throw "apksigner.bat not found under $androidHome\build-tools"
}

$debugKeystore = $env:DEBUG_KEYSTORE
if (-not $debugKeystore) {
    $debugKeystore = Join-Path $env:USERPROFILE ".android\debug.keystore"
}
if (-not (Test-Path $debugKeystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $debugKeystore) | Out-Null
    keytool -genkeypair -v `
        -keystore $debugKeystore `
        -alias androiddebugkey `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass android -keypass android `
        -dname "CN=Android Debug,O=Android,C=US"
}

if (Test-Path $OutputApk) {
    Remove-Item $OutputApk -Force
}

& $apksigner.FullName sign `
    --ks $debugKeystore `
    --ks-pass pass:android `
    --ks-key-alias androiddebugkey `
    --key-pass pass:android `
    --out $OutputApk `
    $InputApk

& $apksigner.FullName verify --verbose $OutputApk | Out-Host

$outputInfo = Get-Item $OutputApk
if ($outputInfo.Length -lt 1MB) {
    throw "Signed APK is too small ($($outputInfo.Length) bytes). Signing failed."
}

Write-Host "Signed APK: $OutputApk ($([math]::Round($outputInfo.Length / 1MB, 1)) MB)"