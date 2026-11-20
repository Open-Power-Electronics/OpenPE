# Setup and development

OpenPE targets Windows x64, macOS arm64 and Linux x64 (glibc 2.41+, Debian 13 or equivalent). Linux arm64 and musl are unsupported. [AGENTS.md](../AGENTS.md#verification-and-delivery) owns validation requirements; [Architecture](ARCHITECTURE.md#storage-and-build-boundaries) owns process, build and storage boundaries.

## Install the app

Download the host installer from [Releases](https://github.com/fleaxiao/OpenPE/releases). Run the Windows NSIS installer, drag the macOS app from its disk image to Applications, or install the Linux Debian package / executable AppImage. Solvers, libraries and examples are bundled; end users do not prepare them separately.

The macOS build is unsigned. If Gatekeeper blocks first launch, Control-click OpenPE and choose Open, or allow it under System Settings → Privacy & Security.

For Debian, use `sudo apt install ./openpe_0.1.0_amd64.deb`. Without FUSE, pass `--appimage-extract-and-run` to the AppImage.

## Run from source

Install Node.js 24 and Git. On macOS, install Xcode Command Line Tools with
`xcode-select --install`.

```sh
npm ci
npm run libraries:download
npm run dev
```

If dependency installation skipped scripts, run `npm run postinstall` before starting Electron.

`npm run dev` prepares formats and Home assets, verifies or downloads the
prebuilt solver resources, and starts Electron with renderer hot reload. Use
`npm run dev -- --verbose` for preparation logs. If a solver release is
unavailable, prepare [a verified local archive or rebuild](#solver-release-access).

Run one development server at a time. Save work and restart the app after Electron or service changes; renderer reload does not replace those modules. Agent integrations are configured separately in Settings. Manual editing and simulation do not require an Agent.

## Linux prerequisites

Use X11 or Wayland and the runtime libraries declared in `package.json` under `build.deb.depends`; keep the Chromium sandbox enabled. 3D previews require WebGL 2. Cursor key storage needs Secret Service or KWallet.

For a blocklisted virtual Mesa renderer, use `npm start -- --ignore-gpu-blocklist`; desktop checks use `OPENPE_E2E_MESA=1 npm run test:e2e`. This explicit compatibility option retains the sandbox. Proxy-based environments can use `NODE_USE_ENV_PROXY=1` and writable npm/Electron caches.

## Browser development

```sh
npm run examples:prepare
npm run dev:web
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Browser and desktop development share this port. Native file dialogs and Agent chat require Electron; authenticated CAD previews and bundled plugins follow the [browser preview boundaries](ARCHITECTURE.md#browser-development-previews).

Prepare missing CAD/thermal resources with `npm run thermal:prepare`, ngspice with `npm run simulation:prepare`, and the optional full KiCad STEP collection with `npm run libraries:download-models`.

## Checks and generation

| Command                    | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run check:docs`       | Check documentation names, links and commands                     |
| `npm run typecheck`        | Check architecture boundaries and TypeScript                      |
| `npm test`                 | Regenerate formats, check architecture and run data/runtime tests |
| `npm run build:format`     | Generate schemas, validators and service bundles                  |
| `npm run examples:prepare` | Prepare portable Home assets and verify original projects         |
| `npm run build`            | Prepare resources and build the renderer                          |
| `npm run package`          | Build and check the host installer                                |

Pass test paths after `npm test --` for focused Node checks. See
[Verification](ARCHITECTURE.md#verification) for the feature index and
[example regeneration](EXAMPLES.md#regeneration-and-resource-preparation) for
the native projects and pinned KiCad versions.

Before a standalone typecheck on a fresh checkout, run `npx next typegen` to
generate the ignored `next-env.d.ts` and route types. `npm run dev` and
`npm run build` generate these files through Next.js startup/build.

On Windows, the atomic-write, host-path and local-archive tests use directory junctions without requiring file-symlink privileges; POSIX retains file and dangling symlink cases. Malicious tar link entries are encoded directly and rejected before extraction on either platform.

## Packaging

`npm run package` prepares libraries, regenerates brand assets, builds the renderer and invokes electron-builder. It then checks that the packaged service resolves its runtime modules inside the application.

| Host        | Output                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Windows x64 | `release/win-unpacked/` and `release/OpenPE Setup <version>.exe`                                              |
| macOS arm64 | `release/mac-arm64/OpenPE.app` and `release/OpenPE-<version>-arm64.dmg`                                       |
| Linux x64   | `release/linux-unpacked/openpe`, `release/OpenPE-<version>.AppImage` and `release/openpe_<version>_amd64.deb` |

`package.json` supplies the version and supported package targets.

## Workspace artifacts

| Path                         | Contents                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `.openpe/`                   | Development and test caches, temporary fixtures, local inputs and optional app data overrides                                 |
| `test-results/`              | Check outputs, temporary profiles, audit inputs and [benchmark snapshots](LAYOUT.md#examples-and-verification)                 |
| `.next/`, `out/`, `release/` | Renderer builds, packages and maintainer solver archives                                                                      |
| `promotion/`                 | Separate local Remotion workspace with source, recordings and renders                                                         |
| `tmp/`                       | Local experiments                                                                                                             |

Classify ignored files by their consumers before cleanup. Resolve each target
inside the workspace and reject links before recursive operations. Keep native
designs, prepared offline resources, corresponding sources and notices, current
builds, recovery and private Git history. See [Storage and build boundaries](ARCHITECTURE.md#storage-and-build-boundaries)
for application-owned stores and generated files.

## Solver release access

Ordinary `simulation:prepare` and `thermal:prepare` install or reuse verified host bundles; they do not compile or read credentials. `simulation:verify` and `thermal:verify` check installed resources offline. Runtime release archives require pinned SHA-256, size and file hashes; unexpected entries and links are rejected. GitHub redirects stay on approved GitHub asset hosts.

Private or unpublished macOS/Linux assets can return `Missing GitHub release asset`. Collaborators can use `gh release download` with their own authenticated account to fetch the lock's tag/asset, then install the local archives:

```sh
npm run simulation:prepare -- --archive path/to/ngspice.tar.gz
npm run thermal:prepare -- --archive path/to/thermal.tar.gz
```

## Maintainer solver builds

Maintainer rebuilds write to `release/solvers/`; the locks record archive names, release tags and hashes.

| Host          | Rebuild command               | Pinned toolchain                                                                         |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| macOS arm64   | `npm run solvers:build-macos` | Apple clang 17.0.0, SDK 26.2, Homebrew GCC 16.2.0, CMake 4.4.5                           |
| Debian 13 x64 | `npm run solvers:build-linux` | GCC/GFortran 14.2.0, glibc 2.41, CMake 4.4.5; Make, Python 3, curl, patch, tar, patchelf |

Linux `--update-lock` explicitly refreshes reviewed file/archive pins. Before Linux archives are available, build with `npm run solvers:build-linux -- --update-lock`, review the diff, then run solver preparation before example preparation. Ordinary archive installation needs no compiler. [SPICE build details](SIMULATION.md#portable-models-and-bundled-solver) · [Thermal build details](THERMAL.md#runtime-and-lifecycle)

`npm run solvers:publish` publishes the current macOS/Linux host's two archives as prereleases with `--latest=false`. **Owner approval is required before publishing.**
