import { Pool } from 'pg'
import { createHostedAuth, databaseURLFromEnvironment, hostedAuthOptionsFromEnvironment } from './server'
import type { HostedAuth } from './server'

let hostedAuth: HostedAuth | undefined

/** Server-only singleton used by hosted web routes. */
export function getHostedAuth(environment: NodeJS.ProcessEnv = process.env): HostedAuth {
  if (hostedAuth) return hostedAuth
  const database = new Pool({ connectionString: databaseURLFromEnvironment(environment) })
  hostedAuth = createHostedAuth(hostedAuthOptionsFromEnvironment(environment, database))
  return hostedAuth
}
