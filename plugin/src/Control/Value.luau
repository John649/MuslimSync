--!strict
-- Tagged encoding for Roblox values crossing the control channel.
--
-- JSON has numbers, strings, booleans and tables; Roblox has Vector3, CFrame,
-- EnumItem and forty other things. Every non-primitive travels as a table with
-- a `__type` tag, using the same shapes Ro Sync proved against Studio.
--
-- Decoding an unknown shape returns an error rather than a default. A silently
-- substituted Vector3.zero is a property set to the wrong value with no
-- indication anything went wrong.

local Value = {}

local function isFinite(n: any): boolean
	return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

-- The path a caller uses to name this instance again. Built from Name only;
-- callers that need to disambiguate duplicates use the index in `ls`.
local function pathOf(instance: Instance): string
	local segments = {}
	local current: Instance? = instance

	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end

	return table.concat(segments, "/")
end

Value.pathOf = pathOf

-- Deep enough for any result worth reading, shallow enough that a nested
-- structure cannot be used to blow up a frame.
local MAX_ENCODE_DEPTH = 8

--- Encodes one Roblox value into a JSON-safe form.
---
--- `depth` and `seen` are how tables recurse; callers pass neither.
function Value.encode(value: any, depth: number?, seen: { [any]: boolean }?): any
	local kind = typeof(value)

	if kind == "table" then
		local level = (depth or 0) + 1
		local visited = seen or {}

		if level > MAX_ENCODE_DEPTH then
			return { __type = "Unsupported", of = "table", text = `nested deeper than {MAX_ENCODE_DEPTH}` }
		end

		if visited[value] then
			-- A table that contains itself would otherwise recurse until the
			-- stack gave out, which reads as a hang rather than as a bad value.
			return { __type = "Unsupported", of = "table", text = "cyclic" }
		end

		visited[value] = true

		local encoded = {}
		for key, item in value do
			local keyKind = type(key)

			if keyKind == "string" or keyKind == "number" then
				encoded[key] = Value.encode(item, level, visited)
			end
		end

		visited[value] = nil

		return encoded
	end

	if kind == "nil" or kind == "boolean" or kind == "string" then
		return value
	elseif kind == "number" then
		-- JSON has no NaN or Infinity; emitting them produces a document the
		-- other side cannot parse.
		return if isFinite(value) then value else tostring(value)
	elseif kind == "Vector2" then
		return { __type = "Vector2", x = value.X, y = value.Y }
	elseif kind == "Vector3" then
		return { __type = "Vector3", x = value.X, y = value.Y, z = value.Z }
	elseif kind == "Color3" then
		return { __type = "Color3", r = value.R, g = value.G, b = value.B }
	elseif kind == "UDim" then
		return { __type = "UDim", scale = value.Scale, offset = value.Offset }
	elseif kind == "UDim2" then
		return {
			__type = "UDim2",
			x = { scale = value.X.Scale, offset = value.X.Offset },
			y = { scale = value.Y.Scale, offset = value.Y.Offset },
		}
	elseif kind == "CFrame" then
		return { __type = "CFrame", components = { value:GetComponents() } }
	elseif kind == "BrickColor" then
		return { __type = "BrickColor", name = value.Name }
	elseif kind == "EnumItem" then
		return { __type = "EnumItem", enum = tostring(value.EnumType), name = value.Name, value = value.Value }
	elseif kind == "NumberRange" then
		return { __type = "NumberRange", min = value.Min, max = value.Max }
	elseif kind == "Rect" then
		return {
			__type = "Rect",
			min = { x = value.Min.X, y = value.Min.Y },
			max = { x = value.Max.X, y = value.Max.Y },
		}
	elseif kind == "Instance" then
		return { __type = "Instance", path = pathOf(value), class = value.ClassName, name = value.Name }
	end

	-- Anything else (ColorSequence, NumberSequence, Font, ...) is reported as
	-- its type rather than pretended to be encodable. A caller can see exactly
	-- what it did not get.
	return { __type = "Unsupported", of = kind, text = tostring(value) }
end

local decoders: { [string]: (any) -> any } = {
	Vector2 = function(v)
		return Vector2.new(v.x, v.y)
	end,
	Vector3 = function(v)
		return Vector3.new(v.x, v.y, v.z)
	end,
	Color3 = function(v)
		return Color3.new(v.r, v.g, v.b)
	end,
	UDim = function(v)
		return UDim.new(v.scale, v.offset)
	end,
	UDim2 = function(v)
		return UDim2.new(v.x.scale, v.x.offset, v.y.scale, v.y.offset)
	end,
	CFrame = function(v)
		if type(v.components) ~= "table" or #v.components ~= 12 then
			error("CFrame needs exactly 12 components")
		end
		return CFrame.new(table.unpack(v.components))
	end,
	BrickColor = function(v)
		return BrickColor.new(v.name)
	end,
	NumberRange = function(v)
		return NumberRange.new(v.min, v.max)
	end,
	Rect = function(v)
		return Rect.new(v.min.x, v.min.y, v.max.x, v.max.y)
	end,
	EnumItem = function(v)
		local enum = (Enum :: any)[v.enum]
		if not enum then
			error(`no such enum: {tostring(v.enum)}`)
		end

		for _, item in enum:GetEnumItems() do
			if item.Name == v.name then
				return item
			end
		end

		error(`{v.enum} has no item named {tostring(v.name)}`)
	end,
}

--- Decodes a JSON value back into a Roblox one. Throws on anything unknown.
function Value.decode(value: any): any
	local kind = type(value)

	if kind == "nil" or kind == "boolean" or kind == "string" or kind == "number" then
		return value
	end

	if kind ~= "table" then
		error(`cannot decode a {kind}`)
	end

	local tag = value.__type

	if type(tag) ~= "string" then
		error("a table value must carry a __type tag")
	end

	local decoder = decoders[tag]

	if not decoder then
		error(`unsupported value type: {tag}`)
	end

	return decoder(value)
end

--- Splits "0, 6, 0" into numbers, or nil if any piece is not one.
local function numbers(text: string): { number }?
	local parsed = {}

	for piece in text:gmatch("[^,%s]+") do
		local number = tonumber(piece)

		if not number then
			return nil
		end

		table.insert(parsed, number)
	end

	return if #parsed > 0 then parsed else nil
end

--- Coercions from what a person types to what a property wants.
---
--- Keyed by the type of the value already in the property, because that is the
--- only reliable statement of what the property will accept — the class
--- database is not reachable from a plugin.
local coercions: { [string]: (string, { number }?) -> any } = {
	Vector3 = function(_, n)
		return if n and #n == 3 then Vector3.new(n[1], n[2], n[3]) else nil
	end,
	Vector2 = function(_, n)
		return if n and #n == 2 then Vector2.new(n[1], n[2]) else nil
	end,
	UDim = function(_, n)
		return if n and #n == 2 then UDim.new(n[1], n[2]) else nil
	end,
	UDim2 = function(_, n)
		return if n and #n == 4 then UDim2.new(n[1], n[2], n[3], n[4]) else nil
	end,
	NumberRange = function(_, n)
		if n and #n == 1 then
			return NumberRange.new(n[1])
		end

		return if n and #n == 2 then NumberRange.new(n[1], n[2]) else nil
	end,
	CFrame = function(_, n)
		if n and #n == 3 then
			-- Three numbers is a move, not a rotation: keeping the orientation
			-- is what "put it there" means.
			return CFrame.new(n[1], n[2], n[3])
		end

		return if n and #n == 12 then CFrame.new(table.unpack(n)) else nil
	end,
	Color3 = function(text, n)
		local hex = text:match("^#?(%x%x%x%x%x%x)$")

		if hex then
			return Color3.fromHex(hex)
		end

		if not n or #n ~= 3 then
			return nil
		end

		-- "255,0,0" and "1,0,0" are both things people write. Anything above 1
		-- can only have meant 0-255, and 0-1 is the Roblox-native range.
		local scaled = n[1] > 1 or n[2] > 1 or n[3] > 1

		return if scaled then Color3.fromRGB(n[1], n[2], n[3]) else Color3.new(n[1], n[2], n[3])
	end,
	BrickColor = function(text)
		local ok, color = pcall(BrickColor.new, text)
		return if ok then color else nil
	end,
	EnumItem = function(text, _)
		return text
	end,
}

--- Turns a typed string into the type a property already holds.
---
--- `msync set Part Position "0,6,0"` is the most ordinary thing to type, and
--- refusing it because the transport carried a string is the tool being
--- pedantic about its own internals. Errors name the format that would work.
function Value.coerce(text: string, current: any): any
	local kind = typeof(current)
	local coerce = coercions[kind]

	if not coerce then
		return text
	end

	if kind == "EnumItem" then
		-- Enums resolve by name against the enum already in the property, so
		-- "Neon" is enough and the full Enum.Material.Neon is not required.
		for _, item in (current :: EnumItem).EnumType:GetEnumItems() do
			if item.Name:lower() == text:lower() then
				return item
			end
		end

		error(`{tostring((current :: EnumItem).EnumType)} has no item named "{text}"`)
	end

	local coerced = coerce(text, numbers(text))

	if coerced == nil then
		error(`"{text}" is not a {kind}`)
	end

	return coerced
end

return Value
