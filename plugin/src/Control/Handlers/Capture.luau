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
local Path = require(MuslimSync.Control.Path)
local Photo = require(MuslimSync.Control.Photo)

local CAPTURE_TIMEOUT = 20
-- A 3/4 view reads as depth rather than as an elevation drawing, and leaving
-- a quarter of the subject's radius as air keeps it off the frame edge.
local SUBJECT_DIRECTION = Vector3.new(1, 0.6, 1).Unit
local SUBJECT_MARGIN = 1.25
local SETTLE_FRAMES = 2
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
			fail(
				"TIMEOUT",
				"the screenshot was never delivered — a modal Studio dialog blocks the callback, "
					.. "so check for a permission prompt or any other open dialog"
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
local function boundsOf(instance: Instance): (CFrame, Vector3)
	if instance:IsA("Model") then
		return instance:GetBoundingBox()
	end

	if instance:IsA("BasePart") then
		return instance.CFrame, instance.Size
	end

	local min: Vector3? = nil
	local max: Vector3? = nil

	for _, descendant in instance:GetDescendants() do
		if not descendant:IsA("BasePart") then
			continue
		end

		local half = descendant.Size / 2
		local low = descendant.Position - half
		local high = descendant.Position + half

		min = if min then (min :: Vector3):Min(low) else low
		max = if max then (max :: Vector3):Max(high) else high
	end

	if not min or not max then
		fail("INVALID_ARGUMENT", `{instance:GetFullName()} has no parts to frame`)
	end

	local low, high = min :: Vector3, max :: Vector3

	return CFrame.new((low + high) / 2), high - low
end

--- Points the camera at a subject and returns how to put it back.
---
--- The restore is returned rather than done here because the capture in
--- between can fail, and a tool that leaves the user's camera somewhere else
--- has broken their editor to take a screenshot.
local function frameSubject(instance: Instance, margin: number): () -> ()
	local camera = workspace.CurrentCamera

	if not camera then
		fail("PLUGIN_ERROR", "there is no current camera to frame with")
	end

	local center, size = boundsOf(instance)
	local radius = math.max(size.Magnitude / 2, 0.5)

	-- Fit against the vertical field of view: the viewport is wider than it is
	-- tall, so height is what actually clips.
	local distance = radius / math.tan(math.rad(camera.FieldOfView) / 2) * margin
	local eye = center.Position + SUBJECT_DIRECTION * distance
	local restore = camera.CFrame

	camera.CFrame = CFrame.lookAt(eye, center.Position)

	-- Give the renderer a moment: capturing the same frame the camera moved on
	-- can catch the previous view.
	for _ = 1, SETTLE_FRAMES do
		RunService.Heartbeat:Wait()
	end

	return function()
		camera.CFrame = restore
	end
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

--- Takes the frame and uploads it, given a viewport that is already staged.
---
--- Split out from the `photo` op so the camera can be restored around it: a
--- failure in here must not leave the user's camera pointing at the subject.
--- One screenshot, decoded, as RGBA8 for the whole viewport.
---
--- Split out because the isolated path needs two of them and must not care how
--- a frame is obtained.
local function readViewport(): (buffer, Vector2)
	local content = screenshot()

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

local function capture(args, context)
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

			-- An isolated render is a different pipeline, not a flag on this
			-- one: it photographs a parked clone twice and solves for alpha,
			-- so it never takes the ordinary single frame at all.
			if args.isolate == true then
				if args.subject == nil then
					fail("INVALID_ARGUMENT", "isolate needs a subject to render")
				end

				local subject = Path.resolveChild(args.subject, "rendered")
				local rendered = Photo.isolate(subject, {
					margin = tonumber(args.margin),
					capture = readViewport,
				})

				local metadata = Artifacts.upload(context.port(), rendered.pixels, "application/octet-stream")

				return {
					artifact = metadata.id,
					width = rendered.size.X,
					height = rendered.size.Y,
					byteLength = buffer.len(rendered.pixels),
					sha256 = metadata.sha256,
					isolated = true,
					subject = tostring(args.subject),
					viewport = { width = rendered.size.X, height = rendered.size.Y },
					region = { x = 0, y = 0, width = rendered.size.X, height = rendered.size.Y },
				}
			end

			-- Framing happens before the delay so a caller can still stage the
			-- shot — the subject decides where the camera goes, the delay
			-- decides when the shutter opens.
			local restoreCamera: (() -> ())? = nil

			if args.subject ~= nil then
				local subject = Path.resolveChild(args.subject, "captured")
				local margin = math.clamp(tonumber(args.margin) or SUBJECT_MARGIN, 1, 8)

				restoreCamera = frameSubject(subject, margin)
			end

			if tonumber(args.delay) then
				-- Lets a caller stage the viewport — move the camera, toggle
				-- UI — before the frame is taken.
				task.wait(math.clamp(tonumber(args.delay) :: number, 0, 5))
			end

			local ok, result = pcall(function()
				return capture(args, context)
			end)

			if restoreCamera then
				restoreCamera()
			end

			if not ok then
				error(result, 0)
			end

			if args.subject ~= nil then
				result.subject = tostring(args.subject)
			end

			return result
		end,
	}
end
