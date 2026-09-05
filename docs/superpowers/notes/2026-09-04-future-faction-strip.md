# Future: faction strip above the hologram panel

Designed with Peter on 2026-09-04 and parked by his call: the dropdown is not needed until
a second pack is fully built. Not scheduled. Everything below was agreed in conversation
and can go straight into a spec when it is picked up.

## Placement

A strip about 28 px tall above the panel, inside the hologram window, aligned to the
panel's left edge and styled like the panel's title bar. The hologram window grows by the
strip height and moves up the same amount so the panel keeps its distance from the
character (`hologramBounds` in `src/main/geometry.ts`). The projection cone still
targets the panel. The strip, and the open list, count as "over the panel" for the
click-through hover test in the hologram renderer.

## Content

Closed: the current faction's flag, its pack name, a small chevron. Open: a list dropping
down over the panel, one row per pack, flag left and name right, current row marked.
Escape, a click elsewhere, or picking a row closes it. A custom element, not a native
select, because selects cannot show images.

## Flag asset

`manifest.json` gains an optional `flag` field naming an atlas frame, validated like the
faces. The Mechanicus flag is `props_10`, the 196 by 330 banner from the sheet's props
band, already in the atlas. Main crops each pack's flag out of its atlas with
`nativeImage` and sends it as a data URL in the pack list, so the panel never needs
another pack's atlas and the `pack://` protocol stays single-pack. Flags draw in their
true colors with no hologram tint, scaled to the strip height. A pack with no flag gets an
accent-colored swatch.

## Pack discovery

At startup main scans `packs/*/manifest.json`, runs each through `loadPack`, lists the
ones that pass, and logs the ones that fail.

## Selection

Picking a row sends `pack:select { id }` to main. Interim: the current pack does nothing;
another pack is saved as `config.pack` with one system line saying it takes over on the
next launch. The hot swap replaces that handler later: reload the pack, re-point the
protocol, resend pack and theme to both renderers, resize the overlay for the new
character height, swap the tray icon, rebuild the readback persona, and keep the chat log
and session. The closures in `src/main/index.ts` that capture the pack, `charW`, and
`charH` move into one object so the swap has a single place to update.

## Tests

Pack discovery against a temp dir with one valid and one broken pack; flag validation in
the loader; the new geometry math; an e2e case that the strip shows the pack name and the
open list shows the flag image.
