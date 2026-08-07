--!strict
local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Util = require(MuslimSync.Util)

local function format(...: any): string
	local args = ""

	for _, arg in { ... } do
		args ..= " " .. Util.stringify(arg)
	end

	return args
end

local Log = {
	Level = {
		Off = 0,
		Error = 1,
		Warn = 2,
		Info = 3,
		Debug = 4,
		Trace = 5,
	},
	__level = 2,
	-- Optional remote sink for Info/Warn/Error entries, set at startup by
	-- the App (injected rather than required here to avoid the
	-- Log -> Http -> Config -> Log require cycle). Fires regardless of the
	-- local display level so the master's plugin.log has the full story
	__reporter = nil :: ((level: string, message: string) -> ())?,
}

local function report(level: string, message: string)
	local reporter = Log.__reporter

	if reporter then
		task.spawn(reporter, level, message)
	end
end

function Log.__setLevel(level: string)
	local num = Log.Level[level]

	if not num then
		Log.error("Invalid log level:", level)
	end

	Log.__level = num
end

function Log.trace(...: any)
	if Log.__level >= Log.Level.Trace then
		print("TRACE:" .. format(...))
	end
end

function Log.debug(...: any)
	if Log.__level >= Log.Level.Debug then
		print("DEBUG:" .. format(...))
	end
end

function Log.info(...: any)
	local message = format(...)
	report("Info", message)

	if Log.__level >= Log.Level.Info then
		print("INFO:" .. message)
	end
end

function Log.warn(...: any)
	local message = format(...)
	report("Warn", message)

	if Log.__level >= Log.Level.Warn then
		warn("WARN:" .. message)
	end
end

function Log.error(...: any)
	local message = format(...)
	report("Error", message)

	if Log.__level >= Log.Level.Error then
		error("ERROR:" .. message, 0)
	end
end

return Log
