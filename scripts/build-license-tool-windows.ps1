$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $Root "build-license-tool-windows.log"

function Invoke-Native {
  param([Parameter(Mandatory = $true)][string]$Command, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command exited with code $LASTEXITCODE" }
}

Start-Transcript -Path $LogFile -Force | Out-Null
try {
  Set-Location $Root
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw "Install Node.js 22.14.0 x64 first." }
  if ((& node.exe -p "process.platform").Trim() -ne "win32") { throw "This builder must run on Windows." }
  if ((& node.exe -p "process.arch").Trim() -ne "x64") { throw "Use Node.js x64." }
  if ((& node.exe -p "process.version").Trim() -ne "v22.14.0") { throw "Use the verified Node.js v22.14.0 x64 runtime." }

  Write-Host "[1/4] Installing locked dependencies..."
  Invoke-Native npm.cmd ci --no-audit --no-fund
  Write-Host "[2/4] Running tests..."
  Invoke-Native npm.cmd test
  Write-Host "[3/4] Building standalone internal tool..."
  Invoke-Native npm.cmd run package:license-tool

  $Version = (& node.exe -p "require('./package.json').version").Trim()
  $OutputDir = Join-Path $Root "releases\data-relay-license-tool-$Version-win32-x64"
  $ZipFile = Join-Path $Root "releases\data-relay-license-tool-$Version-win32-x64.zip"
  foreach ($Required in @("internal-tools\runtime\node.exe", "internal-tools\start-license-tool.cmd", "internal-tools\initialize-license-keys.cmd", "internal-tools\license-tool-ui\index.html")) {
    if (-not (Test-Path (Join-Path $OutputDir $Required))) { throw "Package is missing $Required" }
  }
  Write-Host "[4/4] Creating ZIP archive..."
  Compress-Archive -Path (Join-Path $OutputDir "*") -DestinationPath $ZipFile -Force
  Write-Host "[SUCCESS] Internal License Tool: $ZipFile" -ForegroundColor Green
  exit 0
} catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Complete log: $LogFile"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
