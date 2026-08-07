local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Promise = require(MuslimSync.Packages.Promise)

local Http = require(MuslimSync.Client.Http)
local Config = require(MuslimSync.Config)

-- The MuslimSync daemon, which serves these project endpoints alongside the
-- control channel. It replaces Argon's separate `argon master` process, so
-- there is one thing to run rather than two. Project serves live on 8000+ and
-- never collide with it.
local MASTER_URL = "http://127.0.0.1:7900"

-- StringValue stored inside the place file that identifies unpublished
-- places (PlaceId == 0), which have no Roblox identity to match on
local MARKER_NAME = "ArgonId"

export type ProjectInfo = {
	name: string,
	path: string,
	gameId: number?,
	placeIds: { number },
	argonId: string?,
	running: boolean,
	host: string?,
	port: number?,
	-- Unix seconds of the last serve start; the master sorts /projects
	-- by this, so the picker's order is most-recently-synced first
	lastServed: number?,
	gameConfig: { [string]: { [string]: any } }?,
	placeConfig: { [string]: { [string]: any } }?,
}

export type Session = {
	host: string,
	port: number,
}

local Discovery = {}

function Discovery.getMarker(): string?
	local marker = ServerStorage:FindFirstChild(MARKER_NAME)

	if marker and marker:IsA("StringValue") and marker.Value ~= "" then
		return marker.Value
	end

	return nil
end

-- Creates the marker when missing. Only ever called for unpublished places
function Discovery.ensureMarker(): string
	local existing = Discovery.getMarker()

	if existing then
		return existing
	end

	local id = HttpService:GenerateGUID(false)

	local marker = Instance.new("StringValue")
	marker.Name = MARKER_NAME
	marker.Value = id
	marker.Parent = ServerStorage

	return id
end

-- All projects the master knows about, running or not
function Discovery.getProjects(): Promise.TypedPromise<{ ProjectInfo }>
	return Http.get(`{MASTER_URL}/projects`):andThen(function(response)
		return response:decode()
	end)
end

-- The project synced with the current place: published places match by
-- placeId then gameId, unpublished ones by the ArgonId marker only
function Discovery.findMatch(projects: { ProjectInfo }): ProjectInfo?
	if game.PlaceId ~= 0 then
		for _, project in projects do
			if table.find(project.placeIds, game.PlaceId) then
				return project
			end
		end

		for _, project in projects do
			if project.gameId ~= nil and project.gameId ~= 0 and project.gameId == game.GameId then
				return project
			end
		end
	else
		local marker = Discovery.getMarker()

		if marker then
			for _, project in projects do
				if project.argonId == marker then
					return project
				end
			end
		end
	end

	return nil
end

-- The project-file settings that would apply to the current place
-- (same merge order the config layer uses on connect)
function Discovery.projectConfig(project: ProjectInfo): { [string]: any }
	local merged = {}

	local function merge(configs: { [string]: { [string]: any } }?, id: string)
		local config = configs and configs[id]

		if config then
			for key, value in config do
				merged[key] = value
			end
		end
	end

	merge(project.gameConfig, "*")
	merge(project.gameConfig, tostring(game.GameId))
	merge(project.placeConfig, tostring(game.PlaceId))

	return merged
end

export type BrowseEntry = {
	name: string,
	path: string,
	isProject: boolean,
}

export type BrowseResponse = {
	path: string,
	parent: string?,
	entries: { BrowseEntry },
}

-- Lists directories under the configured project roots (master-side
-- whitelist, see project_roots in ~/.argon/config.toml). Empty path
-- lists the roots themselves
function Discovery.browse(path: string?): Promise.TypedPromise<BrowseResponse>
	return Http.post(`{MASTER_URL}/browse`, {
		path = path,
	}):andThen(function(response)
		return response:decode()
	end)
end

-- Fire-and-forget diagnostic log to the master, appended to
-- ~/.argon/logs/plugin.log so it survives Studio closing. MUST never
-- log on failure - Log itself calls this (recursion guard)
function Discovery.reportLog(level: string, message: string)
	Http.post(`{MASTER_URL}/log`, {
		level = level,
		message = message,
		source = `{game.Name} ({game.PlaceId})`,
	}):catch(function() end)
end

-- Creates a folder inside the given directory (must be within the
-- project roots). Returns the new folder's path
function Discovery.mkdir(parent: string, name: string): Promise.TypedPromise<string>
	return Http.post(`{MASTER_URL}/mkdir`, {
		path = parent,
		name = name,
	}):andThen(function(response)
		return response:decode()
	end)
end

-- Writes one snake_case setting into the running project's file at Game
-- level - used to apply tweaks made on the details page before syncing
function Discovery.setConfig(session: Session, key: string, value: any): Promise.Promise
	local protocol = Config:get("Https") and "https" or "http"

	return Http.post(`{protocol}://{session.host}:{session.port}/setConfig`, {
		level = "game",
		id = tostring(game.GameId),
		key = key,
		value = value,
	})
end

-- Asks the master to start serving the project (no-op if already running)
function Discovery.start(project: ProjectInfo): Promise.TypedPromise<Session>
	if project.running and project.host and project.port then
		return Promise.resolve({ host = project.host, port = project.port })
	end

	return Http.post(`{MASTER_URL}/startProject`, {
		path = project.path,
	}):andThen(function(response)
		return response:decode()
	end)
end

-- Writes the current place's identity into the running project's file,
-- so it auto-connects from now on
function Discovery.claim(session: Session): Promise.Promise
	local body

	if game.PlaceId ~= 0 then
		body = {
			gameId = game.GameId,
			placeId = game.PlaceId,
		}
	else
		body = {
			argonId = Discovery.ensureMarker(),
		}
	end

	return Http.post(`http://{session.host}:{session.port}/claimPlace`, body)
end

-- Asks the master to scaffold a new project for this place,
-- serve it, and hand back the session to connect to
function Discovery.create(
	name: string?,
	dir: string?,
	folder: string?
): Promise.TypedPromise<Session & { path: string }>
	local body: { [string]: any } = {
		name = if name and name ~= "" then name else game.Name,
	}

	if dir and dir ~= "" then
		body.dir = dir
	end

	if folder and folder ~= "" then
		body.folder = folder
	end

	if game.PlaceId ~= 0 then
		body.gameId = game.GameId
		body.placeId = game.PlaceId
	else
		body.argonId = Discovery.ensureMarker()
	end

	return Http.post(`{MASTER_URL}/createProject`, body):andThen(function(response)
		return response:decode()
	end)
end

return Discovery
