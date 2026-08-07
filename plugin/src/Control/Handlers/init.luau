--!strict
-- Op registry. Every handler module is a factory taking a context table and
-- returning a map of op name -> function(args). Adding a family means adding
-- one module and one line below; nothing else in the control channel knows
-- what ops exist.
--
-- Modules are factories rather than plain tables so a handler can reach shared
-- state (like the op list) without requiring this module back and creating a
-- cyclic require.

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Version = require(MuslimSync.Version)

local Handlers = {}

local registry: { [string]: (args: { [string]: any }) -> any } = {}

local function listOps(): { string }
	local ops = {}

	for op in registry do
		table.insert(ops, op)
	end

	table.sort(ops)

	return ops
end

-- The daemon port is not known when this module loads, so it is read through a
-- function at call time rather than captured.
local port = 7900

local context = {
	version = Version,
	port = function()
		return port
	end,
	-- Read at call time, so it reflects the fully built registry rather than
	-- however much of it existed when this module was constructed.
	listOps = listOps,
}

local MODULES = {
	require(script.Core),
	require(script.Tree),
	require(script.Clipboard),
	require(script.Mutate),
	require(script.Runtime),
	require(script.Capture),
}

for _, factory in MODULES do
	for op, handler in factory(context) do
		if registry[op] then
			error(`duplicate control op registered: {op}`)
		end

		registry[op] = handler
	end
end

function Handlers.get(op: any): ((args: { [string]: any }) -> any)?
	if type(op) ~= "string" then
		return nil
	end

	return registry[op]
end

function Handlers.list(): { string }
	return listOps()
end

function Handlers.version(): string
	return Version.version
end

function Handlers.setPort(value: number)
	port = value
end

return Handlers
