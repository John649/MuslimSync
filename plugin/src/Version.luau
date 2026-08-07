--!strict
-- MuslimSync's own product version.
--
-- Deliberately separate from `manifest.package.version` (wally.toml), which is
-- pinned to the Argon server's major.minor for the sync compatibility check in
-- Core/init.luau. Bump this one freely; bump that one only when the vendored
-- argon binary changes.

return {
	version = "0.1.0",
	controlProtocol = 1,
}
