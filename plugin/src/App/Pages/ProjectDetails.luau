local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components
local Util = Components.Util

local Fusion = require(MuslimSync.Packages.Fusion)
local Signal = require(MuslimSync.Packages.Signal)

local Config = require(MuslimSync.Config)
local Discovery = require(MuslimSync.Discovery)

local Theme = require(App.Theme)
local filterNumber = require(Util.filterNumber)

local ScrollingContainer = require(Components.ScrollingContainer)
local TextButton = require(Components.TextButton)
local Container = require(Components.Container)
local Checkbox = require(Components.Checkbox)
local Dropdown = require(Components.Dropdown)
local Padding = require(Components.Padding)
local Input = require(Components.Input)
local Text = require(Components.Text)
local List = require(Components.List)
local Box = require(Components.Box)

local New = Fusion.New
local Value = Fusion.Value
local Computed = Fusion.Computed
local Children = Fusion.Children
local peek = Fusion.peek

type Props = {
	App: { [string]: any },
	Project: Discovery.ProjectInfo,
	Signal: Signal.Signal,
}

-- Every project-file setting, editable before the first sync.
-- Host and Port are absent on purpose: discovery owns routing
local PREVIEW_SETTINGS = {
	{
		key = "initial_sync_priority",
		setting = "InitialSyncPriority",
		label = "Initial sync",
		options = { "Server", "Client", "None" },
	},
	{ key = "two_way_sync", setting = "TwoWaySync", label = "Two-way sync" },
	{ key = "keep_unknowns", setting = "KeepUnknowns", label = "Keep unknowns" },
	{ key = "only_code_mode", setting = "OnlyCodeMode", label = "Only code mode" },
	{ key = "syncback_properties", setting = "SyncbackProperties", label = "Syncback properties" },
	{ key = "auto_connect", setting = "AutoConnect", label = "Auto connect" },
	{ key = "auto_reconnect", setting = "AutoReconnect", label = "Auto reconnect" },
	{ key = "live_hydrate", setting = "LiveHydrate", label = "Live hydrate" },
	{ key = "open_in_editor", setting = "OpenInEditor", label = "Open in editor" },
	{ key = "override_packages", setting = "OverridePackages", label = "Override packages" },
	{
		key = "display_prompts",
		setting = "DisplayPrompts",
		label = "Display prompts",
		options = { "Always", "Initial", "Never" },
	},
	{
		key = "log_level",
		setting = "LogLevel",
		label = "Log level",
		options = { "Off", "Error", "Warn", "Info", "Debug", "Trace" },
	},
	{ key = "changes_threshold", setting = "ChangesThreshold", label = "Changes threshold", number = true },
	{ key = "diff_lines_limit", setting = "DiffLinesLimit", label = "Diff lines limit", number = true },
}

local ROW_HEIGHT = Theme.CompSizeY.Medium + 4

local function Row(label: string, control: Instance, zIndex: number): Frame
	return Container {
		Size = UDim2.new(1, 0, 0, ROW_HEIGHT),
		AutomaticSize = Enum.AutomaticSize.None,
		ZIndex = zIndex,
		[Children] = {
			Text {
				AnchorPoint = Vector2.new(0, 0.5),
				Position = UDim2.fromScale(0, 0.5),
				Text = label,
				Font = Theme.Fonts.Mono,
				TextSize = Theme.TextSize.Medium,
			},
			New "Frame" {
				AnchorPoint = Vector2.new(1, 0.5),
				Position = UDim2.fromScale(1, 0.5),
				AutomaticSize = Enum.AutomaticSize.XY,
				BackgroundTransparency = 1,
				ZIndex = zIndex,
				[Children] = control,
			},
		},
	}
end

local function NumberInput(binding: Fusion.Value<number>): Frame
	local text = Value(tostring(peek(binding)))

	return Box {
		Size = UDim2.fromOffset(70, Theme.CompSizeY.Medium),
		AutomaticSize = Enum.AutomaticSize.None,
		[Children] = {
			Input {
				Size = UDim2.fromScale(1, 1),
				Font = Theme.Fonts.Mono,
				Text = text,
				Changed = function(value)
					text:set(filterNumber(value))
				end,
				Finished = function(value)
					local number = tonumber(value)

					if number then
						binding:set(number)
					else
						text:set(tostring(peek(binding)))
					end
				end,
				[Children] = {
					Padding {
						Horizontal = 6,
					},
				},
			},
		},
	}
end

-- Confirmation page shown after picking a project: where it lives and
-- every setting that would apply to this place. Anything tweaked here
-- is written to the project file when syncing
return function(props: Props): { Instance }
	local project = props.Project
	local config = Discovery.projectConfig(project)

	local initial = {}
	local bindings = {}
	local rows = {}
	local openStates = {}

	for index, entry in PREVIEW_SETTINGS do
		local fileValue = config[entry.key]
		local value = if fileValue ~= nil then fileValue else Config:get(entry.setting)

		initial[entry.key] = value
		bindings[entry.key] = Value(value)

		local control

		if entry.options then
			local isOpen = Value(false)
			table.insert(openStates, isOpen)

			control = Dropdown {
				Options = entry.options,
				Value = bindings[entry.key],
				IsOpen = isOpen,
			}
		elseif entry.number then
			control = NumberInput(bindings[entry.key])
		else
			control = Checkbox {
				Value = bindings[entry.key],
				Placeholder = bindings[entry.key],
			}
		end

		table.insert(rows, Row(entry.label, control, #PREVIEW_SETTINGS - index + 2))
	end

	-- Dropdowns expand past the scroll viewport (the top row's options open
	-- upward, above the frame edge) - clipped pixels neither render nor take
	-- clicks, so unclip the container while any dropdown is open
	local anyDropdownOpen = Computed(function(use)
		for _, state in openStates do
			if use(state) then
				return true
			end
		end

		return false
	end)

	local status = if project.running
		then `● running on {project.host}:{project.port}`
		else "○ not running (will be started)"
	local path = (project.path:gsub("/default%.project%.json$", ""):gsub("^/Users/[^/]+", "~"))

	return {
		List {
			-- Top, not Center: these pages can be taller than the widget, and
			-- centred overflow spills upward over the header as well as off
			-- the bottom.
			VerticalAlignment = Enum.VerticalAlignment.Top,
		},
		Text {
			Text = project.name,
			Font = Theme.Fonts.Bold,
			TextSize = Theme.TextSize.Large,
		},
		Text {
			Text = `{status}\n{path}`,
			TextWrapped = true,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.fromScale(1, 0),
			Font = Theme.Fonts.Mono,
			TextSize = Theme.TextSize.Medium,
			Color = Theme.Colors.TextDimmed,
		},
		Container {
			AutomaticSize = Enum.AutomaticSize.None,
			Size = UDim2.fromScale(1, 0),
			ZIndex = 2,
			[Children] = {
				New "UIFlexItem" {
					FlexMode = Enum.UIFlexMode.Fill,
				},
				New "UISizeConstraint" {
					MinSize = Vector2.new(0, ROW_HEIGHT),
					MaxSize = Vector2.new(math.huge, #PREVIEW_SETTINGS * (ROW_HEIGHT + 2)),
				},
				ScrollingContainer {
					ScrollBar = true,
					ClipsDescendants = Computed(function(use)
						return not use(anyDropdownOpen)
					end),
					[Children] = {
						List {
							Spacing = 2,
						},
						Padding {
							Right = 10,
						},
						rows,
					},
				},
			},
		},
		Text {
			Text = Computed(function(use)
				return if use(bindings.initial_sync_priority) == "Server"
					then "! Initial sync is SERVER: the files will\n! overwrite this place when you sync"
					else ""
			end),
			TextWrapped = true,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.fromScale(1, 0),
			Font = Theme.Fonts.Mono,
			TextSize = Theme.TextSize.Medium,
		},
		Container {
			Size = UDim2.fromScale(1, 0),
			[Children] = {
				List {
					FillDirection = Enum.FillDirection.Horizontal,
					HorizontalAlignment = Enum.HorizontalAlignment.Right,
				},
				TextButton {
					Solid = true,
					LayoutOrder = 2,
					Text = "Sync",
					Activated = function()
						local changes = {}

						for _, entry in PREVIEW_SETTINGS do
							local value = peek(bindings[entry.key])

							if value ~= initial[entry.key] then
								changes[entry.key] = value
							end
						end

						props.Signal:Fire({ action = "Sync", changes = changes })
					end,
				},
				TextButton {
					LayoutOrder = 1,
					Text = "Back",
					Activated = function()
						props.Signal:Fire({ action = "Back" })
					end,
				},
			},
		},
	}
end
