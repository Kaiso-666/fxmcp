# Requires: Firefox Developer Edition (or Nightly / unbranded), Node, and a built extension.
# Installs the built XPI permanently into a Developer Edition profile by sideloading it into
# <profile>\extensions\ and disabling signature enforcement for that profile.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-permanent.ps1 -Verify
#
param(
  [string]$Firefox = "C:\Program Files\Firefox Developer Edition\firefox.exe",
  [string]$ProfileName = "",
  [string]$Bridge = "http://127.0.0.1:8787",
  [switch]$Verify,
  [switch]$WaitForExit,
  [int]$WaitSeconds = 600
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Test-Path $Firefox)) {
  throw "Firefox Developer Edition not found at '$Firefox'. Install it from https://www.mozilla.org/firefox/developer/ or pass -Firefox <path>."
}

# ---------------------------------------------------------------- build ------
Push-Location (Join-Path $root "server")
try {
  & npm.cmd run build 2>&1 | Out-Null
  $version = (Get-Content (Join-Path $root "extension\manifest.json") -Raw | ConvertFrom-Json).version
  $id = (Get-Content (Join-Path $root "extension\manifest.json") -Raw | ConvertFrom-Json).browser_specific_settings.gecko.id
  $zip = Join-Path $root "dist\fxmcp_bridge-$version.zip"
  if (-not (Test-Path $zip)) { throw "build did not produce $zip" }
} finally {
  Pop-Location
}
Write-Host "built   $zip (v$version, id $id)"

# -------------------------------------------------------------- profile ------
$profilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
if (-not $ProfileName) {
  $candidate = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.dev-edition-default" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) { $ProfileName = $candidate.Name }
}
if (-not $ProfileName) {
  $ProfileName = "fxmcp-dev"
  Write-Host "no dev-edition profile yet - creating '$ProfileName'"
}
$profileDir = Join-Path $profilesRoot $ProfileName
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
Write-Host "profile $profileDir"

# ------------------------------------------------------------- sideload ------
$extDir = Join-Path $profileDir "extensions"
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
$target = Join-Path $extDir "$id.xpi"

# Firefox memory-maps the XPI, so it can only be replaced while the browser is closed
$copied = $false
$announced = $false
for ($try = 0; $try -le $WaitSeconds; $try++) {
  try {
    Copy-Item $zip $target -Force -ErrorAction Stop
    $copied = $true
    break
  } catch {
    if (-not $WaitForExit) { throw "cannot replace $target - quit Developer Edition and re-run (or pass -WaitForExit). $($_.Exception.Message)" }
    if (-not $announced) {
      Write-Host "waiting for Developer Edition to close so the XPI can be replaced (up to $WaitSeconds s)..."
      $announced = $true
    }
    Start-Sleep -Seconds 1
  }
}
if (-not $copied) { throw "timed out waiting for Developer Edition to close" }
Write-Host "add-on  $target"

function Test-ProfileInUse($dir) {
  foreach ($name in @("parent.lock", "lock")) {
    $p = Join-Path $dir $name
    if (Test-Path $p) {
      try {
        $fs = [System.IO.File]::Open($p, "Open", "ReadWrite", "None")
        $fs.Close()
      } catch {
        return $true
      }
    }
  }
  return $false
}

# unsigned add-ons stay enabled only when the signature check is off; user.js
# re-applies these on every start and never touches prefs we do not own.
$userJs = Join-Path $profileDir "user.js"
$begin = "// fxmcp:start"
$end = "// fxmcp:end"
$block = @(
  $begin,
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.autoDisableScopes", 0);',
  'user_pref("extensions.enabledScopes", 15);',
  'user_pref("extensions.startupScanScopes", 15);',
  $end
) -join "`r`n"

$existing = ""
if (Test-Path $userJs) { $existing = Get-Content $userJs -Raw }
$pattern = [regex]::Escape($begin) + "(?s).*?" + [regex]::Escape($end)
if ($existing -match $pattern) {
  $existing = [regex]::Replace($existing, $pattern, $block)
} else {
  $existing = ($existing.TrimEnd() + "`r`n`r`n" + $block).TrimStart()
}
Set-Content -Path $userJs -Value $existing -Encoding utf8
Write-Host "prefs   $userJs (xpinstall.signatures.required=false)"

# -------------------------------------------------------------- verify -------
if ($Verify) {
  $health = $null
  try { $health = Invoke-RestMethod "$Bridge/health" -TimeoutSec 2 } catch { }
  if (-not $health) {
    Write-Warning "no bridge on $Bridge - start it first (node server\src\index.js --http) to verify"
  } else {
    # a running Dev Edition holds the profile, so verification must use a copy
    $inUse = Test-ProfileInUse $profileDir
    $verifyDir = $profileDir
    $tempVerify = $false
    if ($inUse) {
      $verifyDir = Join-Path $env:TEMP "fxmcp-verify"
      Remove-Item $verifyDir -Recurse -Force -ErrorAction SilentlyContinue
      & robocopy $profileDir $verifyDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
      foreach ($l in @("lock", "parent.lock", ".parentlock")) {
        Remove-Item (Join-Path $verifyDir $l) -Force -ErrorAction SilentlyContinue
      }
      $tempVerify = $true
      Write-Host "profile is in use by a running Developer Edition - verifying with a temporary copy"
      Write-Host "(restart Developer Edition afterwards so the profile itself picks up the add-on)"
    }

    Write-Host "launching Developer Edition headless to verify..."
    $args = @("-profile", "`"$verifyDir`"", "-no-remote", "-headless")
    $p = Start-Process -FilePath $Firefox -ArgumentList $args -PassThru
    $ok = $false
    for ($i = 0; $i -lt 45; $i++) {
      Start-Sleep -Milliseconds 800
      try {
        $h = Invoke-RestMethod "$Bridge/health" -TimeoutSec 2
        if ($h.connected -eq $true) { $ok = $true; break }
      } catch { }
    }
    & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    foreach ($l in @("lock", "parent.lock", ".parentlock")) {
      Remove-Item (Join-Path $verifyDir $l) -Force -ErrorAction SilentlyContinue
    }
    if ($tempVerify) { Remove-Item $verifyDir -Recurse -Force -ErrorAction SilentlyContinue }

    if ($ok) { Write-Host "verified: the add-on loaded from the profile and connected to the bridge" }
    else { Write-Warning "the add-on did not connect - check about:addons in Developer Edition" }
  }
}

Write-Host ""
Write-Host "done. Start Developer Edition normally:"
Write-Host "  & `"$Firefox`""
if ($ProfileName -eq "fxmcp-dev") { Write-Host "  (first run: that profile is not the default yet, launch with -profile `"$profileDir`")" }
