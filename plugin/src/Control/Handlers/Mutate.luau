--!strict
-- Writes to the live DataModel.
--
-- Every op here changes the place, so each one is wrapped in a change-history
-- recording and is reversible with one Ctrl-Z. Guardrails come from Ro Sync's
-- experience: a raw `Parent =` write is the single easiest way to corrupt a
-- DataModel, so `set` refuses it and points at `mv` instead.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Selection = game:GetService("Selection")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Value = require(MuslimSync.Control.Value)

local MAX_TAGS = 64

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function resolve(path: any): Instance
	local text = if type(path) == "string" then path else ""
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

--- Runs `body` inside one change-history recording, so it is one Ctrl-Z.
---
--- A failure cancels the recording rather than committing a half-applied
--- change: a partial write the user cannot cleanly undo is worse than none.
local function recorded<T>(name: string, body: () -> T): T
	local recording = ChangeHistoryService:TryBeginRecording(`MuslimSync: {name}`)
	local ok, result = pcall(body)

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		)
	end

	if not ok then
		error(result, 0)
	end

	return result
end

local function serviceOf(instance: Instance): Instance?
	local current: Instance? = instance

	while current and current.Parent and current.Parent ~= game do
		current = current.Parent
	end

	return current
end

return function(_context)
	return {
		--- Sets one property. `Parent` is refused; use `mv`.
		set = function(args)
			local instance = resolve(args.path)
			local property = tostring(args.prop or "")

			if property == "" then
				fail("INVALID_ARGUMENT", "prop is required")
			end

			if property == "Parent" and args.forceParent ~= true then
				-- The most common way to corrupt a DataModel by hand. `mv`
				-- does the same thing with the checks that make it safe.
				fail("CONFLICT", "refusing to set Parent directly — use mv, or pass forceParent to override")
			end

			local decoded = Value.decode(args.value)
			local before = Value.encode((instance :: any)[property])

			recorded(`set {property}`, function()
				local ok, err = pcall(function()
					(instance :: any)[property] = decoded
				end)

				if not ok then
					fail("INVALID_ARGUMENT", `could not set {property}: {tostring(err)}`)
				end
			end)

			return {
				path = Value.pathOf(instance),
				prop = property,
				before = before,
				after = Value.encode((instance :: any)[property]),
			}
		end,

		--- Creates an instance under a parent.
		new = function(args)
			local class = tostring(args.class or "")
			if class == "" then
				fail("INVALID_ARGUMENT", "class is required")
			end

			local parent = resolve(args.parent)

			return recorded(`new {class}`, function()
				local ok, instance = pcall(Instance.new, class :: any)

				if not ok or not instance then
					fail("INVALID_ARGUMENT", `cannot create a {class}`)
				end

				if type(args.name) == "string" and args.name ~= "" then
					instance.Name = args.name
				end

				if type(args.properties) == "table" then
					for property, raw in args.properties do
						local applied, err = pcall(function()
							(instance :: any)[property] = Value.decode(raw)
						end)

						if not applied then
							instance:Destroy()
							fail("INVALID_ARGUMENT", `could not set {property}: {tostring(err)}`)
						end
					end
				end

				instance.Parent = parent

				return { path = Value.pathOf(instance), class = instance.ClassName, name = instance.Name }
			end)
		end,

		--- Destroys an instance.
		rm = function(args)
			local instance = resolve(args.path)

			if instance == game then
				fail("INVALID_ARGUMENT", "the DataModel cannot be destroyed")
			end

			if instance.Parent == game then
				fail("CONFLICT", `{instance.Name} is a service and cannot be destroyed`)
			end

			local path = Value.pathOf(instance)

			recorded(`rm {instance.Name}`, function()
				instance:Destroy()
			end)

			return { path = path, destroyed = true }
		end,

		--- Reparents an instance. Crossing services needs an explicit force.
		mv = function(args)
			local instance = resolve(args.from)
			local destination = resolve(args.to)

			if instance == game or instance.Parent == game then
				fail("CONFLICT", "services cannot be moved")
			end

			if destination:IsDescendantOf(instance) or destination == instance then
				-- Roblox would raise its own error, but this one says why.
				fail("CONFLICT", "cannot move an instance into itself or its own descendant")
			end

			-- Moving between services is a much bigger change than it looks:
			-- it changes replication, and on disk it moves the file to another
			-- source tree entirely.
			if serviceOf(instance) ~= serviceOf(destination) and args.force ~= true then
				fail("CONFLICT", "that move crosses services — pass force to confirm")
			end

			local from = Value.pathOf(instance)

			recorded(`mv {instance.Name}`, function()
				instance.Parent = destination
			end)

			return { from = from, to = Value.pathOf(instance) }
		end,

		--- Attribute read/write/remove.
		attr = function(args)
			local instance = resolve(args.path)
			local action = tostring(args.action or "ls")

			if action == "ls" then
				local attributes = {}
				for name, raw in instance:GetAttributes() do
					attributes[name] = Value.encode(raw)
				end
				return { path = Value.pathOf(instance), attributes = attributes }
			end

			local name = tostring(args.name or "")
			if name == "" then
				fail("INVALID_ARGUMENT", "name is required")
			end

			if action == "set" then
				local decoded = Value.decode(args.value)
				recorded(`attr set {name}`, function()
					instance:SetAttribute(name, decoded)
				end)
				return { path = Value.pathOf(instance), name = name, value = Value.encode(instance:GetAttribute(name)) }
			end

			if action == "rm" then
				recorded(`attr rm {name}`, function()
					instance:SetAttribute(name, nil)
				end)
				return { path = Value.pathOf(instance), name = name, removed = true }
			end

			fail("INVALID_ARGUMENT", `unknown attr action: {action}`)
		end,

		--- CollectionService tags.
		tag = function(args)
			local instance = resolve(args.path)
			local action = tostring(args.action or "ls")

			if action == "ls" then
				return { path = Value.pathOf(instance), tags = CollectionService:GetTags(instance) }
			end

			local name = tostring(args.name or "")
			if name == "" then
				fail("INVALID_ARGUMENT", "name is required")
			end

			if action == "add" then
				if #CollectionService:GetTags(instance) >= MAX_TAGS then
					fail("CONFLICT", `that instance already has {MAX_TAGS} tags`)
				end

				recorded(`tag add {name}`, function()
					CollectionService:AddTag(instance, name)
				end)
			elseif action == "rm" then
				recorded(`tag rm {name}`, function()
					CollectionService:RemoveTag(instance, name)
				end)
			else
				fail("INVALID_ARGUMENT", `unknown tag action: {action}`)
			end

			return { path = Value.pathOf(instance), tags = CollectionService:GetTags(instance) }
		end,

		--- Studio's selection, so a human can see what an agent just touched.
		select = function(args)
			if args.paths == nil then
				local selected = {}
				for _, instance in Selection:Get() do
					table.insert(selected, Value.pathOf(instance))
				end
				return { paths = selected }
			end

			local instances = {}
			for _, path in args.paths do
				table.insert(instances, resolve(tostring(path)))
			end

			Selection:Set(instances)
			return { count = #instances }
		end,
	}
end
