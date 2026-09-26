param([Parameter(Mandatory=$true)][string]$Url, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutputPath -TimeoutSec 120 -Headers @{ 'User-Agent' = 'model-roundtable-license-collector' }
