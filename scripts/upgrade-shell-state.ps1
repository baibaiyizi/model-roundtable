param(
  [Parameter(Mandatory=$true)][ValidateSet('Snapshot','Detach','Verify','Restore')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$BackupRoot,
  [Parameter(Mandatory=$true)][string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($install) -ne $temp -or [IO.Path]::GetFileName($install) -notmatch '^model-roundtable-upgrade-[A-Za-z0-9_-]+$') { throw 'Refusing an installation outside the dedicated temporary directory' }
if ((Test-Path -LiteralPath $install) -and ((Get-Item -LiteralPath $install).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Temporary installation must not be a link' }
$backup = [IO.Path]::GetFullPath($BackupRoot)
$manifest = Join-Path $backup 'shell-state.json'
# electron-builder UUID v5 for the fixed org.modelroundtable.desktop application ID.
$guid = 'e992f9c4-5f53-5074-8b60-f727fe5f1029'
$keys = @("Software\$guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
$reg = Join-Path $env:SystemRoot 'System32\reg.exe'
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '模型圆桌.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) '模型圆桌.lnk')
)
function Export-Key([string]$key, [string]$destination) {
  & $reg export "HKCU\$key" $destination /y /reg:64 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot back up the application registry entry' }
}
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
function Assert-NoOtherApp {
  foreach ($process in @(Get-Process -Name '模型圆桌' -ErrorAction SilentlyContinue)) {
    if (-not $process.Path -or -not $process.Path.StartsWith($install+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Close the normal Model Roundtable application before the isolated installer test' }
  }
}
if ($Mode -eq 'Snapshot') {
  if (Test-Path -LiteralPath $manifest) { throw 'Shell backup already exists; restore it before a new test' }
  Assert-NoOtherApp
  # Never alter machine-wide installations or request elevation.
  foreach ($key in $keys) { if (Test-Path -LiteralPath "Registry::HKEY_LOCAL_MACHINE\$key") { throw 'Machine-wide installation exists; use a clean Windows test account' } }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $registry = @(for ($i=0; $i -lt $keys.Count; $i++) {
    $exists = Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$($keys[$i])"
    $file = Join-Path $backup "registry-$i.reg"
    if ($exists) { Export-Key $keys[$i] $file }
    [pscustomobject]@{key=$keys[$i];existed=$exists;sha256=$(if ($exists) { Hash $file } else { $null })}
  })
  $shell = New-Object -ComObject WScript.Shell
  $links = @(for ($i=0; $i -lt $shortcuts.Count; $i++) {
    $path=$shortcuts[$i]; $exists=Test-Path -LiteralPath $path
    if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup "shortcut-$i.lnk"); $target=$shell.CreateShortcut($path).TargetPath } else { $target=$null }
    [pscustomobject]@{path=$path;existed=$exists;sha256=$(if ($exists) {Hash $path} else {$null});target=$target;targetHash=$(if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {Hash $target} else {$null})}
  })
  [pscustomobject]@{install=$install;registry=$registry;shortcuts=$links} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
  Write-Output '{"snapshot":true}'
  exit
}
$state = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($state.install -ne $install -or ($state.registry.key -join '|') -ne ($keys -join '|') -or ($state.shortcuts.path -join '|') -ne ($shortcuts -join '|')) { throw 'Backup does not belong to this test and application' }
if ($Mode -eq 'Verify') {
  Assert-NoOtherApp
  foreach ($key in $keys) {
    if (Test-Path -LiteralPath "Registry::HKEY_LOCAL_MACHINE\$key") { throw 'Machine-wide installation appeared during the test' }
    $path="Registry::HKEY_CURRENT_USER\$key"
    if (Test-Path -LiteralPath $path) {
      $properties=Get-ItemProperty -LiteralPath $path
      if ($properties.InstallLocation -ne $install -and $properties.UninstallString -notlike ('"'+$install+'\*')) { throw 'Application registration no longer belongs to the temporary test' }
    }
  }
  Write-Output '{"temporaryRegistrationVerified":true}'
  exit
}
if ($Mode -eq 'Detach') {
  Assert-NoOtherApp
  # Verify the entire backup before removing either key. Leaving these keys present
  # would make NSIS uninstall the user's normal installation during the test.
  for ($i=0; $i -lt $keys.Count; $i++) {
    $entry=$state.registry[$i]; $exists=Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$($keys[$i])"
    if ($exists -ne $entry.existed) { throw 'Application registry changed after backup' }
    if ($exists) { $check=Join-Path $backup "check-$i.reg"; Export-Key $keys[$i] $check; if ((Hash $check) -ne $entry.sha256) { throw 'Application registry changed after backup' } }
  }
  foreach ($key in $keys) { if (Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$key") { Remove-Item -LiteralPath "Registry::HKEY_CURRENT_USER\$key" -Recurse } }
  Write-Output '{"detached":true}'
  exit
}
$failures = [Collections.Generic.List[string]]::new()
for ($i=0; $i -lt $keys.Count; $i++) {
  try {
    $entry=$state.registry[$i]; $path="Registry::HKEY_CURRENT_USER\$($keys[$i])"
    if (Test-Path -LiteralPath $path) {
      $check=Join-Path $backup "remaining-$i.reg"; Export-Key $keys[$i] $check
      if ($entry.existed -and (Hash $check) -eq $entry.sha256) { continue }
      $properties=Get-ItemProperty -LiteralPath $path
      $ours=($properties.InstallLocation -eq $install) -or ($properties.UninstallString -like ('"'+$install+'\*'))
      if (-not $ours) { throw 'Application registry changed outside the test; preserved for manual inspection' }
      Remove-Item -LiteralPath $path -Recurse
    }
    if ($entry.existed) {
      $file=Join-Path $backup "registry-$i.reg"
      if ((Hash $file) -ne $entry.sha256) { throw 'Registry backup checksum mismatch' }
      & $reg import $file /reg:64 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Application registry restoration failed' }
      $check=Join-Path $backup "restored-$i.reg"; Export-Key $keys[$i] $check
      if ((Hash $check) -ne $entry.sha256) { throw 'Restored application registry differs' }
    }
  } catch { $failures.Add($_.Exception.Message) }
}
$shell = New-Object -ComObject WScript.Shell
for ($i=0; $i -lt $shortcuts.Count; $i++) {
  try {
    $entry=$state.shortcuts[$i]; $path=$shortcuts[$i]
    if (Test-Path -LiteralPath $path) {
      if ($entry.existed -and (Hash $path) -eq $entry.sha256) { continue }
      if (-not $shell.CreateShortcut($path).TargetPath.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Application shortcut changed outside the test; preserved for manual inspection' }
      Remove-Item -LiteralPath $path
    }
    if ($entry.existed) {
      $file=Join-Path $backup "shortcut-$i.lnk"
      if ((Hash $file) -ne $entry.sha256) { throw 'Shortcut backup checksum mismatch' }
      Copy-Item -LiteralPath $file -Destination $path
      if ((Hash $path) -ne $entry.sha256) { throw 'Restored shortcut differs' }
    }
  } catch { $failures.Add($_.Exception.Message) }
}
foreach ($entry in $state.shortcuts) {
  if ($entry.targetHash -and (-not (Test-Path -LiteralPath $entry.target -PathType Leaf) -or (Hash $entry.target) -ne $entry.targetHash)) { $failures.Add('The normal application executable changed during the test') }
}
if ($failures.Count) { throw ($failures -join '; ') }
Write-Output '{"shellIntegrationRestored":true,"normalApplicationUnchanged":true}'
