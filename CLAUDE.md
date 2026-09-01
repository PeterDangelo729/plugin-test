# Working on this plugin with Claude

This file is context for Claude Code (and any other coding agent) working in
this repository. It is also the shortest accurate description of the plugin
model here, so it is worth reading yourself.

## What this repository is

A **SoundBase plugin**: a small network service that provides one or more
devices to SoundBase over a versioned HTTP contract. SoundBase spawns it as a
child process and supervises it — handshake, health, crash-restart, teardown.

The author writes device logic. The author never writes UI, IPC, or HTTP.

```
soundbase-plugin.json   identity, products, config fields
main.js                 shell bootstrap — never edit
adapter.js              device logic — this is the file that changes
driver/                 optional: protocol-specific code adapter.js uses
__tests__/              contract tests, driven through the real shell
```

## Invariants — do not violate these without being asked

- **Never edit `main.js`.** It is byte-identical across every first-party
  plugin and is the contract's entry point. Anything you are tempted to put
  there belongs in `adapter.js`.
- **Never implement HTTP, routing, SSE, auth, or sweep bookkeeping.**
  `@soundbase/plugin-shell` owns all of it. If a change involves an HTTP verb,
  it is almost certainly wrong.
- **Never read a device address from machine-local state.** Addressing arrives
  explicitly on `POST /devices`. The same project opened on another machine
  must work.
- **Device ids must be stable across restarts.** They appear in URLs and are
  stored in users' projects. `usb:<path>` and `net:<host>` are the conventions.
- **Clamp, do not reject.** Out-of-range config gets snapped to what the
  hardware accepts and echoed back. Rejection looks like a broken plugin.
- **Do not bump the `template` block** in `soundbase-plugin.json`. It records
  what this plugin was generated from and is meant to go stale.

## The adapter contract

`adapter.js` exports exactly two things:

```js
export async function discoverDevices(pluginConfig) → Device[]
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → {
  open()                 → { capabilities, identity }
  applyConfig(cfg)       → effective config, echoing what the device accepted
  startSweep(onTrace)    → calls onTrace(number[]) once per completed sweep
  stopSweep()
  close()
}
```

The normative specification is installed, not guessed at:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json
  core.openapi.yaml
  spectrum-analyzer.openapi.yaml
```

**Read those files before answering a question about the contract.** They ship
inside the dependency and always match the shell version in the lockfile, so
they are authoritative in a way that any summary — including this file — is not.

## Verifying a change

In order of what they prove:

```sh
npm test                          # adapter through the real shell, over HTTP
node scripts/validate-manifest.mjs # the manifest the host will refuse or accept
node scripts/smoke.mjs            # boots as a child process, handshakes, sweeps
```

A change is not done because `npm test` passes. If it touches discovery,
startup or the manifest, run the smoke check — that is the path that fails
silently in production, because a plugin that never handshakes is simply
invisible to SoundBase.

## Prompts that work

**Implementing a real device**

> Replace `adapter.js` so it talks to <device> over <transport>. Keep
> `discoverDevices` and `createSpectrumAnalyzerAdapter` as the only exports and
> put the protocol code in `driver/`. Read
> `node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml`
> first and match its semantics for `applyConfig`'s echo and trace geometry.
> Keep the existing tests passing — they are written against the contract, not
> against the synthetic source.

**Adding a device control**

> Add a <name> control. Declare it in `capabilities.controls` from `open()`
> using the config-field vocabulary, read it from `cfg.controls` in
> `applyConfig`, clamp it to what the hardware allows, and echo the settled
> value in the returned `effective.controls`. Add a test that a value outside
> the range comes back clamped rather than rejected.

**Wrapping a native library**

> Read `docs/native-runtimes.md` first. Put the libuhd work in a worker child
> process under `driver/worker/` speaking JSON-lines over stdio, so the driver
> can SIGKILL it when a call wedges. Give the worker a mock mode so tests run
> with no hardware attached.

**Diagnosing "my plugin does not appear in SoundBase"**

> Run `node scripts/smoke.mjs` and work from what it reports. Check in this
> order: does the handshake line appear at all; does `validateManifest` accept
> the manifest; does `GET /devices` return anything. The host gives up on a
> plugin that does not handshake, and logs nothing that explains why.

## What not to ask for

- **A second transport.** WebSocket, gRPC and subscription protocols are all
  out of scope; the contract is HTTP plus SSE lifecycle events, deliberately.
- **UI.** Plugins do not ship renderer code. If a device needs a knob SoundBase
  has never heard of, that is `capabilities.controls`, which renders generically
  and needs no SoundBase release.
- **Changes to the shell.** If the shell seems to be in the way, that is worth
  raising as an issue rather than working around — a workaround in `adapter.js`
  becomes the thing that breaks on the next contract version.
