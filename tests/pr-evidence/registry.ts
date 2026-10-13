import definitions from "./registry.json"
import { parseEvidenceRegistry } from "@canvas/pr-evidence"

const registry = parseEvidenceRegistry(definitions)

export const evidenceCapabilities = registry.capabilities
export const evidenceScenarios = registry.scenarios
export const evidenceTitles = registry.titles
