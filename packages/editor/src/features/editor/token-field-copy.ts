/** Copy for token-bound color fields in the appearance inspector. `target` is a color label such as `Fill 1 color`. */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

export const tokenFieldCopy = {
  context: (hex: string, opacity: number) => `${hex} · ${opacity}%`,
  colorText: (hex: string, opacity: number) => `${hex}, ${opacity}% opacity`,
  aliasTo: (name: string) => `Alias to ${name}`,
  variesByTheme: 'Varies by theme',
  mixedTokens: 'Mixed tokens',
  mixedSources: 'Mixed sources',
  missingToken: (tokenId: string) => `Missing token: ${tokenId}`,
  incompatible: 'Incompatible token',
  unresolved: {
    cycle: (name: string) => `${name} aliases form a loop`,
    depth: (name: string) => `${name} alias chain is too long`,
    'missing-target': (name: string) => `${name} alias target is missing`,
  },
  boundLabel: (target: string, name: string, detail: string) => `${target}: ${name} token, ${detail}`,
  stateLabel: (target: string, state: string) => `${target}: ${state}`,
  rebind: 'Rebind',
  rebindAll: 'Rebind all',
  unlink: 'Unlink',
  editToken: 'Edit token',
  rebindLabel: (target: string) => `Rebind ${lower(target)}`,
  rebindAllLabel: (target: string) => `Rebind ${lower(target)} on every layer`,
  unlinkLabel: (target: string) => `Unlink ${lower(target)}`,
  unlinkEachLabel: (target: string) => `Unlink ${lower(target)} on every layer`,
  editLabel: (name: string, target: string) => `Edit token ${name} from ${lower(target)}`,
  unlinkUnavailable: 'Unlink needs a token that resolves to a color',
} as const
