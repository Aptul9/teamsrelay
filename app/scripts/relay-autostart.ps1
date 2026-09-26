# Starts the local relay at logon of the current Windows user, in the desktop session: the browser window of the
# relay needs it (a Windows service runs in session 0, where the window would be invisible). A scheduled task runs
# "pm2 resurrect" from app/, which starts what "pm2 save" recorded.
#   npx pm2 start ecosystem.config.cjs; npx pm2 save; powershell -File scripts\relay-autostart.ps1
# Remove: Unregister-ScheduledTask -TaskName TeamsRelay -Confirm:$false
# -DryRun prints the task it would register (command, priority) and registers nothing.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pm2 = Join-Path $root 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path -LiteralPath $pm2)) { throw "pm2 not found at ${pm2}: run npm ci first" }
$command = "& '$pm2' resurrect"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# a short delay lets the desktop and the network come up first
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
if ($DryRun) {
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$null, [ref]$errors)
  Write-Output "command: $command"
  Write-Output "parse errors: $($errors.Count)"
  Write-Output "priority: $($settings.Priority)"
  exit 0
}
Register-ScheduledTask -TaskName 'TeamsRelay' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'TeamsRelay local: pm2 resurrect at logon' -Force | Out-Null
Write-Output "Scheduled task TeamsRelay registered: pm2 resurrect at logon of $env:USERNAME"
