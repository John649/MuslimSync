-- The MuslimSync wordmark, drawn rather than imaged.
--
-- The banner it replaces was Argon's uploaded artwork, which we have no right
-- to ship under our own name. Drawing it also means the mark tracks the theme
-- and needs no asset upload to change.
--
-- Mirrors the desktop app's brand mark: a rounded brand-coloured square
-- carrying the Arabic meem, then the product name.

local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)

local Theme = require(App.Theme)

local Container = require(Components.Container)
local Corner = require(Components.Corner)
local List = require(Components.List)
local Text = require(Components.Text)

local New = Fusion.New
local Children = Fusion.Children

local MARK_SIZE = 26

return function(): Frame
	return Container {
		Size = UDim2.new(1, 0, 0, MARK_SIZE),
		[Children] = {
			List {
				FillDirection = Enum.FillDirection.Horizontal,
				VerticalAlignment = Enum.VerticalAlignment.Center,
				Spacing = 8,
			},
			New("Frame") {
				Size = UDim2.fromOffset(MARK_SIZE, MARK_SIZE),
				BackgroundColor3 = Theme.Colors.Brand,
				[Children] = {
					Corner {},
					Text {
						Size = UDim2.fromScale(1, 1),
						BackgroundTransparency = 1,
						-- The meem renders through Studio's font fallback; it
						-- needs no bundled Arabic face at this size.
						Text = "\u{0645}",
						TextSize = Theme.TextSize.Medium,
						Color = Theme.Colors.TextBranded,
					},
				},
			},
			Text {
				AutomaticSize = Enum.AutomaticSize.X,
				Size = UDim2.fromScale(0, 1),
				Text = "MuslimSync",
				Font = Theme.Fonts.Bold,
				TextSize = Theme.TextSize.Large,
				TextXAlignment = Enum.TextXAlignment.Left,
				Color = Theme.Colors.Text,
			},
		},
	}
end
