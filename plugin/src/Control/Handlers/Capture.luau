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

local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Artifacts = require(MuslimSync.Control.Artifacts)
local Path = require(MuslimSync.Control.Path)
local Photo = require(MuslimSync.Control.Photo)
local Playtest = require(MuslimSync.Control.Playtest)
local Screenshot = require(MuslimSync.Control.Screenshot)
local Pixels = require(MuslimSync.Control.Pixels)

-- A 3/4 view reads as depth rather than as an elevation drawing, and leaving
-- a quarter of the subject's radius as air keeps it off the frame edge.
local SUBJECT_DIRECTION = Vector3.new(1, 0.6, 1).Unit
local SUBJECT_MARGIN = 1.25
local SETTLE_FRAMES = 2

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

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

--- Split out from the `photo` op so the camera can be restored around it: a
--- failure in here must not leave the user's camera pointing at the subject.
--- One screenshot, decoded, as RGBA8 for the whole viewport.
---
--- Split out because the isolated path needs two of them and must not care how
--- a frame is obtained.
--- Edit-mode capture through StudioCaptureService: stage, shoot, upload PNG.
local function capturePng(args, context)
	local restoreCamera: (() -> ())? = nil

	if args.subject ~= nil then
		local subject = Path.resolveChild(args.subject, "captured")
		local margin = math.clamp(tonumber(args.margin) or SUBJECT_MARGIN, 1, 8)
		restoreCamera = frameSubject(subject, margin)
	end

	if tonumber(args.delay) then
		task.wait(math.clamp(tonumber(args.delay) :: number, 0, 5))
	end

	local ok, bytes, width, height = pcall(Screenshot.take, args)

	if restoreCamera then
		restoreCamera()
	end

	if not ok then
		error(bytes, 0)
	end

	local metadata = Artifacts.upload(context.port(), bytes :: any, "image/png")

	local result: { [string]: any } = {
		artifact = metadata.id,
		size = metadata.size,
		sha256 = metadata.sha256,
		byteLength = buffer.len(bytes :: any),
		width = width,
		height = height,
		format = "png",
	}

	if args.subject ~= nil then
		result.subject = tostring(args.subject)
	end

	return result
end

return function(context)
	return {
		--- What we can report without triggering a prompt.
		capture_status = function()
			return {
				available = Pixels.available() or Screenshot.available(),
				-- Studio owns the permission state and does not expose it, so
				-- this is deliberately not guessed. Calling capture is the only
				-- way to find out, which is what capture_authorize is for.
				permissionKnown = false,
			}
		end,

		--- Explicitly asks for permission, which may show Studio's prompt.
		capture_authorize = function()
			if not Pixels.available() then
				fail("PERMISSION_REQUIRED", "CaptureService:CaptureScreenshot is not available in this Studio build")
			end

			Pixels.screenshot()
			return { authorized = true }
		end,

		--- Captures the viewport — through StudioCaptureService when Studio has
		--- it (PNG bytes, real errors, playtests via --context), and through
		--- the legacy CaptureService pixel pipeline otherwise.
		photo = function(args)
			if args.context ~= nil and args.isolate ~= true then
				-- A playtest capture: the named clone takes it and we pull the
				-- bytes across the bridge in chunks.
				local name = tostring(args.context)
				local bytes, width, height = Screenshot.pull(function(op, payload)
					return Playtest.request(name, op, payload)
				end, args)

				local metadata = Artifacts.upload(context.port(), bytes, "image/png")

				return {
					artifact = metadata.id,
					size = metadata.size,
					sha256 = metadata.sha256,
					byteLength = buffer.len(bytes),
					width = width,
					height = height,
					format = "png",
					context = name,
				}
			end

			if args.isolate ~= true and Screenshot.available() then
				return capturePng(args, context)
			end

			if not Pixels.available() then
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
					capture = Pixels.readViewport,
				})

				local metadata = Artifacts.upload(context.port(), rendered.pixels, "application/octet-stream")

				return {
					artifact = metadata.id,
					width = rendered.size.X,
					height = rendered.size.Y,
					byteLength = buffer.len(rendered.pixels),
					sha256 = metadata.sha256,
					isolated = true,
					-- Already cropped to the drawn pixels, so the far side must
					-- not crop again.
					cropped = true,
					subject = tostring(args.subject),
					viewport = { width = rendered.viewport.X, height = rendered.viewport.Y },
					region = rendered.region,
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
				return Pixels.capture(args, context)
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
