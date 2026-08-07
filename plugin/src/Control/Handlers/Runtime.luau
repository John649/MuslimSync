--!strict
-- Studio itself: running code, reading output, change history, saving.
--
-- `eval` is the escape hatch. Structured ops cover the common cases; this
-- covers everything else, and it is deliberately the only op that runs
-- arbitrary code so the blast radius is one clearly-named command.

local LogService = game:GetService("LogService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Value = require(MuslimSync.Control.Value)

local MAX_OUTPUT_LINES = 200
local MAX_LOG_LINES = 500
local EVAL_TIMEOUT = 10

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

-- LogService only reports history since Studio started, so the plugin keeps
-- its own ring buffer to survive the plugin reloading mid-session.
local ring: { { level: string, message: string, at: number } } = {}

local LEVELS: { [Enum.MessageType]: string } = {
	[Enum.MessageType.MessageOutput] = "info",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warn",
	[Enum.MessageType.MessageError] = "error",
}

LogService.MessageOut:Connect(function(message, messageType)
	table.insert(ring, {
		level = LEVELS[messageType] or "info",
		message = message,
		at = os.time(),
	})

	if #ring > MAX_LOG_LINES then
		table.remove(ring, 1)
	end
end)

local RANK = { info = 1, warn = 2, error = 3 }

return function(_context)
	return {
		--- Runs Luau in Studio and returns whatever it prints and returns.
		eval = function(args)
			local source = tostring(args.source or "")

			if source == "" then
				fail("INVALID_ARGUMENT", "source is required")
			end

			local chunk, syntaxError = loadstring(source)

			if not chunk then
				-- A syntax error is the caller's mistake, not a plugin fault,
				-- and the message is the useful part.
				fail("INVALID_ARGUMENT", `syntax error: {tostring(syntaxError)}`)
			end

			-- Output printed during the call is captured by watching the ring
			-- buffer's high-water mark rather than replacing `print`, which
			-- would leak into unrelated code if this errored.
			local before = #ring
			local deadline = os.clock() + EVAL_TIMEOUT

			local ok, returned = pcall(chunk :: any)

			if os.clock() > deadline then
				fail("TIMEOUT", `eval exceeded {EVAL_TIMEOUT}s`)
			end

			local output = {}
			for index = before + 1, math.min(#ring, before + MAX_OUTPUT_LINES) do
				table.insert(output, ring[index].message)
			end

			if not ok then
				return { ok = false, error = tostring(returned), output = output }
			end

			return { ok = true, returned = Value.encode(returned), output = output }
		end,

		--- Recent Studio output from the plugin's ring buffer.
		logs = function(args)
			local minimum = RANK[tostring(args.level or "info")] or 1
			local limit = math.clamp(tonumber(args.limit) or 50, 1, MAX_LOG_LINES)

			local matched = {}

			-- Walk backwards so `limit` keeps the newest lines, then restore
			-- chronological order for reading.
			for index = #ring, 1, -1 do
				local line = ring[index]

				if (RANK[line.level] or 1) >= minimum then
					table.insert(matched, 1, {
						level = line.level,
						message = line.message,
						at = os.date("%H:%M:%S", line.at),
					})

					if #matched >= limit then
						break
					end
				end
			end

			return { lines = matched, total = #ring }
		end,

		undo = function()
			if not ChangeHistoryService:CanUndo() then
				fail("CONFLICT", "there is nothing to undo")
			end

			ChangeHistoryService:Undo()
			return { undone = true }
		end,

		redo = function()
			if not ChangeHistoryService:CanRedo() then
				fail("CONFLICT", "there is nothing to redo")
			end

			ChangeHistoryService:Redo()
			return { redone = true }
		end,

		--- Asks Studio to save. Returns as soon as the request is made.
		save = function()
			local ok, err = pcall(function()
				(game :: any):Save()
			end)

			if not ok then
				fail("PLUGIN_ERROR", `save failed: {tostring(err)}`)
			end

			return { saving = true }
		end,
	}
end
