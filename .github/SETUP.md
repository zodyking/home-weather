# GitHub & HACS Setup Guide

## Initial GitHub Setup

1. **Repository already exists:** `https://github.com/zodyking/home-weather.git`

2. **Initialize and push to GitHub:**
   ```bash
   cd /Users/zodyking/Desktop/Home-Weather
   git init
   git add .
   git commit -m "Initial commit: Home Weather integration"
   git branch -M main
   git remote add origin https://github.com/zodyking/home-weather.git
   git push -u origin main
   ```

3. **Create your first release:**
   - Go to GitHub → Releases → Create a new release
   - Tag: `v1.0.0`
   - Title: `v1.0.0`
   - Description: Copy from `.github/RELEASE_TEMPLATE.md` and fill in details
   - Publish release

## HACS Submission (Optional)

Once your repository is set up and has at least one release:

1. **Verify HACS requirements:**
   - ✅ Repository is public
   - ✅ Has at least one release
   - ✅ Has `hacs.json` file
   - ✅ Has `info.md` file
   - ✅ Integration is in `custom_components/<domain>/` structure
   - ✅ Has proper `manifest.json`

2. **Submit to HACS (if desired):**
   - Go to [HACS Default repository](https://github.com/hacs/default)
   - Open an issue requesting to add your integration
   - Provide your repository URL
   - Wait for approval

## Repository Structure

Your repository should have this structure:
```
home-weather/
├── .github/
│   ├── workflows/
│   │   └── validate.yml
│   └── RELEASE_TEMPLATE.md
├── custom_components/
│   └── home_weather/
│       ├── __init__.py
│       ├── manifest.json
│       ├── const.py
│       ├── storage.py
│       ├── coordinator.py
│       ├── automation.py
│       ├── services.py
│       └── www/
│           └── weather-panel.js
├── hacs.json
├── info.md
├── LICENSE
├── README.md
└── .gitignore
```

## Updating the Integration

1. Make your changes
2. Update version in `custom_components/home_weather/manifest.json`
3. Commit and push:
   ```bash
   git add .
   git commit -m "Description of changes"
   git push
   ```
4. Create a new release with the new version tag (e.g., `v1.0.1`)

## Notes

- HACS will automatically detect new releases
- Users can install via HACS custom repository or manually
- The `hacs.json` file tells HACS this is an integration
- The `info.md` file is displayed in HACS when users browse the integration
