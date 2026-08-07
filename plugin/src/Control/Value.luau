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

--- Encodes one Roblox value into a JSON-safe form.
function Value.encode(value: any): any
	local kind = typeof(value)

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

return Value
