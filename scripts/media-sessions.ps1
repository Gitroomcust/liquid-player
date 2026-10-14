$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:asTaskGeneric = (([System.WindowsRuntimeSystemExtensions]).GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  if ($null -eq $WinRtTask) { return $null }
  $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
  try {
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    if (-not $netTask.Wait(3000)) { return $null }
    return $netTask.Result
  } catch { return $null }
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$null = Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;

public static class LiquidPlayerInputReader
{
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static readonly AutoResetEvent Signal = new AutoResetEvent(false);
  public static volatile bool Closed;

  public static void Start()
  {
    var thread = new Thread(ReadLines);
    thread.IsBackground = true;
    thread.Start();
  }

  private static void ReadLines()
  {
    try
    {
      string line;
      while ((line = Console.In.ReadLine()) != null)
      {
        Lines.Enqueue(line);
        Signal.Set();
      }
    }
    catch
    {
    }
    finally
    {
      Closed = true;
      Signal.Set();
    }
  }
}
'@
[LiquidPlayerInputReader]::Start()
$script:manager = $null
$thumbnailCache = @{}
$lastSnapshot = ""
$positionAnchors = @{}

while ($true) {
  $commands = New-Object 'System.Collections.Generic.List[string]'
  $commandLine = $null
  while ([LiquidPlayerInputReader]::Lines.TryDequeue([ref]$commandLine)) {
    $commands.Add($commandLine)
    $commandLine = $null
  }
  if ($commands.Count -eq 0 -and [LiquidPlayerInputReader]::Closed) { break }
  $pollOnly = $commands.Count -eq 0
  if ($pollOnly) { $commands.Add("") }

  foreach ($commandLine in $commands) {
  $action = ""
  $target = ""
  $forceOutput = -not $pollOnly
  if ($forceOutput) {
    $parts = $commandLine -split "`t", 2
    if ($parts.Count -gt 0) { $action = $parts[0] }
    if ($parts.Count -gt 1) { $target = $parts[1] }
  }

  $out = @()
  try {
    if ($null -eq $script:manager) {
      $script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    if ($null -ne $script:manager) {
      $sessions = $script:manager.GetSessions()
      $i = 0
      foreach ($session in $sessions) {
        $i++
        $id = $session.SourceAppUserModelId
        if ([string]::IsNullOrEmpty($id)) { $id = "app#$i" }
        if ($action -and ($target -eq "" -or $target -eq $id)) {
          switch ($action) {
            "play"   { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
            "pause"  { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
            "toggle" { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
            "next"   { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
            "prev"   { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
          }
        }

        $properties = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $playback = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $title = if ($properties) { [string]$properties.Title } else { "" }
        $artist = if ($properties) { [string]$properties.Artist } else { "" }
        $album = if ($properties) { [string]$properties.AlbumTitle } else { "" }
        $thumbKey = "$id|$title|$artist"
        if (-not $thumbnailCache.ContainsKey($id) -or $thumbnailCache[$id].key -ne $thumbKey) {
          $thumb = $null
          if ($properties -and $properties.Thumbnail) {
            try {
              $stream = Await ($properties.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
              if ($stream) {
                $size = [int]$stream.Size
                if ($size -gt 0) {
                  $reader = New-Object Windows.Storage.Streams.DataReader($stream)
                  $loaded = Await ($reader.LoadAsync([uint32]$size)) ([uint32])
                  if ($null -ne $loaded) {
                    $bytes = New-Object byte[] $size
                    $reader.ReadBytes($bytes)
                    $thumb = "data:" + $stream.ContentType + ";base64," + [Convert]::ToBase64String($bytes)
                  }
                  $reader.Dispose()
                }
                $stream.Dispose()
              }
            } catch { $thumb = $null }
          }
          $thumbnailCache[$id] = [pscustomobject]@{ key = $thumbKey; thumb = $thumb }
        }
        $thumb = $thumbnailCache[$id].thumb
        $position = [double]$timeline.Position.TotalSeconds
        $status = [string]$playback.PlaybackStatus
        if ($status -eq "Playing") {
          try { $position += ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds } catch {}
        }
        if ($timeline.EndTime.TotalSeconds -gt 0 -and $position -gt $timeline.EndTime.TotalSeconds) {
          $position = [double]$timeline.EndTime.TotalSeconds
        }
        $out += [pscustomobject]@{
          id = $id
          title = $title
          artist = $artist
          album = $album
          status = $status
          position = $position
          duration = [double]$timeline.EndTime.TotalSeconds
          thumb = $thumb
        }
      }
    }
  } catch { $out = @() }

  $now = [DateTimeOffset]::UtcNow
  $comparison = @($out | ForEach-Object {
    [pscustomobject]@{
      id = $_.id
      title = $_.title
      artist = $_.artist
      album = $_.album
      status = $_.status
      duration = $_.duration
      thumbLength = if ($_.thumb) { $_.thumb.Length } else { 0 }
    }
  })
  $snapshot = ConvertTo-Json -InputObject $comparison -Compress -Depth 3
  $positionJumped = $false
  foreach ($session in $out) {
    if ($positionAnchors.ContainsKey($session.id)) {
      $anchor = $positionAnchors[$session.id]
      $expected = [double]$anchor.position
      if ($anchor.status -eq "Playing") { $expected += ($now - $anchor.at).TotalSeconds }
      if ([Math]::Abs(([double]$session.position) - $expected) -gt 2) { $positionJumped = $true; break }
    }
  }
  if ($forceOutput -or $snapshot -ne $lastSnapshot -or $positionJumped) {
    $lastSnapshot = $snapshot
    $positionAnchors = @{}
    foreach ($session in $out) {
      $positionAnchors[$session.id] = [pscustomobject]@{
        position = [double]$session.position
        status = [string]$session.status
        at = $now
      }
    }
    $json = ConvertTo-Json -InputObject $out -Compress -Depth 3
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
  }

  if ([LiquidPlayerInputReader]::Closed -and [LiquidPlayerInputReader]::Lines.IsEmpty) { break }
  if ([LiquidPlayerInputReader]::Lines.IsEmpty) {
    [LiquidPlayerInputReader]::Signal.WaitOne(1000) | Out-Null
  }
}
