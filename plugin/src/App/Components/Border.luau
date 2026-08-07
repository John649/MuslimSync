local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)

local Theme = require(App.Theme)

local Corner = require(Components.Corner)

local New = Fusion.New

type Props = {
	Color: Fusion.CanBeState<Color3>?,
	Transparency: Fusion.CanBeState<number>?,
	Thickness: Fusion.CanBeState<number>?,
	CornerRadius: Fusion.CanBeState<UDim>?,
}

return function(props: Props): { Instance }
	return {
		Corner {},
		New "UIStroke" {
			ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
			Color = props.Color or Theme.Colors.Border,
			Thickness = props.Thickness or Theme.BorderThickness,
			Transparency = props.Transparency or 0,
		},
	}
end
