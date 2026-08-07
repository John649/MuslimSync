--!strict
local RunService = game:GetService("RunService")

local Log = require(script.Log)

-- Studio clones this plugin into the PlayServer and PlayClient DataModels when
-- a playtest starts. Argon returned immediately in a running DataModel, which
-- was right for a sync tool and wrong for us: the clone is exactly where the
-- playtest agent has to live.
--
-- The clone starts the bridge and nothing else. It has no daemon socket, no UI,
-- and no business syncing files — it answers requests relayed from edit mode.
if RunService:IsRunning() then
	local Playtest = require(script.Control.Playtest)

	if Playtest.isRuntime() then
		Log.__setLevel("Info")
		Playtest.start()
	end

	return
end

local Config = require(script.Config)
local App = require(script.App)
local Control = require(script.Control)

Config.load()
Log.__setLevel(Config:get("LogLevel"))
App.new()

-- The control channel is independent of the sync connection: it dials the
-- MuslimSync daemon on its own port and keeps retrying, so agent commands work
-- whether or not this place is currently syncing.
Control.start()

Config:onChanged("LogLevel", function(level)
	Log.__setLevel(level)
end)
