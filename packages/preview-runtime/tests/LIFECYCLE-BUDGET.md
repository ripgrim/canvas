# Preview lifecycle test budget

`AT-PRV-004` opens, builds, and disposes four independent preview services in one test process. After the last disposal:

- every subscription must be detached;
- every build worker must be gone;
- every loopback HTTP port must refuse a connection;
- every service must reject restart; and
- process heap growth must stay at or below 96 MiB.

The heap limit includes Vite's module cache and memory retained by the Node.js allocator. The test does not force garbage collection, so the budget detects unbounded lifecycle retention without depending on a non-default `--expose-gc` runtime.
