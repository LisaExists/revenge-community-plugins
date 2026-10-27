/**
 * Hidden Channels — Revenge Next port.
 * Plugin version: 1.1.3
 *
 * Upstream project: https://github.com/lioncat6/revenge-plugins
 * The upstream repository credits cloudburst and Training Dummy.
 * This port uses the public Revenge Next plugin APIs documented at:
 * https://github.com/revenge-mod/revenge-plugin-template
 */

import { Image, Pressable, StyleSheet, Text as NativeText, useColorScheme, View } from 'react-native'
import { getAssetIdByName } from '@revenge-mod/assets'
import { AlertActionCreators, ToastActionCreators } from '@revenge-mod/discord/actions'
import { getStore } from '@revenge-mod/discord/flux'
import { Design } from '@revenge-mod/discord/design'
import { Clipboard } from '@revenge-mod/externals/react-native-clipboard'
import { getModules, lookupModule, lookupModules, waitForModules } from '@revenge-mod/modules/finders'
import { withName, withProps } from '@revenge-mod/modules/finders/filters'
import { instead } from '@revenge-mod/patcher'
import { afterJSX } from '@revenge-mod/react/jsx-runtime'

interface HiddenChannelsSettings {
  showIcon: boolean
  showPopup: boolean
  showStartupWarningPopup: boolean
}

type AnyRecord = Record<string, any>
type ChannelRecord = AnyRecord & {
  id?: string
  type?: number | string
  topic?: string | null
  lastMessageId?: string | null
  lastPinTimestamp?: number | string | null
}

const ALERT_KEY = 'de.lisaexists.hidden-channels-next.confirm'
const TOAST_KEY = 'de.lisaexists.hidden-channels-next.date'
const STARTUP_WARNING_ALERT_KEY = 'de.lisaexists.hidden-channels-next.server-warning'
const STARTUP_WARNING_TOAST_KEY = 'de.lisaexists.hidden-channels-next.server-warning-toast'


const DEVELOPER_USER_IDS = new Set<string>(['836161010053283890'])

function getCurrentDiscordUserId(): string | undefined {
  try {
    for (const [moduleExports] of lookupModules(withProps('getCurrentUser'))) {
      for (const target of [moduleExports, moduleExports?.default]) {
        if (!target || typeof target.getCurrentUser !== 'function') continue
        try {
          const id = target.getCurrentUser()?.id
          if (typeof id === 'string' && id.length > 0) return id
        } catch {
          // A candidate module may not be the active user store; try the next one.
        }
      }
    }
  } catch {
    // Fail closed: if the current user cannot be resolved, do not show developer settings.
  }
  return undefined
}

function isDeveloperUser(): boolean {
  const userId = getCurrentDiscordUserId()
  return userId !== undefined && DEVELOPER_USER_IDS.has(userId)
}

/**
 * Resolve Discord's active theme when possible, since a user can choose a
 * Discord theme that differs from the device theme. Fall back to React Native's
 * color scheme if the internal theme store is not available in this Discord build.
 */
function getDiscordThemeIsLight(): boolean | undefined {
  const isLightTheme = (value: unknown): boolean | undefined => {
    if (typeof value !== 'string') return undefined
    const theme = value.toLowerCase()
    if (theme === 'light') return true
    if (['dark', 'darker', 'midnight', 'ash', 'onyx'].includes(theme)) return false
    return undefined
  }

  try {
    for (const [moduleExports] of lookupModules(withProps('theme'))) {
      for (const target of [moduleExports, moduleExports?.default]) {
        if (!target) continue

        // Prefer the directly exposed ThemeStore.theme, but also support builds
        // that expose the active theme only through the store state.
        try {
          const directTheme = isLightTheme(target.theme)
          if (directTheme !== undefined) return directTheme
        } catch {
          // A getter on an unrelated module can throw; continue searching.
        }

        try {
          if (typeof target.getState === 'function') {
            const stateTheme = isLightTheme(target.getState()?.theme)
            if (stateTheme !== undefined) return stateTheme
          }
        } catch {
          // Keep looking for the actual theme store.
        }
      }
    }
  } catch {
    // Internal theme discovery is best-effort; use the system appearance below.
  }

  return undefined
}

/** Apply readable text colors to every custom React Native Text in this plugin. */
function ThemedText(props: { children?: any; style?: any; [key: string]: any }) {
  const systemColorScheme = useColorScheme()
  const isLight = getDiscordThemeIsLight() ?? systemColorScheme === 'light'
  return (
    <NativeText
      {...props}
      style={[{ color: isLight ? '#23272A' : '#F2F3F5' }, props.style]}
    />
  )
}

// Keep the existing JSX unchanged while making all plugin-owned Text theme-aware.
const Text = ThemedText

// November 6 is the reported date, not one I could confirm in Discord's public
// documentation. Discord's developer docs currently list November 16, 2026 for
// mandatory channel obfuscation for bots. Keep the uncertainty explicit.
const SERVER_SIDE_CHANGE_WARNING =
  '⚠️ **SUPPORT WILL NOT BE GIVEN** ⚠️ \nDiscord will stop sending hidden channel names and metadata starting November 16, 2026. Once Discord stops sending real hidden-channel names or metadata to your client, this plugin cannot recover that missing data.'
const SERVER_SIDE_CHANGE_NOTIFICATION =
  'Hidden Channels warning: Discord server-side changes on November 16, 2026 will break this plugin. See the plugin settings for details.'

const styles = StyleSheet.create({
  details: {
    paddingVertical: 8,
    gap: 8,
  },
  heading: {
    fontWeight: '700',
    marginTop: 4,
  },
  dateValue: {
    textDecorationLine: 'underline',
  },
  lockIcon: {
    width: 20,
    height: 20,
    marginRight: 4,
  },
  warningContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 6,
  },
  warningHeading: {
    fontWeight: '700',
  },
  warningText: {
    lineHeight: 20,
  },
})

/**
 * Module finders can return either a namespace or a default export. Prefer the
 * candidate that actually exposes all requested properties, as recommended
 * by the Revenge Next module-finder API.
 */
function findFunction(module: AnyRecord | undefined, name: string): ((...args: any[]) => any) | undefined {
  if (!module) return undefined
  if (typeof module[name] === 'function') return module[name]
  if (typeof module.default === 'function') return module.default
  if (typeof module.default?.[name] === 'function') return module.default[name]
  return undefined
}

function describeValueBriefly(value: unknown): string {
  try {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value !== 'object' && typeof value !== 'function') {
      return `${typeof value}:${String(value).slice(0, 60)}`
    }
    const record = value as AnyRecord
    const fields: string[] = []
    for (const key of ['id', 'type', 'guild_id', 'guildId', 'channelId', 'channel_id', 'name']) {
      try {
        const field = record[key]
        if (field !== undefined && (typeof field !== 'object' || field === null)) {
          fields.push(`${key}=${String(field).slice(0, 36)}`)
        }
      } catch {
        // Do not let a diagnostic summary break calls on proxied Discord models.
      }
    }
    return `${typeof value}{${fields.join(', ') || 'no common channel fields'}}`
  } catch (error) {
    return `<summary-error:${String(error).slice(0, 60)}>`
  }
}

const PERMISSION_ENUM_KEYS = [
  'ADMINISTRATOR',
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'MANAGE_CHANNELS',
  'MANAGE_MESSAGES',
  'CONNECT',
  'ATTACH_FILES',
]

function isPermissionScalar(value: unknown): boolean {
  if (typeof value === 'bigint') return value > 0n
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function permissionEnumFromExports(moduleExports: unknown): AnyRecord | undefined {
  if (moduleExports === null || (typeof moduleExports !== 'object' && typeof moduleExports !== 'function')) return undefined
  const module = moduleExports as AnyRecord
  const candidates = [
    module.Permissions,
    module.constants?.Permissions,
    module.default?.Permissions,
    module.default?.constants?.Permissions,
    module.default,
    module,
  ]

  return candidates.find((candidate) => {
    if (candidate == null || (typeof candidate !== 'object' && typeof candidate !== 'function')) return false
    if (!isPermissionScalar(candidate.VIEW_CHANNEL)) return false
    const matchingKeys = PERMISSION_ENUM_KEYS.filter((key) => isPermissionScalar(candidate[key]))
    return matchingKeys.length >= 3
  }) as AnyRecord | undefined
}

function findViewChannelPermission(): unknown {
  // Search all matching exports but accept only a corroborated permission enum.
  // A generic export named VIEW_CHANNEL alone is not enough to identify the enum.
  for (const [moduleExports] of lookupModules(withProps('Permissions'))) {
    const permissionEnum = permissionEnumFromExports(moduleExports)
    if (permissionEnum) return permissionEnum.VIEW_CHANNEL
  }
  for (const [moduleExports] of lookupModules(withProps('VIEW_CHANNEL'))) {
    const permissionEnum = permissionEnumFromExports(moduleExports)
    if (permissionEnum) return permissionEnum.VIEW_CHANNEL
  }
  return undefined
}

function asDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  const date = normalized instanceof Date ? normalized : new Date(normalized as string | number)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function relativeDate(date: Date): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const absolute = Math.abs(seconds)
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ]

  let amount = absolute
  let unit = 'second'
  for (const [step, name] of units) {
    unit = name
    if (amount < step) break
    amount /= step
  }

  // The first pass uses seconds, then minutes/hours/days/months/years. Round
  // once at the end so values close to a unit boundary stay readable.
  const rounded = Math.max(1, Math.round(amount))
  const label = `${rounded} ${unit}${rounded === 1 ? '' : 's'}`
  return seconds < 0 ? `${label} ago` : `in ${label}`
}

function showToast(content: string): void {
  try {
    // Use the current Mana toast API: open(key, { text }). The legacy object
    // overload ({ key, content }) is deprecated and can leave toast state
    // malformed on newer Discord builds.
    ToastActionCreators.open(TOAST_KEY, { text: content })
  } catch (error) {
    console.warn('[Hidden Channels] Could not display toast:', error)
  }
}

function DateValue({ date }: { date: Date }) {
  return (
    <Pressable
      onPress={() => showToast(date.toLocaleString())}
      onLongPress={async () => {
        try {
          await Clipboard.setString(String(date.getTime()))
          showToast('Copied timestamp to clipboard')
        } catch (error) {
          console.warn('[Hidden Channels] Clipboard access failed:', error)
          showToast(String(date.getTime()))
        }
      }}
    >
      <Text style={styles.dateValue}>{relativeDate(date)}</Text>
    </Pressable>
  )
}

function ChannelDetails({
  channel,
  extractTimestamp,
}: {
  channel: ChannelRecord
  extractTimestamp?: (snowflake: string) => number
}) {
  const snowflakeDate = (id?: string | null) => {
    if (!id || typeof extractTimestamp !== 'function') return undefined
    try {
      return asDate(extractTimestamp(id))
    } catch {
      return undefined
    }
  }

  const creationDate = snowflakeDate(channel.id)
  const lastMessageDate = snowflakeDate(channel.lastMessageId)
  const lastPinDate = asDate(channel.lastPinTimestamp)

  return (
    <View style={styles.details}>
      <Text style={styles.heading}>Topic</Text>
      <Text>{channel.topic || 'No topic.'}</Text>

      <Text style={styles.heading}>Creation date</Text>
      {creationDate ? <DateValue date={creationDate} /> : <Text>Unavailable</Text>}

      <Text style={styles.heading}>Last message</Text>
      {lastMessageDate ? <DateValue date={lastMessageDate} /> : <Text>No messages.</Text>}

      <Text style={styles.heading}>Last pin</Text>
      {lastPinDate ? <DateValue date={lastPinDate} /> : <Text>No pins.</Text>}
    </View>
  )
}

export default plugin<{ jsonStorage: HiddenChannelsSettings }>({
  jsonStorage: {
    load: true,
    default: {
      showIcon: true,
      showPopup: true,
      showStartupWarningPopup: true,
    },
  },

  start({ cleanup, jsonStorage, logger }) {
    // JSON storage loading is asynchronous even when load: true is configured.
    // Do not read the startup popup preference until the persisted file has loaded,
    // otherwise an unset cache is mistaken for the default `true` on every launch.
    void (async () => {
      let startupSettings = jsonStorage.cache as HiddenChannelsSettings | undefined
      try {
        if (!jsonStorage.loaded || !startupSettings) {
          startupSettings = await jsonStorage.get() as HiddenChannelsSettings
        }
      } catch (error) {
        logger.warn(`[Hidden Channels] Could not load startup warning preferences: ${String(error)}`)
      }

      // The toast remains enabled even when the developer disables the dialog.
      try {
        // Use the current two-argument API rather than the deprecated
        // { key, content } overload, which can crash Discord's toast container.
        ToastActionCreators.open(STARTUP_WARNING_TOAST_KEY, {
          text: SERVER_SIDE_CHANGE_NOTIFICATION,
          variant: 'critical',
          duration: 10000,
        })
      } catch (error) {
        logger.warn(`[Hidden Channels] Could not display the startup warning notification: ${String(error)}`)
      }

      if (startupSettings?.showStartupWarningPopup ?? true) {
        try {
          AlertActionCreators.openAlert(
            STARTUP_WARNING_ALERT_KEY,
            <Design.AlertModal
              title="Hidden Channels compatibility warning"
              content={<Text>{SERVER_SIDE_CHANGE_WARNING}</Text>}
              actions={<Design.AlertActionButton text="Understood" />}
            />,
          )
        } catch (error) {
          logger.warn(`[Hidden Channels] Could not display the startup warning dialog: ${String(error)}`)
        }
      }
    })()

    // Read settings dynamically: jsonStorage.set() updates its cache while the
    // plugin remains active, just as the Classic storage proxy did.
    const getSettings = (): HiddenChannelsSettings => {
      const current = jsonStorage.cache as HiddenChannelsSettings | undefined
      return {
        showIcon: current?.showIcon ?? true,
        showPopup: current?.showPopup ?? true,
        showStartupWarningPopup: current?.showStartupWarningPopup ?? true,
      }
    }

    // Discord's internal permission store is not part of Revenge's stable public API.
    // Per the documented finder API, scan currently initialized modules without forcing
    // factories to run, and subscribe to future modules if it is not present yet.
    let runtimeInitialized = false
    let pendingPermissionCandidate: AnyRecord | undefined
    let discoveredViewChannelPermission: unknown
    let attemptedCandidates = 0
    const initializedTargets = new WeakSet<object>()

    const isObjectLike = (value: unknown): value is AnyRecord =>
      value !== null && (typeof value === 'object' || typeof value === 'function')
    // Fail closed: the Classic implementation's identifying signature is `can`
    // AND `getChannelPermissions` on the SAME exported object. Do not patch a
    // coincidental `can()` with only one vaguely similar permission-related method.
    const permissionTargetFrom = (candidate: AnyRecord | undefined): AnyRecord | undefined => {
      if (!candidate) return undefined
      const objects = [candidate, candidate.default]
      return objects.find((value) =>
        isObjectLike(value) &&
        typeof value.can === 'function' &&
        typeof value.getChannelPermissions === 'function'
      ) as AnyRecord | undefined
    }

    const initializeWithPermissionCandidate = (
      candidate: AnyRecord | undefined,
      source: 'trusted-store' | 'signature' | 'generic' = 'generic',
    ): boolean => {
      attemptedCandidates++
      if (runtimeInitialized || !candidate) return false

      const permissions = permissionTargetFrom(candidate)
      if (!permissions || initializedTargets.has(permissions)) return false

      const permissionCan = findFunction(permissions, 'can')
      if (!permissionCan) return false

      // Prefer a constant exposed by the store/module itself before querying the other
      // Discord exports. Some client revisions put Permissions on the permission module.
      const inlinePermission = permissionEnumFromExports(permissions)?.VIEW_CHANNEL
      const viewChannelPermission = discoveredViewChannelPermission
        ?? inlinePermission
        ?? findViewChannelPermission()

      if (viewChannelPermission === undefined) {
        pendingPermissionCandidate = candidate
        logger.log('Permission check module found; waiting for the Discord VIEW_CHANNEL constant.')
        return false
      }

      initializedTargets.add(permissions)
      runtimeInitialized = true
      logger.log(`Permission checks attached using a verified can + getChannelPermissions signature (${source}); ${attemptedCandidates} candidate(s) examined.`)

      let channelTypes: AnyRecord | undefined
      let getChannelMethod: ((id: string) => ChannelRecord | undefined) | undefined
      let getChannelContext: AnyRecord | undefined
      let extractTimestampMethod: ((snowflake: string) => number) | undefined
      let extractTimestampContext: AnyRecord | undefined

      const installChannelTypes = (moduleCandidate: AnyRecord) => {
        const target = [moduleCandidate.default, moduleCandidate].find(
          (value) => value != null && (value.ChannelTypes != null || ('DM' in Object(value) && 'GUILD_CATEGORY' in Object(value))),
        ) as AnyRecord | undefined
        if (target) channelTypes = target.ChannelTypes ?? target
      }
      const installChannelStore = (moduleCandidate: AnyRecord) => {
        const target = [moduleCandidate, moduleCandidate.default].find(
          (value) => value != null && typeof value.getChannel === 'function',
        ) as AnyRecord | undefined
        if (target) {
          getChannelMethod = target.getChannel.bind(target)
          getChannelContext = target
        }
      }
      const installSnowflakeUtils = (moduleCandidate: AnyRecord) => {
        const target = [moduleCandidate, moduleCandidate.default].find(
          (value) => value != null && typeof value.extractTimestamp === 'function',
        ) as AnyRecord | undefined
        if (target) {
          extractTimestampMethod = target.extractTimestamp.bind(target)
          extractTimestampContext = target
        }
      }
      const getChannel = (id: string): ChannelRecord | undefined => getChannelMethod?.call(getChannelContext, id)
      const extractTimestamp = (snowflake: string): number => {
        if (!extractTimestampMethod) throw new Error('Discord snowflake timestamp utility is not initialized')
        return extractTimestampMethod.call(extractTimestampContext, snowflake)
      }

      cleanup(getModules(withProps('ChannelTypes'), installChannelTypes, { max: 1 }))
      cleanup(getStore<AnyRecord>('ChannelStore', installChannelStore))
      if (!getChannelMethod) {
        cleanup(getModules(withProps('getChannel'), installChannelStore, { max: 1 }))
      }
      cleanup(getModules(withProps('extractTimestamp'), installSnowflakeUtils, { max: 1 }))

      const ignoredChannelTypes = [channelTypes?.DM ?? 1, channelTypes?.GROUP_DM ?? 3, channelTypes?.GUILD_CATEGORY ?? 4]

      // Channel models may be frozen/proxied in recent Discord builds. Never write
      // a sentinel property onto a Discord-owned object during React render.
      const channelIdsBeingChecked = new Set<string>()
      const isChannelRecord = (value: unknown): value is ChannelRecord =>
        isObjectLike(value) &&
        typeof value.id === 'string' && value.id.length > 0 &&
        (typeof value.type === 'number' || typeof value.type === 'string')

      function isHidden(input: ChannelRecord | string | undefined): boolean {
        let channel: ChannelRecord | undefined
        if (typeof input === 'string') {
          try {
            channel = getChannel(input)
          } catch {
            return false
          }
        } else {
          channel = input
        }

        if (!isChannelRecord(channel) || (ignoredChannelTypes as (string | number)[]).includes(channel.type ?? 0)) return false

        channelIdsBeingChecked.add(channel.id!)
        try {
          return !permissionCan!.call(permissions, viewChannelPermission, channel)
        } catch (error) {
          logger.warn(`A channel permission check failed: ${String(error)}`)
          return false
        } finally {
          channelIdsBeingChecked.delete(channel.id!)
        }
      }

      // IMPORTANT: Revenge Next's current patcher implementation calls `after`
      // hooks with only the original return value. The public API page has an older
      // callback signature; returning a second parameter from `after` turns can()
      // results into undefined and makes Discord hide every channel. Use `instead`,
      // whose current implementation receives (args, originalFunction).
      cleanup(
        instead(permissions, 'can', function (this: unknown, args: any[], original: (...args: any[]) => any) {
          if (typeof original !== 'function') {
            logger.warn('[Hidden Channels] Patcher did not provide the original can() function; preserving the call is impossible, so this hook is being skipped.')
            return undefined
          }

          // This is the documented runtime shape in revenge-bundle-next: `args`
          // is the function argument array and `original` is the original method.
          // Forward the original invocation first and preserve its receiver.
          if (!Array.isArray(args)) {
            logger.warn(`[Hidden Channels] Unsupported instead-hook argument shape (${describeValueBriefly(args)}); returning the original method's result with a single forwarded value.`)
            return original.apply(this, [args])
          }

          const result = original.apply(this, args)
          if (args.length < 2) return result
          const [permission, channel] = args
          if (permission !== viewChannelPermission || !isChannelRecord(channel)) return result

          const internalCheck = channelIdsBeingChecked.has(channel.id!)
          // Keep internal hidden-state probes intact. For normal UI calls, expose
          // the channel row only when the call actually has the expected permission
          // constant and a channel-shaped second argument.
          if (!internalCheck && result !== true) return true
          return result
        }),
      )

      const installTransitionToGuild = (moduleCandidate: AnyRecord) => {
        const transitionToGuild = [moduleCandidate.default, moduleCandidate].find(
          (value) => value != null && (typeof value === 'object' || typeof value === 'function') && 'transitionToGuild' in Object(value),
        ) as AnyRecord | undefined
        if (!transitionToGuild) return

        for (const key of Object.keys(transitionToGuild)) {
          if (typeof transitionToGuild[key] !== 'function') continue
          cleanup(
            instead(transitionToGuild, key, (args: any[], original: (...args: any[]) => any) => {
              if (typeof original !== 'function') {
                logger.warn(`Skipping ${key}: the original navigation callback was unavailable.`)
                return undefined
              }
              if (!Array.isArray(args)) {
                logger.warn(`Skipping hidden-channel interception for ${key}: the patcher supplied unsupported arguments.`)
                return original()
              }

              const path = args[0]
              if (typeof path === 'string') {
                const channelId = path.match(/(\d+)$/)?.[1]
                const channel = channelId ? getChannel(channelId) : undefined
                if (channel && isHidden(channel)) {
                  if (!getSettings().showPopup) return original(...args)
                  try {
                    AlertActionCreators.openAlert(
                      ALERT_KEY,
                      <Design.AlertModal
                        title="This channel is hidden."
                        content={<ChannelDetails channel={channel} extractTimestamp={extractTimestamp} />}
                        actions={
                          <>
                            <Design.AlertActionButton text="Cancel" />
                            <Design.AlertActionButton text="View Anyway" onPress={() => original(...args)} />
                          </>
                        }
                      />,
                    )
                    return {}
                  } catch (error) {
                    logger.warn(`Could not open the hidden-channel confirmation; continuing navigation: ${String(error)}`)
                  }
                }
              }
              return original(...args)
            }),
          )
        }
      }
      cleanup(getModules(withProps('transitionToGuild'), installTransitionToGuild, { max: 1 }))

      const installChannelInfo = (moduleCandidate: AnyRecord) => {
        const channelInfoComponent = [moduleCandidate?.default, moduleCandidate].find(
          (value) => typeof value === 'function',
        )
        if (typeof channelInfoComponent !== 'function') {
          logger.warn('A ChannelInfo module matched by name but did not expose a component function.')
          return
        }

        // Revenge's docs recommend JSX-runtime hooks for component output changes
        // instead of patching component render functions. Wrapping the created
        // element leaves the original ChannelInfo component and props untouched.
        cleanup(
          afterJSX(channelInfoComponent, (element: any) => {
            try {
              const channel = element?.props?.channel as ChannelRecord | undefined
              if (!getSettings().showIcon || !isChannelRecord(channel) || !isHidden(channel)) return element
              const lockIconId = getAssetIdByName('ic_lock')
              if (lockIconId === undefined || lockIconId === null) return element
              return <><Image source={lockIconId} style={styles.lockIcon} />{element}</>
            } catch (error) {
              // UI decoration must never prevent a channel row from rendering.
              logger.warn(`Could not decorate a ChannelInfo element; preserving it: ${String(error)}`)
              return element
            }
          }),
        )
        logger.log('ChannelInfo JSX hook attached.')
      }
      cleanup(getModules(withName('ChannelInfo'), installChannelInfo, { max: 1 }))
      return true
    }

    const retryPendingPermissionStore = (moduleExports?: AnyRecord) => {
      const permissionEnum = permissionEnumFromExports(moduleExports)
      if (permissionEnum) discoveredViewChannelPermission = permissionEnum.VIEW_CHANNEL
      if (pendingPermissionCandidate && !runtimeInitialized) {
        const candidate = pendingPermissionCandidate
        initializeWithPermissionCandidate(candidate, 'signature')
      }
    }

    // Fast path for the original Classic export shape. This lookup avoids initializing
    // uninitialized modules; a miss is not treated as definitive.
    const [initialPermissions, initialPermissionId] = lookupModule(
      withProps('getChannelPermissions', 'can'),
      { returnNamespace: true, initialize: false },
    )
    if (initialPermissionId !== undefined && initialPermissions != null) {
      initializeWithPermissionCandidate(initialPermissions as AnyRecord, 'signature')
    }

    // Prefer Revenge's named Flux-store resolver for PermissionStore.
    if (!runtimeInitialized) {
      cleanup(getStore<AnyRecord>('PermissionStore', (store) => {
        initializeWithPermissionCandidate(store as AnyRecord, 'trusted-store')
      }))
    }

    // Subscribe to the identifying signature: can + getChannelPermissions on the same export.
    if (!runtimeInitialized) {
      cleanup(getModules(withProps('getChannelPermissions', 'can'), (moduleExports) => {
        initializeWithPermissionCandidate(moduleExports as AnyRecord, 'signature')
      }, { max: 8 }))
    }

    // Fallback: scan already-initialized can() exports, and wait for future exports only
    // when no candidate has been found. The candidate still must expose both methods.
    if (!runtimeInitialized) {
      let scannedCanModules = 0
      try {
        for (const [moduleExports] of lookupModules(withProps('can'))) {
          scannedCanModules++
          if (initializeWithPermissionCandidate(moduleExports as AnyRecord, 'generic')) break
          if (runtimeInitialized || pendingPermissionCandidate) break
        }
      } catch (error) {
        logger.warn(`Could not scan initialized permission candidates: ${String(error)}`)
      }

      if (!runtimeInitialized && !pendingPermissionCandidate) {
        logger.log(`Permission discovery scanned ${scannedCanModules} initialized can() candidate(s); no matching permission module was found yet.`)
        let stopWaiting: (() => void) | undefined
        stopWaiting = waitForModules(withProps('can'), (moduleExports) => {
          const activated = initializeWithPermissionCandidate(moduleExports as AnyRecord, 'generic')
          if ((activated || pendingPermissionCandidate) && stopWaiting) stopWaiting()
        })
        cleanup(stopWaiting)
      }
    }

    // Permission enums can initialize after the store itself. Keep checking multiple
    // matching exports; max: 1 could stop at an unrelated Permissions object.
    if (!runtimeInitialized && pendingPermissionCandidate) {
      cleanup(getModules(withProps('Permissions'), retryPendingPermissionStore, { max: 64 }))
      cleanup(getModules(withProps('VIEW_CHANNEL'), retryPendingPermissionStore, { max: 64 }))
      cleanup(getModules(withProps('PermissionsBits'), retryPendingPermissionStore, { max: 64 }))
      logger.log('Permission check candidate found; waiting for the VIEW_CHANNEL constant before enabling hidden-channel detection.')
    } else if (!runtimeInitialized) {
      cleanup(getModules(withProps('Permissions'), retryPendingPermissionStore, { max: 64 }))
      cleanup(getModules(withProps('VIEW_CHANNEL'), retryPendingPermissionStore, { max: 64 }))
      cleanup(getModules(withProps('PermissionsBits'), retryPendingPermissionStore, { max: 64 }))
      logger.warn(`No verified permission module was found (${attemptedCandidates} candidate(s) inspected). Hidden-channel detection is inactive; normal channel visibility is unchanged.`)
    }

  },

  SettingsComponent({ api }) {
    const settings = api.jsonStorage.use()

    return (
      <>
        <Design.TableRowGroup title="Options">
          <Design.TableSwitchRow
            label="Show Lock Icon"
            subLabel="Show a lock icon beside hidden channel names."
            value={settings?.showIcon ?? true}
            onValueChange={(showIcon: boolean) => api.jsonStorage.set({ showIcon })}
          />
          <Design.TableSwitchRow
            label="Show Popup on Hidden Channels"
            subLabel="Ask before opening a channel marked as hidden."
            value={settings?.showPopup ?? true}
            onValueChange={(showPopup: boolean) => api.jsonStorage.set({ showPopup })}
          />
        </Design.TableRowGroup>
        <Design.TableRowGroup title="Compatibility Warning">
          <View style={styles.warningContainer}>
            <Text style={styles.warningHeading}>Upcoming server-side compatibility risk</Text>
            <Text style={styles.warningText}>{SERVER_SIDE_CHANGE_WARNING}</Text>
          </View>
        </Design.TableRowGroup>
        {isDeveloperUser() ? (
          <Design.TableRowGroup title="Developer">
            <Design.TableSwitchRow
              label="Show Startup Warning Popup"
              subLabel="Disable the startup warning dialog on this device. The warning notification will still appear."
              value={settings?.showStartupWarningPopup ?? true}
              onValueChange={async (showStartupWarningPopup: boolean) => {
                try {
                  // Write a complete settings object so the preference is retained
                  // even if a storage adapter uses replacement semantics.
                  await api.jsonStorage.set({
                    showIcon: settings?.showIcon ?? true,
                    showPopup: settings?.showPopup ?? true,
                    showStartupWarningPopup,
                  })
                } catch (error) {
                  console.warn('[Hidden Channels] Could not save the startup warning preference:', error)
                }
              }}
            />
          </Design.TableRowGroup>
        ) : null}
      </>
    )
  },
})
