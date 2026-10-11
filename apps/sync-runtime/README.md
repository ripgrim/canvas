# Sync runtime

Legacy standalone router for the authoritative room Containers. Staging now owns
the Container directly in the generation-scoped coordinator object so upgraded
WebSocket frames never cross an intermediate Worker. This package remains as an
isolated runtime reference and local compatibility surface.

The Worker has no public route and `workers_dev` is disabled. It is not part of
the staging deploy command. Production is not configured.
