# 07 — Electron app for macOS

## What to do

Ship a desktop wrapper that feels like a Mac app, not a browser tab.

Work:

1. Electron shell loads the shared UI from the local Gateway.
2. If Gateway is down, offer "Start local Gateway" and spawn the binary.
3. Native menu: New job, Settings, Vault, Open workspace in Finder.
4. Keychain vault driver (stream 10 can land together).
5. File drop from Finder.
6. HTML artifacts open in a BrowserWindow or default browser.
7. Notarization plan documented (even if certificates come later).

## Definition of done

- [ ] Double-click app on a clean Mac user account reaches chat after first-run init.
- [ ] Closing the window does not kill the Gateway unless the operator chose "Quit Hivekit and Gateway".
- [ ] Key pasted in Settings does not appear in `~/Library/Logs`.
- [ ] Mock parity: screenshot vs `docs/ui/electron-macos.html`.
- [ ] Apple Silicon build artifact documented (arm64).
