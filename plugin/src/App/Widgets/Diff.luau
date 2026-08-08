local MuslimSync = script:FindFirstAncestor("MuslimSync")
local App = MuslimSync.App
local Widgets = App.Widgets
local Components = App.Components

local Fusion = require(MuslimSync.Packages.Fusion)

local GlobalUtil = require(MuslimSync.Util)
local Types = require(MuslimSync.Types)
local Theme = require(App.Theme)
local Assets = require(App.Assets)

local ScriptDiff = require(Widgets.ScriptDiff)
local DiffFormat = require(Widgets.DiffFormat)
local Widget = require(Components.Plugin.Widget)
local ScrollingContainer = require(Components.ScrollingContainer)
local Collapsible = require(Components.Collapsible)
local Container = require(Components.Container)
local Padding = require(Components.Padding)
local Image = require(Components.Image)
local List = require(Components.List)
local Text = require(Components.Text)

local New = Fusion.New
local Value = Fusion.Value
local OnEvent = Fusion.OnEvent
local Cleanup = Fusion.Cleanup
local Children = Fusion.Children
local Computed = Fusion.Computed
local ForValues = Fusion.ForValues
local cleanup = Fusion.cleanup
local peek = Fusion.peek

type SectionProps = {
	Title: string,
	Color: Color3,
	Elements: { { any } },
}

local function Section(props: SectionProps)
	return Collapsible {
		Title = props.Title,
		Color = props.Color,
		Expanded = true,
		Elements = ForValues(props.Elements, function(_, element)
			return Container {
				Size = UDim2.fromScale(1, 0),
				[Children] = {
					New "Frame" {
						Size = UDim2.new(1, 0, 0, Theme.BorderThickness),
						BackgroundColor3 = Theme.Colors.Border,
						BorderSizePixel = 0,
					},
					Container {
						Size = UDim2.fromScale(1, 1),
						[Children] = {
							List {
								Spacing = 0,
							},
							Padding {},
							element,
						},
					},
				},
			}
		end, cleanup),
	}
end

type TitleProps = {
	Symbol: string,
	Name: string,
	Class: string,
	Color: Color3,
}

local function Title(props: TitleProps)
	return Text {
		Text = `{props.Symbol} [{props.Class}] {props.Name}`,
		Color = props.Color,
		TextSize = Theme.TextSize.Small,
		Font = Theme.Fonts.Mono,
		TextWrapped = true,
	}
end

type PropertyProps = {
	Name: string,
	Old: any,
	New: any?,
	Script: string?,
}

local function Property(props: PropertyProps)
	local isHovered = Value(false)
	local scriptDiffWidget = Value(nil)

	local isScript = props.Script ~= nil
	local text

	if isScript and props.New then
		local delta = DiffFormat.countLines(props.New) - DiffFormat.countLines(props.Old)
		local sign = if delta > 0 then "+" elseif delta < 0 then "-" else "~"

		delta = math.abs(delta)

		text = `<b>{sign}{delta} line{GlobalUtil.plural(delta)}</b>`
	elseif isScript then
		local lines = DiffFormat.countLines(props.Old)
		text = `<b>{lines} line{GlobalUtil.plural(lines)}</b>`
	elseif props.New then
		text = `<b>{props.Old}</b> → <b>{props.New}</b>`
	else
		text = `<b>{props.Old}</b>`
	end

	return Text {
		Text = Computed(function(use)
			return if use(isHovered) or use(scriptDiffWidget)
				then `    <u>{props.Name}: {text}  </u>`
				else `    {props.Name}: {text}  `
		end),
		Color = Theme.Colors.TextDimmed,
		TextSize = Theme.TextSize.Small,
		Font = Theme.Fonts.Mono,
		TextWrapped = true,
		RichText = true,
		[OnEvent "InputBegan"] = function(inputObject)
			if not isScript then
				return
			end

			if inputObject.UserInputType == Enum.UserInputType.MouseMovement then
				isHovered:set(true)
				return
			elseif inputObject.UserInputType ~= Enum.UserInputType.MouseButton1 then
				return
			end

			local widget = peek(scriptDiffWidget)

			if widget then
				widget:Destroy()
				widget = nil
			else
				widget = ScriptDiff {
					Name = props.Script,
					OldSource = props.Old,
					NewSource = props.New,
					Closed = function()
						peek(scriptDiffWidget):Destroy()
						scriptDiffWidget:set(nil)
					end,
				}
			end

			scriptDiffWidget:set(widget)
		end,
		[OnEvent "InputEnded"] = function(inputObject)
			if isScript and inputObject.UserInputType == Enum.UserInputType.MouseMovement then
				isHovered:set(false)
			end
		end,
		[Cleanup] = function()
			local widget = peek(scriptDiffWidget)

			if widget then
				widget:Destroy()
				widget = nil
			end
		end,
		[Children] = isScript and Container {
			AnchorPoint = Vector2.new(1, 0),
			Position = UDim2.fromScale(1, 0),
			Size = UDim2.fromOffset(Theme.TextSize.Small, Theme.TextSize.Small),
			[Children] = {
				Image {
					AnchorPoint = Vector2.new(0, 0.5),
					Position = UDim2.fromScale(0.3, 0.55),
					Size = UDim2.fromScale(0.6, 0.6),
					Image = Assets.Icons.External,
					ImageColor3 = Theme.Colors.Text,
				},
			},
		} or nil,
	}
end

local function Additions(snapshots: { Types.AddedSnapshot }, tree: any)
	local elements = {}

	for _, snapshot in snapshots do
		local parent = tree:getInstance(snapshot.parent)
		local name = snapshot.name

		if parent then
			name = parent:GetFullName() .. "." .. name
		end

		local element = {
			Title {
				Symbol = "+",
				Name = name,
				Class = snapshot.class,
				Color = Theme.Colors.Diff.Add,
			},
		}

		local descendants = DiffFormat.countDescendants(snapshot)
		if descendants > 0 then
			table.insert(
				element,
				Property({
					Name = "Descendants",
					Old = descendants,
				})
			)
		end

		local source = DiffFormat.getSnapshotSource(snapshot)
		if source then
			table.insert(
				element,
				Property({
					Name = "Source",
					Old = source,
					Script = name,
				})
			)
		end

		table.insert(elements, element)
	end

	return Section {
		Title = `Additions ({#snapshots})`,
		Color = Theme.Colors.Diff.Add,
		Elements = elements,
	}
end

local function Updates(snapshots: { Types.UpdatedSnapshot }, tree: any)
	local elements = {}

	for _, snapshot in snapshots do
		local instance = tree:getInstance(snapshot.id)
		local name = instance and instance:GetFullName() or snapshot.name or "?"

		local element = {
			Title {
				Symbol = "~",
				Name = name,
				Class = instance and instance.ClassName or snapshot.class or "?",
				Color = Theme.Colors.Diff.Update,
			},
		}

		for property, value in snapshot.properties or {} do
			if property == "Source" then
				local old = instance and DiffFormat.getInstanceSource(instance) or ""
				local new = DiffFormat.getSnapshotSource(snapshot) or ""

				table.insert(
					element,
					Property({
						Name = property,
						Old = old,
						New = new,
						Script = name,
					})
				)

				continue
			end

			local formatted, raw = "?", nil

			if instance then
				formatted, raw = DiffFormat.formatInstanceValue(instance, property)
			end

			table.insert(
				element,
				Property({
					Name = property,
					Old = formatted,
					New = DiffFormat.formatSnapshotValue(value, raw),
				})
			)
		end

		if snapshot.name and instance and instance.Name ~= snapshot.name then
			table.insert(
				element,
				Property({
					Name = "Name",
					Old = instance.Name,
					New = snapshot.name,
				})
			)
		end

		table.insert(elements, element)
	end

	return Section {
		Title = `Updates ({#snapshots})`,
		Color = Theme.Colors.Diff.Update,
		Elements = elements,
	}
end

local function Removals(objects: { Types.Ref | Instance }, tree: any)
	local elements = {}

	for _, object in objects do
		-- A removal arrives either as the instance itself or as a Ref, which is
		-- a buffer. Resolve it before anything reads a property off it: asking a
		-- buffer for GetFullName throws, and this runs inside the sync loop's
		-- verify step, so the throw took the whole session down rather than
		-- spoiling one row of the diff.
		local instance = object
		if typeof(object) == "buffer" then
			instance = tree:getInstance(object)
		end

		-- A ref that no longer resolves is normal here — the instance being
		-- described is the one going away.
		if typeof(instance) ~= "Instance" then
			instance = nil
		end

		local name = instance and instance:GetFullName() or "?"

		local element = {
			Title {
				Symbol = "-",
				Name = name,
				Class = instance and instance.ClassName or "?",
				Color = Theme.Colors.Diff.Remove,
			},
		}

		local descendants = instance and #instance:GetDescendants() or 0
		if descendants > 0 then
			table.insert(
				element,
				Property({
					Name = "Descendants",
					Old = descendants,
				})
			)
		end

		local source = instance and DiffFormat.getInstanceSource(instance)
		if source then
			table.insert(
				element,
				Property({
					Name = "Source",
					Old = source,
					Script = name,
				})
			)
		end

		table.insert(elements, element)
	end

	return Section {
		Title = `Removals ({#objects})`,
		Color = Theme.Colors.Diff.Remove,
		Elements = elements,
	}
end

type Props = {
	Changes: Types.Changes,
	Tree: any,
	Closed: (() -> ())?,
}

return function(props: Props): DockWidgetPluginGui
	local changes = props.Changes
	local tree = props.Tree
	local entries = {}

	if #changes.additions > 0 then
		table.insert(entries, Additions(changes.additions, tree))
	end

	if #changes.updates > 0 then
		table.insert(entries, Updates(changes.updates, tree))
	end

	if #changes.removals > 0 then
		table.insert(entries, Removals(changes.removals, tree))
	end

	return Widget {
		Name = "MuslimSync - Diff",
		OverrideEnabled = true,
		MinimumSize = Vector2.new(500, 400),
		Closed = props.Closed,
		[Children] = {
			Padding {
				Right = 4,
			},
			ScrollingContainer {
				ScrollBar = true,
				[Children] = {
					List {},
					Padding {
						Padding = Theme.WidgetPadding,
					},
					entries,
				},
			},
		},
	}
end
