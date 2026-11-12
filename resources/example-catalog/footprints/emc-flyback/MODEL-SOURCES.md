# EMC Flyback model provenance

L2 and T1 are OpenPE analytical solids. `scripts/prepare-emc-analytical-models.ts` builds them with the bundled Gmsh/OpenCASCADE path in `server/model-cad-kernel.mjs`. No third-party license applies to these two files. The native board publishes neutral names and a Z-up placement. Model +Y is the opposite of footprint +Y, matching the board preview, and model Z = 0 is the board surface.

| Reference | File | Body | Terminals | Placement |
| --- | --- | --- | --- | --- |
| L2, shielded 8040 inductor | `L_8040_Shielded.step` | 8.0 × 8.0 × 4.0 mm, bottom on the board | Two 2.6 × 8.2 × 0.5 mm feet centered on the existing pads at x = ±2.8 mm | offset (0, 0, 2), rotate (0, 0, 0), scale (1, 1, 1) |
| T1, EFD25 SMD transformer | `T_EFD25_SMD.step` | 32.31 × 27.03 × 13.69 mm | Twelve 2.5 × 1.52 × 0.5 mm feet centered on the existing pads | offset (0, 0, 6.845), rotate (0, 0, 0), scale (1, 1, 1) |

The L2 body is the 8.0 × 8.0 × 4.0 mm shielded 8040 outline. Its feet use the footprint pad rectangles. The overall envelope is 8.2 × 8.2 × 4.0 mm because those pads are 8.2 mm long.

T1 follows Würth 750311591 datasheet revision IKK 007.001, dated 2023-07-11, order code 750311591: [750311591.pdf](https://www.we-online.com/components/products/datasheet/750311591.pdf). The dimensions drawing gives 32.31 mm maximum overall length, 27.03 mm maximum width and 13.69 mm maximum height. The recommended land pattern is a 30.38 mm row spacing, 2.5 × 1.52 mm pads and 3.76 mm pitch, which is the existing footprint (pads at x = ±15.19 mm). The tape cavity K0 of 14.10 mm typical contains the 13.69 mm height. The land extends to x = ±16.44 mm, 0.285 mm past the 32.31 mm maximum on each end, and the feet follow that land. The body is oriented with its length on footprint X.

[manifest.json](manifest.json) pins the file names, placement, sizes and SHA-256 hashes. Preparation generates a missing file and requires the pinned checksum. An existing different file is preserved and preparation fails.

| Reference | Manufacturer part | Model |
| --- | --- | --- |
| L1 | Würth 744822222 | Pinned derivative of [the official KiCad library model](https://github.com/WurthElektronik/KiCad-Library/tree/df5afb528e92371b558431a7dd41d654e09330ca) `3dmodels/Inductor_THT_Wurth.3dshapes/L_Wurth_WE-CMB-S.step` |

L1 is a clearly marked OpenPE modification of that WE-CMB-S model. The source library's root assembly frame is replaced with a centered frame matching the retained native offset `(3.85, 2.5, 0)`. Shape, topology, colours and dimensions remain unchanged. The four terminal centers are at `(±3.85, ±2.5)` mm; lead tips are at Z = −3 mm.
`node scripts/prepare-emc-cmb-model.mjs <manufacturer.step> <aligned.step>` reproduces the derivative from the pinned source hash and preserves the original shape records. Use the resulting bytes as `models/WE-CMB_744822222.step`.

The WE-CMB derivative keeps the Würth KiCad-library terms in [WURTH-KICAD-LICENSE.txt](WURTH-KICAD-LICENSE.txt). The upstream project's CC BY 4.0 license does not relicense it. Sharing the marked derivative requires that attribution. Download availability does not establish manufacturing suitability.
