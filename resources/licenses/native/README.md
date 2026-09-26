# Embedded native and supplemental npm notices

These files retain their original third-party copyright notices and licenses. They are not relicensed under Model Roundtable's MIT license. The installed copy is `resources/licenses/native/`; `manifest.json` records fixed source revisions, archive checksums and the hash of every collected file.

## Canvas 1.0.9 (Windows x64)

The JavaScript wrapper and native binding come from `Brooooooklyn/canvas` commit `b2723ffae4e74e8c9df752902b137ec4061530e9`. The npm platform package contains a statically linked Skia backend and `icudtl.dat`; its npm `license: MIT` field is not a license statement for every embedded component.

The pinned Skia commit is `a9c42c9fce77cd748805df0ec67ef5718800b1e9`. The collection includes Skia, skcms, ICU (including its data and third-party notices), Brotli, Expat, FreeType, HarfBuzz, Highway, libjpeg-turbo, libjxl, libpng, libwebp, Wuffs and zlib. The upstream Windows build flags and exact DEPS are retained under `canvas-1.0.9/upstream/` and `canvas-1.0.9/skia/` as provenance evidence. This application does not rebuild or modify Canvas.

This product uses the FreeType Project (https://www.freetype.org), under the FreeType License (FTL). Its FTL and the additional license notices identified in `LICENSE.TXT` are retained, including unmodified source files whose headers carry those notices.

This software is based in part on the work of the Independent JPEG Group. The libjpeg-turbo roll-up and IJG README are included in `native/libjpeg-turbo/`.

`canvas-1.0.9/rust/` contains license notices for the complete locked Cargo package set, including build-time and non-Windows entries. This is a conservative inventory, not a claim that every listed package is linked into this Windows binary. Vendored libavif, libaom (including bundled third-party notices) and mimalloc are retained recursively. N-API and Nugine SIMD workspace crates that omit their root MIT license in the published package use the exact repository commit recorded in the checksum-verified crate's `.cargo_vcs_info.json`.

The binary contains Rust source revision `48a229ceaefd4985c50990b14116b6d856af0985` (Rust 1.98.1). `rust-standard-library/` includes the official release's complete `COPYRIGHT-library.html`, MIT/Apache texts and commit/version evidence. It covers standard-library code and its dependencies separately from Canvas's Cargo packages. The Rust compiler itself is not distributed by this application.

## Supplemental npm texts

`npm/saxes-6.0.0/LICENSE` comes from the npm version's exact gitHead `211fa0ebec9b628affc09219199639887174bfc3`. `npm/isarray-1.0.0/README.md` is the unmodified installed npm README containing its full MIT text. Both fill missing top-level license files in those published packages.

## Maintenance and verification

`node scripts/prepare-native-licenses.mjs` is an explicit maintainer operation that downloads only pinned official source archives/texts. It never executes downloaded source. It verifies Cargo archive checksums and retains the complete original notice files. Its large download cache is excluded from Git and the installer.

`npm run licenses` first checks this snapshot offline against the dependency lock, the two native payload hashes, Skia DEPS, Cargo.lock and every notice hash. Missing or changed files stop the build. A native package update requires a new reviewed snapshot; copying this inventory onto another binary is not supported. The generated license directory includes this entire snapshot.
