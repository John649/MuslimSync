--!strict
-- Liveness and feature negotiation. `capabilities` is the entrypoint an agent
-- reads before using an optional API, so it must never guess: every flag here
-- is an observed fact about this Studio session, not a version inference.

local StudioService = game:GetService("StudioService")

local function has(service: string, method: string): boolean
	local ok, result = pcall(function()
		return typeof((game:GetService(service :: any) :: any)[method]) == "function"
	end)

	return ok and result == true
end

--- What this DataModel can bridge to, by asking rather than assuming.
local function connectionTargets()
	local targets = { edit = false, test = false, known = false }

	pcall(function()
		local service = game:GetService("PluginConnectionService")
		targets.edit = service:CanHaveConnectionType(Enum.PluginConnectionTargetType.Edit)
		targets.test = service:CanHaveConnectionType(Enum.PluginConnectionTargetType.Test)
		targets.known = true
	end)

	return targets
end

local function studioLocale(): string?
	local ok, locale = pcall(function()
		return StudioService.StudioLocaleId
	end)

	return ok and locale or nil
end

return function(context)
	return {
		ping = function(args)
			return {
				pong = true,
				-- Echoed back so the caller can measure round-trip time
				-- against its own clock rather than trusting ours.
				nonce = args.nonce,
			}
		end,

		capabilities = function()
			return {
				pluginVersion = context.version.version,
				protocolVersion = context.version.controlProtocol,
				place = {
					placeId = tostring(game.PlaceId),
					gameId = tostring(game.GameId),
					name = game.Name,
				},
				studio = {
					locale = studioLocale(),
				},
				features = {
					serialization = has("SerializationService", "SerializeInstancesAsync"),
					deserialization = has("SerializationService", "DeserializeInstancesAsync"),
					scriptEditor = has("ScriptEditorService", "UpdateSourceAsync"),
					capture = has("CaptureService", "CaptureScreenshot"),
					-- Probed by the method that exists. An earlier version looked
					-- for `Connect`, which does not, and reported the playtest
					-- bridge as unavailable when it was fine — a made-up name
					-- turning into a false blocker.
					pluginConnection = has("PluginConnectionService", "CanHaveConnectionType"),
				},
				-- Which way this DataModel may bridge. From edit mode, Test is
				-- the direction a playtest agent needs.
				connections = connectionTargets(),
				ops = context.listOps(),
			}
		end,
	}
end
