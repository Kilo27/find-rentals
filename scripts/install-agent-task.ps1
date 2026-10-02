# Starts the laptop agent whenever you log in to Windows, hidden, logging to agent.log in this repo.
# Its icon appears in the notification area by the clock (green = connected; right-click for the menu).
#   Install:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-agent-task.ps1
#   Remove:   Unregister-ScheduledTask -TaskName RentalWatchAgent -Confirm:$false
# Needs .env in the repo root with AGENT_SERVER_URL and AGENT_TOKEN (see .env.example).
$ErrorActionPreference = "Stop"
$taskName = "RentalWatchAgent"
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $repo ".env"))) {
  throw "Create $repo\.env with AGENT_SERVER_URL and AGENT_TOKEN first (see .env.example)."
}
$node = (Get-Command node -ErrorAction Stop).Source

# node shares the hidden PowerShell console, so no window stays open; the agent writes its own log.
$command = "`$env:AGENT_LOG = 'agent.log'; Set-Location -LiteralPath '$repo'; & '$node' --env-file-if-exists=.env src/agent-main.js"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description "Rental Watch: fetches Daft.ie and Rent.ie pages for the server from this computer's connection" | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started '$taskName'. Log: $repo\agent.log"
