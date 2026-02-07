# Release Process

## Version Bump (Required Before Each Push)

Bump version by **+0.0.1** (patch) before every push to GitHub.

### Files to Update

- `custom_components/home_weather/manifest.json`
  - `"version": "X.Y.Z"` → increment patch (Z)
  - `weather-panel.js?v=X.Y.Z"` → same version (cache busting)

### Steps

1. Edit `manifest.json`: change `1.2.1` → `1.2.2` (or next patch)
2. Update both places: `version` and `?v=` in the js URL
3. Commit and push

### Quick Bump (PowerShell)

```powershell
# From project root
$m = "custom_components/home_weather/manifest.json"
$j = Get-Content $m -Raw | ConvertFrom-Json
$v = [version]$j.version
$new = "$($v.Major).$($v.Minor).$($v.Build + 1)"
$j.version = $new
$j.frontend.js[0] = "/local/home_weather/weather-panel.js?v=$new"
$j | ConvertTo-Json -Compress | Set-Content $m
```
