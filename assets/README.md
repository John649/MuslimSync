# Brand assets

`npm run make:icons` regenerates these from `scripts/make-icons.mjs` — a rounded
square with a crescent, tinted per connection state.

`muslimsync.ico` is not one of them. `npm run make:shortcut` derives it from
`Logo.png` for the Windows taskbar and Start menu, so it is generated on demand
rather than committed.

## Why they are not already in the plugin

A Roblox toolbar icon must be an uploaded asset; a plugin cannot reference a
local file. The fork originally shipped Argon's uploaded artwork, which is not
ours to use under this name, so those ids were removed and the icon is blank
until you upload your own.

## Uploading

1. Upload each PNG to Roblox as a Decal/Image asset on your account or group.
2. Paste the resulting ids into `plugin/src/App/Assets.json` under `Brand`:

   ```json
   "Brand": {
     "Logo":      "rbxassetid://<id>",
     "LogoOk":    "rbxassetid://<id>",
     "LogoWarn":  "rbxassetid://<id>",
     "LogoError": "rbxassetid://<id>"
   }
   ```

3. `npm run build:plugin`.

The toolbar button then shows connection state by colour again: base, green when
synced, amber on a warning, red on an error. Until then the button shows its
name with no icon, which is honest rather than borrowed.

`Icons/*` in that file are still Argon's UI glyphs (settings, help, spinner and
so on) and are covered by its Apache-2.0 licence; they are not brand marks.
