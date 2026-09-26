# Starts the local relay at logon of the current Windows user, in the desktop session: the browser window of the
# relay needs it (a Windows service runs in session 0, where the window would be invisible). A scheduled task runs
# "pm2 resurrect" from app/, which starts what "pm2 save" recorded.
#   npx pm2 start ecosystem.config.cjs; npx pm2 save; powershell -File scripts\relay-autostart.ps1
# Remove: Unregister-ScheduledTask -TaskName TeamsRelay -Confirm:$false
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pm2 = Join-Path $root 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path $pm2)) { throw "pm2 not found at ${pm2}: run npm ci first" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$pm2' resurrect`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# a short delay lets the desktop and the network come up first
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'TeamsRelay' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'TeamsRelay local: pm2 resurrect at logon' -Force | Out-Null
Write-Output "Scheduled task TeamsRelay registered: pm2 resurrect at logon of $env:USERNAME"
