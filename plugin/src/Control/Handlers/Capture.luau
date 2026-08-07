--!strict
-- Viewport capture.
--
-- Pipeline: CaptureService:CaptureScreenshot gives a content id, AssetService
-- decodes it into an EditableImage, and ReadPixelsBuffer hands back RGBA8 that
-- the daemon encodes as PNG. Studio does the rendering; we only move pixels.
--
-- CaptureScreenshot is permission-gated and the prompt is shown by Studio, not
-- by us — so `capture_status` reports what we know without asking, and
-- `capture_authorize` is the separate, explicit step that may prompt.

local AssetService = game:GetService("AssetService")
local CaptureService = game:GetService("CaptureService")
local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Artifacts = require(MuslimSync.Control.Artifacts)

local CAPTURE_TIMEOUT = 20
local MAX_AXIS = 4096
local MAX_PIXELS = 16777216

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function available(): boolean
	return typeof((CaptureService :: any).CaptureScreenshot) == "function"
end

--- Takes one screenshot and returns its content id.
---
--- CaptureScreenshot is callback-based with no failure channel, so the wait is
--- bounded: without a deadline a denied permission prompt would hang the op
--- forever with no way for the caller to tell.
local function screenshot(): string
	local content: string? = nil
	local requested, requestError = pcall(function()
		CaptureService:CaptureScreenshot(function(result)
			content = result
		end)
	end)

	if not requested then
		fail("PERMISSION_REQUIRED", `could not request a screenshot: {tostring(requestError)}`)
	end

	local deadline = os.clock() + CAPTURE_TIMEOUT

	while content == nil do
		if os.clock() > deadline then
			fail("TIMEOUT", "the screenshot was never delivered — the permission prompt may be waiting")
		end
		RunService.Heartbeat:Wait()
	end

	if content == "" then
		fail("PLUGIN_ERROR", "the screenshot came back empty")
	end

	return content :: string
end

local function clampRegion(region: any, size: Vector2)
	if type(region) ~= "table" then
		return Vector2.zero, size
	end

	local x = math.clamp(math.floor(tonumber(region.x) or 0), 0, size.X - 1)
	local y = math.clamp(math.floor(tonumber(region.y) or 0), 0, size.Y - 1)
	local width = math.floor(tonumber(region.width) or (size.X - x))
	local height = math.floor(tonumber(region.height) or (size.Y - y))

	width = math.clamp(width, 1, size.X - x)
	height = math.clamp(height, 1, size.Y - y)

	return Vector2.new(x, y), Vector2.new(width, height)
end

return function(context)
	return {
		--- What we can report without triggering a prompt.
		capture_status = function()
			return {
				available = available(),
				-- Studio owns the permission state and does not expose it, so
				-- this is deliberately not guessed. Calling capture is the only
				-- way to find out, which is what capture_authorize is for.
				permissionKnown = false,
			}
		end,

		--- Explicitly asks for permission, which may show Studio's prompt.
		capture_authorize = function()
			if not available() then
				fail("PERMISSION_REQUIRED", "CaptureService:CaptureScreenshot is not available in this Studio build")
			end

			screenshot()
			return { authorized = true }
		end,

		--- Captures the viewport, or one rectangle of it, as RGBA8.
		photo = function(args)
			if not available() then
				fail("PERMISSION_REQUIRED", "CaptureService:CaptureScreenshot is not available in this Studio build")
			end

			if tonumber(args.delay) then
				-- Lets a caller stage the viewport — move the camera, toggle
				-- UI — before the frame is taken.
				task.wait(math.clamp(tonumber(args.delay) :: number, 0, 5))
			end

			local content = screenshot()

			local decoded, image = pcall(function()
				return AssetService:CreateEditableImageAsync(content :: any)
			end)

			if not decoded or not image then
				fail("PLUGIN_ERROR", `could not decode the screenshot: {tostring(image)}`)
			end

			local editable = image :: EditableImage
			local full = editable.Size

			if full.X < 1 or full.Y < 1 then
				editable:Destroy()
				fail("PLUGIN_ERROR", `the screenshot decoded to {full.X}x{full.Y}`)
			end

			local origin, size = clampRegion(args.region, full)

			if size.X > MAX_AXIS or size.Y > MAX_AXIS or size.X * size.Y > MAX_PIXELS then
				editable:Destroy()
				fail("INVALID_ARGUMENT", `{size.X}x{size.Y} exceeds the capture limits`)
			end

			-- Read only the requested rectangle. Shipping a whole 4K frame to
			-- crop it on the other side would be 33 MB over base64 for what is
			-- often a small subject.
			local read, pixels = pcall(function()
				return editable:ReadPixelsBuffer(origin, size)
			end)

			editable:Destroy()

			if not read then
				fail("PLUGIN_ERROR", `could not read pixels: {tostring(pixels)}`)
			end

			local data = pixels :: buffer
			local expected = size.X * size.Y * 4

			if buffer.len(data) ~= expected then
				-- The daemon revalidates this too, but failing here names the
				-- side that actually produced the wrong buffer.
				fail("PLUGIN_ERROR", `expected {expected} bytes for {size.X}x{size.Y}, got {buffer.len(data)}`)
			end

			local metadata = Artifacts.upload(context.port(), data, "application/octet-stream")

			return {
				artifact = metadata.id,
				width = size.X,
				height = size.Y,
				byteLength = buffer.len(data),
				sha256 = metadata.sha256,
				viewport = { width = full.X, height = full.Y },
				region = { x = origin.X, y = origin.Y, width = size.X, height = size.Y },
			}
		end,
	}
end
