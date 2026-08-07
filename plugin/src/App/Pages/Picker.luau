local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)
local Signal = require(MuslimSync.Packages.Signal)

local Theme = require(App.Theme)

local ScrollingContainer = require(Components.ScrollingContainer)
local TextButton = require(Components.TextButton)
local Container = require(Components.Container)
local Padding = require(Components.Padding)
local Text = require(Components.Text)
local List = require(Components.List)

local New = Fusion.New
local ForPairs = Fusion.ForPairs
local Children = Fusion.Children
local cleanup = Fusion.cleanup

export type Option = {
	label: string,
	detail: string?,
	solid: boolean?,
	-- The project already linked to this place - gets a brand outline
	matched: boolean?,
	[any]: any,
}

type Props = {
	App: { [string]: any },
	Message: string,
	Options: { Option },
	Signal: Signal.Signal,
}

local SPACING = 4

local function escape(text: string): string
	return (text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

-- Vertical menu of options; entries with a `detail` get a second,
-- dimmed line (used to disambiguate same-name projects). The list
-- flex-grows up to its natural height, then the block centers in the
-- leftover space; it only scrolls when the widget is genuinely too small
return function(props: Props): { Instance }
	local function optionHeight(option: Option): number
		return if option.detail then Theme.CompSizeY.Large + 14 else Theme.CompSizeY.Large
	end

	local needed = 0
	for _, option in props.Options do
		needed += optionHeight(option) + SPACING
	end

	return {
		List {
			-- Top, not Center: these pages can be taller than the widget, and
			-- centred overflow spills upward over the header as well as off
			-- the bottom.
			VerticalAlignment = Enum.VerticalAlignment.Top,
		},
		Text {
			Text = props.Message,
			TextWrapped = true,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.fromScale(1, 0),
			Font = Theme.Fonts.Mono,
			TextSize = Theme.TextSize.Medium,
		},
		Container {
			AutomaticSize = Enum.AutomaticSize.None,
			Size = UDim2.fromScale(1, 0),
			[Children] = {
				New "UIFlexItem" {
					FlexMode = Enum.UIFlexMode.Fill,
				},
				New "UISizeConstraint" {
					MinSize = Vector2.new(0, Theme.CompSizeY.Large),
					MaxSize = Vector2.new(math.huge, needed),
				},
				ScrollingContainer {
					ScrollBar = true,
					[Children] = {
						List {
							Spacing = SPACING,
						},
						Padding {
							Right = 10,
						},
						ForPairs(props.Options, function(_, index, option)
							local text = escape(option.label)

							if option.detail then
								text = `{text}\n<font size="{Theme.TextSize.Small}" transparency="0.4">{escape(
									option.detail
								)}</font>`
							end

							return index,
								TextButton {
									LayoutOrder = index,
									Size = UDim2.new(1, 0, 0, optionHeight(option)),
									RichText = true,
									TextTruncate = Enum.TextTruncate.AtEnd,
									TextXAlignment = Enum.TextXAlignment.Left,
									Text = `  {text}`,
									Solid = option.solid,
									Activated = function()
										props.Signal:Fire(option)
									end,
									[Children] = if option.matched
										then New "UIStroke" {
											Color = Theme.Colors.Brand,
											Thickness = 1.5,
										}
										else nil,
								}
						end, cleanup),
					},
				},
			},
		},
	}
end
