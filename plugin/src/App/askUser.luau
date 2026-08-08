--!strict
-- Putting a question to whoever is there to answer it.
--
-- Two of them: "apply these changes?" when a sync would cross the threshold,
-- and "this place is not the one this project claims, continue?". Both block
-- the sync loop until answered.
--
-- Split out of App/init.luau, which had reached the line cap. Worth its own
-- file anyway: the answer can now arrive from the panel or from `msync accept`,
-- and having one function own both paths is what keeps them honest — the CLI
-- fires the same signal the buttons do rather than reaching past them.

local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = script.Parent
local Pages = App.Pages
local Helpers = MuslimSync.Helpers

local Signal = require(MuslimSync.Packages.Signal)
local Bridge = require(MuslimSync.Control.Bridge)
local describeChanges = require(Helpers.describeChanges)
local Prompt = require(Pages.Prompt)

--- Asks, waits, and returns whether the answer was yes.
---
--- `changes` present means the sync prompt; absent means an identity prompt.
return function(app: any, message: string, changes: any, tree: any): boolean
	local signal = Signal.new()
	local isChanges = changes ~= nil

	local options = if isChanges then { "Accept", "Diff", "Cancel" } else { "Continue", "Cancel" }
	local text = if isChanges then describeChanges(changes) else message

	app:setIcon("Warn")

	app:setPage(Prompt {
		App = app,
		Message = text,
		Options = options,
		Signal = signal,
	})

	-- Published so `msync accept` can answer this exact prompt. It fires the
	-- same signal the buttons do, so an answer from the CLI and a click are
	-- indistinguishable from here down.
	Bridge.setPending({
		message = text,
		options = options,
		changes = changes,
		respond = function(choice: string)
			signal:Fire(choice)
		end,
	})

	local choice = signal:Wait()

	-- Opening the diff is not an answer, so the question is still standing when
	-- the window closes.
	while choice == "Diff" do
		app:diff(changes, tree)
		choice = signal:Wait()
	end

	if isChanges then
		app:diff()
	end

	Bridge.setPending(nil)

	return choice == "Accept" or choice == "Continue"
end
