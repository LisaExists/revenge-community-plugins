## 1.0.6

- Replace the hard failure on Discord builds without an OAuth modal or WebView with a system-browser callback workflow.
- Add callback URL validation and exchange in the settings screen; the long-lived token is never shown for manual copying.
- Share the same timed, account-checked callback exchange between automatic and browser-based authorization.

# Changelog

## 1.0.5

- Make OAuth module discovery prefer exact exports, scan all initialized matches, and preserve the modal opener's receiver.
- Validate Discord callback errors and authorization codes before exchanging them with Decor.
- Keep the timeout active while reading the callback response body, and reject HTML responses instead of persisting them as tokens.

## 1.0.4

- Add a guarded browser-view OAuth fallback for Discord builds that do not export `OAuth2AuthorizeModal`.

## 1.0.3

- Accept React `memo`, `forwardRef`, and `lazy` component exports when discovering Discord's OAuth modal.

## 1.0.2

- Use Discord's `openModal(render, options)` OAuth modal path instead of the unsupported `pushModal`/`popModal` shape.
- Discover the modal and opener through validated Revenge Next module finders.

## 1.0.1

- Preserve Discord user model prototypes and own property descriptors when adding Decor metadata, preventing message rendering from losing methods such as `getStatus()`.

## 1.0.0

- Initial Revenge Next port of Decor.
- Ported the Decor API client, per-account authorization storage, decoration picker, presets, upload flow, copy/delete actions, avatar URL handling, and batched user decoration cache.
- Replaced Vendetta imports and lifecycle code with Revenge Next APIs and guarded runtime module adapters.
