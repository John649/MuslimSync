local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)
local Signal = require(MuslimSync.Packages.Signal)

local Discovery = require(MuslimSync.Discovery)
local Log = require(MuslimSync.Log)

local Theme = require(App.Theme)

local ScrollingContainer = require(Components.ScrollingContainer)
local TextButton = require(Components.TextButton)
local Container = require(Components.Container)
local Padding = require(Components.Padding)
local Input = require(Components.Input)
local List = require(Components.List)
local Text = require(Components.Text)
local Box = require(Components.Box)

local New = Fusion.New
local Value = Fusion.Value
local Spring = Fusion.Spring
local Computed = Fusion.Computed
local Children = Fusion.Children
local ForValues = Fusion.ForValues
local cleanup = Fusion.cleanup
local peek = Fusion.peek

type Props = {
	App: { [string]: any },
	Signal: Signal.Signal,
}

-- Strip whitespace and the surrounding quotes Windows' "Copy as path" adds
local function cleanPath(text: string): string
	return (text:gsub("^%s+", ""):gsub("%s+$", ""):gsub('^"', ""):gsub('"$', ""))
end

local function shorten(path: string): string
	return (path:gsub("^/Users/[^/]+", "~"))
end

local function Field(
	label: string,
	binding: Fusion.Value<string>,
	onSubmit: ((text: string, enterPressed: boolean?) -> ())?
): Frame
	local focused = Value(false)

	return Container {
		Size = UDim2.fromScale(1, 0),
		[Children] = {
			List {
				Spacing = 4,
			},
			Text {
				Text = label,
				Font = Theme.Fonts.Bold,
				TextSize = Theme.TextSize.Medium,
			},
			Box {
				Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Large),
				AutomaticSize = Enum.AutomaticSize.None,
				BorderColor = Spring(
					Computed(function(use)
						if use(focused) then
							return use(Theme.Colors.Brand)
						else
							return use(Theme.Colors.Border)
						end
					end),
					Theme.SpringFastSpeed,
					Theme.SpringDamping
				),
				[Children] = {
					Input {
						Size = UDim2.fromScale(1, 1),
						Font = Theme.Fonts.Mono,
						Text = binding,
						Started = function()
							focused:set(true)
						end,
						Changed = function(text)
							binding:set(text)
						end,
						Finished = function(text, enterPressed)
							focused:set(false)

							if onSubmit then
								onSubmit(text, enterPressed)
							end
						end,
						[Children] = {
							Padding {
								Horizontal = Theme.Padding,
							},
							New "UIFlexItem" {
								FlexMode = Enum.UIFlexMode.Fill,
							},
						},
					},
				},
			},
		},
	}
end

-- Pick an old project that is not in the master's registry yet: paste
-- its path (Enter navigates there) or browse the roots; ● rows are
-- project folders and selecting one adds & starts it
return function(props: Props): { Instance }
	local pathInput = Value("")

	local rows = Value({})
	local currentDir = Value("")

	local function applyBrowse(response)
		currentDir:set(response.path)

		if response.path ~= "" then
			pathInput:set(shorten(response.path))
		end

		local newRows = {}

		if response.parent then
			table.insert(newRows, { label = "↑  ..", path = response.parent, isProject = false })
		elseif response.path ~= "" then
			-- At a root: go back up to the roots overview (empty path)
			table.insert(newRows, { label = "↑  ..", path = "", isProject = false })
		end

		for _, entry in response.entries do
			table.insert(newRows, {
				label = (entry.isProject and "● " or "▸ ") .. entry.name,
				path = entry.path,
				isProject = entry.isProject,
			})
		end

		rows:set(newRows)
	end

	local function navigate(path: string?)
		Discovery.browse(path):andThen(applyBrowse):catch(function(err)
			Log.warn("Cannot open directory:", err)

			local current = peek(currentDir)

			if current ~= "" then
				pathInput:set(shorten(current))
			end
		end)
	end

	navigate(nil)

	return {
		List {
			-- Top, not Center: these pages can be taller than the widget, and
			-- centred overflow spills upward over the header as well as off
			-- the bottom.
			VerticalAlignment = Enum.VerticalAlignment.Top,
		},
		Text {
			Text = "Add an existing MuslimSync project:",
			RichText = true,
			TextWrapped = true,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.fromScale(1, 0),
			Font = Theme.Fonts.Mono,
			TextSize = Theme.TextSize.Medium,
		},
		Field("Path", pathInput, function(text, enterPressed)
			local path = cleanPath(text)

			if enterPressed and path ~= "" then
				navigate(path)
			end
		end),
		Container {
			AutomaticSize = Enum.AutomaticSize.None,
			Size = UDim2.fromScale(1, 0),
			[Children] = {
				New "UIFlexItem" {
					FlexMode = Enum.UIFlexMode.Fill,
				},
				New "UISizeConstraint" {
					MinSize = Vector2.new(0, Theme.CompSizeY.Medium + 4),
					MaxSize = Computed(function(use)
						local count = math.max(#use(rows), 1)
						return Vector2.new(math.huge, count * (Theme.CompSizeY.Medium + 2) + 4)
					end),
				},
				ScrollingContainer {
					ScrollBar = true,
					[Children] = {
						List {
							Spacing = 2,
						},
						Padding {
							Right = 10,
						},
						ForValues(rows, function(_, row)
							return TextButton {
								Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium),
								TextXAlignment = Enum.TextXAlignment.Left,
								TextTruncate = Enum.TextTruncate.AtEnd,
								Text = `  {row.label}`,
								Activated = function()
									if row.isProject then
										props.Signal:Fire({ path = row.path })
									else
										navigate(row.path)
									end
								end,
							}
						end, cleanup),
					},
				},
			},
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
					Text = "Add",
					Activated = function()
						local path = cleanPath(peek(pathInput))

						if path ~= "" then
							props.Signal:Fire({ path = path })
						end
					end,
				},
				TextButton {
					LayoutOrder = 1,
					Text = "Cancel",
					Activated = function()
						props.Signal:Fire(nil)
					end,
				},
			},
		},
	}
end
