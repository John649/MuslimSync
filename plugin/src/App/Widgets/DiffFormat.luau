-- Turning what the server sent into something a person can read.
--
-- Split out of Diff.luau, which had grown past the line cap. These are the parts
-- with no Fusion in them: given a snapshot, an instance or an encoded property,
-- produce a number or a short string. Nothing here builds UI, so it can be read
-- and tested on its own.

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Dom = require(MuslimSync.Lib.Dom)
local Types = require(MuslimSync.Types)

-- Long property values are truncated rather than wrapped: a diff row is one
-- line, and a 4,000-character Source turns the whole list into a wall.
local MAX_VALUE_LENGTH = 80

local DiffFormat = {}

function DiffFormat.countDescendants(snapshot: Types.AddedSnapshot): number
	local descendants = 0

	if snapshot.children then
		descendants = #snapshot.children

		for _, child in snapshot.children do
			descendants += DiffFormat.countDescendants(child)
		end
	end

	return descendants
end

function DiffFormat.countLines(source: string): number
	return #source:split("\n")
end

function DiffFormat.getSnapshotSource(snapshot: Types.AddedSnapshot | Types.UpdatedSnapshot): string?
	local source = snapshot.properties and snapshot.properties.Source

	if not source then
		return nil
	end

	local ok, decoded = Dom.EncodedValue.decode(source)
	return ok and decoded or ""
end

function DiffFormat.getInstanceSource(instance: Instance): string?
	if not instance:IsA("LuaSourceContainer") then
		return nil
	end

	local ok, source = Dom.readProperty(instance, "Source")
	return ok and source or ""
end

function DiffFormat.formatValue(value: any)
	if type(value) == "string" then
		value = `"{value}"`
	elseif typeof(value) == "EnumItem" then
		value = value.Name
	end

	value = tostring(value)

	if value:find(",") then
		value = `({value})`
	end

	if #value > MAX_VALUE_LENGTH then
		return value:sub(1, MAX_VALUE_LENGTH - 3) .. "..."
	end

	return value
end

function DiffFormat.formatSnapshotValue(encoded: any, decoded: any?): string
	local ok, value = Dom.EncodedValue.decode(encoded)

	if ok and typeof(decoded) == "EnumItem" then
		local enum = decoded.EnumType
		value = enum:FromValue(value)
	end

	return ok and DiffFormat.formatValue(value) or "?"
end

function DiffFormat.formatInstanceValue(instance: Instance, property: string): (string, any?)
	local ok, value = Dom.readProperty(instance, property)
	return ok and DiffFormat.formatValue(value), value or "?", nil
end

return DiffFormat
