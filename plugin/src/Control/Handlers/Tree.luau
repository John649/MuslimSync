--!strict
-- DataModel navigation: reading the live Studio tree.
--
-- Read-only. Every op here answers a question and changes nothing, so an agent
-- can explore freely before it writes anything.
--
-- Paths are `/`-separated from the DataModel root, e.g. `Workspace/Baseplate`.
-- An empty path is the DataModel itself.

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Value = require(MuslimSync.Control.Value)

-- Bounded so one careless call cannot serialize a whole place into a frame.
local MAX_CHILDREN = 500
local MAX_NODES = 5000
local MAX_MATCHES = 1000
local MAX_DEPTH = 32

-- What a place is actually made of. Deliberately excludes CoreGui,
-- PluginGuiService and the rest of Studio's own interface, which are not the
-- user's game and are never what a search is asking about.
local PLACE_SERVICES = {
	"Workspace",
	"ReplicatedStorage",
	"ReplicatedFirst",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Lighting",
	"SoundService",
	"Teams",
	"Chat",
	"TextChatService",
}

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

--- Resolves a `/`-separated path to one instance, or fails with NOT_FOUND.
local function resolve(path: string?): Instance
	local text = if type(path) == "string" then path else ""

	-- Both "" and "/" mean the DataModel; asking for the root should not be a
	-- special case the caller has to remember.
	if text == "" or text == "/" then
		return game
	end

	local current: Instance = game

	for segment in text:gmatch("[^/]+") do
		local child = current:FindFirstChild(segment)

		if not child then
			fail("NOT_FOUND", `no instance at {text} (stopped at {segment})`)
		end

		current = child
	end

	return current
end

local function describe(instance: Instance)
	return {
		name = instance.Name,
		class = instance.ClassName,
		path = Value.pathOf(instance),
		childCount = #instance:GetChildren(),
	}
end

--- Reads a property, translating Studio's own error into a clear one.
local function readProperty(instance: Instance, property: string): any
	local ok, result = pcall(function()
		return (instance :: any)[property]
	end)

	if not ok then
		fail("NOT_FOUND", `{instance.ClassName} has no readable property "{property}"`)
	end

	return result
end

-- Properties worth showing for any instance. A full property dump needs the
-- reflection database, which `props` will grow into; this keeps `get` useful
-- and cheap in the meantime.
local COMMON = { "Name", "ClassName", "Archivable" }

local BY_CLASS: { [string]: { string } } = {
	BasePart = {
		"Position",
		"Size",
		"Orientation",
		"CFrame",
		"Anchored",
		"CanCollide",
		"Transparency",
		"Color",
		"Material",
	},
	GuiObject = { "Position", "Size", "AnchorPoint", "BackgroundColor3", "BackgroundTransparency", "Visible", "ZIndex" },
	TextLabel = { "Text", "TextColor3", "TextSize", "Font", "TextWrapped" },
	TextButton = { "Text", "TextColor3", "TextSize", "Font" },
	ImageLabel = { "Image", "ImageColor3", "ImageTransparency" },
	-- Enabled and RunContext are BaseScript members. A ModuleScript is a
	-- LuaSourceContainer but has neither, which is why `props` on one used to
	-- show nothing but Name and ClassName.
	BaseScript = { "Enabled", "RunContext" },
	Humanoid = { "Health", "MaxHealth", "WalkSpeed", "JumpPower" },
	Camera = { "CFrame", "FieldOfView", "CameraType" },
	Lighting = { "Ambient", "Brightness", "ClockTime", "FogEnd" },
}

local function interestingProperties(instance: Instance): { string }
	local names = table.clone(COMMON)
	local seen = { Name = true, ClassName = true, Archivable = true }

	for class, properties in BY_CLASS do
		if instance:IsA(class :: any) then
			for _, property in properties do
				if not seen[property] then
					seen[property] = true
					table.insert(names, property)
				end
			end
		end
	end

	return names
end

local function propertiesOf(instance: Instance)
	local properties = {}

	for _, name in interestingProperties(instance) do
		local ok, raw = pcall(function()
			return (instance :: any)[name]
		end)

		if ok then
			properties[name] = Value.encode(raw)
		end
	end

	-- A script's interesting property is its source, but dumping it into every
	-- `props` call would bury everything else. Its shape is the useful summary;
	-- `source` fetches the text itself.
	if instance:IsA("LuaSourceContainer") then
		local ok, source = pcall(function()
			return (instance :: any).Source
		end)

		if ok and type(source) == "string" then
			local _, newlines = source:gsub("\n", "")
			properties.SourceBytes = #source
			properties.SourceLines = if #source == 0 then 0 else newlines + 1
		end
	end

	return properties
end

--- Depth-first subtree, bounded by depth and total node count.
local function subtree(instance: Instance, depth: number, budget: { nodes: number })
	local node = describe(instance)

	if depth <= 0 or budget.nodes <= 0 then
		node.truncated = node.childCount > 0
		return node
	end

	local children = {}

	for index, child in instance:GetChildren() do
		if index > MAX_CHILDREN or budget.nodes <= 0 then
			node.truncated = true
			break
		end

		budget.nodes -= 1
		table.insert(children, subtree(child, depth - 1, budget))
	end

	node.children = children
	return node
end

local function clampDepth(value: any, fallback: number): number
	local depth = tonumber(value) or fallback
	return math.clamp(math.floor(depth), 0, MAX_DEPTH)
end

return function(_context)
	return {
		--- One instance: identity, properties, and its children's names.
		get = function(args)
			local instance = resolve(args.path)

			if type(args.prop) == "string" and args.prop ~= "" then
				return {
					path = Value.pathOf(instance),
					prop = args.prop,
					value = Value.encode(readProperty(instance, args.prop)),
				}
			end

			local view = describe(instance)
			view.properties = propertiesOf(instance)
			return view
		end,

		--- Direct children. The index is stable within one call, so duplicate
		--- names can still be told apart by position.
		ls = function(args)
			local instance = resolve(args.path)
			local children = {}

			for index, child in instance:GetChildren() do
				if index > MAX_CHILDREN then
					break
				end

				local entry = describe(child)
				entry.index = index
				table.insert(children, entry)
			end

			return {
				path = Value.pathOf(instance),
				class = instance.ClassName,
				total = #instance:GetChildren(),
				truncated = #instance:GetChildren() > MAX_CHILDREN,
				children = children,
			}
		end,

		--- A bounded subtree. Depth 0 is the instance alone.
		tree = function(args)
			local instance = resolve(args.path)
			local budget = { nodes = MAX_NODES }
			return subtree(instance, clampDepth(args.depth, 3), budget)
		end,

		--- Every readable property this handler knows about for the class.
		props = function(args)
			local instance = resolve(args.path)
			return { path = Value.pathOf(instance), class = instance.ClassName, properties = propertiesOf(instance) }
		end,

		--- Script source, read through ScriptEditorService so an unsaved draft
		--- in an open editor tab is what the caller sees.
		source = function(args)
			local instance = resolve(args.path)

			if not instance:IsA("LuaSourceContainer") then
				fail("INVALID_ARGUMENT", `{Value.pathOf(instance)} is a {instance.ClassName}, not a script`)
			end

			local editor = game:GetService("ScriptEditorService")
			local ok, source = pcall(function()
				return editor:GetEditorSource(instance)
			end)

			return {
				path = Value.pathOf(instance),
				class = instance.ClassName,
				source = if ok then source else (instance :: any).Source,
			}
		end,

		--- Descendants filtered by class and/or name substring.
		---
		--- Without `under`, this searches the services a place is actually made
		--- of. Searching `game` reaches CoreGui and PluginGuiService, so
		--- `find --class Camera` used to return Studio's own interface
		--- alongside the user's — answers about the wrong program entirely.
		find = function(args)
			local roots: { Instance } = {}

			if type(args.under) == "string" and args.under ~= "" then
				table.insert(roots, resolve(args.under))
			else
				for _, name in PLACE_SERVICES do
					local service = game:FindFirstChild(name)
					if service then
						table.insert(roots, service)
					end
				end
			end
			local class = if type(args.class) == "string" and args.class ~= "" then args.class else nil
			local name = if type(args.name) == "string" and args.name ~= "" then args.name:lower() else nil

			if not class and not name then
				fail("INVALID_ARGUMENT", "find needs a class, a name, or both")
			end

			local matches = {}
			local visited = 0
			local truncated = false

			for _, root in roots do
				for _, descendant in root:GetDescendants() do
					visited += 1

					if visited > MAX_NODES or #matches >= MAX_MATCHES then
						truncated = true
						break
					end

					local classOk = not class or descendant:IsA(class :: any)
					local nameOk = not name or descendant.Name:lower():find(name, 1, true) ~= nil

					if classOk and nameOk then
						table.insert(matches, describe(descendant))
					end
				end

				if truncated then
					break
				end
			end

			local scope = {}
			for _, root in roots do
				table.insert(scope, root.Name)
			end

			return { under = scope, visited = visited, truncated = truncated, matches = matches }
		end,
	}
end
