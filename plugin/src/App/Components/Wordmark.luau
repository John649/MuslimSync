-- The MuslimSync wordmark row: mark, product name, and version.
--
-- Replaces Argon's uploaded banner image, which we have no right to ship under
-- our own name. Drawing it also means the mark tracks the theme.
--
-- Every size here is explicit. `Container` defaults to AutomaticSize.Y, and an
-- auto-sizing container holding a child positioned at scale y=1 resolves
-- circularly — that combination inflated this row into a few hundred pixels of
-- empty space. Nothing in this file auto-sizes on Y, and the version sits in
-- the layout rather than being pinned to a corner.

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

type Props = {
	Version: string?,
}

return function(props: Props): Frame
	props = props or {}

	return Container {
		AutomaticSize = Enum.AutomaticSize.None,
		Size = UDim2.new(1, 0, 0, MARK_SIZE),
		[Children] = {
			List {
				FillDirection = Enum.FillDirection.Horizontal,
				VerticalAlignment = Enum.VerticalAlignment.Center,
				Spacing = 8,
			},

			-- Mark and name travel together; the version is pushed to the far
			-- end by the flex spacer between them.
			Container {
				AutomaticSize = Enum.AutomaticSize.X,
				Size = UDim2.new(0, 0, 1, 0),
				LayoutOrder = 1,
				[Children] = {
					List {
						FillDirection = Enum.FillDirection.Horizontal,
						VerticalAlignment = Enum.VerticalAlignment.Center,
						Spacing = 8,
					},
					New("Frame") {
						LayoutOrder = 1,
						Size = UDim2.fromOffset(MARK_SIZE, MARK_SIZE),
						BackgroundColor3 = Theme.Colors.Brand,
						BorderSizePixel = 0,
						[Children] = {
							Corner {},
							Text {
								-- The shared Text component hardcodes
								-- TextXAlignment.Left and AutomaticSize.XY, so
								-- both have to be undone for the glyph to sit
								-- in the middle of the mark.
								AutomaticSize = Enum.AutomaticSize.None,
								Size = UDim2.fromScale(1, 1),
								BackgroundTransparency = 1,
								-- The meem renders through Studio's font
								-- fallback; no bundled Arabic face needed.
								Text = "\u{0645}",
								TextSize = Theme.TextSize.Medium,
								TextXAlignment = Enum.TextXAlignment.Center,
								TextYAlignment = Enum.TextYAlignment.Center,
								Color = Theme.Colors.TextBranded,
							},
						},
					},
					Text {
						LayoutOrder = 2,
						Text = "MuslimSync",
						Font = Theme.Fonts.Bold,
						TextSize = Theme.TextSize.Large,
						Color = Theme.Colors.Text,
					},
				},
			},

			New("Frame") {
				LayoutOrder = 2,
				Size = UDim2.new(0, 0, 1, 0),
				BackgroundTransparency = 1,
				BorderSizePixel = 0,
				[Children] = New("UIFlexItem") {
					FlexMode = Enum.UIFlexMode.Fill,
				},
			},

			if props.Version
				then Text {
					LayoutOrder = 3,
					Text = `v{props.Version}`,
					TextSize = Theme.TextSize.Small,
					Color = Theme.Colors.TextDimmed,
				}
				else nil,
		},
	}
end
