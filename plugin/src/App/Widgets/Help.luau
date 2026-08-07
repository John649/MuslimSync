local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)

local Theme = require(App.Theme)

local Widget = require(Components.Plugin.Widget)
local ScrollingContainer = require(Components.ScrollingContainer)
local Padding = require(Components.Padding)
local List = require(Components.List)
local Text = require(Components.Text)
local Box = require(Components.Box)

local Children = Fusion.Children

local function Entry(body: { any })
	return Box {
		Size = UDim2.fromScale(1, 0),
		[Children] = {
			Padding {},
			List {
				Spacing = 6,
			},
			body,
		},
	}
end

local function Header(text: string)
	return Text {
		Font = Theme.Fonts.Bold,
		Text = text,
	}
end

local function Paragraph(text: string)
	return Text {
		Text = text,
		RichText = true,
		TextWrapped = true,
		TextSize = Theme.TextSize.Small,
		Color = Theme.Colors.TextDimmed,
	}
end

type Props = {
	Closed: (() -> ())?,
}

return function(props: Props): DockWidgetPluginGui
	return Widget {
		Name = "MuslimSync - Help",
		OverrideEnabled = true,
		MinimumSize = Vector2.new(400, 350),
		Closed = props.Closed,
		[Children] = {
			Padding {
				Right = 4,
			},
			ScrollingContainer {
				ScrollBar = true,
				[Children] = {
					List {
						Spacing = 22,
					},
					Padding {
						Padding = Theme.WidgetPadding,
					},
					Entry {
						Header "1. Setting up the project",
						Paragraph "Open the MuslimSync desktop app, pick a projects folder, and press <b>Create Project</b>. If this place has no project yet, you can also create one straight from the <b>Connect</b> page here.",
						Paragraph "From a terminal, <b>msync init</b> does the same thing for the current folder.",
					},
					Entry {
						Header "2. Starting the server",
						Paragraph "The desktop app starts a sync server for every project you switch on. To run one by hand instead, use <b>msync serve</b>.",
					},
					Entry {
						Header "3. Connecting to the server",
						Paragraph "To connect to the server first make sure that host name and port are the same. Then press <b>Connect</b> button and you are done!",
					},
					Entry {
						Header "4. Syncing",
						Paragraph "Now you can finally start syncing your changes. Remember to save your files in order to see the changes in Roblox Studio.",
						Paragraph "You can also enable <b>Two-Way Sync</b> in the settings to sync changes made in studio back to the file system.",
					},
				},
			},
		},
	}
end
