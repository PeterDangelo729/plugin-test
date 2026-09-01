# SoundBase Plugin Template

A complete, working SoundBase plugin. Clone it, run it, and you have a device
in SoundBase's live-scan picker within a minute — it serves a synthetic
spectrum (a noise floor, two carriers, an intermittent transient) so the whole
path works before you own any hardware.

Then you replace one file.

```sh
npm install
npm start
# SB_PLUGIN_READY {"port":54321}
# [info] template 0.1.0 listening on 127.0.0.1:54321
```

```sh
npm test          # the full contract, exercised against your adapter
```

## What a plugin is

A plugin is a **network service** that provides devices to SoundBase over a
versioned HTTP contract. SoundBase spawns it as a child process and supervises
it — handshake, health, crash-restart, teardown. You write device logic. You
never write UI, IPC, or HTTP.

```
soundbase-plugin.json   your identity, products and config fields
main.js                 shell bootstrap — copy it verbatim, never edit it
adapter.js              your device logic. This is the file you replace.
driver/                 optional: anything protocol-specific adapter.js uses
```

`@soundbase/plugin-shell` implements the entire contract: the HTTP server on
`127.0.0.1:0`, the `SB_PLUGIN_READY` stdout handshake, bearer-token auth, SSE
lifecycle events, sweep-id bookkeeping, `GET /trace` long-polling, and
trace-mode accumulation at full sweep rate. Your adapter never sees a request.

## Making it yours

**1. Edit `soundbase-plugin.json`.** Pick a unique lowercase `id`, then list
your `products` — each gets a namespaced `deviceTypeId` of the form
`plugin:<your-id>/<model>`.

**2. Replace `adapter.js`.** It exports two things:

```js
// called while SoundBase is enumerating; return currently reachable devices
export async function discoverDevices(pluginConfig) {
  return [{ id: 'usb:/dev/tty…', name: 'My Analyzer',
            product: 'plugin:my-id/model',
            transport: { kind: 'usb', path: '/dev/tty…' } }];
}

// one instance per device; device = { id, product, config }
export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return {
    async open() {              // connect + identify
      return {
        capabilities: { minFrequencyHz, maxFrequencyHz, rbwHz: [...] },
        identity: { model, firmware },
      };
    },
    async applyConfig(cfg) {    // cfg = { startHz, stopHz, pointCount?, rbwHz?, controls? }
      return effective;         // echo what the hardware actually accepted
    },
    async startSweep(onTrace) { /* call onTrace(ampsDbm: number[]) per sweep */ },
    async stopSweep() {},
    async close() {},
  };
}
```

**3. Keep the tests passing.** `__tests__/` drives your adapter through the
real shell over real HTTP — configure, sweep, trace geometry, max-hold
accumulation. They are written against the *contract*, not against the
synthetic source, so they keep meaning once your adapter talks to hardware.

## Rules that will bite you if you break them

- **Device ids are yours and must be stable across restarts.** `usb:<path>`,
  `net:<host>` are the conventions the first-party plugins use. They appear in
  URLs, and a project stores them.
- **Device addressing arrives explicitly** on `POST /devices`. Never read a
  device address from your own machine-local state — the same project opened on
  another machine must work.
- **Clamp, don't reject.** When a requested RBW or reference level is out of
  range, snap it and echo what you settled on. The form keeps showing the
  user's saved value either way; a rejection just looks broken.
- **Echo the effective config.** `applyConfig`'s return value is what
  `GET /devices/{id}/configuration` reports, so the host can always read back
  what is actually in force.
- **`main.js` stays byte-identical.** If you find yourself editing it, the
  thing you want almost certainly belongs in `adapter.js`.

## Device controls — knobs SoundBase has never heard of

Return `controls` from `open()` and SoundBase renders them beside RBW and point
count, then hands the values back in `applyConfig`'s `cfg.controls`, keyed by
the same ids:

```js
controls: [
  { id: 'refLevelDbm', type: 'number', label: 'Reference level',
    unit: 'dBm', default: -20, min: -56, max: 20 },
  { id: 'detector', type: 'dropdown', label: 'Detector', default: 'peak',
    choices: [{ id: 'peak', label: 'Peak' }, { id: 'average', label: 'Average' }] },
]
```

Nothing between the form and your adapter interprets them — SoundBase never
learns what a detector is. That means **adding a knob to a shipped plugin needs
no SoundBase release.** Build them in `open()` so ranges can come from the
hardware you just identified.

## Native code, and the gotcha that will cost you a week

If your device needs a native library or a language runtime, read
[`docs/native-runtimes.md`](docs/native-runtimes.md) before you design
anything. The short version, learned the hard way on a USRP:

**Put wedge-prone native work in a child process you can kill.** A blocking C
library that owns a USB device can hang mid-call when someone trips over the
cable. If that call is in your plugin's process, your plugin is gone and
SoundBase restarts it. If it is in a child, you `SIGKILL` it, report a clean
device error, and stay healthy. The process boundary between SoundBase and you
protects *SoundBase*; you need your own boundary to protect *yourself*.

The rest — freezing an interpreter so a user with nothing installed still
works, why cross-compilation must never execute target binaries, and why a
signed app bundle means your runtime can never write beside itself — is in that
document.

## Running it under SoundBase

Drop the folder into SoundBase's `userData/plugins/` (or point `SB_PLUGIN_DIRS`
at a directory containing it), enable the `plugin-system` feature flag, and it
appears in Settings → Plugins and in the live-scan device picker.

Standalone, without SoundBase at all:

```sh
npm start
curl localhost:<port>/health      # {"ok":true,…}
curl localhost:<port>/devices
```

Run by hand it serves the same contract with authentication disabled, which is
the easy way to poke at it with `curl`.

## The specification

The normative documents install with your dependencies:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json     validate your manifest against this
  core.openapi.yaml                the core plugin API
  spectrum-analyzer.openapi.yaml   the SpectrumAnalyzer module
```

They are not a copy that might have gone stale — they ship inside the contract
package, so they always describe the shell version your lockfile pins.

Unknown modules and unknown properties are tolerated everywhere, deliberately:
shipping a plugin must never require a SoundBase release.

## Versioning

Two version numbers that mean different things:

- **`version`** in `soundbase-plugin.json` and `package.json` is *yours*. Semver
  your plugin however you like.
- **`template`** records what you started from and should be left alone:

  ```json
  "template": { "name": "soundbase-plugin-template", "version": "1.0.0" }
  ```

  It is correct forever *because* it goes stale. When a template release notes
  a fix to the example error handling, this is what tells you whether it
  applies to you. Do not bump it to match a template you have not merged.

**`contract` is the only thing that governs compatibility.** Two plugins built
from different template versions can speak exactly the same contract, and an
old lineage does not make an incompatible plugin compatible.

## Working with Claude

[`CLAUDE.md`](CLAUDE.md) gives Claude Code the contract invariants, the file
map, and worked prompts for the common tasks — implementing discovery, adding a
control, wrapping a native driver. It is worth reading yourself: it is the
shortest accurate description of the plugin model in this repo.

## Licence

This template and `@soundbase/plugin-shell` are licensed under the **Business
Source License 1.1** — source available, not open source. See `LICENSE` for the
exact terms, and read the **Additional Use Grant**: it permits developing,
distributing and operating plugins for SoundBase, including commercially, and
does not permit using this code with anything that is not SoundBase.

Each version converts automatically to the Change License named in `LICENSE` on
its Change Date.

Your own plugin code is yours; licence it however you like. The Additional Use
Grant governs the parts you received under this licence.

## Support

Issues on this repository are for the template itself. For the plugin contract,
device behaviour, or getting a plugin listed, see the SoundBase Lab.
