import { RegistryEntry, registryAssets, registryContract } from 'virtual:canvas-verified-component-registry'

document.documentElement.dataset.component = RegistryEntry?.name ?? ''
document.documentElement.dataset.registry = registryContract.fingerprint
document.documentElement.dataset.mark = registryAssets['fixture-mark'] ?? ''
