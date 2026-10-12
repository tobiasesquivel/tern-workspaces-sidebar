# Plays one audio file and exits. Launched hidden by play.vbs; never run by hand
# from a terminal (it blocks until the file ends).
#
# The script is herdr's Windows player (src/sound.rs, Apache-2.0) with the path
# coming from -Path instead of HERDR_SOUND_PATH. MediaPlayer plays mp3; the
# dispatcher frame keeps PowerShell alive until playback ends, so the process
# tree dies with the sound instead of lingering.
param(
	[Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
$script:player = [System.Windows.Media.MediaPlayer]::new()
$script:frame = [System.Windows.Threading.DispatcherFrame]::new()
$script:timer = [System.Windows.Threading.DispatcherTimer]::new()
$script:timer.Interval = [TimeSpan]::FromSeconds(15)
$script:failed = $null
$script:timedOut = $false
$script:player.add_MediaOpened({ $script:player.Play() })
$script:player.add_MediaEnded({ $script:frame.Continue = $false })
$script:player.add_MediaFailed({
	param($sender, $eventArgs)
	$script:failed = $eventArgs.ErrorException
	$script:frame.Continue = $false
})
$script:timer.add_Tick({
	$script:timedOut = $true
	$script:frame.Continue = $false
})
try {
	$script:player.Open([Uri]::new($resolved))
	$script:timer.Start()
	[System.Windows.Threading.Dispatcher]::PushFrame($script:frame)
} finally {
	$script:timer.Stop()
	$script:player.Close()
}
if ($script:failed) { throw "sound media failed: $($script:failed.Message)" }
if ($script:timedOut) { throw 'sound playback timed out' }
