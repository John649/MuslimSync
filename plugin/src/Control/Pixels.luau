--!strict
-- The legacy pixel pipeline: CaptureService -> content id -> EditableImage ->
-- RGBA8 bytes.
--
-- Kept for two callers: the isolated transparent render, which genuinely needs
-- raw pixels for its matte math, and Studio builds without StudioCaptureService.
-- Everything else goes through Screenshot.luau, which gets PNG bytes directly.

local AssetService = game:GetService("AssetService")
local CaptureService = game:GetService("CaptureService")
local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Artifacts = require(MuslimSync.Control.Artifacts)
local Playtest = require(MuslimSync.Control.Playtest)

local CAPTURE_TIMEOUT = 20
local MAX_AXIS = 4096
local MAX_PIXELS = 16777216

local Pixels = {}

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

function Pixels.available(): boolean
	return typeof((CaptureService :: any).CaptureScreenshot) == "function"
end

--- Takes one screenshot and returns its content id.
---
--- CaptureScreenshot is callback-based with no failure channel, so the wait is
--- bounded: without a deadline a denied permission prompt would hang the op
--- forever with no way for the caller to tell.
function Pixels.screenshot(): string
	-- During a playtest the edit viewport is not the one on screen and this
	-- legacy callback silently never fires. The playtest path is --context.
	if Playtest.contextCount() > 0 then
		fail(
			"UNSUPPORTED",
			"a playtest is running — capture it from inside with --context client (or server), "
				.. "or stop it first (msync stop)"
		)
	end

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
			fail(
				"TIMEOUT",
				"the screenshot was never delivered — most likely a permission prompt is waiting "
					.. "in Studio (or another modal dialog); capture needs it answered once"
			)
		end
		RunService.Heartbeat:Wait()
	end

	if content == "" then
		fail("PLUGIN_ERROR", "the screenshot came back empty")
	end

	return content :: string
end

--- The world-space box a subject occupies, whatever kind of instance it is.
---
--- A Model knows its own bounds; anything else is measured from the parts under
--- it, so framing a Folder or an Attachment's parent works the same way.
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

--- Takes the frame and uploads it, given a viewport that is already staged.
---
function Pixels.readViewport(): (buffer, Vector2)
	local content = Pixels.screenshot()

	local decoded, image = pcall(function()
		return AssetService:CreateEditableImageAsync(content :: any)
	end)

	if not decoded or not image then
		fail("PLUGIN_ERROR", `could not decode the screenshot: {tostring(image)}`)
	end

	local editable = image :: EditableImage
	local size = editable.Size

	if size.X < 1 or size.Y < 1 then
		editable:Destroy()
		fail("PLUGIN_ERROR", `the screenshot decoded to {size.X}x{size.Y}`)
	end

	local read, pixels = pcall(function()
		return editable:ReadPixelsBuffer(Vector2.zero, size)
	end)

	editable:Destroy()

	if not read then
		fail("PLUGIN_ERROR", `could not read pixels: {tostring(pixels)}`)
	end

	return pixels :: buffer, size
end

function Pixels.capture(args, context)
	local content = Pixels.screenshot()

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
end

return Pixels
