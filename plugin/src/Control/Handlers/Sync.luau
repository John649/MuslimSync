--!strict
-- The sync session, driven from outside Studio.
--
-- The panel could always do this; the CLI could not, and that asymmetry cost
-- real time. A reorganization crosses the changes threshold, Studio raises a
-- modal, and an agent working headlessly has no way to see it, read it, or
-- answer it — the sync sits there, or drops.
--
-- These ops answer the prompt through the same signal the buttons fire, so
-- there is no second path that could accept something the panel would refuse.

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Bridge = require(MuslimSync.Control.Bridge)
local Changes = require(MuslimSync.Core.Changes)
local Discovery = require(MuslimSync.Discovery)

-- Enough to decide by, not so much that a reorganization floods the terminal.
local MAX_LISTED = 200

local function named(object: any, tree: any): string
	if typeof(object) == "buffer" then
		local instance = tree and tree:getInstance(object)
		return typeof(instance) == "Instance" and instance:GetFullName() or "?"
	end

	if typeof(object) == "Instance" then
		return object:GetFullName()
	end

	return tostring(typeof(object) == "table" and object.name or object)
end

local function summarize(changes: any)
	return {
		additions = #changes.additions,
		updates = #changes.updates,
		removals = #changes.removals,
		total = Changes.Total(changes),
	}
end

--- The changed instances by name, capped, with a count of what was cut.
local function detail(changes: any, tree: any)
	local listed, truncated = {}, 0

	local function take(kind: string, objects: { any })
		for _, object in objects do
			if #listed >= MAX_LISTED then
				truncated += 1
				continue
			end

			table.insert(listed, { kind = kind, name = named(object, tree) })
		end
	end

	take("addition", changes.additions)
	take("update", changes.updates)
	take("removal", changes.removals)

	return listed, truncated
end

local function tree(): any
	local app = Bridge.app()
	return app and app.core and app.core.tree
end

return function(_context)
	local function respond(choice: string)
		local entry = Bridge.pending()

		if not entry then
			return { answered = false, reason = "no prompt is waiting" }
		end

		if not table.find(entry.options, choice) then
			return {
				answered = false,
				reason = `this prompt takes {table.concat(entry.options, ", ")}, not "{choice}"`,
			}
		end

		entry.respond(choice)

		return { answered = true, choice = choice }
	end

	return {
		--- Whether a sync is running, and whether it is blocked on a prompt.
		sync_status = function()
			local app = Bridge.app()
			local entry = Bridge.pending()

			return {
				connected = app ~= nil and app:isConnected() == true,
				host = app and app.host or nil,
				port = app and app.port or nil,
				waiting = entry ~= nil,
				prompt = entry and {
					message = entry.message,
					options = entry.options,
					changes = entry.changes and summarize(entry.changes) or nil,
				} or nil,
			}
		end,

		--- What the pending prompt would apply, instance by instance.
		sync_changes = function()
			local entry = Bridge.pending()

			if not entry then
				return { waiting = false, listed = {}, truncated = 0 }
			end

			if not entry.changes then
				return { waiting = true, message = entry.message, listed = {}, truncated = 0 }
			end

			local listed, truncated = detail(entry.changes, tree())

			return {
				waiting = true,
				message = entry.message,
				changes = summarize(entry.changes),
				listed = listed,
				truncated = truncated,
			}
		end,

		--- Answers the waiting prompt yes.
		---
		--- The changes prompt says "Accept" and the identity prompts say
		--- "Continue". The caller should not have to know which one it got, so
		--- this picks whichever word this prompt actually understands.
		sync_accept = function()
			local entry = Bridge.pending()
			local choice = entry and table.find(entry.options, "Accept") and "Accept" or "Continue"

			return respond(choice)
		end,

		sync_cancel = function()
			return respond("Cancel")
		end,

		--- Starts a project's server if needed and attaches this place to it.
		sync_connect = function(args)
			local app = Bridge.app()

			if not app then
				return { started = false, reason = "the panel is not loaded" }
			end

			local wanted = args and args.project

			if not wanted then
				-- No name given: connect to whatever this place already matches,
				-- which is what the panel's auto-connect does.
				app:discover(true)
				return { started = true, project = nil }
			end

			local ok, projects = Discovery.getProjects():await()

			if not ok then
				return { started = false, reason = "could not reach the master to list projects" }
			end

			for _, project in projects do
				if project.name == wanted or tostring(project.id) == tostring(wanted) then
					app:startAndConnect(project)
					return { started = true, project = project.name }
				end
			end

			return { started = false, reason = `no project named "{wanted}"` }
		end,

		sync_disconnect = function()
			local app = Bridge.app()

			if not app then
				return { disconnected = false, reason = "the panel is not loaded" }
			end

			app:disconnect(true)
			app:home()

			return { disconnected = true }
		end,

		--- The projects the master knows about, as the picker sees them.
		sync_projects = function()
			local ok, projects = Discovery.getProjects():await()

			if not ok then
				return { projects = {}, reason = "could not reach the master" }
			end

			return { projects = projects }
		end,
	}
end
