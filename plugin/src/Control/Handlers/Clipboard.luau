--!strict
-- Cross-project copy and paste.
--
-- Studio does the serializing. SerializationService round-trips a real .rbxm,
-- which is why MuslimSync needs no binary format parser of its own — the whole
-- reason the JavaScript side can stay JavaScript.
--
-- Copy serializes the selected roots in ONE call so references between them
-- survive; serializing individually would silently break every link.

local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Artifacts = require(MuslimSync.Control.Artifacts)
local Value = require(MuslimSync.Control.Value)

local MAX_ROOTS = 64

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function service(name: string)
	local ok, found = pcall(function()
		return game:GetService(name :: any)
	end)

	if not ok or not found then
		fail("PERMISSION_REQUIRED", `{name} is not available in this Studio build`)
	end

	return found
end

local function resolve(path: string): Instance
	local current: Instance = game

	for segment in path:gmatch("[^/]+") do
		local child = current:FindFirstChild(segment)
		if not child then
			fail("NOT_FOUND", `no instance at {path} (stopped at {segment})`)
		end
		current = child
	end

	if current == game then
		fail("INVALID_ARGUMENT", "the DataModel itself cannot be copied")
	end

	return current
end

--- Drops any root that is a descendant of another root.
---
--- Serializing both a parent and its child would insert the child twice on
--- paste: once inside the parent, once standalone.
local function withoutNested(roots: { Instance }): { Instance }
	local kept = {}

	for _, candidate in roots do
		local nested = false

		for _, other in roots do
			if other ~= candidate and candidate:IsDescendantOf(other) then
				nested = true
				break
			end
		end

		if not nested then
			local duplicate = false
			for _, already in kept do
				if already == candidate then
					duplicate = true
					break
				end
			end

			if not duplicate then
				table.insert(kept, candidate)
			end
		end
	end

	return kept
end

return function(context)
	return {
		--- Serializes explicit paths, or the current Studio selection.
		clipboard_copy = function(args)
			local serialization = service("SerializationService")

			local roots: { Instance } = {}

			if type(args.paths) == "table" and #args.paths > 0 then
				for _, path in args.paths do
					table.insert(roots, resolve(tostring(path)))
				end
			else
				for _, selected in Selection:Get() do
					table.insert(roots, selected)
				end
			end

			roots = withoutNested(roots)

			if #roots == 0 then
				fail("INVALID_ARGUMENT", "nothing to copy: pass paths, or select something in Studio")
			end

			if #roots > MAX_ROOTS then
				fail("INVALID_ARGUMENT", `too many roots ({#roots}); the limit is {MAX_ROOTS}`)
			end

			-- One call for all roots: references between them are preserved
			-- only within a single serialization.
			local ok, serialized = pcall(function()
				return (serialization :: any):SerializeInstancesAsync(roots)
			end)

			if not ok then
				fail("PLUGIN_ERROR", `serialization failed: {tostring(serialized)}`)
			end

			local metadata = Artifacts.upload(context.port(), serialized, "model/rbxm")

			-- Only counts and paths come back. The serialized bytes and any
			-- script source inside them never enter a command response.
			local summary = {}
			for _, root in roots do
				table.insert(summary, { path = Value.pathOf(root), class = root.ClassName, name = root.Name })
			end

			return { artifact = metadata.id, size = metadata.size, sha256 = metadata.sha256, roots = summary }
		end,

		--- Deserializes an artifact into the open place, under one Undo.
		clipboard_paste = function(args)
			local serialization = service("SerializationService")

			if type(args.artifact) ~= "string" or args.artifact == "" then
				fail("INVALID_ARGUMENT", "artifact id is required")
			end

			local parent: Instance = if type(args.to) == "string" and args.to ~= "" then resolve(args.to) else workspace

			local data = Artifacts.download(context.port(), args.artifact)

			local ok, instances = pcall(function()
				return (serialization :: any):DeserializeInstancesAsync(data)
			end)

			if not ok then
				fail("PLUGIN_ERROR", `deserialization failed: {tostring(instances)}`)
			end

			local recording = ChangeHistoryService:TryBeginRecording("MuslimSync paste")
			local parented = {}

			local applied = pcall(function()
				for _, instance in instances do
					instance.Parent = parent
					table.insert(parented, instance)
				end
			end)

			if not applied then
				-- Destroy anything already inserted before cancelling, so a
				-- failed paste cannot leave half a tree behind.
				for _, instance in parented do
					pcall(function()
						instance:Destroy()
					end)
				end

				if recording then
					ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
				end

				fail("PLUGIN_ERROR", "could not parent the pasted instances")
			end

			if recording then
				ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
			end

			Selection:Set(parented)

			local summary = {}
			for _, instance in parented do
				table.insert(
					summary,
					{ path = Value.pathOf(instance), class = instance.ClassName, name = instance.Name }
				)
			end

			return { to = Value.pathOf(parent), count = #parented, roots = summary }
		end,
	}
end
