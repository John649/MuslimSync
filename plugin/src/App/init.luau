local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local plugin = script:FindFirstAncestorWhichIsA("Plugin")

local MuslimSync = script:FindFirstAncestor("MuslimSync")
local Packages = MuslimSync.Packages
local Helpers = MuslimSync.Helpers

local Components = script.Components
local Widgets = script.Widgets
local Pages = script.Pages

local Fusion = require(Packages.Fusion)
local Signal = require(Packages.Signal)
local Promise = require(Packages.Promise)

local manifest = require(MuslimSync.manifest)
local Config = require(MuslimSync.Config)
local Types = require(MuslimSync.Types)
local Util = require(MuslimSync.Util)
local Core = require(MuslimSync.Core)
local Log = require(MuslimSync.Log)
local Discovery = require(MuslimSync.Discovery)
local describeChanges = require(Helpers.describeChanges)

local Assets = require(script.Assets)
local Loader = require(script.Loader)
local Theme = require(script.Theme)

local Toolbar = require(Components.Plugin.Toolbar)
local ToolbarButton = require(Components.Plugin.ToolbarButton)
local Widget = require(Components.Plugin.Widget)
local Container = require(Components.Container)
local Wordmark = require(Components.Wordmark)
local Padding = require(Components.Padding)
local Text = require(Components.Text)
local List = require(Components.List)

local NotConnected = require(Pages.NotConnected)
local Picker = require(Pages.Picker)
local CreateProject = require(Pages.CreateProject)
local AddProject = require(Pages.AddProject)
local ProjectDetails = require(Pages.ProjectDetails)
local Connecting = require(Pages.Connecting)
local Connected = require(Pages.Connected)
local Unavailable = require(Pages.Unavailable)
local Prompt = require(Pages.Prompt)
local Error = require(Pages.Error)

local Settings = require(Widgets.Settings)
local Help = require(Widgets.Help)
local Diff = require(Widgets.Diff)

local New = Fusion.New
local Value = Fusion.Value
local Spring = Fusion.Spring
local OnEvent = Fusion.OnEvent
local OnChange = Fusion.OnChange
local Observer = Fusion.Observer
local Computed = Fusion.Computed
local Children = Fusion.Children
local cleanup = Fusion.cleanup
local peek = Fusion.peek

local RECONNECT_INTERVAL = 5
local DISCOVER_INTERVAL = 3

local App = {}
App.__index = App

function App.new()
	Loader.load()

	local self = setmetatable({}, App)

	-- Ship Info/Warn/Error logs to the master so diagnostics survive
	-- Studio closing (persisted in ~/.argon/logs/plugin.log)
	Log.__reporter = Discovery.reportLog

	self.core = nil
	self.lastUpdate = os.clock()
	self.onCanceled = Signal.new()
	self.pollScheduled = false

	self.host = Config:get("Host")
	self.port = Config:get("Port")

	self.lastSync = Value(os.time())
	self.lastSyncKind = Value("Unknown")

	-- Minimum widget size - the picker, details and create pages need
	-- vertical room, so don't let the panel collapse below usability
	self.rootSize = Value(Vector2.new(320, 400))
	self.icon = Value(Assets.Brand.Logo)
	self.pages = Value({})

	self.settingsWidget = Value(nil)
	self.helpWidget = Value(nil)
	self.diffWidget = Value(nil)

	local isOpen = Value(false)

	local toolbarButton = ToolbarButton {
		Toolbar = Toolbar {
			Name = "MuslimSync",
		},
		Name = "MuslimSync",
		ToolTip = "Open MuslimSync UI",
		Image = self.icon,
		[OnEvent "Click"] = function()
			isOpen:set(not peek(isOpen))
		end,
	}

	Widget {
		Name = "MuslimSync",
		MinimumSize = peek(self.rootSize),
		Enabled = isOpen,
		[OnChange "Enabled"] = function(isEnabled)
			isOpen:set(isEnabled)
		end,
		[OnChange "AbsoluteSize"] = function(size)
			self.rootSize:set(size)
		end,
		[Children] = self.pages,
	}

	plugin.Unloading:Connect(Observer(isOpen):onChange(function()
		toolbarButton:SetActive(peek(isOpen))
	end))

	toolbarButton:SetActive(peek(isOpen))

	if RunService:IsEdit() then
		self:home()

		if Config:get("AutoConnect") then
			self:discover()
		end
	else
		self:setPage(Unavailable())
	end

	return self
end

function App:setIcon(icon: ("Ok" | "Warn" | "Error")?)
	if icon == "Ok" then
		self.icon:set(Assets.Brand.LogoOk)
	elseif icon == "Warn" then
		self.icon:set(Assets.Brand.LogoWarn)
	elseif icon == "Error" then
		self.icon:set(Assets.Brand.LogoError)
	else
		self.icon:set(Assets.Brand.Logo)
	end
end

-- `fill` pages stretch to the full widget height (their scroll areas
-- flex-grow); others stay a vertically centered block
function App:setPage(page, fill)
	local pages = peek(self.pages)

	for id, child in pages do
		if child._finished then
			page[id] = nil
			continue
		end

		task.spawn(function()
			child._destructor(child._value)
			child._finished = true
		end)
	end

	local size = Value(UDim2.fromScale(1, 1))

	-- Extremely hacky way to smoothly transition between pages
	page = Computed(function()
		return New "Frame" {
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.fromScale(0.5, 0.5),
			Size = Spring(size, 10),
			BackgroundColor3 = Theme.Colors.Background,
			BorderSizePixel = 0,
			[Children] = {
				List {
					VerticalAlignment = Enum.VerticalAlignment.Center,
					HorizontalAlignment = Enum.HorizontalAlignment.Center,
					Spacing = 8,
				},
				Padding {
					Padding = Theme.WidgetPadding,
				},
				Container {
					Size = UDim2.fromScale(1, 0),
					[Children] = {
						Wordmark {},
						Text {
							AnchorPoint = Vector2.new(1, 1),
							Position = UDim2.new(1, -3, 1, 0),
							Text = `v{manifest.package.version}`,
							Color = Theme.Colors.TextDimmed,
							TextSize = Theme.TextSize.Small,
						},
					},
				},
				Container {
					AutomaticSize = if fill then Enum.AutomaticSize.None else Enum.AutomaticSize.Y,
					Size = UDim2.fromScale(1, 0),
					[Children] = {
						page,
						if fill then New "UIFlexItem" { FlexMode = Enum.UIFlexMode.Fill } else nil,
					},
				},
			},
		}
	end, function(page)
		if not page then
			return
		end

		local TWEEN_INFO = TweenInfo.new(0.2, Enum.EasingStyle.Sine, Enum.EasingDirection.Out)
		TweenService:Create(page, TWEEN_INFO, { BackgroundTransparency = 1 }):Play()

		for _, descendant in page:GetDescendants() do
			local properties = {}

			if descendant:IsA("GuiObject") then
				if descendant:IsA("GuiButton") then
					descendant.Active = false
				end

				properties.BackgroundTransparency = 1

				if descendant:IsA("TextLabel") or descendant:IsA("TextButton") or descendant:IsA("TextBox") then
					properties.TextTransparency = 1
				elseif descendant:IsA("ImageLabel") or descendant:IsA("ImageButton") then
					properties.ImageTransparency = 1
				end
			end

			if descendant:IsA("UIStroke") then
				properties.Transparency = 1
			end

			if next(properties) then
				TweenService:Create(descendant, TWEEN_INFO, properties):Play()
			end
		end

		page.ZIndex = 2

		size:set(UDim2.fromScale(1.2, 1))

		task.wait(0.2)
		cleanup(page)
	end)

	pages[Util.generateGUID()] = page
	self.pages:set(pages)
end

function App:home()
	self.lastUpdate = os.clock()

	self:setPage(NotConnected {
		App = self,
		Host = self.host,
		Port = self.port,
	})

	self:setIcon()
end

function App:settings()
	local widget = peek(self.settingsWidget)

	if widget then
		widget:Destroy()
		widget = nil
	else
		widget = Settings {
			Closed = function()
				peek(self.settingsWidget):Destroy()
				self.settingsWidget:set(nil)
			end,
		}
	end

	self.settingsWidget:set(widget)
end

function App:help()
	local widget = peek(self.helpWidget)

	if widget then
		widget:Destroy()
		widget = nil
	else
		widget = Help {
			Closed = function()
				peek(self.helpWidget):Destroy()
				self.helpWidget:set(nil)
			end,
		}
	end

	self.helpWidget:set(widget)
end

function App:diff(changes: Types.Changes?, tree: any?)
	local widget = peek(self.diffWidget)

	if widget then
		widget:Destroy()
		widget = nil
	elseif changes and tree then
		widget = Diff {
			Changes = changes,
			Tree = tree,
			Closed = function()
				peek(self.diffWidget):Destroy()
				self.diffWidget:set(nil)
			end,
		}
	end

	self.diffWidget:set(widget)
end

function App:setAddress(host: string?, port: number?)
	self.host = host or self.host
	self.port = port or self.port
end

-- Re-check the master for projects while disconnected (AutoConnect only),
-- so starting a serve after Studio is already open still connects
function App:schedulePoll()
	if self.pollScheduled then
		return
	end

	self.pollScheduled = true

	task.delay(DISCOVER_INTERVAL, function()
		self.pollScheduled = false

		if not self.core and Config:get("AutoConnect") and RunService:IsEdit() then
			self:discover()
		end
	end)
end

-- Asks the MuslimSync master which projects exist, connects to the one synced
-- with this place (starting its serve if needed), or shows the picker.
-- With `manual` (Connect button) a dead master falls back to vanilla connect
function App:discover(manual: boolean?)
	Discovery.getProjects()
		:andThen(function(projects)
			local match = Discovery.findMatch(projects)

			if match then
				self:startAndConnect(match)
			elseif #projects > 0 or manual then
				self:projectMenu(projects)
			else
				self:schedulePoll()
			end
		end)
		:catch(function(err)
			if manual then
				Log.debug("MuslimSync master unreachable, connecting directly:", err)
				self:connect()
			else
				Log.trace("MuslimSync master unreachable:", err)
				self:schedulePoll()
			end
		end)
end

function App:startAndConnect(project, claim: boolean?)
	if not project.running then
		self:setPage(Connecting {
			App = self,
		})
	end

	Discovery.start(project)
		:andThen(function(session)
			if claim then
				return Discovery.claim(session):andThen(function()
					-- Give the server a moment to reload the claimed project file
					task.wait(0.5)
					return session
				end)
			end

			return session
		end)
		:andThen(function(session)
			self:setAddress(session.host, session.port)
			self:connect()
		end)
		:catch(function(err)
			Log.warn("Failed to start project:", err)
			self:home()
			self:schedulePoll()
		end)
end

-- Opens the project picker directly, regardless of whether a project
-- already matches this place (the quick select button)
function App:openProjectPicker()
	Discovery.getProjects()
		:andThen(function(projects)
			self:projectMenu(projects, true)
		end)
		:catch(function(err)
			Log.warn("MuslimSync master unreachable:", err)
			self:home()
		end)
end

function App:projectMenu(projects: { Discovery.ProjectInfo }, manual: boolean?)
	local signal = Signal.new()

	local options = {}

	local nameCounts = {}
	for _, project in projects do
		nameCounts[project.name] = (nameCounts[project.name] or 0) + 1
	end

	-- Highlight the project already linked to this place
	-- (placeId -> gameId -> ArgonId, same matching as Connect)
	local match = Discovery.findMatch(projects)

	for _, project in projects do
		local detail

		-- Disambiguate same-name projects with their directory
		if nameCounts[project.name] > 1 then
			detail = project.path:gsub("/[^/]+$", ""):gsub("^/Users/[^/]+", "~")
		end

		table.insert(options, {
			label = (project.running and "● " or "") .. project.name,
			detail = detail,
			project = project,
			matched = project == match,
		})
	end

	table.insert(options, { label = "Create new project", solid = true })
	table.insert(options, { label = "Add existing project" })
	table.insert(options, { label = "Cancel" })

	local message = if manual
		then "Pick a project to sync with this place:"
		elseif #projects == 0 then "No MuslimSync project is synced with this place yet. Create one?"
		else `Found {#projects} MuslimSync project(s), but none is synced with this place. Pick one to sync:`

	self:setPage(
		Picker {
			App = self,
			Message = message,
			Options = options,
			Signal = signal,
		},
		true
	)

	task.spawn(function()
		local choice = signal:Wait()

		if choice.project then
			self:projectDetailsPage(choice.project)
		elseif choice.label == "Create new project" then
			self:createProjectPage()
		elseif choice.label == "Add existing project" then
			self:addProjectPage()
		else
			self:home()
		end
	end)
end

-- Settings preview after picking a project - nothing syncs until
-- confirmed, and any tweaks made are written to the project file first
function App:projectDetailsPage(project)
	local signal = Signal.new()

	self:setPage(
		ProjectDetails {
			App = self,
			Project = project,
			Signal = signal,
		},
		true
	)

	task.spawn(function()
		local result = signal:Wait()

		if result.action ~= "Sync" then
			self:openProjectPicker()
			return
		end

		self:setPage(Connecting {
			App = self,
		})

		Discovery.start(project)
			:andThen(function(session)
				local applied = Promise.resolve()

				for key, value in result.changes do
					applied = applied:andThen(function()
						return Discovery.setConfig(session, key, value)
					end)
				end

				return applied
					:andThen(function()
						return Discovery.claim(session)
					end)
					:andThen(function()
						-- Give the server a moment to reload the project file
						task.wait(0.5)
						self:setAddress(session.host, session.port)
						self:connect()
					end)
			end)
			:catch(function(err)
				Log.warn("Failed to sync project:", err)
				self:home()
			end)
	end)
end

-- Pick an old project the registry does not know yet: paste a path or
-- browse to it. The master starts (and thereby registers) its serve,
-- then the normal details/preview flow takes over so the initial sync
-- direction is still confirmed before anything touches the files
function App:addProjectPage()
	local signal = Signal.new()

	self:setPage(
		AddProject {
			App = self,
			Signal = signal,
		},
		true
	)

	task.spawn(function()
		local result = signal:Wait()

		if not result then
			self:openProjectPicker()
			return
		end

		self:setPage(Connecting {
			App = self,
		})

		Discovery.start({ path = result.path } :: any)
			:andThen(function(session)
				-- The spawned serve registers the project as it boots
				task.wait(0.5)

				return Discovery.getProjects():andThen(function(projects)
					for _, project in projects do
						if project.running and project.host == session.host and project.port == session.port then
							self:projectDetailsPage(project)
							return
						end
					end

					-- Started but not matched (unlikely) - the picker will
					-- list it now that it is registered
					self:openProjectPicker()
				end)
			end)
			:catch(function(err)
				Log.warn("Failed to add project:", err)
				self:openProjectPicker()
			end)
	end)
end

-- Form asking for project name and directory before creating
function App:createProjectPage()
	local signal = Signal.new()

	self:setPage(
		CreateProject {
			App = self,
			Signal = signal,
		},
		true
	)

	task.spawn(function()
		local result = signal:Wait()

		if not result then
			self:home()
			return
		end

		self:setPage(Connecting {
			App = self,
		})

		Discovery.create(result.name, result.dir, result.folder)
			:andThen(function(created)
				task.wait(0.5)
				self:setAddress(created.host, created.port)
				self:connect()
			end)
			:catch(function(err)
				Log.warn("Failed to create project:", err)
				self:home()
			end)
	end)
end

function App:connect()
	local project = Value({})
	local canceled = false
	local loading = true

	self.core = Core.new(self.host, self.port)

	task.spawn(function()
		task.wait(0.2)

		if not self:isConnected() and loading then
			self:setPage(Connecting {
				App = self,
			})
		end
	end)

	self.onCanceled:Once(function()
		canceled = true
	end)

	self.core:onPrompt(function(message, changes, tree)
		loading = false

		local signal = Signal.new()
		local result = false

		self:setIcon("Warn")

		-- Prompt user to accept or reject incoming changes
		if changes then
			local options = { "Accept", "Diff", "Cancel" }
			message = describeChanges(changes)

			self:setPage(Prompt {
				App = self,
				Message = message,
				Options = options,
				Signal = signal,
			})

			local choice = signal:Wait()

			while choice == "Diff" do
				self:diff(changes, tree)
				choice = signal:Wait()
			end

			self:diff()

			result = choice == "Accept"
		-- Prompt user whether to continue when server ID differs
		else
			local options = { "Continue", "Cancel" }

			self:setPage(Prompt {
				App = self,
				Message = message,
				Options = options,
				Signal = signal,
			})

			result = signal:Wait() == "Continue"
		end

		if self.core.status == Core.Status.Connected then
			self:setPage(Connected {
				App = self,
				Project = project,
			})

			self:setIcon("Ok")
		end

		return result
	end)

	self.core:onReady(function(projectDetails)
		loading = false
		project:set(projectDetails)

		self.lastSync:set(os.time())

		self.lastSyncKind:set(Config:get("InitialSyncPriority"))

		self:setPage(Connected {
			App = self,
			Project = project,
		})

		self:setIcon("Ok")
	end)

	self.core:onSync(function(kind, data)
		self.lastSync:set(os.time())
		self.lastSyncKind:set(
			(kind == "SyncChanges" or kind == "SyncDetails") and "Server"
				or kind == "SyncbackChanges" and "Client"
				or "None"
		)

		if kind == "SyncDetails" then
			project:set(data)
		end
	end)

	self.core:run():catch(function(err)
		loading = false

		if Core.wasExitGraceful(err) or canceled then
			Log.info("Disconnected from the server", if canceled then "(canceled by user)" else "(graceful exit)")

			self:disconnect()
			self:home()
			return
		end

		Log.warn("Disconnected from the server with error:", err.message or err)

		self:setPage(Error {
			App = self,
			Message = err.message or tostring(err),
		})

		self:setIcon("Error")

		self:disconnect()

		if Config:get("AutoReconnect") then
			Log.info(`Reconnecting automatically in {RECONNECT_INTERVAL} seconds..`)

			task.wait(RECONNECT_INTERVAL)

			if self.lastUpdate + RECONNECT_INTERVAL <= os.clock() then
				-- Re-discover through the master instead of dialing the cached
				-- host/port - a serve that died (the usual reason we are here)
				-- comes back on a fresh port, so a direct connect just fails
				self:discover()
			else
				Log.info("Auto reconnect skipped (another connection took over)")
			end
		end
	end)
end

function App:disconnect(cancel: boolean?)
	self.lastUpdate = os.clock()

	if self.core then
		if cancel then
			self.onCanceled:Fire()
		end

		self.core:stop()
		self.core = nil
	end
end

function App:isConnected()
	return self.core and self.core.status == Core.Status.Connected
end

function App:setHost(host: string)
	self.host = host
end

function App:setPort(port: number)
	self.port = port
end

return App
