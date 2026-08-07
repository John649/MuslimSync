local HttpService = game:GetService("HttpService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Promise = require(MuslimSync.Packages.Promise)

local Types = require(MuslimSync.Types)
local Place = require(MuslimSync.Place)
local Log = require(MuslimSync.Log)
local MsgPack = require(MuslimSync.Lib.MsgPack)

local Http = require(script.Http)
local Error = require(script.Error)

local function generateId(): number
	return math.floor(math.random() * 10 ^ 9)
end

local Client = {}
Client.__index = Client

function Client.new(host: string, port: number, https: boolean)
	local self = setmetatable({}, Client)

	self.isSubscribed = false
	self.clientId = generateId()
	self.placeName = Place.Name
	self.host = host
	self.port = port
	self.https = https

	return self
end

function Client:getUrl(endpoint: string?): string
	local protocol = self.https and "https" or "http"
	return `{protocol}://{self.host}:{self.port}/{endpoint or ""}`
end

function Client:fetchDetails(): Promise.TypedPromise<Types.Project>
	Log.trace("Client request: details")

	local url = self:getUrl("details")

	return Http.get(url):andThen(function(response)
		return response:decode()
	end)
end

function Client:subscribe(): Promise.Promise
	Log.trace("Client request: subscribe")

	local url = self:getUrl("subscribe")

	return Http.post(url, {
		clientId = self.clientId,
		name = self.placeName,
	})
		:andThen(function()
			self.isSubscribed = true
		end)
		:catch(function(err)
			if err == Error.Unknown then
				return Promise.reject(Error.new(Error.AlreadySubscribed, self.clientId))
			else
				return Promise.reject(err)
			end
		end)
end

function Client:unsubscribe(): Promise.Promise
	Log.trace("Client request: unsubscribe")

	local url = self:getUrl("unsubscribe")

	return Http.post(url, {
		clientId = self.clientId,
	})
		:andThen(function()
			self.isSubscribed = false
		end)
		:catch(function(err)
			if err == Error.Unknown then
				return Promise.reject(Error.new(Error.NotSubscribed, self.clientId))
			else
				return Promise.reject(err)
			end
		end)
end

function Client:getSnapshot(instance: Types.Ref?): Promise.TypedPromise<Types.AddedSnapshot>
	Log.trace("Client request: snapshot")

	local url = self:getUrl("snapshot")

	return Http.post(url, {
		instance = instance or buffer.create(16),
	}):andThen(function(response)
		return response:decode()
	end)
end

function Client:read(): Promise.TypedPromise<Types.Message>
	Log.trace("Client request: read")

	local url = self:getUrl("read")

	return Http.post(url, {
		clientId = self.clientId,
	})
		:andThen(function(response)
			return response:decode()
		end)
		:catch(function(err)
			-- We don't need to handle this as Rust queue uses `recv_timeout`
			if err == Error.Timedout then
				return self:read()
			else
				-- Any other read failure ends the session - always say why
				Log.warn("Sync read failed (this disconnects the session):", err)
				return Promise.reject(err)
			end
		end)
end

export type Stream = {
	close: () -> (),
}

-- Opens a WebSocket push stream for queue messages (replaces the /read
-- long poll). Returns nil when the WebStream API is unavailable or fails,
-- in which case the caller should fall back to long polling
function Client:openStream(onMessage: (Types.Message) -> (), onClosed: () -> ()): Stream?
	local protocol = self.https and "wss" or "ws"

	local ok, stream = pcall(function()
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {
			Url = `{protocol}://{self.host}:{self.port}/ws/{self.clientId}`,
		})
	end)

	if not ok or not stream then
		Log.debug("WebStream unavailable, falling back to long polling:", stream)
		return nil
	end

	Log.trace("Client stream: opened")

	local closed = false

	stream.MessageReceived:Connect(function(message)
		local success, decoded = pcall(MsgPack.decode, message)

		if success then
			onMessage(decoded)
		else
			Log.warn("Failed to decode stream message:", decoded)
		end
	end)

	stream.Error:Connect(function(code, message)
		Log.warn("Sync stream error:", code, message)
	end)

	stream.Closed:Connect(function()
		if not closed then
			closed = true
			Log.trace("Client stream: closed")
			onClosed()
		end
	end)

	return {
		close = function()
			if not closed then
				closed = true

				pcall(function()
					stream:Close()
				end)

				-- Wake anyone blocked on the stream (the Closed event
				-- is suppressed by the flag above)
				onClosed()
			end
		end,
	}
end

function Client:write(changes: Types.Changes): Promise.Promise
	Log.trace("Client request: write")

	local url = self:getUrl("write")

	return Http.post(url, {
		clientId = self.clientId,
		changes = changes,
	})
end

function Client:setConfig(level: string, id: string, key: string, value: any): Promise.Promise
	Log.trace("Client request: setConfig")

	local url = self:getUrl("setConfig")

	return Http.post(url, {
		level = level,
		id = id,
		key = key,
		value = value,
	})
end

function Client:open(instance: Types.Ref, line: number): Promise.Promise
	Log.trace("Client request: open")

	local url = self:getUrl("open")

	return Http.post(url, {
		instance = instance,
		line = line,
	})
end

return Client
