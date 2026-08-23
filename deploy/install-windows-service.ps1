<#
.SYNOPSIS
  Start the harness at logon on a Windows workstation, and keep it running.

.DESCRIPTION
  Run once per machine. Idempotent — re-running replaces the task.

  A Scheduled Task rather than a Windows Service. A service runs in session 0
  with no user profile, and this harness reads `~/.dsh` and needs the account's
  own environment; a service would come up unable to find its own settings and
  say so in a log nobody opens. A logon task runs as you, sees your profile,
  and restarts on failure, which is what was actually wanted.

  Nothing here is per-machine except the paths, and both are checked before the
  task is registered rather than discovered when it silently fails to start.

.PARAMETER HarnessDir
  Directory holding the harness. Either a source checkout (run with tsx) or
  anywhere `dsh` is on PATH.

.PARAMETER TaskName
  Scheduled Task name.
#>
[CmdletBinding()]
param(
  [string] $HarnessDir = 'D:\engineering\deepseek-harness',
  [string] $TaskName   = 'dsh-web'
)

$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH' }
# Parsed here rather than by handing node a -p expression: PowerShell mangles
# the brackets and quotes in one, node returns nothing, and an empty string
# casts to 0 — so this refused a perfectly good v24.12.0 as too old, which is
# the worst kind of check: one that fails closed while naming the correct
# version in its own error message.
$version = (& $node --version)   # v24.12.0
$major = [int]($version.TrimStart('v').Split('.')[0])
# node:sqlite is used unguarded, so this is a floor rather than a suggestion.
if ($major -lt 24) { throw "node 24+ required, found $version" }

# Two ways to run it, and the check picks whichever this machine actually has.
# Guessing wrong produces a task that registers cleanly and never serves a page.
$entry = Join-Path $HarnessDir 'apps\cli\src\bin.ts'
$dsh = (Get-Command dsh -ErrorAction SilentlyContinue).Source
if (Test-Path $entry) {
  $arguments = "--import tsx/esm `"$entry`" web --no-open"
  $workdir = $HarnessDir
  Write-Host "source checkout: $entry"
} elseif ($dsh) {
  $arguments = "`"$dsh`" web --no-open"
  $workdir = $env:USERPROFILE
  Write-Host "installed dsh: $dsh"
} else {
  throw "found neither $entry nor a dsh on PATH"
}

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $workdir
$trigger = New-ScheduledTaskTrigger -AtLogOn

# ExecutionTimeLimit zero means never time it out. The default is three days,
# after which Task Scheduler kills a perfectly healthy long-running process --
# a failure that arrives once a quarter and looks like nothing in particular.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

# A Scheduled Task is the better mechanism -- Task Scheduler does the
# restarting -- but registering one needs elevation, and a setup step that
# needs an administrator is a setup step most people skip. So it is attempted,
# and the Startup folder is the fallback: same trigger, no elevation, with the
# supervisor doing the restarting instead of the scheduler.
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "registered scheduled task: $TaskName"
  Write-Host "stop it with:    Stop-ScheduledTask -TaskName $TaskName"
  Write-Host "remove it with:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:"
} catch {
  Write-Host "scheduled task refused ($($_.Exception.Message.Trim())); using the Startup folder instead"
  $supervisor = Join-Path $PSScriptRoot 'dsh-web.ps1'
  if (-not (Test-Path $supervisor)) { throw "supervisor not found at $supervisor" }
  $startup = [Environment]::GetFolderPath('Startup')
  $shim = Join-Path $startup 'dsh-web.vbs'
  # A .vbs shim, because a .cmd or a shortcut to powershell.exe flashes a
  # console window at every logon. WScript.Shell Run with 0 starts it hidden.
  #
  # VBScript escapes a quote inside a string literal by DOUBLING it, and a
  # PowerShell double-quoted string collapses "" to one quote while building
  # the line -- so the obvious spelling writes bare quotes into the middle of a
  # VBScript string and produces a file that cannot parse. Built from
  # single-quoted parts here, where nothing is collapsed.
  # Doubling applies INSIDE a literal, not to its delimiters: the
  # CreateObject argument is its own string and takes single quotes, while the
  # paths sit inside the Run argument and take doubled ones. Getting that
  # backwards is what the check below caught on the first try.
  $vbs = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""' +
    $supervisor + '"" -HarnessDir ""' + $HarnessDir + '""", 0, False'
  Set-Content -Path $shim -Value $vbs -Encoding ascii

  # Run it. The installer printed "installed" and exited 0 over a shim that
  # could not parse, which is the same class of lie as an npm install that
  # blocks a native build and calls it a warning. "Written" is not "works".
  $check = (& cscript.exe //nologo $shim 2>&1) -join ' '
  if ($LASTEXITCODE -ne 0) { throw "the startup shim does not run: $check" }

  Write-Host "installed: $shim"
  Write-Host "remove it with:  Remove-Item '$shim'"
  Write-Host "log:             $env:USERPROFILE\.dsh-web.log"
}
