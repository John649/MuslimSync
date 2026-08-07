local ContentProvider = game:GetService("ContentProvider")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Util = require(MuslimSync.Util)
local Log = require(MuslimSync.Log)

local Assets = require(script.Parent.Assets)

local Loader = {}

function Loader.assets(): { string }
	return Util.dictionaryToArray(Assets)
end

function Loader.load()
	local assets = Loader.assets()

	Log.trace(`Loading {#assets} assets..`)

	task.spawn(function()
		ContentProvider:PreloadAsync(assets)
	end)
end

return Loader
