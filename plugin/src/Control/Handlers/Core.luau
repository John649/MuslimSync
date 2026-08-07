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
					pluginConnection = has("PluginConnectionService", "Connect"),
				},
				ops = context.listOps(),
			}
		end,
	}
end
