param(
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'status',
  [switch]$IfInstalled
)
$ErrorActionPreference = 'Stop'
$BaseDir = $PSScriptRoot
$Wrapper = Join-Path $BaseDir 'DataRelayService.exe'
$ServiceId = 'DataRelay'

function Invoke-Wrapper([string]$Command) {
  & $Wrapper $Command
  if ($LASTEXITCODE -ne 0) { throw "Service wrapper $Command failed: $LASTEXITCODE" }
}

try {
  $Service = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'"
  if (-not $Service -and $IfInstalled) { exit 3 }
  if ($Service) {
    $Expected = '"' + $Wrapper + '"'
    if ($Service.PathName -ne $Expected -and $Service.PathName -ne $Wrapper) {
      throw "DataRelay is registered from another folder: $($Service.PathName). Unregister it from that folder first."
    }
  }
  if ($Action -eq 'status') {
    if ($Service) { $Service | Select-Object Name, State, StartMode, StartName, PathName | Format-List }
    else { Write-Host 'DataRelay service is not registered.' }
    exit 0
  }
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
  if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this command as Administrator.'
  }
  if (-not (Test-Path $Wrapper)) { throw 'DataRelayService.exe missing. Use a complete Windows offline package.' }
  $env:PM2_HOME = Join-Path $BaseDir 'data\pm2'
  $env:DATA_RELAY_NODE = Join-Path $BaseDir 'runtime\node.exe'

  if ($Action -eq 'install') {
    # Migrate only this package's old scheduled task, never another installation.
    $Task = Get-ScheduledTask -TaskName $ServiceId -ErrorAction SilentlyContinue
    if ($Task) {
      $Owned = @($Task.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains((Join-Path $BaseDir 'start.cmd')) })
      if (-not $Owned.Count) { throw 'An unrelated DataRelay scheduled task exists. Remove it explicitly before registering this service.' }
      Stop-ScheduledTask -TaskName $ServiceId -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $ServiceId -Confirm:$false
    }
    if (-not $Service) {
      # Stop only the PM2 instance belonging to this package before switching accounts.
      if (Test-Path (Join-Path $env:PM2_HOME 'pm2.pid')) {
        & $env:DATA_RELAY_NODE (Join-Path $BaseDir 'node_modules\pm2\bin\pm2') kill
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the existing local PM2 instance.' }
      }
      Invoke-Wrapper 'install'
    }
    Set-Service -Name $ServiceId -StartupType Automatic
    Start-Service -Name $ServiceId
    (Get-Service $ServiceId).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
    Write-Host 'DataRelay service registered and started. Automatic startup is enabled.'
  } elseif ($Action -eq 'uninstall') {
    if ($Service) {
      Stop-Service -Name $ServiceId
      (Get-Service $ServiceId).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
      Invoke-Wrapper 'uninstall'
    }
    Write-Host 'DataRelay service unregistered. Application files, data, logs and license were preserved.'
  } else {
    if (-not $Service) { throw 'Service is not registered. Run install-service.cmd first.' }
    switch ($Action) {
      'start' { Start-Service $ServiceId; (Get-Service $ServiceId).WaitForStatus('Running', [TimeSpan]::FromSeconds(60)) }
      'stop' { Stop-Service $ServiceId; (Get-Service $ServiceId).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
      'restart' { Restart-Service $ServiceId; (Get-Service $ServiceId).WaitForStatus('Running', [TimeSpan]::FromSeconds(60)) }
    }
    Get-Service $ServiceId | Format-Table Name, Status
  }
  exit 0
} catch { Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
