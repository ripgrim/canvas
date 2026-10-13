import definitions from "./registry.json"
import { parseEvidenceRegistry } from "../../packages/pr-evidence/dist/index.js"

const registry = parseEvidenceRegistry(definitions)

export const evidenceCapabilities = registry.capabilities
export const evidenceScenarios = registry.scenarios
export const evidenceTitles = registry.titles
