import { runEntrypoint } from '@companion-module/base'
import { RemoteVolumeInstance } from './instance.js'
import { UpgradeScripts } from './upgrades.js'

runEntrypoint(RemoteVolumeInstance, UpgradeScripts)
