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

local DEFAULT_DIR = "~/projects/Scratch"

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

local function shorten(path: string): string
	return (path:gsub("^/Users/[^/]+", "~"))
end

return function(props: Props): { Instance }
	-- Bound to a local first: selene's Roblox standard library types `game.Name`
	-- as a plain property and rejects calling a string method directly on it.
	local placeName: string = game.Name
	local nameInput = Value(placeName)
	local folderInput = Value((placeName:gsub("[^%w _-]", "")) .. "MuslimSync")
	local dirInput = Value(DEFAULT_DIR)
	local newFolderName = Value("")

	-- Directory browser fed by the master (locked to project_roots)
	local rows = Value({})
	local currentDir = Value("")

	local function applyBrowse(response)
		currentDir:set(response.path)

		if response.path ~= "" then
			dirInput:set(shorten(response.path))
		end

		local newRows = {}

		if response.parent then
			table.insert(newRows, { label = "↑  ..", path = response.parent })
		elseif response.path ~= "" then
			-- At a root: go back up to the roots overview (empty path)
			table.insert(newRows, { label = "↑  ..", path = "" })
		end

		for _, entry in response.entries do
			table.insert(newRows, {
				label = (entry.isProject and "● " or "▸ ") .. entry.name,
				path = entry.path,
			})
		end

		rows:set(newRows)
	end

	local function navigate(path: string?)
		Discovery.browse(path):andThen(applyBrowse):catch(function(err)
			if path then
				-- e.g. the default Scratch dir doesn't exist yet
				navigate(nil)
			else
				Log.warn("Failed to browse directories:", err)
			end
		end)
	end

	-- Typed into the Directory field + Enter: browse there, or warn and
	-- revert to the last good location (never fall back to the roots list)
	local function submitDir(text: string)
		Discovery.browse(text):andThen(applyBrowse):catch(function(err)
			Log.warn("Cannot open directory:", err)

			local current = peek(currentDir)
			dirInput:set(current ~= "" and shorten(current) or DEFAULT_DIR)
		end)
	end

	navigate(DEFAULT_DIR)

	return {
		List {
			VerticalAlignment = Enum.VerticalAlignment.Center,
		},
		Text {
			Text = "Create an MuslimSync project for this place. If the folder already exists, it is adopted instead:",
			RichText = true,
			TextWrapped = true,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.fromScale(1, 0),
			Font = Theme.Fonts.Mono,
			TextSize = Theme.TextSize.Medium,
		},
		Field("Project name", nameInput),
		Field("Folder name", folderInput),
		Field("Directory", dirInput, function(text, enterPressed)
			-- Enter-only: clicking away (e.g. onto a folder row) must not navigate
			if enterPressed and text:gsub("%s", "") ~= "" then
				submitDir((text:gsub("^%s+", ""):gsub("%s+$", "")))
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
					-- Grow with the row count, then stop - leftover space
					-- recenters the form instead of stretching the browser
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
									navigate(row.path)
								end,
							}
						end, cleanup),
					},
				},
			},
		},
		Container {
			Size = UDim2.new(1, 0, 0, Theme.CompSizeY.Medium + 4),
			AutomaticSize = Enum.AutomaticSize.None,
			[Children] = {
				List {
					Spacing = 6,
					FillDirection = Enum.FillDirection.Horizontal,
					VerticalAlignment = Enum.VerticalAlignment.Center,
				},
				Box {
					Size = UDim2.new(1, -90, 0, Theme.CompSizeY.Medium),
					AutomaticSize = Enum.AutomaticSize.None,
					[Children] = {
						Input {
							Size = UDim2.fromScale(1, 1),
							Font = Theme.Fonts.Mono,
							PlaceholderText = "New folder name",
							Text = newFolderName,
							Changed = function(text)
								newFolderName:set(text)
							end,
							[Children] = {
								Padding {
									Horizontal = 6,
								},
							},
						},
					},
				},
				TextButton {
					Size = UDim2.fromOffset(84, Theme.CompSizeY.Medium),
					Text = "+ Folder",
					Activated = function()
						local name = peek(newFolderName)
						local parent = peek(currentDir)

						if name == "" or parent == "" then
							return
						end

						Discovery.mkdir(parent, name)
							:andThen(function()
								newFolderName:set("")
								navigate(parent)
							end)
							:catch(function(err)
								Log.warn("Failed to create folder:", err)
							end)
					end,
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
					Text = "Create",
					Activated = function()
						props.Signal:Fire({
							name = peek(nameInput),
							dir = peek(dirInput),
							folder = peek(folderInput),
						})
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
