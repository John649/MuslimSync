--!strict
-- Binary transport from the plugin's side.
--
-- Serialized instance trees and rendered images are far too large for a
-- WebSocket JSON frame, so they travel over the daemon's artifact HTTP routes
-- instead: lease, append chunks at exact offsets, finalize with a digest.
--
-- Uses the same MsgPack transport as the rest of the plugin's HTTP, so there is
-- one wire format rather than two.

-- EncodingService, not HttpService: base64 lives there and works on buffers
-- directly, so there is no string round-trip for binary data.
local EncodingService = game:GetService("EncodingService")

local MuslimSync = script:FindFirstAncestor("MuslimSync")

local Http = require(MuslimSync.Client.Http)

-- Comfortably under the daemon's 1 MiB chunk ceiling once base64 inflates it
-- by a third, with room for the surrounding frame.
local CHUNK_BYTES = 512 * 1024

local Artifacts = {}

local function url(daemonPort: number, route: string): string
	return `http://127.0.0.1:{daemonPort}/artifacts/{route}`
end

--- base64 for one slice of a buffer.
local function encodeSlice(data: buffer, offset: number, length: number): string
	local slice = buffer.create(length)
	buffer.copy(slice, 0, data, offset, length)

	return buffer.tostring(EncodingService:Base64Encode(slice))
end

local function decodeToBuffer(text: string): buffer
	return EncodingService:Base64Decode(buffer.fromstring(text))
end

--- Uploads a buffer and returns its finalized metadata.
function Artifacts.upload(port: number, data: buffer, mime: string): { [string]: any }
	local total = buffer.len(data)

	local lease = Http.post(url(port, "lease"), {
		size = total,
		mime = mime,
	})
		:expect()
		:decode()

	local offset = 0

	while offset < total do
		local length = math.min(CHUNK_BYTES, total - offset)

		Http.post(url(port, "chunk"), {
			id = lease.id,
			token = lease.token,
			offset = offset,
			data = encodeSlice(data, offset, length),
		}):expect()

		offset += length
	end

	return Http.post(url(port, "finalize"), {
		id = lease.id,
		token = lease.token,
	})
		:expect()
		:decode()
end

--- Reads a finalized artifact back into one buffer.
function Artifacts.download(port: number, id: string): buffer
	local parts = {}
	local offset = 0

	repeat
		local page = Http.post(url(port, "read"), {
			id = id,
			offset = offset,
		})
			:expect()
			:decode()

		local chunk = decodeToBuffer(page.dataBase64)
		table.insert(parts, chunk)

		-- The daemon echoes the offset it actually served; trusting our own
		-- arithmetic instead would desynchronise on a short read.
		offset = page.nextOffset
	until page.eof

	local total = 0
	for _, part in parts do
		total += buffer.len(part)
	end

	local combined = buffer.create(total)
	local at = 0

	for _, part in parts do
		buffer.copy(combined, at, part)
		at += buffer.len(part)
	end

	return combined
end

return Artifacts
