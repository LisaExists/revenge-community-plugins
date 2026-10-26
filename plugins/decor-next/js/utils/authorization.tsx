/* Decor Classic attribution: Fiery and Bwlok. Revenge Next port: LisaExists. GPL-3.0. */

import { lookupModules } from '@revenge-mod/modules/finders'
import { withName, withProps } from '@revenge-mod/modules/finders/filters'
import { ReactNative } from '@revenge-mod/react'
import { AUTHORIZE_URL, CLIENT_ID } from '../constants'
import { getAuthSnapshot, setTokenForCurrentAccount } from '../stores/auth'

type RecordLike = Record<string, any>
type CloseOptions = { onCloseCallback?: () => void }
type OpenModal = (
	render: (props: RecordLike) => unknown,
	options?: CloseOptions,
) => unknown

let cancelPending: (() => void) | undefined

/** Raised when this Discord build has no in-app OAuth UI. Settings can then
 * offer the system-browser callback flow rather than failing authorization. */
export class ManualOAuthRequiredError extends Error {
	constructor() {
		super('This Discord build requires browser-based Decor authorization.')
		this.name = 'ManualOAuthRequiredError'
	}
}

/** Exchange a copied Decor callback URL for a token without exposing the token
 * in the browser or asking the user to paste a long-lived credential. */
export async function exchangeDecorCallback(
	location: string,
	expectedAccountId: string,
	parentSignal?: AbortSignal,
): Promise<void> {
	if (getAuthSnapshot().accountId !== expectedAccountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)

	let callback: URL
	try {
		callback = new URL(location.trim())
	} catch {
		throw new Error('Paste the full URL from the Decor authorization redirect.')
	}
	const expected = new URL(AUTHORIZE_URL)
	if (
		callback.protocol !== 'https:' ||
		callback.origin !== expected.origin ||
		callback.pathname !== expected.pathname
	)
		throw new Error(
			'The URL must be the final HTTPS redirect to decor.fieryflames.dev/api/authorize.',
		)

	const oauthError = callback.searchParams.get('error')
	if (oauthError === 'access_denied')
		throw new Error('Discord authorization was denied.')
	if (oauthError)
		throw new Error('Discord reported an authorization error. Please retry.')
	if (!callback.searchParams.get('code'))
		throw new Error(
			'The pasted URL has no authorization code. Finish Discord authorization and copy the final redirect URL.',
		)

	callback.searchParams.set('client', 'revenge')
	const controller = new AbortController()
	const abortFromParent = () => controller.abort()
	if (parentSignal?.aborted) controller.abort()
	else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
	const timeout = setTimeout(() => controller.abort(), 20_000)
	try {
		let response: Response
		try {
			response = await fetch(callback.toString(), {
				method: 'GET',
				signal: controller.signal,
			})
		} catch {
			if (controller.signal.aborted)
				throw new Error(
					'Decor authorization timed out. Check your connection and retry.',
				)
			throw new Error(
				'Decor authorization could not reach its callback endpoint.',
			)
		}
		if (!response.ok)
			throw new Error(`Decor authorization failed (HTTP ${response.status}).`)
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
		if (contentType.includes('text/html'))
			throw new Error(
				'Decor returned a web page instead of an authorization token. Please retry.',
			)
		let responseText: string
		try {
			responseText = await response.text()
		} catch {
			if (controller.signal.aborted)
				throw new Error(
					'Decor authorization timed out. Check your connection and retry.',
				)
			throw new Error('Decor returned an unreadable authorization response.')
		}
		const token = responseText.trim()
		if (
			!token ||
			token.length > 4096 ||
			/^<!doctype\s+html|^<html\b/i.test(token)
		)
			throw new Error('Decor returned an invalid authorization response.')
		if (getAuthSnapshot().accountId !== expectedAccountId)
			throw new Error(
				'The active Discord account changed. Reopen Decor and try again.',
			)
		setTokenForCurrentAccount(token, expectedAccountId)
	} finally {
		clearTimeout(timeout)
		parentSignal?.removeEventListener('abort', abortFromParent)
	}
}

function namespaceOf(value: unknown): RecordLike | undefined {
	if (value && (typeof value === 'object' || typeof value === 'function'))
		return value as RecordLike
	return undefined
}

function isReactComponent(value: unknown): boolean {
	if (typeof value === 'function') return true
	if (!value || typeof value !== 'object') return false
	const tag = (value as RecordLike).$$typeof
	return (
		tag === Symbol.for('react.forward_ref') ||
		tag === Symbol.for('react.memo') ||
		tag === Symbol.for('react.lazy')
	)
}

function hasExportName(value: unknown, name: string, depth = 0): boolean {
	if (depth > 3) return false
	if (typeof value === 'function') {
		const fn = value as unknown as RecordLike
		return fn.name === name || fn.displayName === name
	}
	const candidate = namespaceOf(value)
	if (!candidate) return false
	if (candidate.displayName === name) return true
	return (
		hasExportName(candidate.type, name, depth + 1) ||
		hasExportName(candidate.render, name, depth + 1) ||
		hasExportName(candidate.default, name, depth + 1)
	)
}

/**
 * Prefer an exact named export, then try the component's runtime name. Search
 * every match instead of assuming the first module returned by a finder is the
 * component; Discord commonly has several unrelated exports with similar names.
 * `initialize: false` avoids initializing unrelated, not-yet-loaded Discord
 * modules simply because a settings screen was opened.
 */
function findComponentExport(name: string): unknown {
	try {
		for (const [moduleExports] of lookupModules(withProps(name), {
			returnNamespace: true,
			initialize: false,
		})) {
			const namespace = namespaceOf(moduleExports)
			const defaultNamespace = namespaceOf(namespace?.default)
			for (const candidate of [
				namespace?.[name],
				defaultNamespace?.[name],
			]) {
				if (isReactComponent(candidate)) return candidate
			}
		}
	} catch {
		// Continue with the name-based lookup if this client has unusual exports.
	}

	try {
		for (const [moduleExports] of lookupModules(withName(name), {
			returnNamespace: true,
			initialize: false,
		})) {
			const namespace = namespaceOf(moduleExports)
			for (const candidate of [namespace?.[name], namespace?.default, namespace]) {
				if (
					isReactComponent(candidate) &&
					hasExportName(candidate, name)
				)
					return candidate
			}
		}
	} catch {
		// The feature should fail with an actionable message, not break settings.
	}
	return undefined
}

/**
 * `openModal` is an ordinary function, not a React component. Resolve the
 * exact property first and preserve its receiver in case the export uses `this`.
 */
function findModalOpener(): OpenModal | undefined {
	const fallbackCandidates: OpenModal[] = []
	const options = { returnNamespace: true, initialize: false } as const
	const namespacesOf = (moduleExports: unknown): RecordLike[] => {
		const namespace = namespaceOf(moduleExports)
		const defaultNamespace = namespaceOf(namespace?.default)
		return [namespace, defaultNamespace].filter(
			(value): value is RecordLike => !!value,
		)
	}
	const modalApi = (owner: RecordLike): boolean =>
		typeof owner.closeModal === 'function' ||
		typeof owner.openModalLazy === 'function'

	// Discord's modal manager exposes a close helper alongside openModal on
	// common client builds. Prefer that shape over unrelated functions sharing
	// the generic name `openModal`.
	try {
		for (const [moduleExports] of lookupModules(
			withProps('openModal', 'closeModal'),
			options,
		)) {
			for (const owner of namespacesOf(moduleExports)) {
				if (typeof owner.openModal === 'function')
					return (owner.openModal as OpenModal).bind(owner)
			}
		}
	} catch {
		// Continue with a broad search for client versions that split modal APIs.
	}

	try {
		for (const [moduleExports] of lookupModules(withProps('openModal'), options)) {
			for (const owner of namespacesOf(moduleExports)) {
				if (typeof owner.openModal !== 'function') continue
				const opener = (owner.openModal as OpenModal).bind(owner)
				if (modalApi(owner)) return opener
				fallbackCandidates.push(opener)
			}
		}
	} catch {
		// Try the named-function lookup next.
	}

	try {
		for (const [moduleExports] of lookupModules(withName('openModal'), options)) {
			for (const owner of namespacesOf(moduleExports)) {
				const candidate = owner.openModal ?? owner.default
				if (
					typeof candidate === 'function' &&
					hasExportName(candidate, 'openModal')
				) {
					fallbackCandidates.push(
						owner.openModal === candidate
							? (candidate as OpenModal).bind(owner)
							: (candidate as OpenModal),
					)
				}
			}
		}
	} catch {
		// Leave the caller to report that this Discord build has no modal API.
	}
	return fallbackCandidates[0]
}

/**
 * Discord does not expose its OAuth modal through Revenge's public API. Use
 * Discord's `openModal(render, options)` interface, discovered without relying
 * on a single first-match module result.
 */
export async function authorizeWithDecor(
	expectedAccountId: string,
): Promise<void> {
	const OAuth2AuthorizeModal: any = findComponentExport('OAuth2AuthorizeModal')
	const openModal = findModalOpener()
	const WebView: any =
		(ReactNative as any).WebView ??
		findComponentExport('WebView') ??
		findComponentExport('RNCWebView') ??
		findComponentExport('DiscordWebView')
	const hasOAuthModal = isReactComponent(OAuth2AuthorizeModal)
	const hasWebView = isReactComponent(WebView)
	if (!hasOAuthModal && !hasWebView)
		throw new ManualOAuthRequiredError()
	if (typeof openModal !== 'function')
		throw new ManualOAuthRequiredError()

	if (getAuthSnapshot().accountId !== expectedAccountId)
		throw new Error(
			'The active Discord account changed. Reopen Decor and try again.',
		)

	await new Promise<void>((resolve, reject) => {
		let settled = false
		let callbackStarted = false
		let callbackController: AbortController | undefined
		let dismissModal: (() => void) | undefined
		const finish = (error?: Error, close = false) => {
			if (settled) return
			settled = true
			cancelPending = undefined
			if (error) callbackController?.abort()
			if (error || close) {
				try {
					dismissModal?.()
				} catch {
					// Discord may already have dismissed the authorization modal.
				}
			}
			if (error) reject(error)
			else resolve()
		}
		cancelPending = () =>
			finish(new Error('Authorization was cancelled.'), true)

		const completeCallback = async (
			location: string,
			closeAfterSuccess = false,
		): Promise<void> => {
			if (settled || callbackStarted) return
			callbackStarted = true
			try {
				callbackController = new AbortController()
				await exchangeDecorCallback(
					location,
					expectedAccountId,
					callbackController.signal,
				)
				if (settled) return
				finish(undefined, closeAfterSuccess)
			} catch (error) {
				finish(
					error instanceof Error
						? error
						: new Error('Decor authorization failed.'),
					true,
				)
			}
		}

		const interceptCallback = (location: string): boolean => {
			try {
				const callback = new URL(location)
				const expected = new URL(AUTHORIZE_URL)
				if (
					callback.protocol !== 'https:' ||
					callback.origin !== expected.origin ||
					callback.pathname !== expected.pathname ||
					callbackStarted
				)
					return false
				void completeCallback(location, true)
				return true
			} catch {
				return false
			}
		}

		const authorizationUrl = new URL('https://discord.com/oauth2/authorize')
		authorizationUrl.searchParams.set('client_id', CLIENT_ID)
		authorizationUrl.searchParams.set('redirect_uri', AUTHORIZE_URL)
		authorizationUrl.searchParams.set('response_type', 'code')
		authorizationUrl.searchParams.set('scope', 'identify')

		try {
			openModal(
				modalProps => {
					const close =
						modalProps.dismissOAuthModal ??
						modalProps.onClose ??
						modalProps.closeModal
					if (typeof close === 'function') dismissModal = close
					if (!hasOAuthModal) {
						const NativeView = (ReactNative as any).View
						const NativeText = (ReactNative as any).Text
						const NativePressable = (ReactNative as any).Pressable
						return (
							<NativeView style={{ flex: 1, minHeight: 480 }}>
								<NativeView
									style={{
										minHeight: 52,
										flexDirection: 'row',
										alignItems: 'center',
										justifyContent: 'space-between',
										paddingHorizontal: 16,
									}}
								>
									<NativeText>Authorize Decor</NativeText>
									<NativePressable
										accessibilityRole="button"
										onPress={() =>
											finish(new Error('Authorization was cancelled.'), true)
										}
										style={{ padding: 12 }}
									>
										<NativeText>Cancel</NativeText>
									</NativePressable>
								</NativeView>
								<WebView
									source={{ uri: authorizationUrl.toString() }}
									style={{ flex: 1 }}
									javaScriptEnabled
									sharedCookiesEnabled
									onShouldStartLoadWithRequest={(request: { url?: string }) => {
										const location = request?.url ?? ''
										if (interceptCallback(location)) return false
										try {
											const url = new URL(location)
											return (
												url.protocol === 'https:' &&
												(url.hostname === 'discord.com' ||
													url.hostname.endsWith('.discord.com') ||
													url.hostname === 'discordapp.com' ||
													url.hostname.endsWith('.discordapp.com') ||
													url.hostname === 'hcaptcha.com' ||
													url.hostname.endsWith('.hcaptcha.com'))
											)
										} catch {
											return false
										}
									}}
									onNavigationStateChange={(state: { url?: string }) => {
										if (state?.url) interceptCallback(state.url)
									}}
									onError={() =>
										finish(
											new Error(
												'Could not load Discord authorization. Check your connection and retry.',
											),
											true,
										)
									}
								/>
							</NativeView>
						)
					}
					return (
						<OAuth2AuthorizeModal
							{...modalProps}
							clientId={CLIENT_ID}
							redirectUri={AUTHORIZE_URL}
							scopes={['identify']}
							responseType="code"
							permissions={0n}
							cancelCompletesFlow={false}
							callback={async ({ location }: { location: string }) =>
								completeCallback(location)
							}
						/>
					)
				},
				{
					onCloseCallback: () =>
						finish(new Error('Authorization was cancelled.')),
				},
			)
		} catch {
			finish(new Error("Could not open Discord's OAuth authorization UI."))
		}
	})
}

export function cancelAuthorization(): void {
	cancelPending?.()
}
