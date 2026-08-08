--!strict
-- The App, reachable from the control channel.
--
-- The plugin's panel and the CLI are two front doors onto one session, and
-- until now only the panel could answer a sync prompt. That made a headless
-- agent's sync unattendable: a reorganization crosses the changes threshold,
-- Studio raises a modal nobody is sitting in front of, and the run stalls or
-- disconnects. Everything the panel can do, the CLI should be able to do.
--
-- A registry rather than a require: Control loads before App and must not
-- depend on it, and there is exactly one App per DataModel.

local Bridge = {}

local app: any = nil
local pending: any = nil

function Bridge.setApp(value: any)
	app = value
end

function Bridge.app(): any
	return app
end

--- Records a prompt the panel is currently blocked on.
---
--- `respond` takes the option string the panel would have sent, so a CLI answer
--- and a click travel the identical path — there is no second code path that
--- could accept changes the panel would have refused.
function Bridge.setPending(entry: { message: string, options: { string }, changes: any, respond: (string) -> () }?)
	pending = entry
end

function Bridge.pending(): any
	return pending
end

return Bridge
