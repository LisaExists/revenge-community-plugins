# Decor (Next)

A Revenge Next port of [Decor by Fiery and Bwlok](https://github.com/bwlok/revenge-plugins/tree/master/plugins/Decor). The port keeps the original Decor service and data protocol while replacing Vendetta lifecycle, storage, UI, patching, and module lookup with Revenge Next APIs.

## Features

- OAuth authorization using Decor's original client ID, `identify` scope, authorize endpoint, and `client=revenge` callback exchange.
- Separate persisted access tokens for each Discord account.
- Browse owned decorations and presets, select a reviewed decoration, or clear the selection.
- Upload PNG/APNG decorations with a name, preview, progress, and the service's pending-review workflow.
- Copy a decoration hash and delete only decorations authored by the active account, with confirmation.
- Render Decor CDN and raw URI avatar decorations while forwarding ordinary Discord decorations to Discord's resolver.
- Batch and cache user decoration lookups for message, typing, profile, and connection events.

Decor (Next) requires the original Decor API at `https://decor.fieryflames.dev/api` and CDN at `https://decorcdn.fieryflames.dev`. It does not include a replacement service or sample data. Only authenticated API calls include the user's Decor bearer token.

## Authorization and privacy

Authorization takes place in Discord's OAuth modal and exchanges the callback through Decor's existing `/api/authorize` endpoint. Tokens are stored in Revenge's per-plugin JSON storage, keyed by Discord user ID, and are sent only to authenticated Decor API routes. Logging out removes the token for the active account.

The current Revenge Next public API does not expose Discord's OAuth modal or Discord's image-picker module. The port isolates those client integrations behind guarded runtime discovery adapters. Authorization resolves the exact `openModal` export first, scans all initialized matching exports, and prefers Discord's `OAuth2AuthorizeModal` when present. On builds that omit the modal, it uses a guarded, discovered React Native browser view inside Discord's modal UI and intercepts only Decor's exact callback URL. Image selection discovers `launchImageLibrary`. If the required modal and browser exports are both absent, authorization reports the unavailable capability. No undocumented native module path is used.

## Compatibility

The code targets manifest format 1, `revenge.api >=1 <2`, and Discord `>=352.0`. Imports and patcher callback behavior were checked against the Revenge Next template's current cached `@revenge-mod/types` declarations and the public bundle source. The plugin has not been exercised inside a Discord client in this repository environment; account switching, OAuth UI discovery, image-picker discovery, and avatar resolver target matching still need device verification. The environment also could not reach the Decor endpoint, so its current availability and live response behavior were not verified.

The image picker accepts `image/png` assets with `.png` or `.apng` names, matching the original uploader's PNG MIME requirement while permitting APNG files that report PNG MIME. On iOS, the typed Revenge `FileModule.readAsset` bridge converts the picked file to a data URI before multipart upload to retain animation. On Android, the picker URI is uploaded as a native multipart file part.

## Build locally

From the repository root:

```sh
bun install
bun run build decor-next
./gradlew packageDecorNext
```

Gradle writes the package to `build/dist/de.lisaexists.decor-next@1.0.6.zip`.

## Credits and license

- Original Decor authors: Fiery (`890228870559698955`) and Bwlok (`501827585806827520`).
- Revenge Next port: LisaExists (`836161010053283890`).
- This port retains the original GPL-3.0 licensing and attribution. See [LICENSE](./LICENSE).
