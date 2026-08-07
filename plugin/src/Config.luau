local plugin = script:FindFirstAncestorWhichIsA("Plugin")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Util = require(MuslimSync.Util)
local Log = require(MuslimSync.Log)

export type Level = "Place" | "Game" | "Global"
export type Setting =
	"InitialSyncPriority"
	| "Host"
	| "Port"
	| "AutoConnect"
	| "AutoReconnect"
	| "LiveHydrate"
	| "KeepUnknowns"
	| "TwoWaySync"
	| "SyncbackProperties"
	| "OnlyCodeMode"
	| "OpenInEditor"
	| "Https"
	| "DiffLinesLimit"
	| "DisplayPrompts"
	| "ChangesThreshold"
	| "LogLevel"
	| "OverridePackages"
	| "AuthToken"

type Config = {
	__configs: { [Level]: { [Setting]: any } },
	__serverConfig: { [Setting]: any },
	__serverConfigs: { [Level]: { [Setting]: any } },
	__callbacks: { [Setting]: { (value: any) -> () } },
	__client: any,
	load: () -> (),
	setClient: (client: any) -> (),
	applyServerConfig: (
		gameConfig: { [string]: { [string]: any } }?,
		placeConfig: { [string]: { [string]: any } }?
	) -> (),
	get: (self: Config, setting: Setting, level: Level?, exact: boolean?) -> any,
	getDefault: (self: Config, setting: Setting) -> any,
	set: (self: Config, setting: Setting, value: any, level: Level) -> (),
	restoreDefaults: (self: Config, level: Level) -> (),
	onChanged: (self: Config, setting: Setting, callback: (value: any) -> ()) -> () -> (),
}

local DEFAULTS = {
	InitialSyncPriority = "Client",
	Host = "localhost",
	Port = 8000,
	AutoConnect = false,
	AutoReconnect = false,
	LiveHydrate = true,
	KeepUnknowns = false,
	TwoWaySync = true,
	SyncbackProperties = false,
	OnlyCodeMode = true,
	OpenInEditor = false,
	Https = false,
	DiffLinesLimit = 3000,
	DisplayPrompts = "Always",
	ChangesThreshold = 5,
	LogLevel = "Warn",
	OverridePackages = true,
	-- Shared secret from ~/.argon/auth.token - proves requests come from
	-- the plugin, not from game scripts. Never synced to project files
	AuthToken = "",
}

local CONFIGS_ORDERED = { "Place", "Game", "Global" }
local CONFIGS = {
	Place = "ArgonConfigPlace_" .. game.PlaceId,
	Game = "ArgonConfigGame_" .. game.GameId,
	Global = "ArgonConfigGlobal",
}

-- Maps snake_case keys used in *.project.json `gameConfig` / `placeConfig`
-- to the plugin's PascalCase setting names. Host and Port are deliberately
-- absent: connection routing belongs to discovery, not to project config
local SERVER_KEY_MAP = {
	initial_sync_priority = "InitialSyncPriority",
	auto_connect = "AutoConnect",
	auto_reconnect = "AutoReconnect",
	live_hydrate = "LiveHydrate",
	keep_unknowns = "KeepUnknowns",
	two_way_sync = "TwoWaySync",
	syncback_properties = "SyncbackProperties",
	only_code_mode = "OnlyCodeMode",
	open_in_editor = "OpenInEditor",
	https = "Https",
	diff_lines_limit = "DiffLinesLimit",
	display_prompts = "DisplayPrompts",
	changes_threshold = "ChangesThreshold",
	log_level = "LogLevel",
	override_packages = "OverridePackages",
}

-- Reverse of SERVER_KEY_MAP, for writing settings back to the project file
local SETTING_TO_SERVER_KEY = {}
for key, setting in SERVER_KEY_MAP do
	SETTING_TO_SERVER_KEY[setting] = key
end

local Config: Config = {
	__configs = {},
	__serverConfig = {},
	__serverConfigs = { Game = {}, Place = {} },
	__callbacks = {},
	__client = nil,
} :: Config

-- When a client is set, Game and Place level settings are two-way synced
-- with the project file instead of being stored in Studio. Clearing the
-- client (disconnect) also drops the server-provided override layer
function Config.setClient(client)
	Config.__client = client

	if not client then
		Config.applyServerConfig(nil, nil)
	end
end

function Config.load()
	for level, config in CONFIGS do
		config = plugin:GetSetting(config)

		if config and type(config) == "table" then
			Config.__configs[level] = config
		else
			Config.__configs[level] = {}
		end
	end
end

-- Applies project-defined config sent by the MuslimSync server as an in-memory
-- override layer above all other levels. Never persisted to Studio settings
function Config.applyServerConfig(gameConfig, placeConfig)
	local newConfigs: { [Level]: { [Setting]: any } } = { Game = {}, Place = {} }

	local function merge(configs: { [string]: { [string]: any } }?, id: string, level: Level)
		local config = configs and configs[id]

		if not config then
			return
		end

		for key, value in config do
			local setting = SERVER_KEY_MAP[key]

			if not setting then
				Log.warn(`Unknown setting '{key}' in project config, skipping!`)
				continue
			end

			newConfigs[level][setting] = Util.cast(value, type(DEFAULTS[setting]))
		end
	end

	merge(gameConfig, "*", "Game")
	merge(gameConfig, tostring(game.GameId), "Game")
	merge(placeConfig, tostring(game.PlaceId), "Place")

	-- Place overlays Game, so start from a copy of Game rather than an empty
	-- table: the two loops were doing exactly that, one key at a time.
	local newConfig: { [Setting]: any } = table.clone(newConfigs.Game)

	for setting, value in newConfigs.Place do
		newConfig[setting] = value
	end

	local affected: { [Setting]: boolean } = {}

	for setting in Config.__serverConfig do
		affected[setting] = true
	end
	for setting in newConfig do
		affected[setting] = true
	end

	Config.__serverConfig = newConfig
	Config.__serverConfigs = newConfigs

	for setting in affected do
		if Config.__callbacks[setting] then
			for _, callback in Config.__callbacks[setting] do
				callback(Config:get(setting))
			end
		end
	end
end

function Config:get(setting, level, exact)
	local default = DEFAULTS[setting]
	local relevant = not level

	if default == nil then
		Log.error(`Setting '{setting}' does not exist!`)
	end

	if exact then
		local value = self.__configs[level][setting]

		-- Server-provided settings live at Game/Place level too - without
		-- this the settings UI would display stale Studio-stored values
		if value == nil and level ~= "Global" then
			value = self.__serverConfigs[level][setting]
		end

		return value
	end

	if self.__serverConfig[setting] ~= nil then
		return self.__serverConfig[setting]
	end

	if level and level ~= "Global" then
		local index = table.find(CONFIGS_ORDERED, level)

		if not index then
			Log.error(`Config level '{level}' does not exist!`)
		end

		level = CONFIGS_ORDERED[index + 1]
	end

	for _, config in CONFIGS_ORDERED do
		if not relevant then
			if config == level then
				relevant = true
			else
				continue
			end
		end

		local value = self.__configs[config][setting]

		if value ~= nil then
			return value
		end
	end

	return default
end

function Config:getDefault(setting)
	local default = DEFAULTS[setting]

	if default == nil then
		Log.error(`Setting '{setting}' does not exist!`)
	end

	return default
end

function Config:set(setting, value, level)
	local default = DEFAULTS[setting]
	local config = self.__configs[level]

	if default == nil then
		Log.error(`Setting '{setting}' does not exist!`)
	end

	-- Two-way sync: when connected, Game and Place level settings are
	-- written back to the project file instead of Studio's storage.
	-- Settings without a server key (AuthToken, Host, Port) always use
	-- Studio's storage - they are secrets or routing, not project config
	if self.__client and level ~= "Global" and SETTING_TO_SERVER_KEY[setting] then
		value = Util.cast(value, type(default))

		if value == self.__serverConfigs[level][setting] then
			return
		end

		local newValue = if value == default then nil else value
		local id = tostring(if level == "Game" then game.GameId else game.PlaceId)

		self.__serverConfigs[level][setting] = newValue
		self.__serverConfig[setting] = if self.__serverConfigs.Place[setting] ~= nil
			then self.__serverConfigs.Place[setting]
			else self.__serverConfigs.Game[setting]

		self.__client:setConfig(level:lower(), id, SETTING_TO_SERVER_KEY[setting], newValue):catch(function(err)
			Log.warn(`Failed to write setting '{setting}' to project file:`, err)
		end)

		if self.__callbacks[setting] then
			for _, callback in self.__callbacks[setting] do
				callback(self:get(setting))
			end
		end

		return
	end

	if value == config[setting] then
		return
	end

	value = Util.cast(value, type(default))
	config[setting] = if value == default then nil else value

	if self.__callbacks[setting] then
		for _, callback in self.__callbacks[setting] do
			callback(self:get(setting))
		end
	end

	if not next(config) then
		plugin:SetSetting(CONFIGS[level], nil)
	else
		plugin:SetSetting(CONFIGS[level], config)
	end
end

function Config:restoreDefaults(level)
	self.__configs[level] = {}

	-- Also clear server-managed settings from the project file
	if self.__client and level ~= "Global" then
		local id = tostring(if level == "Game" then game.GameId else game.PlaceId)

		for setting in self.__serverConfigs[level] do
			self.__client:setConfig(level:lower(), id, SETTING_TO_SERVER_KEY[setting], nil):catch(function(err)
				Log.warn(`Failed to clear setting '{setting}' in project file:`, err)
			end)
		end

		self.__serverConfigs[level] = {}

		for setting in DEFAULTS do
			self.__serverConfig[setting] = if self.__serverConfigs.Place[setting] ~= nil
				then self.__serverConfigs.Place[setting]
				else self.__serverConfigs.Game[setting]
		end
	end

	for setting in DEFAULTS do
		if self.__callbacks[setting] then
			for _, callback in self.__callbacks[setting] do
				callback(self:get(setting))
			end
		end
	end

	plugin:SetSetting(CONFIGS[level], nil)
end

function Config:onChanged(setting, callback)
	if not self.__callbacks[setting] then
		self.__callbacks[setting] = {}
	end

	local id = Util.generateGUID()
	self.__callbacks[setting][id] = callback

	return function()
		self.__callbacks[setting][id] = nil
	end
end

return Config
