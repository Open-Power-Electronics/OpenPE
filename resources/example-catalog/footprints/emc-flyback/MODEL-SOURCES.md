# EMC Flyback manufacturer models

These three STEP models complete the manufacturer references in the EMC Flyback
board. The 28 original project/KiCad models and the pinned upstream source remain
unchanged. Native model filenames, instance transforms and electrical geometry
are retained.

| Reference | Manufacturer part | Original model source |
| --- | --- | --- |
| T1 | Würth 750311591 | [WE-FB product downloads](https://www.we-online.com/en/components/products/WE-FB#750311591), `Download_STP_070-4476_0178_clip (rev1).STEP` |
| L1 | Würth 744822222 | [Official KiCad library](https://github.com/WurthElektronik/KiCad-Library/tree/df5afb528e92371b558431a7dd41d654e09330ca), `3dmodels/Inductor_THT_Wurth.3dshapes/L_Wurth_WE-CMB-S.step` |
| L2 | Bourns SRN8040TA | [Official engineering files](https://www.bourns.com/resources/design-tools/engineering-files-list?folder=SRN8040TA), `SRN8040TA.stp` |

[manifest.json](manifest.json) pins source URLs, local filenames, sizes and
SHA-256 hashes. Manufacturer downloads stay outside Git under this shared
resource directory's `models/` and are included in local application packages.
Preparation copies their exact bytes to `examples/emc-flyback/models/`,
alongside the other native STEP assets. Project `circuits/` directories contain
SPICE `.lib` files. Restore missing source files from their official sources
before preparation; a missing or differing file fails verification. Preview
and native asset copying never download files.

T1 and L2 retain their original STEP bytes under the native reference filenames.
L1 is a clearly marked OpenPE modification of the exact manufacturer's WE-CMB-S
model used by its `S_744822222` symbol. The source library's root assembly frame
is replaced with a centered frame matching the retained native offset
`(3.85, 2.5, 0)`. Shape, topology, colours and dimensions remain unchanged.
The four terminal centers are at `(±3.85, ±2.5)` mm; lead tips are at Z = −3 mm.
`node scripts/prepare-emc-cmb-model.mjs <manufacturer.step> <aligned.step>`
reproduces the derivative from the pinned source hash and preserves the original
shape records. Use the resulting bytes as `models/WE-CMB_744822222.step`.

Manufacturer assets retain their own terms; the upstream project's CC BY 4.0
license does not relicense them. [WURTH-CAD-DISCLAIMER.txt](WURTH-CAD-DISCLAIMER.txt)
retains the catalog CAD notice, [WURTH-KICAD-LICENSE.txt](WURTH-KICAD-LICENSE.txt)
retains the official KiCad-library terms, and [BOURNS-NOTICE.txt](BOURNS-NOTICE.txt)
identifies the Bourns source and legal notice. These notices accompany native
project copies containing the manufacturer models. Download availability does
not establish unrestricted redistribution rights or manufacturing suitability.
