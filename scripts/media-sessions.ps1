# Dumps system media sessions (GSMTC) as JSON. Optional action: -Action play|pause|toggle|next|prev -Target <AppUserModelId>
param([string]$Action = "", [string]$Target = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
Function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = $mgr.GetSessions()
$out = @()
$i = 0
foreach ($s in $sessions) {
  $i++
  $id = $s.SourceAppUserModelId
  if ([string]::IsNullOrEmpty($id)) { $id = "app#$i" }
  if ($Action -ne "" -and ($Target -eq "" -or $Target -eq $id)) {
    switch ($Action) {
      "play"   { Await ($s.TryPlayAsync()) ([bool]) | Out-Null }
      "pause"  { Await ($s.TryPauseAsync()) ([bool]) | Out-Null }
      "toggle" { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
      "next"   { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null }
      "prev"   { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null }
    }
    Start-Sleep -Milliseconds 150
  }
  try {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  } catch { $props = $null }
  $pb = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $pos = [double]$tl.Position.TotalSeconds
  if ([string]$pb.PlaybackStatus -eq "Playing") {
    try { $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds } catch {}
  }
  if ($tl.EndTime.TotalSeconds -gt 0 -and $pos -gt $tl.EndTime.TotalSeconds) { $pos = [double]$tl.EndTime.TotalSeconds }
  $thumb = $null
  if ($props -and $props.Thumbnail) {
    try {
      $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $size = [int]$stream.Size
      if ($size -gt 0) {
        $reader = New-Object Windows.Storage.Streams.DataReader($stream)
        Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        $thumb = "data:" + $stream.ContentType + ";base64," + [Convert]::ToBase64String($bytes)
      }
    } catch { $thumb = $null }
  }
  $out += [pscustomobject]@{
    id       = $id
    title    = if ($props) { $props.Title } else { "" }
    artist   = if ($props) { $props.Artist } else { "" }
    album    = if ($props) { $props.AlbumTitle } else { "" }
    status   = [string]$pb.PlaybackStatus
    position = $pos
    duration = [double]$tl.EndTime.TotalSeconds
    thumb    = $thumb
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
