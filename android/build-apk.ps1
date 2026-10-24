# 一条命令构建安卓 APK
#
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Release
#
# 依赖的工具链默认放在 D:\AndroidToolchain(jdk / gradle / sdk),
# 换机器时用 -Toolchain 指定, 或者直接装 Android Studio 用 Gradle 自己构建。
param(
    [switch]$Release,
    [string]$Toolchain = 'D:\AndroidToolchain',
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$jdk = Join-Path $Toolchain 'jdk'
$sdk = Join-Path $Toolchain 'sdk'
$gradle = Join-Path $Toolchain 'gradle\bin\gradle.bat'

foreach ($p in @($jdk, $sdk, $gradle)) {
    if (-not (Test-Path $p)) { throw "工具链缺失: $p" }
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GRADLE_USER_HOME = Join-Path $Toolchain 'gradle-home'
$env:PATH = "$jdk\bin;$env:PATH"

# local.properties 里的 sdk.dir 用正斜杠, 免得被当转义字符
Set-Content -Path (Join-Path $here 'local.properties') -Value ("sdk.dir=" + ($sdk -replace '\\', '/')) -Encoding ASCII

$task = 'assembleDebug'
if ($Release) { $task = 'assembleRelease' }

$gradleArgs = @($task, "--project-dir=$here", '--console=plain')
if ($Version -ne '') { $gradleArgs += "-PversionName=$Version" }

Write-Host "==> gradle $task" -ForegroundColor Cyan
& $gradle @gradleArgs
if ($LASTEXITCODE -ne 0) { throw "构建失败 (exit=$LASTEXITCODE)" }

$apkDir = Join-Path $here 'app\build\outputs\apk'
$apks = Get-ChildItem $apkDir -Recurse -Filter *.apk -ErrorAction SilentlyContinue
if (-not $apks) { throw "没有找到 APK, 检查 $apkDir" }

Write-Host "`n==> 产物:" -ForegroundColor Green
$apks | ForEach-Object { Write-Host ("  {0}  ({1} MB)" -f $_.FullName, [math]::Round($_.Length / 1MB, 1)) }
