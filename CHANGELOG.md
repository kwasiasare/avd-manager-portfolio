# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
- Initial public portfolio edition: a sanitized copy of a private AVD operations console codebase, with a fresh history.
- `npm run scan` denylist/GUID scanner and CI workflow (build, lint, test, scan).
- `app/frontend/scripts/render-swa-config.mjs` to substitute the Static Web Apps tenant ID at build time.

### Changed
- All estate-specific names (host pool, workspace, gallery, storage account, Key Vault, VNet, admin username) are now required configuration with no built-in defaults.
- Neutral application theme replaces the original brand palette.
