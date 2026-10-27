/*
 * Decor (Next) avatar-shape compatibility.
 *
 * Discord has an avatar-shape experiment that can render user pictures with
 * rounded-square corners while custom Decor frames are designed around a
 * circular avatar. This adapter uses only Revenge Next's React/JSX exports and standard React
 * Native Image `source`/`style` props. It affects decorated Discord user-avatar
 * URLs and the built-in default-avatar placeholders; mirror-hosted frame images
 * are not modified.
 */

import { getModuleWithImportedPath } from '@revenge-mod/discord/utils/modules/finders'
import { instead } from '@revenge-mod/patcher'
import { React, ReactJSXRuntime } from '@revenge-mod/react'
import { DECOR_SKU_ID } from '../constants'
import {
	getUserDecorationAsset,
	queueUserDecorations,
	setUserDecorationAsset,
} from '../stores/users'
import type { LogLike } from '../types'

type AnyRecord = Record<string, any>
type Cleanup = (callback: () => void) => void

const DISCORD_USER_ID = /^\d{17,22}$/
const CIRCULAR_AVATAR_STYLE = { borderRadius: 9999 }
const AVATAR_COMPONENT_PATH = 'design/void/Avatar/native/Avatar.tsx'
const avatarComponents = new Set<object>()

function isRecord(value: unknown): value is AnyRecord {
	return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function userIdFromUri(uri: unknown): string | undefined {
	if (typeof uri !== 'string') return undefined
	try {
		const url = new URL(uri)
		const hostname = url.hostname.toLowerCase()
		if (
			!/^([a-z0-9-]+\.)*discordapp\.(com|net)$/.test(hostname) ||
			!/^\/(?:avatars|embed\/avatars)\//i.test(url.pathname)
		)
			return undefined
		const match = url.pathname.match(/^\/avatars\/(\d{17,22})\//i)
		return match && DISCORD_USER_ID.test(match[1]) ? match[1] : undefined
	} catch {
		return undefined
	}
}

function sourceUserId(source: unknown): string | undefined {
	if (Array.isArray(source)) {
		for (const item of source) {
			const id = sourceUserId(item)
			if (id) return id
		}
		return undefined
	}
	if (typeof source === 'string') return userIdFromUri(source)
	if (!isRecord(source)) return undefined
	return userIdFromUri(source.uri)
}

function isDefaultAvatarSource(source: unknown): boolean {
	if (Array.isArray(source)) return source.some(isDefaultAvatarSource)
	const uri = typeof source === 'string' ? source : isRecord(source) ? source.uri : undefined
	if (typeof uri !== 'string') return false
	try {
		const url = new URL(uri)
		return (
			/^([a-z0-9-]+\.)*discordapp\.(com|net)$/i.test(url.hostname) &&
			/^\/embed\/avatars\//i.test(url.pathname)
		)
	} catch {
		return false
	}
}

function candidateUserId(props: AnyRecord): string | undefined {
	const id =
		typeof props.user === 'string' ? props.user : (props.user?.id ?? props.userId)
	return typeof id === 'string' && DISCORD_USER_ID.test(id) ? id : undefined
}

function transformArgs(args: any[]): any[] {
	if (!Array.isArray(args)) return args
	let nextArgs = args
	const type = args[0]
	const props = args[1]

	// The exact Avatar component is resolved by imported path below. Injecting
	// the cached custom decoration at element creation also covers historical
	// message rows whose embedded author object predates the USER_UPDATE event.
	if (
		(isRecord(type) || typeof type === 'function') &&
		avatarComponents.has(type as object)
	) {
		if (isRecord(props)) {
			const userId = candidateUserId(props)
			if (userId) {
				const existing = props.avatarDecoration
				const cachedAsset = getUserDecorationAsset(userId)
				if (
					cachedAsset === undefined &&
					existing?.skuId === DECOR_SKU_ID &&
					typeof existing.asset === 'string' &&
					/^(?:a_)?[a-f\d]{8,128}$/i.test(existing.asset)
				)
					setUserDecorationAsset(userId, existing.asset)
				const asset = getUserDecorationAsset(userId)
				if (asset === undefined) {
					queueUserDecorations([userId])
				} else if (asset) {
					const avatarDecoration = { asset, skuId: DECOR_SKU_ID }
					if (
						props.avatarDecoration?.skuId !== DECOR_SKU_ID ||
						props.avatarDecoration?.asset !== asset
					) {
						nextArgs = [...args]
						nextArgs[1] = { ...props, avatarDecoration }
					}
				} else if (props.avatarDecoration?.skuId === DECOR_SKU_ID) {
					nextArgs = [...args]
					nextArgs[1] = { ...props, avatarDecoration: null }
				}
			}
		}
		return nextArgs
	}

	const effectiveProps = nextArgs[1]
	if (!isRecord(effectiveProps)) return nextArgs
	// The default avatar URLs don't encode a user ID. Keep those placeholder
	// images circular too; this is the standard shape for people, and they carry
	// no asset that could be mistaken for a Decor frame.
	if (isDefaultAvatarSource(effectiveProps.source)) {
		const defaultProps = {
			...effectiveProps,
			style: [effectiveProps.style, CIRCULAR_AVATAR_STYLE],
		}
		if (nextArgs === args) nextArgs = [...args]
		nextArgs[1] = defaultProps
		return nextArgs
	}
	const userId = sourceUserId(effectiveProps.source)
	if (!userId) return nextArgs

	const asset = getUserDecorationAsset(userId)
	if (asset === undefined) {
		// The image can render before the history event finishes hydrating its
		// user IDs. Queueing here lets a later USER_UPDATE trigger a fresh render.
		queueUserDecorations([userId])
		return nextArgs
	}
	if (!asset) return nextArgs

	const nextProps: AnyRecord = {
		...effectiveProps,
		style: [effectiveProps.style, CIRCULAR_AVATAR_STYLE],
	}
	// Fresco has an explicit crop flag on clients that expose it. Only override
	// it when the caller already supplied that documented boolean prop.
	if (effectiveProps.roundAsCircle === false) nextProps.roundAsCircle = true
	if (nextArgs === args) nextArgs = [...args]
	nextArgs[1] = nextProps
	return nextArgs
}

/** Register the actual component identity from the path used by current Revenge Next plugins. */
function registerAvatarModule(moduleExports: unknown, logger: LogLike): void {
	if (!isRecord(moduleExports)) return
	const candidates = [moduleExports.default, moduleExports.Avatar]
	for (const candidate of candidates) {
		let value: unknown = candidate
		for (let depth = 0; depth < 3 && value; depth++) {
			if (typeof value === 'function' || isRecord(value)) {
				avatarComponents.add(value as object)
				if (isRecord(value) && value.type) {
					value = value.type
					continue
				}
				if (isRecord(value) && value.render) {
					value = value.render
					continue
				}
			}
			break
		}
	}
	if (avatarComponents.size > 0) logger.log('Discord Avatar component resolved by imported path.')
}

/**
 * Keep decorated users circular when Discord's rounded-square avatar experiment
 * is active. All factory and patcher lookups are guarded, so a missing runtime
 * export simply disables this cosmetic compatibility layer rather than breaking
 * message rendering.
 */
export function installDecoratedAvatarShapeCompatibility(
	cleanup: Cleanup,
	logger: LogLike,
): void {
	let installed = 0
	let componentFound = false
	const onAvatarModule = (moduleExports: unknown): void => {
		registerAvatarModule(moduleExports, logger)
		componentFound = avatarComponents.size > 0
	}
	try {
		cleanup(getModuleWithImportedPath(AVATAR_COMPONENT_PATH, onAvatarModule))
	} catch (error) {
		logger.warn(
			`Could not resolve Discord Avatar component: ${error instanceof Error ? error.message : 'imported path unavailable'}`,
		)
	}

	const attach = (target: unknown, method: string): void => {
		if (!isRecord(target)) return
		try {
			if (typeof target[method] !== 'function') return
			cleanup(
				instead(
					target as Record<string, (...args: any[]) => any>,
					method,
					function (
						this: unknown,
						args: any[],
						original: (...args: any[]) => any,
					) {
						let nextArgs = args
						try {
							nextArgs = transformArgs(args)
						} catch {
							// Cosmetic patch only: never prevent a Discord element from rendering.
						}
						return original.apply(this, nextArgs)
					},
				),
			)
			installed++
		} catch (error) {
			logger.warn(
				`Could not install avatar-shape compatibility on ${method}: ${error instanceof Error ? error.message : 'unsupported runtime'}`,
			)
		}
	}

	const jsxRuntime = ReactJSXRuntime as unknown
	for (const method of ['jsx', 'jsxs', 'jsxDEV']) attach(jsxRuntime, method)
	attach(React as unknown, 'createElement')

	if (installed) {
		logger.log(
			`Decor avatar compatibility attached (${installed} React element factories; Avatar component ${componentFound ? 'found' : 'not yet found'}).`,
		)
	} else {
		logger.warn(
			'Could not attach avatar compatibility to the exposed React element factories; this Discord build may render avatars outside the exposed React Native path.',
		)
	}
}
