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

Drop the matching binary at the path above and `chmod +x` it on POSIX.
`scripts/build-plugin.mjs` and the project-serving daemon both resolve it
through `daemon/argon.js`, so nothing else needs changing.

**It must be built from the fork.** A stock upstream argon release will not have
the auth token, `/setConfig` or `/claimPlace`, and the failures are confusing
rather than obvious — the plugin connects and then behaves as if the place were
unclaimed. Do not download an official release and drop it in.

From a checkout of the fork:

    cargo build --release --target x86_64-pc-windows-msvc

On Windows that is all it takes. Cross-compiling from macOS does not work out of
the box — `ring` needs a C compiler targeting MSVC, and the Windows SDK headers
are not there. `cargo-xwin` handles it if you want to cross-compile, at the cost
of downloading Microsoft SDK components.

CI avoids the problem entirely by building each target on its own runner. The
fork has a `binaries` workflow for this; run it from the Actions tab and it
produces one artifact per platform, named for where the binary goes:

    windows-x86_64  ->  vendor/argon/windows-x86_64/argon.exe
    darwin-arm64    ->  vendor/argon/darwin-arm64/argon
    darwin-x64      ->  vendor/argon/darwin-x64/argon
    linux-x86_64    ->  vendor/argon/linux-x86_64/argon

Download, unzip into the matching folder, and `chmod +x` on POSIX.

## Version

The plugin refuses to sync against a mismatched server: `Core/init.luau` compares
major.minor. `plugin/wally.toml`'s version is pinned to the vendored binary's for
that reason — bump them together, or sync stops working with no obvious cause.

Currently vendored: **argon-rbx 2.0.28** (built from the John649/argon fork,
which adds the auth token, `/setConfig` and `/claimPlace` that this plugin uses).
A stock upstream argon will not have those endpoints.
