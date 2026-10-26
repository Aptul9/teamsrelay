# Starts the local relay at logon of the current Windows user, in the desktop session: the browser window of the
# relay needs it (a Windows service runs in session 0, where the window would be invisible). A scheduled task runs this
# script with -Resurrect from app/, which starts what "pm2 save" recorded.
#   npx pm2 start ecosystem.config.cjs; npx pm2 save; powershell -File scripts\relay-autostart.ps1
# Remove: Unregister-ScheduledTask -TaskName TeamsRelay -Confirm:$false
# -DryRun prints the task it would register (command, priority, triggers) and registers nothing.
#
# The task runs at logon and again when the session is unlocked or an RDP client reconnects: a start at logon that
# died (seen after a Windows Update reboot, task result 0xC000013A, nothing started) is made good the next time someone
# comes back to the session. -Resurrect leaves a relay that pm2 already knows alone, online or stopped on purpose, so
# the extra runs cost nothing.
# Every run writes what it did to state\autostart.log.
param(
  [switch]$DryRun,
  [switch]$Resurrect,
  # -Resurrect: tries of "pm2 resurrect" and the wait after each before the relay is looked for
  [int]$Attempts = 4,
  [int]$WaitSeconds = 20
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pm2 = Join-Path $root 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path -LiteralPath $pm2)) { throw "pm2 not found at ${pm2}: run npm ci first" }

if ($Resurrect) {
  # pm2 writes to stderr on success too: in Windows PowerShell that is an error record, which Stop would make fatal
  $ErrorActionPreference = 'Continue'
  $state = Join-Path $root 'state'
  if (-not (Test-Path -LiteralPath $state)) { New-Item -ItemType Directory -Path $state | Out-Null }
  $logFile = Join-Path $state 'autostart.log'
  # one old generation is enough to read the last few reboots
  if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 256KB) {
    Move-Item -LiteralPath $logFile -Destination "$logFile.old" -Force
  }
  function Write-Log([string]$line) {
    Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $line)
  }
  # the pid pm2 has for the relay: above 0 online, 0 known but stopped or errored, -1 unknown to pm2 (a daemon that
  # resurrect has not filled yet, as after a reboot) or no answer
  function Get-RelayPid {
    $out = (& $pm2 pid teamsrelay 2>$null | Out-String).Trim()
    $relayPid = 0
    if ([int]::TryParse($out, [ref]$relayPid)) { return $relayPid }
    return -1
  }

  $running = Get-RelayPid
  if ($running -gt 0) {
    Write-Log "already online pid=$running"
    exit 0
  }
  # resurrect starts only the apps pm2 does not know: a relay stopped on purpose (pm2 stop, an update) stays stopped
  if ($running -eq 0) {
    Write-Log "known to pm2 but not online, left alone: pm2 start teamsrelay starts it"
    exit 0
  }
  for ($i = 1; $i -le $Attempts; $i++) {
    # its own message lines only: the process table it prints after them is box drawing that the log cannot show
    $out = (& $pm2 resurrect 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '^\[PM2\]' }) -join ' | '
    Write-Log "resurrect attempt=$i exit=$LASTEXITCODE $out"
    Start-Sleep -Seconds $WaitSeconds
    $running = Get-RelayPid
    if ($running -gt 0) {
      Write-Log "online pid=$running"
      exit 0
    }
  }
  Write-Log "not online after $Attempts attempts: pm2 ls and the relay logs in the pm2 home say why"
  exit 1
}

# inside single quotes an apostrophe of the path (a user folder such as O'Brien) is doubled
$command = "& '$($PSCommandPath.Replace("'", "''"))' -Resurrect"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $root
$user = "$env:USERDOMAIN\$env:USERNAME"
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
# a short delay lets the desktop and the network come up first
$logon.Delay = 'PT30S'
$triggers = @($logon)
# unlock (8) and RDP reconnect (3) of this user's session: no cmdlet makes these, the CIM class does
$sessionClass = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskSessionStateChangeTrigger'
foreach ($change in 8, 3) {
  $t = New-CimInstance -CimClass $sessionClass -ClientOnly
  $t.StateChange = $change
  $t.UserId = $user
  $t.Delay = 'PT15S'
  $t.Enabled = $true
  $triggers += $t
}
# priority 5 is normal; a task gets 7, below normal, unless told. A run that failed is tried again by the scheduler.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 5 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
if ($DryRun) {
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$null, [ref]$errors)
  Write-Output "command: $command"
  Write-Output "parse errors: $($errors.Count)"
  Write-Output "priority: $($settings.Priority)"
  Write-Output "triggers: logon, $(($triggers | Select-Object -Skip 1 | ForEach-Object { @{ 8 = 'unlock'; 3 = 'remote connect' }[[int]$_.StateChange] }) -join ', ')"
  Write-Output "restart on failure: $($settings.RestartCount)"
  exit 0
}
Register-ScheduledTask -TaskName 'TeamsRelay' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'TeamsRelay local: pm2 resurrect at logon, unlock and RDP reconnect' -Force | Out-Null
Write-Output "Scheduled task TeamsRelay registered: pm2 resurrect at logon, unlock and RDP reconnect of $env:USERNAME"
