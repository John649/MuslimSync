--!strict
local RunService = game:GetService("RunService")

if RunService:IsRunning() then
	return
end

local Config = require(script.Config)
local Log = require(script.Log)
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
