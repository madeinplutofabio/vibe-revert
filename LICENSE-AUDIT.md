# License Audit

<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run regen:license-audit`. -->
<!-- Authoritative inputs: committed pnpm-lock.yaml + workspace manifests + license-policy.json + license-metadata.json. -->

## Inputs

| Input | Value |
| --- | --- |
| Generator schema version | `1` |
| pnpm-lock.yaml SHA-256 | `51d459c5201b6dead8940b5338f86970c6419b31b63eff1a265e04d6804a95e0` |
| Workspace manifests digest (SHA-256) | `0086b2689ffb8b402a0484e0be3c14f7bba375ef2c039299972b452756719be4` |
| license-policy.json SHA-256 | `8f210e8009e477a5339838d18731e9f383c03b918be605377391d76baca972e6` |
| license-metadata.json SHA-256 | `d90c3dbd4a126c8592aa54401d0a7293f6f79a1b8430cdbeb0e7b2c0ece22ee9` |
| Reachable snapshot instances | `315` |
| Aggregated package rows | `315` |

## Summary

- Third-party packages: `315`
- First-party workspace packages: `9`
- Unresolved peer obligations: `0`

### Dispositions

| Disposition | Count |
| --- | --- |
| `allowed` | `1` |
| `allowed-with-obligations` | `291` |
| `review-required` | `23` |
| `disallowed` | `0` |

### Postures

| Posture | Count |
| --- | --- |
| `production` | `105` |
| `optional-production` | `2` |
| `peer` | `0` |
| `development` | `208` |

### Requires review

- Package rows needing review (conflict, review-required, or disallowed): `23`
- Unresolved peer obligations (consumer-supplied, counted independently): `0`

## Third-party packages

| Name | Version | Posture | Disposition | Normalized SPDX | Obligations | Conflict |
| --- | --- | --- | --- | --- | --- | --- |
| `@babel/runtime` | `7.29.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@biomejs/biome` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-darwin-arm64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-darwin-x64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-linux-arm64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-linux-arm64-musl` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-linux-x64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-linux-x64-musl` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-win32-arm64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@biomejs/cli-win32-x64` | `2.4.13` | `development` | `review-required` | — | — | `no` |
| `@changesets/apply-release-plan` | `7.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/assemble-release-plan` | `6.0.10` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/changelog-git` | `0.2.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/cli` | `2.31.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/config` | `3.1.4` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/errors` | `0.2.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/get-dependents-graph` | `2.1.4` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/get-release-plan` | `4.0.16` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/get-version-range-type` | `0.4.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/git` | `3.0.4` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/logger` | `0.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/parse` | `0.4.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/pre` | `2.0.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/read` | `0.6.7` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/should-skip-package` | `0.1.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/types` | `4.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/types` | `6.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@changesets/write` | `0.4.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@emnapi/core` | `1.10.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@emnapi/runtime` | `1.10.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@emnapi/wasi-threads` | `1.2.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/aix-ppc64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/android-arm` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/android-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/android-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/darwin-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/darwin-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/freebsd-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/freebsd-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-arm` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-ia32` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-loong64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-mips64el` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-ppc64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-riscv64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-s390x` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/linux-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/netbsd-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/openbsd-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/openbsd-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/sunos-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/win32-arm64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/win32-ia32` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@esbuild/win32-x64` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@hono/node-server` | `1.19.14` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@inquirer/external-editor` | `1.0.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@isaacs/fs-minipass` | `4.0.1` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `@jridgewell/sourcemap-codec` | `1.5.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@manypkg/find-root` | `1.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@manypkg/get-packages` | `1.1.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@modelcontextprotocol/sdk` | `1.29.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@napi-rs/wasm-runtime` | `1.1.4` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@nodelib/fs.scandir` | `2.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@nodelib/fs.stat` | `2.0.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@nodelib/fs.walk` | `1.2.8` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@oxc-project/types` | `0.127.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-android-arm64` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-darwin-arm64` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-darwin-x64` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-freebsd-x64` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-arm-gnueabihf` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-arm64-gnu` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-arm64-musl` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-ppc64-gnu` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-s390x-gnu` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-x64-gnu` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-linux-x64-musl` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-openharmony-arm64` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-wasm32-wasi` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-win32-arm64-msvc` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/binding-win32-x64-msvc` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@rolldown/pluginutils` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@standard-schema/spec` | `1.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@tybys/wasm-util` | `0.10.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/chai` | `5.2.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/deep-eql` | `4.0.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/estree` | `1.0.8` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/js-yaml` | `4.0.9` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/node` | `12.20.55` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/node` | `22.15.30` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@types/picomatch` | `4.0.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/expect` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/mocker` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/pretty-format` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/runner` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/snapshot` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/spy` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `@vitest/utils` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `accepts` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ajv` | `8.20.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ajv-formats` | `3.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ansi-colors` | `4.1.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ansi-regex` | `5.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `argparse` | `1.0.10` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `argparse` | `2.0.1` | `development` | `review-required` | `Python-2.0` | — | `no` |
| `array-union` | `2.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `assertion-error` | `2.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `better-path-resolve` | `1.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `body-parser` | `2.2.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `braces` | `3.0.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `bytes` | `3.1.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `call-bind-apply-helpers` | `1.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `call-bound` | `1.0.4` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `chai` | `6.2.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `chardet` | `2.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `chownr` | `3.0.0` | `production` | `allowed-with-obligations` | `BlueOak-1.0.0` | `include-license-text` | `no` |
| `clipanion` | `3.2.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `content-disposition` | `1.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `content-type` | `1.0.5` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `content-type` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `convert-source-map` | `2.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `cookie` | `0.7.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `cookie-signature` | `1.2.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `cors` | `2.8.6` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `cross-spawn` | `7.0.6` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `debug` | `4.4.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `depd` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `detect-indent` | `6.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `detect-libc` | `2.1.2` | `development` | `allowed-with-obligations` | `Apache-2.0` | `include-license-text`; `preserve-notice-if-present` | `no` |
| `diff` | `9.0.0` | `production` | `allowed-with-obligations` | `BSD-3-Clause` | `include-license-text` | `no` |
| `dir-glob` | `3.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `dunder-proto` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ee-first` | `1.1.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `encodeurl` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `enquirer` | `2.4.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `es-define-property` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `es-errors` | `1.3.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `es-module-lexer` | `2.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `es-object-atoms` | `1.1.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `esbuild` | `0.23.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `escape-html` | `1.0.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `esprima` | `4.0.1` | `development` | `allowed-with-obligations` | `BSD-2-Clause` | `include-license-text` | `no` |
| `estree-walker` | `3.0.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `etag` | `1.8.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `eventsource` | `3.0.7` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `eventsource-parser` | `3.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `expect-type` | `1.3.0` | `development` | `allowed-with-obligations` | `Apache-2.0` | `include-license-text`; `preserve-notice-if-present` | `no` |
| `express` | `5.2.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `express-rate-limit` | `8.5.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `extendable-error` | `0.1.7` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fast-deep-equal` | `3.1.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fast-glob` | `3.3.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fast-uri` | `3.1.2` | `production` | `allowed-with-obligations` | `BSD-3-Clause` | `include-license-text` | `no` |
| `fastq` | `1.20.1` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `fdir` | `6.5.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fill-range` | `7.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `finalhandler` | `2.1.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `find-up` | `4.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `forwarded` | `0.2.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fresh` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fs-extra` | `7.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fs-extra` | `8.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `fsevents` | `2.3.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `function-bind` | `1.1.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `get-intrinsic` | `1.3.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `get-proto` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `get-tsconfig` | `4.14.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `glob-parent` | `5.1.2` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `globby` | `11.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `gopd` | `1.2.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `graceful-fs` | `4.2.11` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `has-symbols` | `1.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `hasown` | `2.0.4` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `hono` | `4.12.25` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `http-errors` | `2.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `human-id` | `4.1.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `iconv-lite` | `0.7.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ignore` | `5.3.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `inherits` | `2.0.4` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `ip-address` | `10.2.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ipaddr.js` | `1.9.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-extglob` | `2.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-glob` | `4.0.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-number` | `7.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-promise` | `4.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-subdir` | `1.2.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `is-windows` | `1.0.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `isexe` | `2.0.0` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `jose` | `6.2.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `js-yaml` | `3.14.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `js-yaml` | `4.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `js-yaml` | `4.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `json-schema-traverse` | `1.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `json-schema-typed` | `8.0.2` | `production` | `allowed-with-obligations` | `BSD-2-Clause` | `include-license-text` | `no` |
| `jsonfile` | `4.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `lightningcss` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-android-arm64` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-darwin-arm64` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-darwin-x64` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-freebsd-x64` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-linux-arm-gnueabihf` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-linux-arm64-gnu` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-linux-arm64-musl` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-linux-x64-gnu` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-linux-x64-musl` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-win32-arm64-msvc` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `lightningcss-win32-x64-msvc` | `1.32.0` | `development` | `review-required` | `MPL-2.0` | — | `no` |
| `locate-path` | `5.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `lodash.startcase` | `4.4.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `magic-string` | `0.30.21` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `math-intrinsics` | `1.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `media-typer` | `1.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `merge-descriptors` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `merge2` | `1.4.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `micromatch` | `4.0.8` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `mime-db` | `1.54.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `mime-types` | `3.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `minipass` | `7.1.3` | `production` | `allowed-with-obligations` | `BlueOak-1.0.0` | `include-license-text` | `no` |
| `minizlib` | `3.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `mri` | `1.2.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `ms` | `2.1.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `nanoid` | `3.3.11` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `negotiator` | `1.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `node-addon-api` | `7.1.1` | `optional-production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `node-pty` | `1.1.0` | `optional-production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `object-assign` | `4.1.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `object-inspect` | `1.13.4` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `obug` | `2.1.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `on-finished` | `2.4.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `once` | `1.4.0` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `outdent` | `0.5.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `p-filter` | `2.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `p-limit` | `2.3.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `p-locate` | `4.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `p-map` | `2.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `p-try` | `2.2.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `package-manager-detector` | `0.2.11` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `parseurl` | `1.3.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `path-exists` | `4.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `path-key` | `3.1.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `path-to-regexp` | `8.4.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `path-type` | `4.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `pathe` | `2.0.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `picocolors` | `1.1.1` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `picomatch` | `2.3.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `picomatch` | `4.0.4` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `pify` | `4.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `pkce-challenge` | `5.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `postcss` | `8.5.12` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `prettier` | `2.8.8` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `proxy-addr` | `2.0.7` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `qs` | `6.15.2` | `production` | `allowed-with-obligations` | `BSD-3-Clause` | `include-license-text` | `no` |
| `quansync` | `0.2.11` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `queue-microtask` | `1.2.3` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `range-parser` | `1.2.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `raw-body` | `3.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `read-yaml-file` | `1.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `require-from-string` | `2.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `resolve-from` | `5.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `resolve-pkg-maps` | `1.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `reusify` | `1.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `rolldown` | `1.0.0-rc.17` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `router` | `2.2.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `run-parallel` | `1.2.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `safer-buffer` | `2.1.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `semver` | `7.7.4` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `send` | `1.2.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `serve-static` | `2.2.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `setprototypeof` | `1.2.0` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `shebang-command` | `2.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `shebang-regex` | `3.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `side-channel` | `1.1.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `side-channel-list` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `side-channel-map` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `side-channel-weakmap` | `1.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `siginfo` | `2.0.0` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `signal-exit` | `4.1.0` | `development` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `slash` | `3.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `source-map-js` | `1.2.1` | `development` | `allowed-with-obligations` | `BSD-3-Clause` | `include-license-text` | `no` |
| `spawndamnit` | `3.0.1` | `development` | `review-required` | — | — | `no` |
| `sprintf-js` | `1.0.3` | `development` | `allowed-with-obligations` | `BSD-3-Clause` | `include-license-text` | `no` |
| `stackback` | `0.0.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `statuses` | `2.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `std-env` | `4.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `strip-ansi` | `6.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `strip-bom` | `3.0.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tar` | `7.5.15` | `production` | `allowed-with-obligations` | `BlueOak-1.0.0` | `include-license-text` | `no` |
| `term-size` | `2.2.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tinybench` | `2.9.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tinyexec` | `1.1.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tinyglobby` | `0.2.16` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tinyrainbow` | `3.1.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `to-regex-range` | `5.0.1` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `toidentifier` | `1.0.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `tslib` | `2.8.1` | `development` | `allowed` | `0BSD` | — | `no` |
| `tsx` | `4.19.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `typanion` | `3.14.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `type-is` | `2.1.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `typescript` | `5.9.3` | `development` | `allowed-with-obligations` | `Apache-2.0` | `include-license-text`; `preserve-notice-if-present` | `no` |
| `ulid` | `3.0.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `undici-types` | `6.21.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `universalify` | `0.1.2` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `unpipe` | `1.0.0` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `vary` | `1.1.2` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `vite` | `8.0.10` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `vitest` | `4.1.5` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `which` | `2.0.2` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `why-is-node-running` | `2.3.0` | `development` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `wrappy` | `1.0.2` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `yallist` | `5.0.0` | `production` | `allowed-with-obligations` | `BlueOak-1.0.0` | `include-license-text` | `no` |
| `yaml` | `2.8.3` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |
| `zod` | `4.4.1` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `zod` | `4.4.3` | `production` | `allowed-with-obligations` | `MIT` | `include-license-text` | `no` |
| `zod-to-json-schema` | `3.25.2` | `production` | `allowed-with-obligations` | `ISC` | `include-license-text` | `no` |

## Details (conflict, review-required, or disallowed)

### `@biomejs/biome@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: —
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13`
- Package identities:
  - Identity `@biomejs/biome@2.4.13` (integrity `sha512-gLXOwkOBBg0tr7bDsqlkIh4uFeKuMjxvqsrb1Tukww1iDmHcfr4Uu8MoQxp0Rcte+69+osRNWXwHsu/zxT6XqA==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE-APACHE`, `LICENSE-MIT`

### `@biomejs/cli-darwin-arm64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-darwin-arm64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-darwin-arm64@2.4.13` (integrity `sha512-2KImO1jhNFBa2oWConyr0x6flxbQpGKv6902uGXpYM62Xyem8U80j441SyUJ8KyngsmKbQjeIv1q2CQfDkNnYg==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-darwin-x64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-darwin-x64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-darwin-x64@2.4.13` (integrity `sha512-BKrJklbaFN4p1Ts4kPBczo+PkbsHQg57kmJ+vON9u2t6uN5okYHaSr7h/MutPCWQgg2lglaWoSmm+zhYW+oOkg==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-linux-arm64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-linux-arm64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-linux-arm64@2.4.13` (integrity `sha512-NzkUDSqfvMBrPplKgVr3aXLHZ2NEELvvF4vZxXulEylKWIGqlvNEcwUcj9OLrn75TD3lJ/GIqCVlBwd1MZCuYQ==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-linux-arm64-musl@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-linux-arm64-musl@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-linux-arm64-musl@2.4.13` (integrity `sha512-U5MsuBQW25dXaYtqWWSPM3P96H6Y+fHuja3TQpMNnylocHW0tEbtFTDlUj6oM+YJLntvEkQy4grBvQNUD4+RCg==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-linux-x64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-linux-x64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-linux-x64@2.4.13` (integrity `sha512-Az3ZZedYRBo9EQzNnD9SxFcR1G5QsGo6VEc2hIyVPZ1rdKwee/7E9oeBBZFpE8Z44ekxsDQBqbiWGW5ShOhUSQ==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-linux-x64-musl@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-linux-x64-musl@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-linux-x64-musl@2.4.13` (integrity `sha512-Z601MienRgTBDza/+u2CH3RSrWoXo9rtr8NK6A4KJzqGgfxx+H3VlyLgTJ4sRo40T3pIsqpTmiOQEvYzQvBRvQ==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-win32-arm64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-win32-arm64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-win32-arm64@2.4.13` (integrity `sha512-Px9PS2B5/Q183bUwy/5VHqp3J2lzdOCeVGzMpphYfl8oSa7VDCqenBdqWpy6DCy/en4Rbf/Y1RieZF6dJPcc9A==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `@biomejs/cli-win32-x64@2.4.13`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@biomejs/biome@2.4.13`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@biomejs/biome` -> `@biomejs/biome@2.4.13` -> `@biomejs/cli-win32-x64@2.4.13`
- Package identities:
  - Identity `@biomejs/cli-win32-x64@2.4.13` (integrity `sha512-tTcMkXyBrmHi9BfrD2VNHs/5rYIUKETqsBlYOvSAABwBkJhSDVb5e7wPukftsQbO3WzQkXe6kaztC6WtUOXSoQ==`):
    - Raw license: `"MIT OR Apache-2.0"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: —

### `argparse@2.0.1`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `js-yaml@4.1.0`, `js-yaml@4.1.1`
- Originating importers: `.`, `packages/adapters`
- Reached via:
  - `development`: importer `packages/adapters` declares `js-yaml` -> `js-yaml@4.1.0` -> `argparse@2.0.1`
- Package identities:
  - Identity `argparse@2.0.1` (integrity `sha512-8+9WqebbFzpX9OR+Wa6O29asIogeRMzcGtAINdpMHHyAg10f05aSFVBbcEqGf/PXw1EjAZ+q2/bEBg3DvurK3Q==`):
    - Raw license: `"Python-2.0"`
    - Normalized SPDX: `Python-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0`
- Package identities:
  - Identity `lightningcss@1.32.0` (integrity `sha512-NXYBzinNrblfraPGyrbPoD19C1h9lfI/1mzgWYvXUTe414Gz/X1FD2XBZSZM7rRTrMA8JL3OtAaGifrIKhQ5yQ==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-android-arm64@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-android-arm64@1.32.0`
- Package identities:
  - Identity `lightningcss-android-arm64@1.32.0` (integrity `sha512-YK7/ClTt4kAK0vo6w3X+Pnm0D2cf2vPHbhOXdoNti1Ga0al1P4TBZhwjATvjNwLEBCnKvjJc2jQgHXH0NEwlAg==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-darwin-arm64@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-darwin-arm64@1.32.0`
- Package identities:
  - Identity `lightningcss-darwin-arm64@1.32.0` (integrity `sha512-RzeG9Ju5bag2Bv1/lwlVJvBE3q6TtXskdZLLCyfg5pt+HLz9BqlICO7LZM7VHNTTn/5PRhHFBSjk5lc4cmscPQ==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-darwin-x64@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-darwin-x64@1.32.0`
- Package identities:
  - Identity `lightningcss-darwin-x64@1.32.0` (integrity `sha512-U+QsBp2m/s2wqpUYT/6wnlagdZbtZdndSmut/NJqlCcMLTWp5muCrID+K5UJ6jqD2BFshejCYXniPDbNh73V8w==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-freebsd-x64@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-freebsd-x64@1.32.0`
- Package identities:
  - Identity `lightningcss-freebsd-x64@1.32.0` (integrity `sha512-JCTigedEksZk3tHTTthnMdVfGf61Fky8Ji2E4YjUTEQX14xiy/lTzXnu1vwiZe3bYe0q+SpsSH/CTeDXK6WHig==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-linux-arm-gnueabihf@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-linux-arm-gnueabihf@1.32.0`
- Package identities:
  - Identity `lightningcss-linux-arm-gnueabihf@1.32.0` (integrity `sha512-x6rnnpRa2GL0zQOkt6rts3YDPzduLpWvwAF6EMhXFVZXD4tPrBkEFqzGowzCsIWsPjqSK+tyNEODUBXeeVHSkw==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-linux-arm64-gnu@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-linux-arm64-gnu@1.32.0`
- Package identities:
  - Identity `lightningcss-linux-arm64-gnu@1.32.0` (integrity `sha512-0nnMyoyOLRJXfbMOilaSRcLH3Jw5z9HDNGfT/gwCPgaDjnx0i8w7vBzFLFR1f6CMLKF8gVbebmkUN3fa/kQJpQ==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-linux-arm64-musl@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-linux-arm64-musl@1.32.0`
- Package identities:
  - Identity `lightningcss-linux-arm64-musl@1.32.0` (integrity `sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-linux-x64-gnu@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-linux-x64-gnu@1.32.0`
- Package identities:
  - Identity `lightningcss-linux-x64-gnu@1.32.0` (integrity `sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-linux-x64-musl@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-linux-x64-musl@1.32.0`
- Package identities:
  - Identity `lightningcss-linux-x64-musl@1.32.0` (integrity `sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-win32-arm64-msvc@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-win32-arm64-msvc@1.32.0`
- Package identities:
  - Identity `lightningcss-win32-arm64-msvc@1.32.0` (integrity `sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `lightningcss-win32-x64-msvc@1.32.0`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `lightningcss@1.32.0`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `vitest` -> `vitest@4.1.5(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `vite@8.0.10(@types/node@22.15.30)(tsx@4.19.2)(yaml@2.8.3)` -> `lightningcss@1.32.0` -> `lightningcss-win32-x64-msvc@1.32.0`
- Package identities:
  - Identity `lightningcss-win32-x64-msvc@1.32.0` (integrity `sha512-Amq9B/SoZYdDi1kFrojnoqPLxYhQ4Wo5XiL8EVJrVsB8ARoC1PWW6VGtT0WKCemjy8aC+louJnjS7U18x3b06Q==`):
    - Raw license: `"MPL-2.0"`
    - Normalized SPDX: `MPL-2.0`
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

### `spawndamnit@3.0.1`

- Disposition: `review-required`
- Metadata conflict: `no`
- Reaching postures: `development`
- Direct parents: `@changesets/cli@2.31.0(@types/node@22.15.30)`, `@changesets/git@3.0.4`
- Originating importers: `.`
- Reached via:
  - `development`: importer `.` declares `@changesets/cli` -> `@changesets/cli@2.31.0(@types/node@22.15.30)` -> `spawndamnit@3.0.1`
- Package identities:
  - Identity `spawndamnit@3.0.1` (integrity `sha512-MmnduQUuHCoFckZoWnXsTg7JaiLBJrKFj9UI2MbRPGaJeVpsLcVBu6P/IGZovziM/YBsellCmsprgNA+w0CzVg==`):
    - Raw license: `"SEE LICENSE IN LICENSE"`
    - Normalized SPDX: —
    - Disposition: `review-required`
    - Obligations: —
    - Packaged legal files: `LICENSE`

## First-party workspace packages

- `@viberevert/adapters`
- `@viberevert/checks`
- `@viberevert/cli-commands`
- `@viberevert/core`
- `@viberevert/git`
- `@viberevert/installers`
- `@viberevert/mcp`
- `@viberevert/reporters`
- `@viberevert/session-format`

## Unresolved peer obligations

None.

## Disclaimer

This audit is generated by a scanner from committed inputs. Detected licenses are factual,
best-effort observations from packaged metadata — not legal advice and not proof of SPDX
registration. Dispositions are this repository's own policy, not a legal determination. A
`review-required` or `disallowed` row, a metadata conflict, or an unresolved peer obligation
means human review is needed; it is not an automated legal judgment.
