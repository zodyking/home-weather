# Bump Home Weather integration version by +0.0.1 (patch)
$manifestPath = Join-Path $PSScriptRoot "..\custom_components\home_weather\manifest.json"
$content = Get-Content $manifestPath -Raw

if ($content -match '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3] + 1
    $newVersion = "$major.$minor.$patch"
    $content = $content -replace '"version"\s*:\s*"[^"]+"', "`"version`": `"$newVersion`""
    $content = $content -replace 'weather-panel\.js\?v=[^"]+', "weather-panel.js?v=$newVersion"
    Set-Content $manifestPath $content -NoNewline
    Write-Host "Bumped to $newVersion"
} else {
    Write-Error "Could not parse version in manifest.json"
    exit 1
}
