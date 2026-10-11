# Desktop session storage

The desktop auth client keeps session cookies and Better Auth's local session cache in the Electron main process. The renderer receives only the session status plus the user's id, name, email, and optional HTTPS avatar URL.

Persistent values are protected with Electron `safeStorage` before Conf writes them under Electron's `userData` directory. Better Auth's Electron plugin also protects its cookie and cache values before passing them to this package, so the persisted value is encrypted at both boundaries. Existing values written by the plugin are wrapped without first decrypting them.

The adapter receives the current platform explicitly. On Linux it persists only when `safeStorage` reports a named secret-store backend such as libsecret or KWallet. A missing or failing backend query, `unknown`, and `basic_text` all fail closed. Windows and macOS use their platform `safeStorage` implementation without the Linux-only backend query.

When operating-system encryption is unavailable or fails, the storage adapter keeps new values in process memory and does not write plaintext. A restart in that fallback state requires signing in again. Corrupt values, plaintext values, and values protected for another operating-system account fail closed as a missing session.

This protects session material at rest from casual file inspection. It does not protect against code executing in the trusted main process or an attacker who can use the signed-in operating-system account's credential facilities.
