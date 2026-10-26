/* Decor Classic attribution: Fiery and Bwlok. Revenge Next port: LisaExists. GPL-3.0. */

import { FileModule } from '@revenge-mod/discord/native'
import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { ReactNative } from '@revenge-mod/react'
import type { NewDecoration } from '../types'

type ImageAsset = { uri?: string; type?: string; fileName?: string | null }
type PickerResponse = {
	didCancel?: boolean
	errorCode?: string
	errorMessage?: string
	assets?: ImageAsset[] | null
}
type Picker = (
	options: Record<string, unknown>,
	callback: (result: PickerResponse) => void,
) => unknown

let launchImageLibrary: Picker | undefined
let finding = false
const ready: Array<(picker: Picker | undefined) => void> = []

function acceptModule(moduleExports: unknown): void {
	if (
		!moduleExports ||
		(typeof moduleExports !== 'object' && typeof moduleExports !== 'function')
	)
		return
	const exports = moduleExports as Record<string, any>
	const candidates = [exports, exports.default]
	const candidate = candidates.find(
		item => item && typeof item.launchImageLibrary === 'function',
	)
	if (!candidate) return
	launchImageLibrary = candidate.launchImageLibrary.bind(candidate)
}

function findPicker(): Promise<Picker | undefined> {
	if (launchImageLibrary) return Promise.resolve(launchImageLibrary)
	return new Promise(resolve => {
		ready.push(resolve)
		if (finding) return
		finding = true
		let finished = false
		let unsubscribe: (() => void) | undefined
		const finish = (picker?: Picker) => {
			if (finished) return
			finished = true
			finding = false
			unsubscribe?.()
			while (ready.length) ready.shift()?.(picker)
		}
		const unsubscriber = getModules(
			withProps('launchImageLibrary'),
			moduleExports => {
				acceptModule(moduleExports)
				if (launchImageLibrary) finish(launchImageLibrary)
			},
			{ max: 16 },
		)
		if (finished) unsubscriber()
		else unsubscribe = unsubscriber
		setTimeout(() => finish(launchImageLibrary), 4_000)
	})
}

export async function pickPngDecoration(): Promise<NewDecoration | null> {
	const picker = await findPicker()
	if (!picker)
		throw new Error(
			'This Discord client does not expose its image picker to plugins.',
		)
	const response = await new Promise<PickerResponse>((resolve, reject) => {
		let called = false
		const done = (result: PickerResponse) => {
			if (called) return
			called = true
			resolve(result)
		}
		try {
			const returned = picker({ mediaType: 'photo', selectionLimit: 1 }, done)
			if (
				returned &&
				typeof (returned as Promise<PickerResponse>).then === 'function'
			) {
				void (returned as Promise<PickerResponse>).then(done, reject)
			}
		} catch (error) {
			reject(error)
		}
	})
	if (!response || typeof response !== 'object')
		throw new Error('The image picker returned an unreadable result.')
	if (response.didCancel) return null
	if (response.errorCode)
		throw new Error(
			response.errorMessage ||
				`Image selection failed (${response.errorCode}).`,
		)
	const asset = response.assets?.[0]
	if (!asset?.uri)
		throw new Error('The image picker did not return a readable image.')
	const type = asset.type?.toLowerCase()
	const fileName = asset.fileName || `decor-${Date.now()}.png`
	const extension = fileName.split('.').pop()?.toLowerCase()
	if (type !== 'image/png' || (extension !== 'png' && extension !== 'apng')) {
		throw new Error(
			'Choose a PNG or APNG image reported as image/png. JPEG, WebP, and other formats are not accepted.',
		)
	}
	return { uri: asset.uri, fileName, fileType: type, alt: '' }
}

export async function uploadUriForPlatform(
	uri: string,
	mimeType: string,
): Promise<string> {
	if (ReactNative.Platform.OS !== 'ios') return uri
	// Discord's FileModule is a typed Revenge Next bridge API. Repackage iOS
	// files as a data URI because the original service upload path can strip APNG
	// animation from file-backed multipart attachments on iOS.
	const base64 = await FileModule.readAsset(uri, 'base64')
	if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64))
		throw new Error('Could not read the selected image from iOS storage.')
	return `data:${mimeType};base64,${base64}`
}
