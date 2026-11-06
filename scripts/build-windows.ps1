$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $Root "build-windows.log"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE"
  }
}

Start-Transcript -Path $LogFile -Force | Out-Null
try {
  Set-Location $Root
  Write-Host "=================================================="
  Write-Host "Data Relay Windows x64 offline package builder"
  Write-Host "=================================================="

  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js 22.14.0 x64 first."
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js 22.14.0 x64 first."
  }

  $BuildPlatform = (& node.exe -p "process.platform").Trim()
  $BuildArch = (& node.exe -p "process.arch").Trim()
  $BuildNode = (& node.exe -p "process.version").Trim()
  if ($BuildPlatform -ne "win32") { throw "This builder must run on Windows. Current platform: $BuildPlatform" }
  if ($BuildArch -ne "x64") { throw "Use Node.js x64. Current architecture: $BuildArch" }
  if ($BuildNode -ne "v22.14.0") { throw "The verified runtime is Node.js v22.14.0 x64. Current version: $BuildNode" }

  $SourceFiles = @(
    "src\index.js",
    "src\storage\database.js",
    "src\kh\client.js",
    "src\kh\worker.js",
    "src\protocol\framer.js",
    "src\protocol\parser.js",
    "src\tcp\server.js",
    "src\license\manager.js",
    "src\license\no-license-manager.js",
    "src\license\policy-entry.js",
    "tools\tcp-batch-simulator.js",
    "scripts\build-backend-bytecode.mjs",
    "scripts\build-license-bytecode.mjs",
    "scripts\build-offline-package.mjs",
    "scripts\windows-service-assets.mjs",
    "vendor\winsw\WinSW-x64.exe",
    "vendor\winsw\LICENSE.txt",
    "packaging\build-variants.json",
    "package.json",
    "package-lock.json"
  )
  $MissingSourceFiles = @($SourceFiles | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
  if ($MissingSourceFiles.Count -gt 0) {
    throw "The Windows build source is incomplete. Missing: $($MissingSourceFiles -join ', '). Copy/extract the complete Windows build source package and try again."
  }

  Write-Host "[1/5] Installing locked dependencies..."
  Write-Host "If this is the first build, downloading packages may take several minutes."
  Invoke-Native npm.cmd ci --no-audit --no-fund

  Write-Host "[2/5] Running automated tests..."
  Invoke-Native npm.cmd test

  Write-Host "[3/5] Building source and JSC offline packages..."
  Invoke-Native npm.cmd run package:offline

  $PackageName = (& node.exe -p "require('./package.json').name").Trim()
  $PackageVersion = (& node.exe -p "require('./package.json').version").Trim()
  $BuildConfig = Get-Content (Join-Path $Root "packaging\build-variants.json") -Raw | ConvertFrom-Json
  $Variants = @($BuildConfig.variants)
  if ($Variants.Count -ne 2) { throw "build-variants.json must contain the source and jsc variants." }
  if ($BuildConfig.PSObject.Properties.Name -notcontains "licenseRequired" -or $BuildConfig.licenseRequired -isnot [bool]) {
    throw "build-variants.json licenseRequired must be boolean true or false."
  }
  $LicenseMode = if ($BuildConfig.licenseRequired) { "licensed" } else { "unlicensed" }

  Write-Host "[4/5] Checking both package structures..."
  $BuildResults = @()
  foreach ($Variant in $Variants) {
    $VariantId = [string]$Variant.id
    $Backend = [string]$Variant.backend
    $OutputDir = Join-Path $Root "releases\$PackageName-$PackageVersion-win32-x64-$LicenseMode-$VariantId"
    $ZipFile = Join-Path $Root "releases\$PackageName-$PackageVersion-win32-x64-$LicenseMode-$VariantId.zip"

    foreach ($Relative in @("runtime\node.exe", "VERSION.json", "SHA256SUMS.txt", "start.cmd", "restart.cmd", "simulate-tcp.cmd", "simulate-udp.cmd", "simulate-tcp-udp.cmd", "collect-diagnostics.cmd", ".env")) {
      if (-not (Test-Path (Join-Path $OutputDir $Relative))) { throw "$VariantId package is missing $Relative" }
    }
    foreach ($Relative in @('DataRelayService.exe', 'DataRelayService.xml', 'windows-service.ps1', 'install-service.cmd', 'uninstall-service.cmd', 'WINSW-LICENSE.txt')) {
      if (-not (Test-Path (Join-Path $OutputDir $Relative))) { throw "$VariantId service asset is missing: $Relative" }
    }
    foreach ($Forbidden in @("src\license\manager.js", "src\license\codec.js", "src\license\machine.js", "src\license\no-license-manager.js", "src\license\policy-entry.js", "internal-tools")) {
      if (Test-Path (Join-Path $OutputDir $Forbidden)) { throw "Protected source leaked into $VariantId package: $Forbidden" }
    }

    if ($Backend -eq "source") {
      foreach ($Relative in @("src\index.js", "src\license\license-core.jsc", "src\license\runtime.js")) {
        if (-not (Test-Path (Join-Path $OutputDir $Relative))) { throw "Source package is missing $Relative" }
      }
    } elseif ($Backend -eq "jsc") {
      foreach ($Relative in @("src\app.jsc", "src\index.cjs", "tools\tcp-device-fleet.jsc", "tools\tcp-device-fleet.cjs", "tools\tcp-simulator.jsc", "tools\tcp-simulator.cjs", "tools\tcp-batch-simulator.jsc", "tools\tcp-batch-simulator.cjs")) {
        if (-not (Test-Path (Join-Path $OutputDir $Relative))) { throw "JSC package is missing $Relative" }
      }
      $LeakedBackendSource = @(Get-ChildItem (Join-Path $OutputDir "src"), (Join-Path $OutputDir "tools") -Recurse -File | Where-Object { $_.Extension -in @(".js", ".mjs") })
      if ($LeakedBackendSource.Count -gt 0) {
        throw "Backend source leaked into JSC package: $($LeakedBackendSource.FullName -join ', ')"
      }
    } else {
      throw "Unsupported backend variant in build-variants.json: $Backend"
    }

    $VersionInfo = Get-Content (Join-Path $OutputDir "VERSION.json") -Raw | ConvertFrom-Json
    if ($VersionInfo.variant -ne $VariantId -or $VersionInfo.backend -ne $Backend -or $VersionInfo.licenseMode -ne $LicenseMode) {
      throw "$VariantId package VERSION.json does not match its configured variant."
    }
    $BuildResults += [PSCustomObject]@{ Variant = $VariantId; Folder = $OutputDir; Zip = $ZipFile }
  }

  Write-Host "[5/5] Creating both ZIP archives..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($Result in $BuildResults) {
    if (Test-Path $Result.Zip) { Remove-Item $Result.Zip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $Result.Folder,
      $Result.Zip,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $false
    )
  }

  Write-Host ""
  Write-Host "[SUCCESS] Both Windows offline packages were created:" -ForegroundColor Green
  foreach ($Result in $BuildResults) {
    Write-Host "[$($Result.Variant)] Folder: $($Result.Folder)"
    Write-Host "[$($Result.Variant)] ZIP:    $($Result.Zip)"
  }
  Write-Host "Test both ZIP files on a clean Windows x64 computer before taking them onsite."
  exit 0
} catch {
  Write-Host ""
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Complete log: $LogFile"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
