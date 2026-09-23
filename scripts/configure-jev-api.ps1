<#
.SYNOPSIS
Configure a TypeSafe Jev API key without putting it in shell history.

.DESCRIPTION
Prompts for a key using hidden input, verifies it with the authenticated
GET /v1/models endpoint, and stores it in TYPESAFE_API_KEY. User scope persists
for future terminals. Process scope lasts only for the current PowerShell
process; invoke this script with & in that shell rather than a child process.

.EXAMPLE
& ./scripts/configure-jev-api.ps1

.EXAMPLE
& ./scripts/configure-jev-api.ps1 -VerifyOnly
#>
param(
  [ValidateSet('User', 'Process')]
  [string]$Scope = 'User',
  [switch]$VerifyOnly,
  [switch]$SkipVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($VerifyOnly -and $SkipVerify) {
  throw 'Choose either -VerifyOnly or -SkipVerify.'
}

$variableName = 'TYPESAFE_API_KEY'
$key = $null

try {
  if ($VerifyOnly) {
    $key = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::Process)
    if ([string]::IsNullOrWhiteSpace($key)) {
      $key = [Environment]::GetEnvironmentVariable($variableName, [EnvironmentVariableTarget]::User)
    }
    if ([string]::IsNullOrWhiteSpace($key)) {
      throw "$variableName is not configured for this process or Windows user."
    }
  } else {
    $secureKey = Read-Host 'Paste the TypeSafe API key (input is hidden)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
      $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
      $secureKey.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($key)) {
      throw 'No API key was entered.'
    }
    $key = $key.Trim()
  }

  if (-not $SkipVerify) {
    try {
      $result = Invoke-RestMethod -Method Get -Uri 'https://api.typesafe.ai/v1/models' `
        -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    } catch {
      $status = $null
      if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $null -ne $_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
      }
      if ($null -eq $status) {
        throw 'Could not verify the key with TypeSafe. Check connectivity and try again; nothing was saved.'
      }
      throw "TypeSafe rejected the verification request (HTTP $status); nothing was saved."
    }
    if ($result.PSObject.Properties.Name -notcontains 'models') {
      throw 'TypeSafe returned no model list; nothing was saved.'
    }
    $models = @($result.models)
    if ($models.Count -eq 0) {
      throw 'The key authenticated but no models are available to this account; nothing was saved.'
    }
    $modelNames = ($models | ForEach-Object { $_.name }) -join ', '
    Write-Output "TypeSafe access verified. Available models: $modelNames"
  }

  if (-not $VerifyOnly) {
    [Environment]::SetEnvironmentVariable($variableName, $key, [EnvironmentVariableTarget]$Scope)
    [Environment]::SetEnvironmentVariable($variableName, $key, [EnvironmentVariableTarget]::Process)
    Write-Output "$variableName configured for $Scope scope. The key was not printed."
    if ($Scope -eq 'User') {
      Write-Output 'Restart terminals and Codex so new processes inherit the user variable.'
    }
  }
} finally {
  $key = $null
}
