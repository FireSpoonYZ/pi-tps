# Changelog

## 1.4.0 (2026-11-22)

- Measure TPS using Pi's native model request duration and the provider's output token count.
- Display request duration alongside total turn time and stall diagnostics.
- Publish the fork as `@firespoon/pi-tps`.

## 1.3.19

- Show the local completion time in the TPS notification after the assistant fully settles.

## 1.3.15

- Pin development SDKs to Pi 1.0.0 while retaining host-owned wildcard peers.
- Exercise actual SDK and bundled host lifecycle, identity, native nested validation/loadouts, reload and shutdown offline.
- Verify persisted telemetry for each actual fake-provider turn.

## 1.3.14

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
