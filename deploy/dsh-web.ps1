<#
.SYNOPSIS
  Run the harness, and put it back when it stops.

.DESCRIPTION
  The supervisor half of the Windows startup. A Scheduled Task would do this
  itself, but registering one needs elevation and this does not — which matters
  more than the tidiness, because a setup step that requires an administrator
  is a setup step most people skip.

  Health is measured by asking the harness a question, not by looking at the
  process. Those are different facts: a Node process can be alive and wedged,
  and the port stays bound while every request hangs. That exact failure cost
  most of an afternoon on this deployment when it happened to an SSH tunnel,
  and the shape of the mistake — supervising liveness instead of service — is
  the same wherever it is made.

.PARAMETER HarnessDir
  Directory holding the harness source checkout.
#>
[CmdletBinding()]
param(
  [string] $HarnessDir   = 'D:\engineering\deepseek-harness',
  [int]    $Port         = 3080,
  [int]    $CheckSeconds = 30,
  [int]    $FailsToRecycle = 3,
  [int]    $ProbeMillis  = 6000,
  [string] $LogPath      = "$env:USERPROFILE\.dsh-web.log"
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string] $Message)
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { }
}

function Start-Harness {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node is not on PATH' }
  $entry = Join-Path $HarnessDir 'apps\cli\src\bin.ts'
  # The port is passed to the harness, not only probed. Without this the
  # supervisor asks one port how a process listening on another is doing, and
  # every answer is "down" -- so it recycles a perfectly healthy harness on a
  # loop. Caught by running it on a spare port, which is also the only way it
  # could have been caught: on the default port the two agree by accident.
  if (Test-Path $entry) {
    $arguments = "--import tsx/esm `"$entry`" web --no-open --port $Port"
    $workdir = $HarnessDir
  } else {
    $dsh = (Get-Command dsh -ErrorAction SilentlyContinue).Source
    if (-not $dsh) { throw "found neither $entry nor a dsh on PATH" }
    $arguments = "`"$dsh`" web --no-open --port $Port"
    $workdir = $env:USERPROFILE
  }
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $workdir -WindowStyle Hidden -PassThru
  Write-Log "started harness pid $($process.Id)"
  return $process
}

function Test-Harness {
  # A raw socket with explicit ceilings, not Invoke-WebRequest: the failure
  # being detected is a HANG, and Invoke-WebRequest's -TimeoutSec did not fire
  # against a socket that accepts and never answers. A watchdog that can hang
  # on the thing it watches is not a watchdog.
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne($ProbeMillis, $false)) { return $false }
    $client.EndConnect($connect)
    $client.SendTimeout = $ProbeMillis
    $client.ReceiveTimeout = $ProbeMillis
    $stream = $client.GetStream()
    $request = [Text.Encoding]::ASCII.GetBytes(
      "GET /swarm-api/stats HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n`r`n")
    $stream.Write($request, 0, $request.Length)
    $stream.Flush()
    $buffer = New-Object byte[] 15
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { return $false }
    return ([Text.Encoding]::ASCII.GetString($buffer, 0, $read)).StartsWith('HTTP/1.1 200')
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Stop-Harness {
  param($Process)
  if ($null -eq $Process) { return }
  try { if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction Stop; Write-Log "killed pid $($Process.Id)" } } catch { }
  Start-Sleep -Seconds 3
}

# Another copy already serving means this one has nothing to do. Starting a
# second would bind-fail in a loop and fill the log with it.
if (Test-Harness) { Write-Log 'already serving; supervisor exiting'; exit 0 }

Write-Log "supervisor starting for port $Port"
$harness = $null
$fails = 0

while ($true) {
  if ($null -eq $harness -or $harness.HasExited) {
    if ($null -ne $harness) { Write-Log 'harness exited' }
    $harness = Start-Harness
    $fails = 0
    # It reads a profile, composes a plugin tree, and opens a database before
    # it listens. Probing during that would recycle a healthy start.
    Start-Sleep -Seconds 25
  }

  if (Test-Harness) {
    if ($fails -gt 0) { Write-Log "healthy again after $fails missed check(s)" }
    $fails = 0
  } else {
    $fails++
    Write-Log "probe failed ($fails/$FailsToRecycle)"
    if ($fails -ge $FailsToRecycle) {
      Write-Log 'recycling a harness that is up but not answering'
      Stop-Harness -Process $harness
      $harness = $null
      $fails = 0
      continue
    }
  }

  Start-Sleep -Seconds $CheckSeconds
}
