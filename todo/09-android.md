# 09 — Android companion

## What to do

A thin client that can start, watch, and approve jobs against a reachable Gateway.

Work:

1. Kotlin app, min SDK documented (recommend 29+).
2. Connection screen: Gateway URL + token + Tailscale hint.
3. Native job list and approval sheet (biometric optional).
4. WebView for chat and HTML artifacts.
5. FCM (or UnifiedPush) for `needs_approval` and `job.done`.
6. No local vault of provider keys on the phone. Token only.

## Definition of done

- [ ] On a physical device or emulator, operator sees live job status from a laptop Gateway (via adb reverse or Tailscale).
- [ ] Approval of a pending git.push from the phone unblocks the laptop job.
- [ ] Provider keys are not in app storage (inspection of shared prefs / files).
- [ ] Mock parity vs `docs/ui/android.html` for the four main screens: connect, chat, jobs, approve.
- [ ] Rotation and back-stack do not duplicate WS sessions.
