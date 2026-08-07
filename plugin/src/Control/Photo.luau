--!strict
-- Isolated rendering: one instance on a transparent background.
--
-- Studio has no API that returns a rendered instance with an alpha channel, and
-- a viewport screenshot always has an opaque sky. The alpha is recovered
-- instead, by photographing the subject twice against known backdrops:
--
--   over black:  D = C·a
--   over white:  L = C·a + 255·(1 - a)
--
-- so  a = 1 - (L - D) / 255  and  C = D / a.
--
-- Where the backdrop shows through, the two frames differ by the full span and
-- alpha is 0. Where the subject is opaque they are identical and alpha is 1.
-- Edges land in between, which is what makes the result composite cleanly
-- rather than showing a halo.
--
-- The backdrop's endpoints are measured rather than assumed to be 0 and 255:
-- exposure and colour correction remap both ends, and assuming the full range
-- there produces alpha that is subtly wrong everywhere.

local Workspace = game:GetService("Workspace")

-- Far enough from any real build that nothing else lands in shot. Studio's
-- coordinate space is comfortable here; parts stop being reliable past ~2^24.
local PARK = Vector3.new(0, 100000, 0)
-- Below this the two passes are too close to tell backdrop from subject, and
-- solving would amplify noise into garbage alpha.
local MIN_SPAN = 4
-- Matte extraction never lands exactly on zero: the renderer dithers, and a
-- backdrop pixel can come back a shade off between the two passes. Anything
-- under this is backdrop that did not quite cancel, and keeping it means a
-- faint halo in the file and a crop that snaps to the whole frame.
local NOISE_FLOOR = 8 / 255

local Photo = {}

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

--- The world-space box an instance occupies, whatever kind it is.
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
		min = if min then (min :: Vector3):Min(descendant.Position - half) else descendant.Position - half
		max = if max then (max :: Vector3):Max(descendant.Position + half) else descendant.Position + half
	end

	if not min or not max then
		fail("INVALID_ARGUMENT", `{instance:GetFullName()} has no parts to render`)
	end

	local low, high = min :: Vector3, max :: Vector3

	return CFrame.new((low + high) / 2), high - low
end

--- Moves a cloned subject bodily to the parking spot.
local function park(clone: Instance, centre: Vector3)
	local offset = PARK - centre

	if clone:IsA("Model") then
		clone:PivotTo(clone:GetPivot() + offset)
		return
	end

	for _, part in clone:GetDescendants() do
		if part:IsA("BasePart") then
			part.CFrame = part.CFrame + offset
		end
	end

	if clone:IsA("BasePart") then
		clone.CFrame = clone.CFrame + offset
	end
end

--- A flat surface behind the subject whose colour we control exactly.
---
--- LightInfluence 0 matters: a backdrop that responds to lighting is not a
--- known colour, and the whole solve rests on knowing it.
local function backdrop(camera: Camera, distance: number, size: number): (Part, Frame)
	local part = Instance.new("Part")
	part.Name = "MuslimSyncBackdrop"
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.CastShadow = false
	part.Transparency = 1
	part.Size = Vector3.new(math.min(size, 2048), math.min(size, 2048), 0.05)

	local eye = camera.CFrame.Position
	part.CFrame = CFrame.lookAt(eye + camera.CFrame.LookVector * distance, eye, camera.CFrame.UpVector)

	local mesh = Instance.new("SpecialMesh")
	mesh.MeshType = Enum.MeshType.Brick
	mesh.Scale = Vector3.new(size / math.min(size, 2048), size / math.min(size, 2048), 1)
	mesh.Parent = part

	local surface = Instance.new("SurfaceGui")
	surface.Adornee = part
	surface.Face = Enum.NormalId.Front
	surface.LightInfluence = 0
	surface.MaxDistance = 0
	surface.SizingMode = Enum.SurfaceGuiSizingMode.FixedSize
	surface.CanvasSize = Vector2.new(64, 64)
	surface.Parent = part

	local colour = Instance.new("Frame")
	colour.BorderSizePixel = 0
	colour.Size = UDim2.fromScale(1, 1)
	colour.BackgroundColor3 = Color3.new(0, 0, 0)
	colour.Parent = surface

	part.Parent = Workspace

	return part, colour
end

--- Recovers straight-alpha RGBA, given the backdrop's own endpoints.
---
--- The endpoints are measured per pixel rather than assumed, and rather than
--- taken as one number for the whole frame. The backdrop vignettes: its white
--- reads ~233 in the corners and 255 in the middle, so a single global span
--- leaves every background pixel at alpha 22 instead of 0 — transparent enough
--- to look right and opaque enough that a tight crop snaps to the whole frame.
---
--- `bgDark`/`bgLight` are the same two shots with the subject removed, so each
--- pixel is compared against the backdrop as it actually renders *there*.
function Photo.solve(dark: buffer, light: buffer, bgDark: buffer, bgLight: buffer, pixels: number): buffer
	local out = buffer.create(pixels * 4)

	for index = 0, pixels - 1 do
		local offset = index * 4

		-- The channel where the backdrop separates most: the others may be
		-- saturated by the subject's own colour and say nothing useful.
		local span = 0
		local difference = 0

		for channel = 0, 2 do
			local backdropSpan = buffer.readu8(bgLight, offset + channel) - buffer.readu8(bgDark, offset + channel)

			if backdropSpan > span then
				span = backdropSpan
				difference = buffer.readu8(light, offset + channel) - buffer.readu8(dark, offset + channel)
			end
		end

		if span < MIN_SPAN then
			-- The backdrop does not reach this pixel, so nothing can be seen
			-- through it. Opaque is the honest answer.
			buffer.writeu8(out, offset, buffer.readu8(dark, offset))
			buffer.writeu8(out, offset + 1, buffer.readu8(dark, offset + 1))
			buffer.writeu8(out, offset + 2, buffer.readu8(dark, offset + 2))
			buffer.writeu8(out, offset + 3, 255)
			continue
		end

		local alpha = math.clamp(1 - difference / span, 0, 1)

		if alpha < NOISE_FLOOR then
			-- Fully transparent: the colour underneath is the backdrop's, and
			-- writing it would tint whatever composites this image.
			buffer.writeu32(out, offset, 0)
			continue
		end

		for channel = 0, 2 do
			-- Un-premultiply: the dark pass is the subject already multiplied
			-- by its own alpha.
			local straight = buffer.readu8(dark, offset + channel) / alpha
			buffer.writeu8(out, offset + channel, math.clamp(math.round(straight), 0, 255))
		end

		buffer.writeu8(out, offset + 3, math.round(alpha * 255))
	end

	return out
end

--- Renders one instance on a transparent background.
---
--- `capture` takes a frame and hands back RGBA8 for the whole viewport; it is
--- passed in so this module never touches CaptureService itself and stays
--- testable in isolation from Studio's permission prompt.
function Photo.isolate(instance: Instance, options: { margin: number?, capture: () -> (buffer, Vector2) })
	local camera = Workspace.CurrentCamera

	if not camera then
		fail("PLUGIN_ERROR", "there is no current camera to render with")
	end

	if instance == game or not instance:IsA("Instance") then
		fail("INVALID_ARGUMENT", "the DataModel itself cannot be rendered")
	end

	local centre, extents = boundsOf(instance)
	local radius = math.max(extents.Magnitude / 2, 0.5)

	local clone: Instance
	local ok, cloned = pcall(function()
		return instance:Clone()
	end)

	if not ok or not cloned then
		-- A script with unsaved edits, or anything non-archivable, will not
		-- clone. Saying which is better than a bare nil.
		fail("INVALID_ARGUMENT", `{instance:GetFullName()} cannot be cloned for rendering`)
	end

	clone = cloned :: Instance
	clone.Parent = Workspace
	park(clone, centre.Position)

	local restoreCFrame = camera.CFrame
	local restoreFov = camera.FieldOfView

	local margin = math.clamp(options.margin or 1.25, 1, 8)
	local distance = radius / math.tan(math.rad(camera.FieldOfView) / 2) * margin
	local eye = PARK + Vector3.new(1, 0.6, 1).Unit * distance

	camera.CFrame = CFrame.lookAt(eye, PARK)

	-- Behind the subject, and wide enough to fill the frame at that distance.
	local behind = distance + radius * 2
	local screen = 2 * behind * math.tan(math.rad(camera.FieldOfView) / 2) * 1.5
	local part, colour = backdrop(camera, behind, screen)

	local function cleanup()
		camera.CFrame = restoreCFrame
		camera.FieldOfView = restoreFov
		part:Destroy()
		clone:Destroy()
	end

	local captured, result = pcall(function()
		-- The backdrop alone first, so every pixel is later compared against
		-- the backdrop as it actually renders at that spot.
		local hidden = clone.Parent
		clone.Parent = nil

		colour.BackgroundColor3 = Color3.new(0, 0, 0)
		local bgDark, size = options.capture()

		colour.BackgroundColor3 = Color3.new(1, 1, 1)
		local bgLight = options.capture()

		clone.Parent = hidden

		colour.BackgroundColor3 = Color3.new(0, 0, 0)
		local dark, darkSize = options.capture()

		colour.BackgroundColor3 = Color3.new(1, 1, 1)
		local light = options.capture()

		if size ~= darkSize then
			fail("PLUGIN_ERROR", "the calibration and subject passes came back at different sizes")
		end

		return {
			pixels = Photo.solve(dark, light, bgDark, bgLight, size.X * size.Y),
			size = size,
		}
	end)

	cleanup()

	if not captured then
		error(result, 0)
	end

	return result
end

return Photo
