--!strict
-- Playtest lifecycle and runtime access.
--
-- Starting a playtest is a real Studio API — StudioTestService's Execute*Async
-- family — so this does not require anyone to press Play. Once running, the
-- clones announce themselves through the bridge and `playtest_exec` reaches
-- into whichever one the caller names.

local RunService = game:GetService("RunService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Bridge = require(MuslimSync.Control.Playtest)

local MAX_PLAYERS = 8

local function fail(code: string, message: string): never
	error({ code = code, message = message }, 0)
end

local function service()
	local ok, found = pcall(function()
		return game:GetService("StudioTestService")
	end)

	if not ok or not found then
		fail("PERMISSION_REQUIRED", "StudioTestService is unavailable in this Studio build")
	end

	return found :: any
end

return function(_context)
	return {
		--- Starts a playtest. Returns as soon as Studio accepts the request.
		playtest_start = function(args)
			if RunService:IsRunning() then
				fail("CONFLICT", "a playtest is already running")
			end

			local test = service()
			local mode = string.lower(tostring(args.mode or "play"))
			local players = math.clamp(math.floor(tonumber(args.players) or 1), 1, MAX_PLAYERS)

			-- Test args reach the clone through StudioTestService:GetTestArgs,
			-- which is how a playscript would receive its configuration.
			local testArgs = { muslimsync = true }

			-- Execute*Async yields until the playtest ends, so it runs on its
			-- own thread: the caller wants the test started, not finished.
			task.spawn(function()
				local ok, err = pcall(function()
					if mode == "run" then
						return test:ExecuteRunModeAsync(testArgs)
					elseif mode == "multiplayer" then
						return test:ExecuteMultiplayerTestAsync(players, testArgs)
					else
						return test:ExecutePlayModeAsync(testArgs)
					end
				end)

				if not ok then
					warn(`[MuslimSync] playtest ended with an error: {tostring(err)}`)
				end
			end)

			return { started = true, mode = mode, players = if mode == "multiplayer" then players else 1 }
		end,

		--- Whether a playtest is running, and which contexts have checked in.
		---
		--- Connected contexts are the signal, not RunService:IsRunning(). The
		--- edit-mode DataModel is not the one running, so IsRunning is false
		--- there for the entire duration of a playtest.
		playtest_status = function()
			local live = Bridge.contexts()

			return {
				running = #live > 0,
				contexts = live,
			}
		end,

		--- Ends the running playtest.
		playtest_stop = function()
			if #Bridge.contexts() == 0 then
				fail("CONFLICT", "no playtest is running")
			end

			local stopped, err = pcall(function()
				service():EndTest()
			end)

			if not stopped then
				fail("PLUGIN_ERROR", `could not stop the playtest: {tostring(err)}`)
			end

			return { stopped = true }
		end,

		--- Runs Luau inside a named runtime context.
		playtest_exec = function(args)
			local name = tostring(args.context or "server")
			local source = tostring(args.source or "")

			if source == "" then
				fail("INVALID_ARGUMENT", "source is required")
			end

			if #Bridge.contexts() == 0 then
				-- The likeliest cause by far, and the one the caller can act on.
				fail("NOT_FOUND", "no playtest contexts are connected — start a playtest first")
			end

			local reply = Bridge.request(name, "exec", { source = source })

			if not reply.ok then
				return { ok = false, error = tostring(reply.error) }
			end

			return { ok = true, context = name, value = reply.value }
		end,

		--- Round-trips a named context, to check the bridge itself.
		playtest_ping = function(args)
			local name = tostring(args.context or "server")
			local reply = Bridge.request(name, "ping", {})

			return { ok = reply.ok == true, context = name, value = reply.value }
		end,
	}
end
