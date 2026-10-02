# The laptop agent's icon in the Windows notification area (by the clock). Windows only.
# src/agent-tray.js starts this and writes one line per change to its standard input:  <state>|<tooltip text>
# where <state> is connecting, connected, offline or refused. When the agent stops, its end of that pipe closes and
# this script removes the icon and exits. "Quit the agent" writes "quit" to standard output, which the agent acts on.
param(
  [Parameter(Mandatory = $true)] [string]$IconPath,
  [string]$LogPath = "",
  [string]$Url = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Native -Name Icons -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle);'

# The app icon with a status dot in the corner. Drawn once per state, so nothing is created while the agent runs.
$dotColours = @{ connecting = "#71717a"; offline = "#71717a"; connected = "#16a34a"; refused = "#dc2626" }
$base = [System.Drawing.Image]::FromFile($IconPath)
$icons = @{}
foreach ($name in $dotColours.Keys) {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($base, 0, 0, 32, 32)
  $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($dotColours[$name]))
  $g.FillEllipse($ring, 14, 14, 18, 18)
  $g.FillEllipse($dot, 16, 16, 14, 14)
  $g.Dispose()
  $handle = $bitmap.GetHicon()
  $bitmap.Dispose()
  $icons[$name] = @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}
$base.Dispose()

$context = New-Object System.Windows.Forms.ApplicationContext
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons["connecting"].Icon
$tray.Text = "Rental Watch agent"
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Rental Watch agent")
$statusItem.Enabled = $false
$null = $menu.Items.Add("-")
if ($Url) {
  $openApp = $menu.Items.Add("Open Rental Watch")
  $openApp.add_Click({ Start-Process $Url })
}
if ($LogPath) {
  $openLog = $menu.Items.Add("Open the agent log")
  $openLog.add_Click({ if (Test-Path -LiteralPath $LogPath) { Start-Process notepad.exe -ArgumentList "`"$LogPath`"" } })
}
$quit = $menu.Items.Add("Quit the agent")
$quit.add_Click({
  [Console]::Out.WriteLine("quit")
  [Console]::Out.Flush()
  $context.ExitThread()
})
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

# Everything the timer changes lives in this one table, so the handler and the rest of the script see the same values.
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput())
$shared = @{ Pending = $stdin.ReadLineAsync() }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.add_Tick({
  try {
    while ($shared.Pending.IsCompleted) {
      if ($shared.Pending.IsFaulted) { $context.ExitThread(); return }
      $line = $shared.Pending.Result
      if ($null -eq $line) { $context.ExitThread(); return }
      $state, $text = $line -split "\|", 2
      if ($icons.ContainsKey($state)) {
        $tray.Icon = $icons[$state].Icon
        # A notification-area tooltip holds at most 63 characters; the menu has room for all of it.
        $tray.Text = if ($text.Length -gt 63) { $text.Substring(0, 63) } else { $text }
        $statusItem.Text = $text
      }
      $shared.Pending = $stdin.ReadLineAsync()
    }
  } catch {
    # A bad line must not stop the icon from updating on the next one.
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($context)

$timer.Stop()
$tray.Visible = $false
$tray.Dispose()
foreach ($i in $icons.Values) { $null = [Native.Icons]::DestroyIcon($i.Handle) }
