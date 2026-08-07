--!strict
-- DataModel paths.
--
-- Paths are `/`-separated from the DataModel root, e.g. `Workspace/Baseplate`.
-- Both "" and "/" mean the DataModel itself, so asking for the root is not a
-- special case every caller has to remember.
--
-- This walk lived in three handlers before it lived here, which is three
-- places for the NOT_FOUND message to drift apart.

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local Path = {}

--- Resolves a path to one instance, or fails with NOT_FOUND naming the segment
--- that was missing — which is the part the caller got wrong.
function Path.resolve(path: any): Instance
	local text = if type(path) == "string" then path else ""

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

--- Resolves a path that must name a real instance rather than the DataModel.
---
--- Copying, capturing or reparenting `game` is never what was meant, and the
--- failure is much clearer here than wherever the operation would break.
function Path.resolveChild(path: any, verb: string): Instance
	local instance = Path.resolve(path)

	if instance == game then
		fail("INVALID_ARGUMENT", `the DataModel itself cannot be {verb}`)
	end

	return instance
end

return Path
