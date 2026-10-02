# Rental Watch agent as a Windows tray app: one icon near the clock that runs the laptop agent
# (src/agent-main.js), shows whether it is connected, and lets you pause it or open the log.
#
#   Install (desktop + Start menu shortcuts, starts at log-on, replaces the old RentalWatchAgent task):
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-tray.ps1 -Install
#   Remove everything it installed:
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent-tray.ps1 -Uninstall
#   Try it once without installing (the icon appears near the clock):
#     powershell -NoProfile -ExecutionPolicy Bypass -STA -File scripts\agent-tray.ps1
#
# Needs .env in the repo root with AGENT_SERVER_URL and AGENT_TOKEN (see .env.example) and `npm install`.
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
[CmdletBinding()]
param([switch]$Install, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace RentalWatch -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'

$AppName = 'Rental Watch Agent'
$Repo = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $Repo 'agent.log'
$DataDir = Join-Path $env:LOCALAPPDATA 'RentalWatchAgent'
$IconPath = Join-Path $DataDir 'agent.ico'
$MutexName = 'Local\RentalWatchAgentTray'
$OldTask = 'RentalWatchAgent'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName.lnk"
$MenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
$Colors = @{ ok = '#2f9e5f'; wait = '#d99a2b'; off = '#8b9099'; bad = '#cf4b3f' }

# What the tray app is doing. wanted = the user wants the agent running (Pause turns it off); proc = the
# node process; problem = something only the user can fix (no .env, no node, crash loop).
$script:wanted = $false
$script:proc = $null
$script:started = [DateTime]::MinValue
$script:restartAt = [DateTime]::MinValue
$script:quick = 0
$script:problem = $null
$script:cfg = @{}
$script:notice = $null

# ---- icon ---------------------------------------------------------------------------------------------

# A coloured dot with a white house on it, drawn at any size.
function New-AgentBitmap([int]$size, [string]$color) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($color))
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $u = $size / 16.0
    $g.FillEllipse($fill, 0.0, 0.0, $size - 1.0, $size - 1.0)
    $outline = @(@(8, 3), @(13, 7.8), @(11.4, 7.8), @(11.4, 12.8), @(4.6, 12.8), @(4.6, 7.8), @(3, 7.8))
    $points = foreach ($p in $outline) { New-Object System.Drawing.PointF([single]($p[0] * $u), [single]($p[1] * $u)) }
    $g.FillPolygon([System.Drawing.Brushes]::White, [System.Drawing.PointF[]]@($points))
    $g.FillRectangle($fill, [single](7 * $u), [single](9.6 * $u), [single](2 * $u), [single](3.2 * $u))
  } finally {
    $fill.Dispose()
    $g.Dispose()
  }
  return $bmp
}

function New-TrayIcon([string]$color) {
  $px = [Math]::Max(16, [System.Windows.Forms.SystemInformation]::SmallIconSize.Width)
  $bmp = New-AgentBitmap $px $color
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# A .ico for the shortcuts: PNG images inside an ICO container (Windows Vista and later read these).
function Save-AgentIcon([string]$path) {
  $images = @(foreach ($size in 16, 32, 48, 256) {
    $bmp = New-AgentBitmap $size $Colors.ok
    $png = New-Object System.IO.MemoryStream
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [pscustomobject]@{ Size = $size; Bytes = $png.ToArray() }
  })
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($out)
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$img.Bytes.Length); $w.Write([uint32]$offset)
    $offset += $img.Bytes.Length
  }
  foreach ($img in $images) { $w.Write([byte[]]$img.Bytes) }
  $w.Flush()
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path))
  [System.IO.File]::WriteAllBytes($path, $out.ToArray())
}

function Save-Shortcut([string]$path) {
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$PSCommandPath`""
  $lnk.WorkingDirectory = $Repo
  $lnk.IconLocation = "$IconPath,0"
  $lnk.WindowStyle = 7
  $lnk.Description = 'Fetches Daft.ie and Rent.ie pages for Rental Watch from this computer'
  $lnk.Save()
}

function Stop-Matching([string]$exe, [string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name = '$exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# ---- the agent process --------------------------------------------------------------------------------

function Read-EnvFile([string]$path) {
  $vars = @{}
  if (Test-Path -LiteralPath $path) {
    foreach ($line in Get-Content -LiteralPath $path) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $name = $Matches[1]
        $value = $Matches[2]
        if ($value -match '^(["''])(.*)\1$') { $value = $Matches[2] }
        $vars[$name] = $value
      }
    }
  }
  return $vars
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $default = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $default) { return $default }
  return $null
}

# An agent started some other way (npm run agent in a terminal) is adopted rather than doubled up.
function Find-RunningAgent {
  $found = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*agent-main.js*' } | Select-Object -First 1
  if ($found) { return Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue }
  return $null
}

function Start-Agent {
  $script:problem = $null
  $script:cfg = Read-EnvFile (Join-Path $Repo '.env')
  $node = Find-Node
  if (-not $node) {
    $script:problem = 'Node.js was not found. Install it from nodejs.org.'
  } elseif (-not $script:cfg['AGENT_SERVER_URL'] -or -not $script:cfg['AGENT_TOKEN']) {
    $script:problem = 'Add AGENT_SERVER_URL and AGENT_TOKEN to .env (see .env.example).'
  } elseif (-not (Test-Path -LiteralPath (Join-Path $Repo 'node_modules'))) {
    $script:problem = 'Run npm install in the repo folder first.'
  }
  if ($script:problem) {
    $script:wanted = $false
    return
  }
  # agent.log only grows; keep the last run's worth so it never gets large.
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 2MB) {
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '--env-file-if-exists=.env src/agent-main.js'
  $psi.WorkingDirectory = $Repo
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['AGENT_LOG'] = 'agent.log'
  $script:proc = [System.Diagnostics.Process]::Start($psi)
  $script:started = Get-Date
  $script:wanted = $true
}

function Stop-Agent {
  if ($script:proc) {
    try {
      if (-not $script:proc.HasExited) {
        $script:proc.Kill()
        [void]$script:proc.WaitForExit(3000)
      }
    } catch {
      # already gone
    }
  }
  $script:proc = $null
}

# Restarts the agent if it dies (a crash, a node upgrade) but gives up after three quick failures in a row.
function Update-Agent {
  if (-not $script:wanted) { return }
  if ($script:proc -and $script:proc.HasExited) {
    $lived = ((Get-Date) - $script:started).TotalSeconds
    $script:quick = if ($lived -lt 30) { $script:quick + 1 } else { 0 }
    $script:proc = $null
    $script:restartAt = (Get-Date).AddSeconds(5)
    if ($script:quick -ge 3) {
      $script:wanted = $false
      $script:problem = 'The agent keeps stopping. Open the log, or run npm run agent to see why.'
      return
    }
  }
  if (-not $script:proc -and (Get-Date) -ge $script:restartAt) { Start-Agent }
}

# ---- status, from the agent's own log -----------------------------------------------------------------

function Read-LogTail([string]$path) {
  try {
    $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      if ($stream.Length -gt 65536) { [void]$stream.Seek(-65536, [System.IO.SeekOrigin]::End) }
      $text = (New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)).ReadToEnd()
    } finally {
      $stream.Dispose()
    }
    return @($text -split "`r?`n")
  } catch {
    return @()
  }
}

# The newest connection line since the agent started decides the state. A fetched page also proves it is
# connected. Lines from earlier runs (same file) are ignored.
function Get-LogStatus([string[]]$lines, [DateTime]$sinceUtc) {
  $state = $null
  $message = ''
  $lastPage = $null
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -notmatch '^(\d{4}-\d\d-\d\dT\S+Z) (.*)$') { continue }
    $when = [DateTime]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    if ($when -lt $sinceUtc) { break }
    $text = $Matches[2]
    if (-not $lastPage -and $text -match '^\[agent\] \S+ -> (\d{3}|failed)') { $lastPage = $when }
    if (-not $state) {
      if ($text -match 'refused the token') {
        $state = 'token'
      } elseif ($text -match "(lost|can't reach) the server: (.*?)(; retrying.*)?$") {
        $state = 'offline'
        $message = $Matches[2]
      } elseif ($text -match '^\[agent\] connected to ' -or $text -match '^\[agent\] \S+ -> (\d{3}|failed)') {
        $state = 'connected'
      } elseif ($text -match '^\[agent\] starting') {
        $state = 'starting'
      }
    }
    if ($state -and $lastPage) { break }
  }
  return [pscustomobject]@{ State = $state; Message = $message; LastPage = $lastPage }
}

function Format-Ago([DateTime]$whenUtc) {
  $minutes = [int][Math]::Floor(((Get-Date).ToUniversalTime() - $whenUtc).TotalMinutes)
  if ($minutes -lt 1) { return 'just now' }
  if ($minutes -lt 60) { return "$minutes min ago" }
  $hours = [int][Math]::Floor($minutes / 60)
  if ($hours -lt 48) { return "$hours h ago" }
  return "$([int][Math]::Floor($hours / 24)) days ago"
}

# Key picks the icon colour (ok/wait/off/bad); Title is the menu's first line, Detail its second.
function Get-AgentStatus {
  $hostName = ''
  try { $hostName = ([Uri]$script:cfg['AGENT_SERVER_URL']).Host } catch { $hostName = '' }
  if ($script:problem) { return @{ Key = 'bad'; Title = 'Needs attention'; Detail = $script:problem } }
  if (-not $script:wanted) { return @{ Key = 'off'; Title = 'Paused'; Detail = 'Daft and Rent.ie are not being checked' } }
  if (-not $script:proc) { return @{ Key = 'wait'; Title = 'Restarting'; Detail = 'The agent stopped; starting it again' } }
  $log = Get-LogStatus (Read-LogTail $LogPath) $script:proc.StartTime.ToUniversalTime()
  switch ($log.State) {
    'connected' {
      $detail = if ($log.LastPage) { "Last page fetched $(Format-Ago $log.LastPage)" } else { 'Waiting for the next scan' }
      return @{ Key = 'ok'; Title = "Connected to $hostName"; Detail = $detail }
    }
    'offline' { return @{ Key = 'wait'; Title = "Can't reach $hostName"; Detail = "Retrying: $($log.Message)" } }
    'token' { return @{ Key = 'bad'; Title = 'The server refused the token'; Detail = "AGENT_TOKEN in .env must match Railway's" } }
    default {
      # The agent logs "connected" within ~40 s of starting, so silence after that means no log is being kept
      # (an agent started by hand without AGENT_LOG, which this app adopted).
      if (((Get-Date) - $script:started).TotalSeconds -gt 90) {
        return @{ Key = 'wait'; Title = 'Running'; Detail = 'Its log has no status; start it from this app to see one' }
      }
      return @{ Key = 'wait'; Title = 'Starting'; Detail = 'Connecting to the server' }
    }
  }
}

# ---- the tray app -------------------------------------------------------------------------------------

function Start-Tray {
  [void][RentalWatch.Native]::SetProcessDPIAware()
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  $owned = $false
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    [void][System.Windows.Forms.MessageBox]::Show("$AppName is already running. Its icon is near the clock; click the ^ arrow if it is hidden.", $AppName)
    return
  }

  $icons = @{}
  foreach ($key in $Colors.Keys) { $icons[$key] = New-TrayIcon $Colors[$key] }

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $miTitle = $menu.Items.Add('Starting')
  $miTitle.Font = New-Object System.Drawing.Font($miTitle.Font, [System.Drawing.FontStyle]::Bold)
  $miTitle.Enabled = $false
  $miDetail = $menu.Items.Add('')
  $miDetail.Enabled = $false
  [void]$menu.Items.Add('-')
  $miToggle = $menu.Items.Add('Pause agent')
  $miSite = $menu.Items.Add('Open Rental Watch')
  $miLog = $menu.Items.Add('Show log')
  [void]$menu.Items.Add('-')
  $miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('Start when I log in')
  [void]$menu.Items.Add($miAuto)
  $miQuit = $menu.Items.Add('Quit (stops the agent)')

  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.ContextMenuStrip = $menu
  $ni.Icon = $icons['wait']
  $ni.Text = $AppName
  $context = New-Object System.Windows.Forms.ApplicationContext
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 3000
  $shown = @{ Key = ''; Problem = '' }

  $refresh = {
    try {
      Update-Agent
      $s = Get-AgentStatus
      $miTitle.Text = $s.Title
      $miDetail.Text = $s.Detail
      $miToggle.Text = if ($script:wanted) { 'Pause agent' } else { 'Start agent' }
      $miAuto.Checked = Test-Path -LiteralPath $StartupLink
      if ($s.Key -ne $shown.Key) {
        $ni.Icon = $icons[$s.Key]
        if ($s.Key -eq 'bad') { $ni.ShowBalloonTip(8000, $AppName, "$($s.Title). $($s.Detail)", [System.Windows.Forms.ToolTipIcon]::Warning) }
        $shown.Key = $s.Key
      }
      $tip = "Rental Watch agent: $($s.Title)"
      $ni.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length)) # NotifyIcon.Text throws past 63 characters
    } catch {
      # a failed refresh must never take the tray down
    }
  }

  $miToggle.Add_Click({
    if ($script:wanted) {
      $script:wanted = $false
      Stop-Agent
    } else {
      $script:quick = 0
      Start-Agent
    }
    & $refresh
  })
  $miSite.Add_Click({
    $url = $script:cfg['AGENT_SERVER_URL']
    if ($url -match '^https?://') { Start-Process $url }
  })
  $miLog.Add_Click({
    if (Test-Path -LiteralPath $LogPath) { Start-Process notepad.exe -ArgumentList "`"$LogPath`"" }
  })
  $miAuto.Add_Click({
    if (Test-Path -LiteralPath $StartupLink) {
      Remove-Item -LiteralPath $StartupLink -Force
    } else {
      if (-not (Test-Path -LiteralPath $IconPath)) { Save-AgentIcon $IconPath }
      Save-Shortcut $StartupLink
    }
    & $refresh
  })
  $miQuit.Add_Click({
    $script:wanted = $false
    Stop-Agent
    $ni.Visible = $false
    $context.ExitThread()
  })
  $menu.Add_Opening({ & $refresh })
  $ni.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      # NotifyIcon only opens its menu on right-click; a left click should work too.
      try { [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic').Invoke($ni, $null) } catch { }
    }
  })
  $timer.Add_Tick({ & $refresh })

  $existing = Find-RunningAgent
  if ($existing) {
    $script:proc = $existing
    $script:started = $existing.StartTime
    $script:wanted = $true
  } else {
    Start-Agent
  }
  & $refresh
  $ni.Visible = $true
  if (-not $script:problem) {
    $ni.ShowBalloonTip(5000, $AppName, 'Running. It keeps Daft and Rent.ie working while this computer is on. Its icon is near the clock; click the ^ arrow if it is hidden.', [System.Windows.Forms.ToolTipIcon]::Info)
  }
  $timer.Start()
  try {
    [System.Windows.Forms.Application]::Run($context)
  } finally {
    $timer.Stop()
    Stop-Agent
    $ni.Visible = $false
    $ni.Dispose()
    $mutex.ReleaseMutex()
  }
}

# Dot-sourcing (for tests) only loads the functions above.
if ($MyInvocation.InvocationName -eq '.') { return }

if ($Install) {
  Save-AgentIcon $IconPath
  foreach ($link in $DesktopLink, $MenuLink, $StartupLink) { Save-Shortcut $link }
  if (Get-ScheduledTask -TaskName $OldTask -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $OldTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $OldTask -Confirm:$false
    Write-Output "Removed the old '$OldTask' scheduled task; the tray app replaces it."
  }
  Stop-Matching 'powershell.exe' '*agent-tray.ps1*'
  Start-Process -FilePath $MenuLink
  Write-Output "Installed '$AppName': shortcuts on the desktop and Start menu, and it starts when you log in."
  Write-Output 'Its icon is near the clock; click the ^ arrow if it is hidden, and drag it out to keep it visible.'
  exit 0
}
if ($Uninstall) {
  Stop-Matching 'powershell.exe' '*agent-tray.ps1*'
  Stop-Matching 'node.exe' '*agent-main.js*'
  foreach ($link in $DesktopLink, $MenuLink, $StartupLink) { Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "Removed '$AppName' and stopped the agent."
  exit 0
}

Start-Tray
