# Vendored argon

MuslimSync does not build argon; it ships one. The binary is a black box that
owns file <-> DataModel sync, and nothing in this repo compiles Rust.

## Layout

    vendor/argon/darwin-arm64/argon
    vendor/argon/darwin-x64/argon
    vendor/argon/linux-x86_64/argon
    vendor/argon/windows-x86_64/argon.exe

Only the platform you run on needs to be present. `darwin-arm64` is committed.

## Adding another platform

Drop the matching release binary at the path above and `chmod +x` it on
POSIX. `scripts/build-plugin.mjs` and the project-serving daemon both resolve it
through `daemon/argon.js`, so nothing else needs changing.

## Version

The plugin refuses to sync against a mismatched server: `Core/init.luau` compares
major.minor. `plugin/wally.toml`'s version is pinned to the vendored binary's for
that reason — bump them together, or sync stops working with no obvious cause.

Currently vendored: **argon-rbx 2.0.28** (built from the John649/argon fork,
which adds the auth token, `/setConfig` and `/claimPlace` that this plugin uses).
A stock upstream argon will not have those endpoints.
