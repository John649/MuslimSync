-- A Luau command: the source runs in Studio through the ordinary eval op, so it
-- has exactly the reach an eval does and no more.
--
-- `args` is in scope, already decoded from the command's declared arguments.

local root = game

for segment in tostring(args.path):gmatch("[^/]+") do
	root = root:FindFirstChild(segment) or error(`no instance at {args.path}`)
end

local loose = {}

for _, descendant in root:GetDescendants() do
	if descendant:IsA("BasePart") and not descendant.Anchored then
		table.insert(loose, descendant:GetFullName())

		if not args.dryRun then
			descendant.Anchored = true
		end
	end
end

return { checked = args.path, anchored = if args.dryRun then 0 else #loose, found = loose }
