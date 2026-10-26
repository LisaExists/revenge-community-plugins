/*
 * Adapted Decor avatar decoration integration.
 * Vencord, a Discord client mod; Copyright (c) 2023 Vendicated and contributors.
 * Decor Classic authors: Fiery and Bwlok. Revenge Next port: LisaExists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Dispatcher } from '@revenge-mod/discord/common/flux'
import { getStore, onFluxEventDispatched } from '@revenge-mod/discord/flux'
import { getModules, lookupModule } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { instead } from '@revenge-mod/patcher'
import { ReactNative } from '@revenge-mod/react'
import { CDN_BASE, DECOR_SKU_ID, RAW_SKU_ID } from '../constants'
import { activateAccount, getAuthSnapshot } from '../stores/auth'
import {
	getCurrentUserState,
	refreshCurrentUser,
	resetCurrentUser,
} from '../stores/currentUser'
import {
	clearUserDecorations,
	configureUserDecorations,
	getUserDecorationAsset,
	queueUserDecorations,
	setUserDecorationAsset,
} from '../stores/users'
import type { Decoration, LogLike } from '../types'

type AnyRecord = Record<string, any>
type Cleanup = (callback: () => void) => void
let userStore: AnyRecord | undefined
const currentSelections = new Map<string, Decoration | null>()
const pendingCurrentSelections = new Set<string>()
let integrationLogger: LogLike | undefined

function isRecord(value: unknown): value is AnyRecord {
	return (
		value !== null && (typeof value === 'object' || typeof value === 'function')
	)
}

function decorationAssetUrl(
	decoration: any,
	canAnimate?: boolean,
): string | undefined {
	if (!decoration || typeof decoration.asset !== 'string') return undefined
	if (decoration.skuId === DECOR_SKU_ID) {
		let asset = decoration.asset
		if (!/^(?:a_)?[a-f\d]{8,128}$/i.test(asset)) return undefined
		if (!canAnimate && asset.startsWith('a_')) asset = asset.slice(2)
		return `${CDN_BASE}/${asset}.png`
	}
	if (
		decoration.skuId === RAW_SKU_ID &&
		/^(?:https?:|file:|content:|data:)/i.test(decoration.asset)
	)
		return decoration.asset
	return undefined
}

function discordDecoration(
	asset: string | null,
): { asset: string; skuId: string } | null {
	return asset ? { asset, skuId: DECOR_SKU_ID } : null
}

function decorateUser(user: AnyRecord, asset: string | null): AnyRecord {
	const avatarDecoration = asset
		? discordDecoration(asset)
		: user.avatarDecoration?.skuId === DECOR_SKU_ID
			? null
			: (user.avatarDecoration ?? null)
	// Discord user records can expose methods such as getStatus() on their
	// prototype. Object spread drops those methods and causes message rendering
	// to fail when consumers call them on a patched getUser() result.
	try {
		const descriptors = Object.getOwnPropertyDescriptors(user)
		for (const key of ['avatarDecoration', 'avatarDecorationData']) {
			const previous = descriptors[key]
			descriptors[key] = {
				configurable: true,
				enumerable: previous?.enumerable ?? true,
				writable: true,
				value: avatarDecoration,
			}
		}
		return Object.create(Object.getPrototypeOf(user), descriptors)
	} catch {
		// A guarded module adapter must not break Discord's message render path.
		return user
	}
}

export function installDiscordIntegration(
	cleanup: Cleanup,
	logger: LogLike,
): void {
	integrationLogger = logger
	cleanup(() => {
		integrationLogger = undefined
		userStore = undefined
	})
	cleanup(clearUserDecorations)
	cleanup(() => resetCurrentUser(null))
	const patched = new WeakSet<object>()
	let userStoreFound = false
	let resolverFound = false
	let animationUtilityFound = false
	const diagnostics = setTimeout(() => {
		if (!userStoreFound)
			logger.warn(
				'UserStore was not found. Decor selection data can load, but Discord user metadata integration is inactive.',
			)
		if (!resolverFound)
			logger.warn(
				'Discord avatar decoration URL resolver was not found. Custom image URL handling is inactive.',
			)
		if (!animationUtilityFound)
			logger.warn(
				'Discord avatar decoration animation utility was not found. iOS local-file animation support is inactive.',
			)
	}, 8_000)
	cleanup(() => clearTimeout(diagnostics))

	const currentAccountId = (): string | null => {
		try {
			const user = userStore?.getCurrentUser?.()
			return typeof user?.id === 'string' ? user.id : null
		} catch {
			return null
		}
	}

	const syncAccount = (clearCache: boolean): void => {
		const accountId = currentAccountId()
		const previous = getAuthSnapshot().accountId
		if (clearCache && accountId !== previous) {
			clearUserDecorations()
			resetCurrentUser(accountId)
			if (accountId) {
				currentSelections.delete(accountId)
				pendingCurrentSelections.add(accountId)
			}
		}
		if (getCurrentUserState().accountId !== accountId)
			resetCurrentUser(accountId)
		activateAccount(accountId)
		if (!accountId) return
		if (getAuthSnapshot().token)
			void refreshCurrentUser().catch(() => undefined)
		else resetCurrentUser(accountId)
		queueUserDecorations([accountId])
	}

	const applyReturnedUser = (user: unknown): unknown => {
		if (!isRecord(user) || typeof user.id !== 'string') return user
		let asset = getUserDecorationAsset(user.id)
		if (user.id === getAuthSnapshot().accountId) {
			if (pendingCurrentSelections.has(user.id)) {
				queueUserDecorations([user.id])
				return decorateUser(user, null)
			}
			const selected = currentSelections.get(user.id)
			if (currentSelections.has(user.id))
				asset = selected
					? `${selected.animated ? 'a_' : ''}${selected.hash}`
					: null
		}
		if (asset === undefined) {
			queueUserDecorations([user.id])
			return user
		}
		const current = user.avatarDecoration
		if (current?.skuId === DECOR_SKU_ID && current.asset === asset) return user
		return decorateUser(user, asset)
	}

	const attachUserStore = (store: AnyRecord): void => {
		if (!isRecord(store) || patched.has(store)) return
		if (
			typeof store.getCurrentUser !== 'function' ||
			typeof store.getUser !== 'function'
		) {
			logger.warn(
				'UserStore was found without getCurrentUser/getUser; decoration metadata integration is inactive.',
			)
			return
		}
		userStore = store
		userStoreFound = true
		patched.add(store)
		cleanup(
			instead(
				store as Record<string, (...args: any[]) => any>,
				'getUser',
				function (
					this: unknown,
					args: any[],
					original: (...args: any[]) => any,
				) {
					const user = original.apply(this, args)
					return applyReturnedUser(user)
				},
			),
		)
		cleanup(
			instead(
				store as Record<string, (...args: any[]) => any>,
				'getCurrentUser',
				function (
					this: unknown,
					args: any[],
					original: (...args: any[]) => any,
				) {
					return applyReturnedUser(original.apply(this, args))
				},
			),
		)
		configureUserDecorations(
			logger,
			id => {
				try {
					return store.getUser(id)
				} catch {
					return undefined
				}
			},
			(user, asset) => {
				try {
					if (user?.id === getAuthSnapshot().accountId)
						pendingCurrentSelections.delete(user.id)
					void Dispatcher.dispatch({
						type: 'USER_UPDATE',
						user: decorateUser(user, asset),
					} as any).catch(error => {
						logger.warn(
							`Could not dispatch a user decoration update: ${error instanceof Error ? error.message : 'dispatch failed'}`,
						)
					})
				} catch (error) {
					logger.warn(
						`Could not refresh a user decoration in Discord: ${error instanceof Error ? error.message : 'dispatch failed'}`,
					)
				}
			},
		)
		syncAccount(false)
		logger.log('User decoration metadata integration attached.')
	}

	// Prefer the named Flux store, and fall back to a validated module signature.
	cleanup(getStore<AnyRecord>('UserStore', attachUserStore))
	const [existingUserStore] = lookupModule(
		withProps('getCurrentUser', 'getUser'),
		{ returnNamespace: true, initialize: false },
	)
	if (isRecord(existingUserStore)) attachUserStore(existingUserStore)
	cleanup(
		getModules(
			withProps('getCurrentUser', 'getUser'),
			exports => attachUserStore(exports as AnyRecord),
			{ max: 16 },
		),
	)

	const resolverTargets = new WeakSet<object>()
	const attachResolver = (moduleExports: unknown): void => {
		if (!isRecord(moduleExports)) return
		const targets = [moduleExports.default, moduleExports]
		for (const target of targets) {
			if (
				!isRecord(target) ||
				typeof target.getAvatarDecorationURL !== 'function' ||
				resolverTargets.has(target)
			)
				continue
			resolverTargets.add(target)
			resolverFound = true
			cleanup(
				instead(
					target as Record<string, (...args: any[]) => any>,
					'getAvatarDecorationURL',
					function (
						this: unknown,
						args: any[],
						original: (...args: any[]) => any,
					) {
						const [options] = args
						const customUrl = decorationAssetUrl(
							options?.avatarDecoration,
							options?.canAnimate,
						)
						if (customUrl) return customUrl
						return original.apply(this, args)
					},
				),
			)
			logger.log('Avatar decoration URL resolver attached.')
		}
	}
	const [existingResolver] = lookupModule(withProps('getAvatarDecorationURL'), {
		returnNamespace: true,
		initialize: false,
	})
	attachResolver(existingResolver)
	cleanup(
		getModules(withProps('getAvatarDecorationURL'), attachResolver, { max: 8 }),
	)

	const animatedTargets = new WeakSet<object>()
	const attachAnimationUtility = (moduleExports: unknown): void => {
		if (!isRecord(moduleExports)) return
		for (const target of [moduleExports.default, moduleExports]) {
			if (
				!isRecord(target) ||
				typeof target.isAnimatedAvatarDecoration !== 'function' ||
				animatedTargets.has(target)
			)
				continue
			animatedTargets.add(target)
			animationUtilityFound = true
			cleanup(
				instead(
					target as Record<string, (...args: any[]) => any>,
					'isAnimatedAvatarDecoration',
					function (
						this: unknown,
						args: any[],
						original: (...args: any[]) => any,
					) {
						const result = original.apply(this, args)
						const decoration = args[0]
						if (
							ReactNative.Platform.OS === 'ios' &&
							decoration?.skuId === RAW_SKU_ID &&
							decoration?.asset?.startsWith('file://')
						)
							return true
						return result
					},
				),
			)
		}
	}
	const [existingAnimationUtility] = lookupModule(
		withProps('isAnimatedAvatarDecoration'),
		{ returnNamespace: true, initialize: false },
	)
	attachAnimationUtility(existingAnimationUtility)
	cleanup(
		getModules(
			withProps('isAnimatedAvatarDecoration'),
			attachAnimationUtility,
			{ max: 8 },
		),
	)

	const onConnection = () => {
		clearUserDecorations()
		const id = currentAccountId()
		resetCurrentUser(id)
		activateAccount(id)
		if (id) {
			currentSelections.delete(id)
			pendingCurrentSelections.add(id)
		}
		if (id && getAuthSnapshot().token)
			void refreshCurrentUser().catch(() => undefined)
		if (id) queueUserDecorations([id])
	}
	cleanup(onFluxEventDispatched('CONNECTION_OPEN', onConnection))
	cleanup(
		onFluxEventDispatched('USER_SETTINGS_ACCOUNT_SUBMIT_SUCCESS', () =>
			syncAccount(true),
		),
	)
	cleanup(
		onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', (payload: AnyRecord) => {
			const ids = Array.isArray(payload.messages)
				? payload.messages.map((message: any) => message?.author?.id)
				: []
			queueUserDecorations(ids)
		}),
	)
	cleanup(
		onFluxEventDispatched('MESSAGE_CREATE', (payload: AnyRecord) => {
			const id = payload.message?.author?.id
			if (id) queueUserDecorations([id])
		}),
	)
	cleanup(
		onFluxEventDispatched('TYPING_START', (payload: AnyRecord) => {
			if (payload.userId) queueUserDecorations([payload.userId])
		}),
	)
	cleanup(
		onFluxEventDispatched('USER_PROFILE_MODAL_OPEN', (payload: AnyRecord) => {
			if (payload.userId) queueUserDecorations([payload.userId])
		}),
	)

	syncAccount(false)
}

export function setCurrentDecorAsset(
	accountId: string,
	decoration: Decoration | null,
): void {
	const asset = decoration
		? `${decoration.animated ? 'a_' : ''}${decoration.hash}`
		: null
	setUserDecorationAsset(accountId, asset)
	const previous = currentSelections.get(accountId)
	if (
		currentSelections.has(accountId) &&
		previous?.hash === decoration?.hash &&
		previous?.animated === decoration?.animated
	)
		return
	currentSelections.set(accountId, decoration)
	pendingCurrentSelections.delete(accountId)
	try {
		const user = userStore?.getUser(accountId)
		if (user)
			void Dispatcher.dispatch({
				type: 'USER_UPDATE',
				user: decorateUser(user, asset),
			} as any).catch(error => {
				integrationLogger?.warn(
					`Could not dispatch the current user decoration update: ${error instanceof Error ? error.message : 'dispatch failed'}`,
				)
			})
	} catch {
		// Cached user metadata is applied on its next store read.
	}
}
