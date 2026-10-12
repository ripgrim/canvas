import { Container } from "@cloudflare/containers"
import { validateCoordinatorEnv } from "./config.js"
import type { SyncCoordinatorEnv } from "./config.js"
import { proxyRoomUpgrade } from "./index.js"
import type { DurableObjectContext } from "./platform.js"

const roomContainerPort = 4325
type ContainerContext = ConstructorParameters<typeof Container<SyncCoordinatorEnv>>[0]

export class LocalFileSyncRoom {
  readonly #context: DurableObjectContext
  readonly #env: SyncCoordinatorEnv

  constructor(context: DurableObjectContext, env: SyncCoordinatorEnv) {
    this.#context = context
    this.#env = env
  }

  fetch(request: Request): Promise<Response> {
    return proxyRoomUpgrade({ request, env: this.#env, storage: this.#context.storage })
  }
}

export class FileSyncRoom extends Container<SyncCoordinatorEnv> {
  readonly #context: ContainerContext
  readonly #env: SyncCoordinatorEnv
  defaultPort = roomContainerPort
  pingEndpoint = "container/healthz"
  enableInternet = true

  constructor(context: ContainerContext, env: SyncCoordinatorEnv) {
    super(context, env)
    this.#context = context
    this.#env = env
    const configuration = validateCoordinatorEnv(env)
    this.sleepAfter = Math.ceil(configuration.inactivityMs / 1_000)
    this.envVars = {
      DATABASE_URL: configuration.databaseUrl,
      SYNC_ROOM_TICKET_SECRET: configuration.ticketSecretText,
      ALLOWED_ORIGINS: configuration.allowedOriginsText,
      SYNC_ROOM_CHECKPOINT_DIR: "/tmp/canvas-checkpoints",
      HOST: "0.0.0.0",
      PORT: String(roomContainerPort),
      SYNC_HOST_MAX_ROOMS: "1",
      SYNC_ROOM_ALLOW_NON_LOOPBACK: "true",
    }
  }

  fetch(request: Request): Promise<Response> {
    return proxyRoomUpgrade({
      request,
      env: this.#env,
      storage: this.#context.storage,
      runtimeFetch: runtimeRequest => super.fetch(runtimeRequest),
    })
  }
}
