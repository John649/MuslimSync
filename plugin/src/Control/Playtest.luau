--!strict
-- The bridge between edit mode and a running playtest.
--
-- Studio clones the whole plugin into the PlayServer and PlayClient DataModels
-- when a playtest starts. Those clones cannot reach the daemon — only the
-- edit-mode copy holds the socket — so they talk back through
-- PluginConnectionService instead, and edit mode relays.
--
-- This module runs on both sides. Which side it is on is decided by asking
-- Studio which connection types this DataModel may have, rather than by
-- inferring it from RunService, which reports the same thing for a PlayServer
-- clone and an ordinary running game.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Log = require(MuslimSync.Log)

local REQUEST_TIMEOUT = 15
local EXEC_TIMEOUT = 10
local MAX_OUTPUT = 100

local Playtest = {}

-- Edit side: runtime contexts that have announced themselves.
local contexts: { [string]: { name: string, connection: any, kind: string, at: number } } = {}
local pending: { [string]: { resolved: boolean, value: any } } = {}
local nextRequest = 0

--- Which connection types this DataModel may hold.
local function targets(): (boolean, boolean)
	local edit, test = false, false

	pcall(function()
		local service = game:GetService("PluginConnectionService")
		edit = service:CanHaveConnectionType(Enum.PluginConnectionTargetType.Edit)
		test = service:CanHaveConnectionType(Enum.PluginConnectionTargetType.Test)
	end)

	return edit, test
end

--- True when this copy is a playtest clone rather than the edit-mode plugin.
---
--- A clone may connect *to* Edit; the edit-mode copy may connect to Test. That
--- asymmetry is the only reliable signal — HostDataModelType is missing on some
--- Studio channels and RunService cannot tell a clone from a live game.
function Playtest.isRuntime(): boolean
	local edit, test = targets()

	if edit or test then
		return edit
	end

	-- No connection service at all: fall back to whether we are running.
	return RunService:IsRunning()
end

local function send(connection: any, payload: { [string]: any }): boolean
	local encoded, text = pcall(HttpService.JSONEncode, HttpService, payload)

	if not encoded then
		Log.debug("Playtest: could not encode a frame:", text)
		return false
	end

	local sent = pcall(function()
		connection:SendMessage(text)
	end)

	return sent
end

-- --------------------------------------------------------------- execute

--- Runs source inside the playtest by injecting a temporary script.
---
--- `loadstring` is unavailable here: a plugin clone in a playtest runs with
--- game security, not plugin security, and Studio refuses the call outright.
--- Injecting a real Script is the only way to run arbitrary source in a live
--- game, which is what Ro Sync settled on too.
---
--- The script is destroyed whether it succeeds or fails, so a playtest does not
--- accumulate debris from repeated calls.
function Playtest._execute(source: string): (boolean, string)
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
	runner.Name = "Runner" -- The user's source becomes the body of a function, so `return` works the -- way it does in an eval and the result comes back through the event.
	(runner :: any).Source = table.concat({
		'local done = script.Parent:WaitForChild("Done")',
		"local ok, result = pcall(function()",
		source,
		"end)",
		"done:Fire(ok, if ok then tostring(result) else tostring(result))",
	}, "\n")
	runner.Parent = holder

	local finished = false
	local succeeded = false
	local output = "nil"

	done.Event:Connect(function(ok, result)
		finished = true
		succeeded = ok
		output = tostring(result)
	end)

	holder.Parent = container

	local deadline = os.clock() + EXEC_TIMEOUT

	while not finished and os.clock() < deadline do
		task.wait(0.05)
	end

	holder:Destroy()

	if not finished then
		return false, `execution did not finish within {EXEC_TIMEOUT}s`
	end

	return succeeded, output
end

-- --------------------------------------------------------------- runtime

--- Runs in a PlayServer or PlayClient clone: answers requests from edit mode.
local function startRuntimeAgent()
	local name = if RunService:IsServer() then "server" else "client"

	local function handle(connection: any, raw: string)
		local ok, frame = pcall(HttpService.JSONDecode, HttpService, raw)

		if not ok or type(frame) ~= "table" or frame.kind ~= "muslimsync-playtest" then
			return
		end

		if frame.t ~= "req" then
			return
		end

		local reply: { [string]: any } = { kind = "muslimsync-playtest", t = "res", id = frame.id }

		if frame.op == "exec" then
			local ran, result = Playtest._execute(tostring(frame.source or ""))
			reply.ok = ran
			reply.value = if ran then result else nil
			reply.error = if ran then nil else result
		elseif frame.op == "endtest" then
			-- EndTest is the runtime's own call to make; edit mode has no test
			-- to end. It also requires a result argument.
			local ended, err = pcall(function()
				game:GetService("StudioTestService"):EndTest("stopped by MuslimSync")
			end)

			reply.ok = ended
			reply.error = if ended then nil else tostring(err)
		elseif frame.op == "ping" then
			reply.ok = true
			reply.value = name
		else
			reply.ok = false
			reply.error = `unknown runtime op: {tostring(frame.op)}`
		end

		send(connection, reply)
	end

	local function attach(connection: any)
		-- Announce first, so edit mode knows this context exists before it is
		-- asked for anything.
		send(connection, {
			kind = "muslimsync-playtest",
			t = "hello",
			name = name,
			isServer = RunService:IsServer(),
			placeId = tostring(game.PlaceId),
		})

		-- BindToMessage, not a MessageReceived signal. PluginConnection has no
		-- such event, and assuming one silently broke the whole bridge.
		local bound = pcall(function()
			connection:BindToMessage(function(payload)
				handle(connection, tostring(payload))
			end)
		end)

		if not bound then
			Log.warn("Playtest: could not bind to a connection from edit mode")
		end
	end

	local ok, service = pcall(function()
		return game:GetService("PluginConnectionService")
	end)

	if not ok or not service then
		Log.warn("Playtest: PluginConnectionService is unavailable in this runtime")
		return
	end

	pcall(function()
		for _, connection in service:GetPluginConnectionsOfType(Enum.PluginConnectionTargetType.Edit) do
			attach(connection)
		end
	end)

	service.Connected:Connect(function(connection)
		if connection.Type == Enum.PluginConnectionTargetType.Edit then
			attach(connection)
		end
	end)

	-- Info, not trace: this line is the only evidence the agent is alive inside
	-- a clone, and Output is the only place it can surface.
	Log.info(`Playtest: runtime agent ready as {name}`)
end

-- ------------------------------------------------------------------ edit

--- Runs in edit mode: collects runtime contexts and relays requests to them.
local function startEditCoordinator()
	local function handle(connection: any, raw: string)
		local ok, frame = pcall(HttpService.JSONDecode, HttpService, raw)

		if not ok or type(frame) ~= "table" or frame.kind ~= "muslimsync-playtest" then
			return
		end

		if frame.t == "hello" then
			local name = tostring(frame.name or "runtime")

			-- A second client joins as client:2, client:3 and so on, so a
			-- caller can address one of several PlayClients.
			if contexts[name] and contexts[name].connection ~= connection then
				local index = 2
				while contexts[`{name}:{index}`] do
					index += 1
				end
				name = `{name}:{index}`
			end

			contexts[name] = { name = name, connection = connection, kind = tostring(frame.name), at = os.time() }
			Log.info(`Playtest: runtime context connected: {name}`)
			return
		end

		if frame.t == "res" and frame.id then
			local waiter = pending[tostring(frame.id)]

			if waiter then
				waiter.resolved = true
				waiter.value = frame
			end
		end
	end

	local function attach(connection: any)
		pcall(function()
			connection:BindToMessage(function(payload)
				handle(connection, tostring(payload))
			end)
		end)
	end

	local ok, service = pcall(function()
		return game:GetService("PluginConnectionService")
	end)

	if not ok or not service then
		return
	end

	pcall(function()
		for _, connection in service:GetPluginConnectionsOfType(Enum.PluginConnectionTargetType.Test) do
			attach(connection)
		end
	end)

	service.Connected:Connect(function(connection)
		if connection.Type == Enum.PluginConnectionTargetType.Test then
			attach(connection)
		end
	end)
end

--- The runtime contexts currently reachable, dropping any that have gone.
function Playtest.contexts(): { { name: string, kind: string } }
	local live = {}

	for name, context in contexts do
		if context.connection and context.connection.Connected then
			table.insert(live, { name = name, kind = context.kind })
		else
			contexts[name] = nil
		end
	end

	table.sort(live, function(a, b)
		return a.name < b.name
	end)

	return live
end

--- Sends one request to a named runtime context and waits for its reply.
function Playtest.request(name: string, op: string, payload: { [string]: any }): { [string]: any }
	local context = contexts[name]

	if not context or not context.connection or not context.connection.Connected then
		error({ code = "NOT_FOUND", message = `no runtime context named "{name}"` }, 0)
	end

	nextRequest += 1
	local id = tostring(nextRequest)
	pending[id] = { resolved = false, value = nil }

	local frame: { [string]: any } = { kind = "muslimsync-playtest", t = "req", id = id, op = op }

	for key, value in payload do
		frame[key] = value
	end

	if not send(context.connection, frame) then
		pending[id] = nil
		error({ code = "CONFLICT", message = `could not reach {name}` }, 0)
	end

	local deadline = os.clock() + REQUEST_TIMEOUT

	while not pending[id].resolved do
		if os.clock() > deadline then
			pending[id] = nil
			error({ code = "TIMEOUT", message = `{name} did not answer within {REQUEST_TIMEOUT}s` }, 0)
		end
		task.wait(0.05)
	end

	local reply = pending[id].value
	pending[id] = nil

	return reply
end

function Playtest.maxOutput(): number
	return MAX_OUTPUT
end

--- Starts whichever side this DataModel is.
function Playtest.start()
	if Playtest.isRuntime() then
		startRuntimeAgent()
	else
		startEditCoordinator()
	end
end

return Playtest
