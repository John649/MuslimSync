--!strict
-- Screenshots through StudioCaptureService.
--
-- The older CaptureService pipeline hands back a content id that must be
-- decoded through EditableImage into raw pixels; this service hands back the
-- PNG bytes themselves, reports failure through BufferStatus and GetErrors
-- instead of a callback that silently never fires, and — the part that matters
-- most — works from a playtest clone, because the clone is the DataModel that
-- owns the screen. Learned by reading how Ro Sync does it.
--
-- This module runs on both sides of the playtest bridge. The edit plugin calls
-- `take` directly; a runtime clone serves `prepare`/`read`/`close` so edit
-- mode can pull a capture out in chunks, and `pull` is that loop — handed a
-- request function rather than requiring the bridge, so the bridge can require
-- this module without a cycle.

local EncodingService = game:GetService("EncodingService")
local HttpService = game:GetService("HttpService")

local Screenshot = {}

local CAPTURE_TIMEOUT = 20
local SESSION_TTL = 120
local MAX_BYTES = 64 * 1024 * 1024
-- Sized for the JSON frames the playtest bridge speaks: 192KB of raw bytes is
-- 256KB of base64, comfortably inside a connection-service message.
local CHUNK_BYTES = 192 * 1024

local sessions: { [string]: { bytes: buffer, width: number, height: number, at: number } } = {}

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function service(): any?
	local ok, found = pcall(function()
		return game:GetService("StudioCaptureService" :: any)
	end)

	if not ok or not found then
		return nil
	end

	return found
end

function Screenshot.available(): boolean
	local capture = service()

	if not capture then
		return false
	end

	local ok, can = pcall(function()
		return capture:CanCaptureScreenshot()
	end)

	return ok and can == true
end

--- One screenshot as PNG bytes.
---
--- `args.ui = "none"` leaves the GUI out; `args.region` crops in the capture
--- itself rather than in pixel math afterwards.
function Screenshot.take(args: { [string]: any }): (buffer, number, number)
	local capture = service()

	if not capture then
		fail("PERMISSION_REQUIRED", "StudioCaptureService is not available in this Studio build")
	end

	local can = false
	pcall(function()
		can = capture:CanCaptureScreenshot()
	end)

	if not can then
		fail(
			"PERMISSION_REQUIRED",
			"screenshot permission is not granted — run `msync photo` once in edit mode "
				.. "with Studio focused and allow the prompt"
		)
	end

	local options: { [string]: any } = {
		Format = Enum.StudioCaptureScreenshotFormat.PNG,
		UICaptureMode = if tostring(args.ui or "all"):lower() == "none"
			then Enum.UICaptureMode.None
			else Enum.UICaptureMode.All,
	}

	if type(args.region) == "table" then
		local x = math.max(0, math.floor(tonumber(args.region.x) or 0))
		local y = math.max(0, math.floor(tonumber(args.region.y) or 0))
		local width = math.floor(tonumber(args.region.width) or 0)
		local height = math.floor(tonumber(args.region.height) or 0)

		if width > 0 and height > 0 then
			options.Position = Vector2.new(x, y)
			options.CaptureSize = Vector2.new(width, height)
		end
	end

	local shot: any = nil
	local requested, requestError = pcall(function()
		shot = capture:CaptureScreenshot(options)
	end)

	if not requested or shot == nil then
		fail("PLUGIN_ERROR", `could not request a screenshot: {tostring(requestError)}`)
	end

	local deadline = os.clock() + CAPTURE_TIMEOUT

	while
		shot.BufferStatus == Enum.StudioCaptureBufferStatus.NotStarted
		or shot.BufferStatus == Enum.StudioCaptureBufferStatus.Pending
	do
		if os.clock() > deadline then
			fail("TIMEOUT", "the screenshot never became ready — is a permission prompt waiting in Studio?")
		end
		task.wait(0.05)
	end

	if shot.BufferStatus ~= Enum.StudioCaptureBufferStatus.Ready then
		local reasons = {}
		pcall(function()
			for _, item in shot:GetErrors() do
				table.insert(reasons, tostring(item))
			end
		end)
		fail(
			"PLUGIN_ERROR",
			`the screenshot failed: {if #reasons > 0 then table.concat(reasons, "; ") else "unknown error"}`
		)
	end

	local bytes = shot:GetBuffer()

	if typeof(bytes) ~= "buffer" or buffer.len(bytes) < 1 then
		fail("PLUGIN_ERROR", "the screenshot returned no bytes")
	end

	if buffer.len(bytes) > MAX_BYTES then
		fail("PLUGIN_ERROR", `the screenshot is implausibly large ({buffer.len(bytes)} bytes)`)
	end

	local resolution = shot.Resolution

	return bytes, math.floor(resolution.X), math.floor(resolution.Y)
end

-- ------------------------------------------------------------- runtime side

local function sweep()
	local now = os.clock()
	for id, session in sessions do
		if now - session.at > SESSION_TTL then
			sessions[id] = nil
		end
	end
end

--- Runtime: capture now, hold the bytes, hand back a session to read from.
function Screenshot.prepare(args: { [string]: any }): { [string]: any }
	sweep()

	local bytes, width, height = Screenshot.take(args)
	local id = HttpService:GenerateGUID(false)

	sessions[id] = { bytes = bytes, width = width, height = height, at = os.clock() }

	return { sessionId = id, byteLength = buffer.len(bytes), width = width, height = height }
end

--- Runtime: one chunk of a held capture, as base64.
function Screenshot.read(args: { [string]: any }): { [string]: any }
	local session = sessions[tostring(args.sessionId)]

	if not session then
		fail("NOT_FOUND", `no capture session {tostring(args.sessionId)} — it may have expired`)
	end

	local total = buffer.len(session.bytes)
	local offset = math.clamp(math.floor(tonumber(args.offset) or 0), 0, total)
	local length = math.min(CHUNK_BYTES, total - offset)

	local slice = buffer.create(length)
	buffer.copy(slice, 0, session.bytes, offset, length)

	session.at = os.clock()

	return {
		data = buffer.tostring(EncodingService:Base64Encode(slice)),
		nextOffset = offset + length,
		eof = offset + length >= total,
	}
end

function Screenshot.close(args: { [string]: any })
	sessions[tostring(args.sessionId)] = nil
	return { closed = true }
end

-- ---------------------------------------------------------------- edit side

--- Edit: pulls a whole capture out of a runtime context.
---
--- `request(op, payload)` is the bridge — injected, so this module never
--- requires it. Every failure path still closes the far session.
function Screenshot.pull(
	request: (string, { [string]: any }) -> { [string]: any },
	args: { [string]: any }
): (buffer, number, number)
	local prepared = request("capture_prepare", { ui = args.ui, region = args.region })

	if prepared.ok == false then
		fail("PLUGIN_ERROR", tostring(prepared.error))
	end

	local meta = prepared.value or prepared
	local total = math.floor(tonumber(meta.byteLength) or 0)

	if total < 1 or total > MAX_BYTES then
		pcall(request, "capture_close", { sessionId = meta.sessionId })
		fail("PLUGIN_ERROR", `the runtime reported an invalid capture size ({tostring(meta.byteLength)})`)
	end

	local bytes = buffer.create(total)
	local offset = 0

	local ok, failure = pcall(function()
		while offset < total do
			local reply = request("capture_read", { sessionId = meta.sessionId, offset = offset })

			if reply.ok == false then
				error(tostring(reply.error))
			end

			local chunk = reply.value or reply
			local decoded = EncodingService:Base64Decode(buffer.fromstring(tostring(chunk.data)))

			buffer.copy(bytes, offset, decoded, 0, buffer.len(decoded))
			offset += buffer.len(decoded)

			if chunk.eof then
				break
			end
		end
	end)

	pcall(request, "capture_close", { sessionId = meta.sessionId })

	if not ok then
		fail("PLUGIN_ERROR", `pulling the capture failed at byte {offset}/{total}: {tostring(failure)}`)
	end

	if offset < total then
		fail("PLUGIN_ERROR", `the capture ended early at byte {offset}/{total}`)
	end

	return bytes, math.floor(tonumber(meta.width) or 0), math.floor(tonumber(meta.height) or 0)
end

return Screenshot
