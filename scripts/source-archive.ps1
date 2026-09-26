$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$extensionRoot = Join-Path $sourceRoot 'vscode-extension'
$extensionPackage = Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($extensionPackage.version -ne $package.version) { throw 'Application and companion extension versions must match' }
$releaseRoot = Join-Path $sourceRoot "release/.staging/$($package.version)"
[System.IO.Directory]::CreateDirectory($releaseRoot) | Out-Null
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "Model-Roundtable-$($package.version)-source.zip"))
if (-not $archivePath.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid source archive target' }
$sourceList = & node (Join-Path $PSScriptRoot 'source-files.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source file allowlist validation failed' }
$sourceFiles = ConvertFrom-Json -InputObject ($sourceList -join [Environment]::NewLine)
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($name in $sourceFiles) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $sourceRoot $name), $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
  }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output "Source archive: $archivePath ($count files)"
