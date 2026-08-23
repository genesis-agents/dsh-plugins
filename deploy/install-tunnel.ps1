<#
.SYNOPSIS
  Register the tunnel supervisor to start at logon and keep itself running.

.DESCRIPTION
  Run once per Windows machine that wants full access to the harness. Idempotent.

  The task runs the supervisor, and the supervisor runs ssh — two layers,
  because they fail differently. Task Scheduler restarts the supervisor if the
  whole thing dies; the supervisor replaces ssh when the tunnel stops carrying
  traffic without dying. Neither layer covers the other's case.
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'dsh-tunnel',
  [string] $ScriptPath = "$PSScriptRoot\dsh-tunnel.ps1"
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $ScriptPath)) { throw "supervisor not found at $ScriptPath" }

# -WindowStyle Hidden on powershell.exe still flashes a console; -NonInteractive
# with the task's own hidden run keeps it out of the way.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

# ExecutionTimeLimit zero means "never time it out" -- the default is 3 days,
# after which Task Scheduler would kill a perfectly healthy supervisor.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "registered and started: $TaskName"
Write-Host "log: $env:USERPROFILE\.dsh-tunnel.log"
