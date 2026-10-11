# Sync runtime

Private staging router for the authoritative room Containers. It maps one file
generation to one stable Container object, starts the room host on demand, waits
for `/healthz`, forwards the WebSocket upgrade, and lets the Container sleep
after ten idle minutes.

The Worker has no public route and `workers_dev` is disabled. Only this boundary
holds the staging database URL and room-ticket secret. The coordinator reaches it
through a service binding. Production is not configured.
