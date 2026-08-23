<#
.SYNOPSIS
  Keeps a working loopback tunnel to the Mac mini open.

.DESCRIPTION
  Not just "restart ssh when it exits" — that version was written first and
  failed twice in one afternoon. An ssh session can lose the far end and keep
  running: the process is alive, the local port is still bound, and every
  request into it hangs. Restart-on-exit never fires, because nothing exited.
  From the browser it looks exactly like the service being down, which is what
  sent us hunting on the wrong machine.

  So the health signal is the thing we actually want — an HTTP answer through
  the tunnel — rather than the liveness of the process carrying it. Miss
  enough checks in a row and the ssh we started is killed and replaced.

  Only OUR ssh is ever killed, tracked by PID. Other ssh sessions on this
  machine (an editor's remote, another tunnel) are none of this script's
  business.

.PARAMETER Target
  user@host of the Mac.

.PARAMETER Port
  Local and remote port; the harness serves 3080 on loopback.
#>
[CmdletBinding()]
param(
  [string] $Target        = 'genesis@100.92.251.1',
  [int]    $Port          = 3080,
  [string] $KeyPath       = "$env:USERPROFILE\.ssh\id_ed25519",
  [int]    $CheckSeconds  = 20,
  [int]    $FailsToRecycle = 3,
  [int]    $FastExitSeconds = 15,
  [int]    $ProbeMillis    = 6000,
  [string] $LogPath       = "$env:USERPROFILE\.dsh-tunnel.log"
)

$ErrorActionPreference = 'Stop'
$probe = "http://127.0.0.1:$Port/swarm-api/stats"

function Write-Log {
  param([string] $Message)
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  # Best-effort: a log that cannot be written must not take the tunnel down.
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { }
}

function Start-Tunnel {
  # ExitOnForwardFailure matters: without it ssh happily connects when the
  # local port is already taken, and we would supervise a session forwarding
  # nothing. ServerAlive gives the kernel-level path its own detection, which
  # catches some stalls faster than the HTTP probe does.
  $sshArgs = @(
    '-N'
    '-o', 'BatchMode=yes'
    '-o', 'ExitOnForwardFailure=yes'
    '-o', 'ServerAliveInterval=15'
    '-o', 'ServerAliveCountMax=3'
    '-o', 'StrictHostKeyChecking=accept-new'
    '-i', $KeyPath
    '-L', "${Port}:127.0.0.1:${Port}"
    $Target
  )
  $process = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
  Write-Log "started ssh pid $($process.Id)"
  return $process
}

function Stop-Tunnel {
  param($Process)
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction Stop
      Write-Log "killed ssh pid $($Process.Id)"
    }
  } catch { }
  # The port is released asynchronously; reconnecting into a still-bound port
  # would trip ExitOnForwardFailure and cost a whole cycle.
  Start-Sleep -Seconds 2
}

function Clear-StalePortOwner {
  <#
    An ssh that exits the moment it starts is almost always ExitOnForwardFailure:
    something else already holds the port. The usual something else is a
    PREVIOUS ssh of ours that lost its far end -- and if it is wedged or suspended
    it will never exit, so restarting ours forever accomplishes nothing. That is a
    real loop this script produced before this function existed: exit, restart,
    exit, restart, with the health counter reset each time so the recycle branch
    was never reached.

    Only ssh.exe is ever reaped. If anything else holds the port -- a local dev
    server, the harness itself running here -- that is a situation for a person,
    not for a supervisor with a kill switch.
  #>
  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -eq 0) { return $false }
  $reaped = $false
  foreach ($owner in $owners) {
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ($proc.ProcessName -ne 'ssh') {
      Write-Log "port $Port held by $($proc.ProcessName) pid $owner -- not ours, leaving it alone"
      continue
    }
    try {
      Stop-Process -Id $owner -Force -ErrorAction Stop
      Write-Log "reaped stale ssh pid $owner holding port $Port"
      $reaped = $true
    } catch {
      Write-Log "could not reap ssh pid ${owner}: $($_.Exception.Message)"
    }
  }
  if (-not $reaped) { return $false }
  Start-Sleep -Seconds 2
  # Killing is not the same as the port being free. A process wedged deeply
  # enough can be marked terminated and still hold its socket, and silently
  # retrying forever against that is the failure this whole function exists to
  # end. Say so instead, so the log names the pid a person has to deal with.
  $still = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($still.Count -gt 0) {
    Write-Log "WARNING port $Port still held after reaping (pid $($still[0].OwningProcess)); manual intervention may be needed"
  }
  return $true
}

function Test-Tunnel {
  <#
    A raw socket rather than Invoke-WebRequest, because the failure being
    detected is a HANG and Invoke-WebRequest cannot be relied on to abort one.
    Against a wedged tunnel -- TCP accepted, nothing ever sent back -- its
    -TimeoutSec did not fire, and the supervisor blocked inside its own health
    check. A watchdog that can hang on the thing it is watching is not a
    watchdog; this was caught the first time the wedge was simulated.

    Every wait here has an explicit ceiling, so the worst case is bounded by
    ProbeMillis rather than by someone else's default.
  #>
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
    # "HTTP/1.1 200" and nothing else counts. A tunnel that answers 502 or
    # closes mid-status is not carrying the harness, whatever it is carrying.
    return ([Text.Encoding]::ASCII.GetString($buffer, 0, $read)).StartsWith('HTTP/1.1 200')
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

Write-Log "supervisor starting: $Target -> 127.0.0.1:$Port"
$ssh = $null
$fails = 0
$fastExits = 0
$startedAt = $null

while ($true) {
  if ($null -eq $ssh -or $ssh.HasExited) {
    if ($null -ne $ssh) {
      $lived = if ($null -eq $startedAt) { 0 } else { ((Get-Date) - $startedAt).TotalSeconds }
      if ($lived -lt $FastExitSeconds) {
        $fastExits++
        Write-Log ('ssh exited after {0:N0}s ({1} fast exit(s) in a row)' -f $lived, $fastExits)
        # Two in a row is the signature of a held port, not of a flaky network.
        if ($fastExits -ge 2) {
          if (-not (Clear-StalePortOwner)) {
            Write-Log 'nothing of ours holds the port; backing off before retrying'
            Start-Sleep -Seconds 30
          }
          $fastExits = 0
        }
      } else {
        Write-Log ('ssh exited after {0:N0}s' -f $lived)
        $fastExits = 0
      }
    }
    $ssh = Start-Tunnel
    $startedAt = Get-Date
    $fails = 0
    Start-Sleep -Seconds 5
  }

  if (Test-Tunnel) {
    if ($fails -gt 0) { Write-Log "healthy again after $fails missed check(s)" }
    $fails = 0
  } else {
    $fails++
    Write-Log "probe failed ($fails/$FailsToRecycle)"
    if ($fails -ge $FailsToRecycle) {
      # This is the case restart-on-exit could never reach: the process is
      # alive and holding the port, and only replacing it helps.
      Write-Log 'recycling a tunnel that is up but not carrying traffic'
      Stop-Tunnel -Process $ssh
      $ssh = $null
      $fails = 0
      continue
    }
  }

  Start-Sleep -Seconds $CheckSeconds
}
