local HttpService = game:GetService("HttpService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Promise = require(MuslimSync.Packages.Promise)
local MsgPack = require(MuslimSync.Lib.MsgPack)
local Config = require(MuslimSync.Config)

local Error = require(script.Parent.Error)

-- Token baked in at build time (src/AuthToken.luau, gitignored).
-- Absent in dist builds - there the AuthToken setting is used instead
local EMBEDDED_TOKEN = ""
do
	local module = MuslimSync:FindFirstChild("AuthToken")

	if module and module:IsA("ModuleScript") then
		local ok, value = pcall(require, module)

		if ok and type(value) == "string" then
			EMBEDDED_TOKEN = value
		end
	end
end

type Response = {
	Body: string,
	Headers: { [string]: string },
	StatusCode: number,
	StatusMessage: string,
	Success: boolean,
	decode: () -> { [string]: any },
}

local function methodify(response: { [string]: any }): any
	return setmetatable(response, {
		__index = {
			decode = function(self)
				return MsgPack.decode(self.Body)
			end,
		},
	})
end

local function request(method: string, url: string, body: { [string]: any }?): Promise.TypedPromise<Response>
	return Promise.new(function(resolve, reject)
		local headers = {
			["Content-Type"] = "application/msgpack",
		}

		local token = Config:get("AuthToken")

		if token == "" then
			token = EMBEDDED_TOKEN
		end

		if token ~= "" then
			headers["x-argon-token"] = token
		end

		local success, response = pcall(function()
			return HttpService:RequestAsync({
				Url = url,
				Method = method,
				Headers = headers,
				Body = body and MsgPack.encode(body) or nil,
			})
		end)

		if success then
			if response.Success then
				resolve(methodify(response))
			else
				reject(Error.fromResponse(response))
			end
		else
			reject(Error.fromMessage(response))
		end
	end)
end

local Http = {}

function Http.get(url: string)
	return request("GET", url)
end

function Http.post(url: string, body: { [string]: any }?)
	return request("POST", url, body)
end

return Http
