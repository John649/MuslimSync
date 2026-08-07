--!strict
-- Running arbitrary source inside a playtest.
--
-- `loadstring` is unavailable here: a plugin clone in a playtest runs with game
-- security, not plugin security, and Studio refuses the call outright. Injecting
-- a real Script is the only way to run arbitrary source in a live game, which is
-- what Ro Sync settled on too.
--
-- Split out from the bridge because it is the one part of the playtest support
-- that is about Luau rather than about moving frames between two DataModels.

local RunService = game:GetService("RunService")

local EXEC_TIMEOUT = 10

local Exec = {}

--- Runs source inside the playtest by injecting a temporary script.
---
--- `loadstring` is unavailable here: a plugin clone in a playtest runs with
--- game security, not plugin security, and Studio refuses the call outright.
--- Injecting a real Script is the only way to run arbitrary source in a live
--- game, which is what Ro Sync settled on too.
---
--- The script is destroyed whether it succeeds or fails, so a playtest does not
--- accumulate debris from repeated calls.
function Exec.run(source: string): (boolean, string, boolean)
	if source == "" then
		return false, "source is required"
	end

	local isServer = RunService:IsServer()

	local container: Instance
	local class: string

	if isServer then
		container = game:GetService("ServerScriptService")
		class = "Script"
	else
		local player = game:GetService("Players").LocalPlayer

		if not player then
			return false, "no LocalPlayer yet — the client is still joining"
		end

		container = player:WaitForChild("PlayerScripts", 5) or player
		class = "LocalScript"
	end

	local holder = Instance.new("Folder")
	holder.Name = "MuslimSyncExec"

	local done = Instance.new("BindableEvent")
	done.Name = "Done"
	done.Parent = holder

	local runner = Instance.new(class :: any)
	runner.Name = "Runner"

	-- The user's source becomes the body of a function, so `return` works the
	-- way it does in an eval and the result comes back through the event.
	--
	-- A table result is JSON-encoded rather than tostring'd: a check that
	-- returns { player = "x", health = 100 } should arrive as that, not as
	-- "table: 0x033c3ab2bf110f56".
	local body = table.concat({
		'local done = script.Parent:WaitForChild("Done")',
		'local http = game:GetService("HttpService")',
		"local ok, result = pcall(function()",
		source,
		"end)",
		"local encoded, json = false, nil",
		'if ok and type(result) == "table" then',
		"\tencoded, json = pcall(function() return http:JSONEncode(result) end)",
		"end",
		"done:Fire(ok, if encoded then json else tostring(result), encoded)",
	}, "\n");

	(runner :: any).Source = body
	runner.Parent = holder

	local finished = false
	local succeeded = false
	local output = "nil"
	local isJson = false

	done.Event:Connect(function(ok, result, encoded)
		finished = true
		succeeded = ok
		output = tostring(result)
		isJson = encoded == true
	end)

	holder.Parent = container

	local deadline = os.clock() + EXEC_TIMEOUT

	while not finished and os.clock() < deadline do
		task.wait(0.05)
	end

	holder:Destroy()

	if not finished then
		return false, `execution did not finish within {EXEC_TIMEOUT}s`, false
	end

	return succeeded, output, isJson
end
return Exec
