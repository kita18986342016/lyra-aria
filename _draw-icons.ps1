Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$dir = 'D:\MusicPlayer\assets\thumb'
$W = [System.Drawing.Brushes]::White

function New-Clean32 {
  $b = New-Object System.Drawing.Bitmap(32, 32)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($b, $g)
}

function Save-Icon($path, $b, $g) {
  $g.Dispose()
  $b.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

# prev: left bar + left arrow
$r = New-Clean32
$r[1].FillRectangle($W, 5, 8, 4, 16)
$r[1].FillPolygon($W, [System.Drawing.Point[]]@([System.Drawing.Point]::new(28,8), [System.Drawing.Point]::new(10,16), [System.Drawing.Point]::new(28,24)))
Save-Icon "$dir\prev.png" $r[0] $r[1]

# next: right arrow + right bar
$r = New-Clean32
$r[1].FillRectangle($W, 23, 8, 4, 16)
$r[1].FillPolygon($W, [System.Drawing.Point[]]@([System.Drawing.Point]::new(4,8), [System.Drawing.Point]::new(22,16), [System.Drawing.Point]::new(4,24)))
Save-Icon "$dir\next.png" $r[0] $r[1]

# play: right triangle
$r = New-Clean32
$r[1].FillPolygon($W, [System.Drawing.Point[]]@([System.Drawing.Point]::new(8,6), [System.Drawing.Point]::new(28,16), [System.Drawing.Point]::new(8,26)))
Save-Icon "$dir\play.png" $r[0] $r[1]

# pause: two bars
$r = New-Clean32
$r[1].FillRectangle($W, 9, 6, 5, 20)
$r[1].FillRectangle($W, 18, 6, 5, 20)
Save-Icon "$dir\pause.png" $r[0] $r[1]

Write-Output 'icons saved'
Get-ChildItem $dir | ForEach-Object {
  $b = New-Object System.Drawing.Bitmap($_.FullName)
  $na = 0; $minX = 99; $maxX = -1
  for ($x = 0; $x -lt $b.Width; $x++) { for ($y = 0; $y -lt $b.Height; $y++) { if ($b.GetPixel($x,$y).A -gt 0) { $na++; if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x } } } }
  $b.Dispose()
  Write-Output ("{0}: {1} B | px={2} | x={3}-{4}" -f $_.Name, $_.Length, $na, $minX, $maxX)
}
