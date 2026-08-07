--!strict
-- Control channel: the MuslimSync-only request/response link to the Node
-- daemon. It is deliberately independent of `Client` (Argon's sync socket) —
-- the two never share state, so a control failure cannot disturb a sync.
--
-- Frames (JSON text, both directions):
--   plugin -> daemon  {"t":"hello", protocol, placeId, gameId, pluginVersion}
--   daemon -> plugin  {"t":"req", id, op, args}
--   plugin -> daemon  {"t":"res", id, ok, value|error}
--   plugin -> daemon  {"t":"event", kind, ...}

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Log = require(MuslimSync.Log)

local Handlers = require(script.Handlers)

local PROTOCOL = 1
local DEFAULT_HOST = "127.0.0.1"
local DEFAULT_PORT = 7900
-- CreateWebStreamClient is asynchronous. Sending while the socket is still
-- Connecting returns without throwing but drops the frame, which would leave
-- an open but forever-unidentified connection.
local OPEN_TIMEOUT = 5
local RECONNECT_DELAY = 3

local Control = {}
Control.__index = Control

export type Control = typeof(setmetatable(
	{} :: {
		host: string,
		port: number,
		stream: any,
		connected: boolean,
		stopped: boolean,
	},
	Control
))

function Control.new(host: string?, port: number?): Control
	return setmetatable({
		host = host or DEFAULT_HOST,
		port = port or DEFAULT_PORT,
		stream = nil,
		connected = false,
		stopped = false,
	}, Control) :: any
end

function Control:url(): string
	return `ws://{self.host}:{self.port}/control`
end

-- Serializes one frame and writes it, swallowing transport errors: a control
-- send must never propagate into whatever op is running.
function Control:send(frame: { [string]: any })
	if not self.stream or not self.connected then
		return
	end

	local ok, encoded = pcall(HttpService.JSONEncode, HttpService, frame)

	if not ok then
		Log.warn("Control: failed to encode frame:", encoded)
		return
	end

	local sent, err = pcall(function()
		self.stream:Send(encoded)
	end)

	if not sent then
		Log.debug("Control: send failed:", err)
	end
end

function Control:respond(id: number, ok: boolean, payload: any)
	if ok then
		self:send({ t = "res", id = id, ok = true, value = payload })
	else
		self:send({ t = "res", id = id, ok = false, error = payload })
	end
end

function Control:onFrame(raw: string)
	local ok, frame = pcall(HttpService.JSONDecode, HttpService, raw)

	if not ok or type(frame) ~= "table" then
		Log.warn("Control: received undecodable frame")
		return
	end

	if frame.t ~= "req" then
		Log.trace("Control: ignoring frame of type", frame.t)
		return
	end

	local id = tonumber(frame.id)

	if not id then
		Log.warn("Control: request without a numeric id")
		return
	end

	local handler = Handlers.get(frame.op)

	if not handler then
		self:respond(id, false, {
			code = "UNKNOWN_OP",
			message = `unknown op: {tostring(frame.op)}`,
			retryable = false,
		})
		return
	end

	-- Each request runs on its own thread so a slow op cannot stall the
	-- socket, and an erroring op returns a structured error rather than
	-- killing the receive loop.
	task.spawn(function()
		local succeeded, result = pcall(handler, frame.args or {})

		if succeeded then
			self:respond(id, true, result)
		elseif type(result) == "table" and type(result.code) == "string" then
			-- Handlers raise structured errors so callers can branch on a code
			-- rather than parse prose. Flattening these to PLUGIN_ERROR would
			-- throw away the only machine-readable part.
			self:respond(id, false, {
				code = result.code,
				message = tostring(result.message),
				retryable = result.retryable == true,
			})
		else
			self:respond(id, false, {
				code = "PLUGIN_ERROR",
				message = tostring(result),
				retryable = false,
			})
		end
	end)
end

function Control:connect(): boolean
	local created, stream = pcall(function()
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {
			Url = self:url(),
		})
	end)

	if not created or not stream then
		Log.debug("Control: could not open stream:", stream)
		return false
	end

	self.stream = stream

	stream.MessageReceived:Connect(function(message)
		self:onFrame(message)
	end)

	stream.Error:Connect(function(code, message)
		Log.debug("Control: stream error:", code, message)
	end)

	stream.Closed:Connect(function()
		self.connected = false
		self.stream = nil
		Log.trace("Control: disconnected")
	end)

	-- Wait for Opened before the hello, bounded so a daemon that never
	-- finishes the handshake does not pin us here forever.
	local deadline = os.clock() + OPEN_TIMEOUT

	while stream.ConnectionState ~= Enum.WebStreamClientState.Open do
		if os.clock() > deadline or self.stopped then
			pcall(function()
				stream:Close()
			end)
			self.stream = nil
			Log.debug("Control: timed out waiting for the socket to open")
			return false
		end

		task.wait(0.05)
	end

	self.connected = true

	self:send({
		t = "hello",
		protocol = PROTOCOL,
		placeId = tostring(game.PlaceId),
		gameId = tostring(game.GameId),
		placeName = game.Name,
		pluginVersion = Handlers.version(),
	})

	Log.trace("Control: connected to", self:url())

	return true
end

-- Reconnects for the lifetime of the edit session. The daemon may legitimately
-- not be running yet, so a failed dial is a debug-level event, not a warning.
function Control:start()
	task.spawn(function()
		while not self.stopped do
			if not self.connected then
				self:connect()
			end

			task.wait(RECONNECT_DELAY)
		end
	end)
end

function Control:stop()
	self.stopped = true
	self.connected = false

	if self.stream then
		pcall(function()
			self.stream:Close()
		end)
		self.stream = nil
	end
end

local module = {}

function module.start(host: string?, port: number?): Control?
	-- Playtest clones must not open their own daemon connection; runtime work
	-- is routed through the edit-mode plugin instead.
	if RunService:IsRunning() then
		return nil
	end

	local control = Control.new(host, port)
	control:start()

	return control
end

return module
