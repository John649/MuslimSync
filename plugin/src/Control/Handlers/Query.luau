--!strict
-- Selector matching over the live tree.
--
-- `msync query 'StarterGui/**/TextButton'` is the difference between an agent
-- making one call and making forty. `*` matches one segment, `**` matches zero
-- or more, and a trailing class filter narrows without another traversal.
--
-- Every bound here is deliberate: a selector starting with `**` walks the whole
-- place, and an unbounded walk on a real game is the difference between a
-- useful tool and one nobody dares run.

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Value = require(MuslimSync.Control.Value)

local MAX_MATCHES = 1000
local MAX_NODES = 20000
local MAX_SEGMENTS = 32
local MAX_PROPERTIES = 16

-- Searching from `game` reaches CoreGui and PluginGuiService, which are
-- Studio's own interface and never what a selector is asking about.
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
	"TextChatService",
}

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function parse(selector: string): { string }
	local segments = {}

	for segment in selector:gmatch("[^/]+") do
		table.insert(segments, segment)

		if #segments > MAX_SEGMENTS then
			fail("INVALID_ARGUMENT", `a selector may have at most {MAX_SEGMENTS} segments`)
		end
	end

	if #segments == 0 then
		fail("INVALID_ARGUMENT", "a selector cannot be empty")
	end

	return segments
end

local function matchesText(name: string, pattern: string): boolean
	if pattern == "*" then
		return true
	end

	if not pattern:find("*", 1, true) then
		return name == pattern
	end

	-- `Btn*` and `*Frame` are worth supporting; escaping everything else keeps
	-- a name containing Lua pattern characters from being read as a pattern.
	local escaped = pattern:gsub("[%^%$%(%)%%%.%[%]%+%-%?]", "%%%1"):gsub("%*", ".-")

	return name:match(`^{escaped}$`) ~= nil
end

--- Whether an instance matches one segment.
---
--- A segment matches either the Name or the ClassName, because nobody writing
--- `StarterGui/**/TextButton` means "an instance literally named TextButton" —
--- they mean the class. Matching names only made that selector, the example in
--- every doc, silently return nothing.
local function matches(instance: Instance, pattern: string): boolean
	if matchesText(instance.Name, pattern) then
		return true
	end

	-- IsA rather than an exact ClassName compare, so `**/BasePart` finds Parts
	-- and MeshParts the way a Roblox developer would expect.
	local ok, isType = pcall(function()
		return instance:IsA(pattern :: any)
	end)

	return ok and isType
end

--- The roots a selector starts from.
local function rootsFor(first: string): { Instance }
	if first == "*" or first == "**" then
		local services = {}

		for _, name in PLACE_SERVICES do
			local service = game:FindFirstChild(name)
			if service then
				table.insert(services, service)
			end
		end

		return services
	end

	local service = game:FindFirstChild(first)

	return if service then { service } else {}
end

type Budget = { nodes: number, truncated: boolean, reason: string? }

--- Walks `instance` against segment `index`, collecting matches.
local function walk(instance: Instance, segments: { string }, index: number, found: { Instance }, budget: Budget)
	if budget.truncated then
		return
	end

	budget.nodes -= 1

	if budget.nodes <= 0 then
		budget.truncated = true
		budget.reason = "nodes"
		return
	end

	-- Past the last segment: this instance is a match.
	if index > #segments then
		if #found >= MAX_MATCHES then
			budget.truncated = true
			budget.reason = "matches"
			return
		end

		table.insert(found, instance)
		return
	end

	local segment = segments[index]

	if segment == "**" then
		-- Zero segments: try the next pattern against this same instance. This
		-- is what makes `A/**/B` also match a B directly inside A.
		walk(instance, segments, index + 1, found, budget)

		for _, child in instance:GetChildren() do
			walk(child, segments, index, found, budget)
		end

		return
	end

	for _, child in instance:GetChildren() do
		if matches(child, segment) then
			walk(child, segments, index + 1, found, budget)
		end
	end
end

return function(_context)
	return {
		--- Matches a selector and returns the instances it found.
		query = function(args)
			local selector = tostring(args.selector or "")

			if selector == "" then
				fail("INVALID_ARGUMENT", "a selector is required, e.g. StarterGui/**/TextButton")
			end

			local segments = parse(selector)
			local class = if type(args.class) == "string" and args.class ~= "" then args.class else nil

			local projected: { string } = {}

			if type(args.props) == "table" then
				for _, name in args.props do
					table.insert(projected, tostring(name))

					if #projected > MAX_PROPERTIES then
						fail("INVALID_ARGUMENT", `at most {MAX_PROPERTIES} properties may be projected`)
					end
				end
			end

			local budget: Budget = { nodes = MAX_NODES, truncated = false, reason = nil }
			local found: { Instance } = {}

			-- The first segment names a service, so the walk starts one level in.
			for _, root in rootsFor(segments[1]) do
				local startIndex = if segments[1] == "**" then 1 else 2

				if startIndex == 1 then
					walk(root, segments, 1, found, budget)
				else
					walk(root, segments, 2, found, budget)
				end
			end

			local results = {}

			for _, instance in found do
				if class and not instance:IsA(class :: any) then
					continue
				end

				local entry: { [string]: any } = {
					name = instance.Name,
					class = instance.ClassName,
					path = Value.pathOf(instance),
				}

				if #projected > 0 then
					local properties = {}

					for _, property in projected do
						local ok, raw = pcall(function()
							return (instance :: any)[property]
						end)

						if ok then
							properties[property] = Value.encode(raw)
						end
					end

					entry.properties = properties
				end

				table.insert(results, entry)
			end

			return {
				selector = selector,
				matches = results,
				visited = MAX_NODES - budget.nodes,
				truncated = budget.truncated,
				-- Machine-readable, so a caller can tell "there are no more" from
				-- "we stopped looking" without parsing prose.
				truncationReason = budget.reason,
			}
		end,
	}
end
