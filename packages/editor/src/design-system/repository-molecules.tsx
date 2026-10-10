import type { ShadcnComponent, ShadcnDiagnostic } from '@canvas/scanner/contracts'
import type { ReactNode } from 'react'
import { Button, Icon } from './atoms'
import { ThemeSwatch } from './theme-atoms'
import { RepositoryBulkBar, RepositoryDiagnostic, RepositoryDiagnosticList, RepositoryList, RepositoryMark, RepositoryRow, RepositoryRowAction, RepositoryRowBody, RepositorySelect, RepositorySelectionToggle, RepositorySummary } from './repository-atoms'

const nestedScrollThreshold = 6

export function RepositoryTokenList({ label, count, header, action, children }: { label: string; count: number; header?: ReactNode; action?: ReactNode; children: ReactNode }) { return <RepositoryList label={label} header={header} action={action} scrollable={count > nestedScrollThreshold}>{children}</RepositoryList> }

export function RepositoryTokenSelectAll({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) { return <div className="repository-list-header"><RepositorySelectionToggle label={label} checked={checked} disabled={disabled} onChange={onChange} /></div> }

export function RepositoryTokenRow({ property, name, color, selected, imported, disabled, selectLabel, importLabel, importedLabel, swatchLabel, onSelect, onImport }: { property: string; name: string; color: string; selected: boolean; imported: boolean; disabled: boolean; selectLabel: string; importLabel: string; importedLabel: string; swatchLabel: string; onSelect: (selected: boolean, range: boolean) => void; onImport: () => void }) {
  return <RepositoryRow selected={selected} onSelect={disabled || imported ? undefined : range => onSelect(!selected, range)}>
    <RepositorySelect label={selectLabel} checked={selected} disabled={disabled || imported} onChange={onSelect} />
    <ThemeSwatch color={color} label={swatchLabel} />
    <RepositoryRowBody name={name} detail={property} />
    <RepositoryRowAction><Button variant="ghost" disabled={disabled || imported} onClick={onImport}>{imported ? importedLabel : importLabel}</Button></RepositoryRowAction>
  </RepositoryRow>
}

export function RepositoryComponentList({ label, components }: { label: string; components: readonly ShadcnComponent[] }) {
  return <RepositoryList label={label} scrollable={components.length > nestedScrollThreshold}>{components.map(component => <RepositoryRow kind="component" key={`${component.path}:${component.exportName}`}>
    <RepositoryMark><Icon name="component" /></RepositoryMark>
    <RepositoryRowBody name={component.exportName} detail={`${component.path} · ${component.props.length} props${component.slots.length ? ` · ${component.slots.length} slots` : ''}`} />
  </RepositoryRow>)}</RepositoryList>
}

export function RepositoryBulkImport({ label, onImport }: { label: string; onImport: () => void }) { return <RepositoryBulkBar><Button variant="primary" onClick={onImport}>{label}</Button></RepositoryBulkBar> }

const diagnosticDetails: Record<ShadcnDiagnostic['code'], string> = {
  'unsupported-export': 'Non-component helpers and providers were skipped.',
  'invalid-config': 'A shadcn configuration could not be read.',
  'missing-css': 'A configured token stylesheet was not found.',
  'missing-ui-root': 'A configured component directory was not found.',
}

export function RepositoryDiagnostics({ label, diagnostics }: { label: string; diagnostics: readonly ShadcnDiagnostic[] }) {
  const groups = new Map<ShadcnDiagnostic['code'], number>()
  for (const diagnostic of diagnostics) groups.set(diagnostic.code, (groups.get(diagnostic.code) ?? 0) + 1)
  return <RepositoryDiagnosticList>{[...groups].map(([code, count]) => <RepositoryDiagnostic key={code} name={code.replaceAll('-', ' ')} count={count} detail={diagnosticDetails[code]} />)}<RepositorySummary>{label}</RepositorySummary></RepositoryDiagnosticList>
}
