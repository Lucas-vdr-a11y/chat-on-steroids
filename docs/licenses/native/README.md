# Native image-library licenses

The sharp/libvips packages include separately licensed native libraries. Their README.md
and versions.json files identify the components and versions for each target platform.
This supplement preserves full license texts omitted from the published native npm packages:

- LGPL-3.0.txt: https://ftp.gnu.org/gnu/Licenses/lgpl-3.0.txt
- GPL-3.0.txt: https://ftp.gnu.org/gnu/Licenses/gpl-3.0.txt
- MPL-2.0.txt: https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt

Retrieved 2026-09-08. These are unmodified license texts. Including GPLv3 here supplies
the text incorporated by LGPLv3; it does not relicense Chat On Steroids as GPL software.

Upstream build/source projects:
- sharp: https://github.com/lovell/sharp
- Unix libvips builds: https://github.com/lovell/sharp-libvips
- Windows libvips builds: https://github.com/libvips/build-win64-mxe
- libvips source: https://github.com/libvips/libvips

These project links are references, not a claim that a release already supplies complete
corresponding source. A binary release must also verify applicable source-distribution and
replacement/relinking requirements for its exact native libraries, including their dependencies.
Full license texts alone do not discharge those obligations. The installed libraries remain
separate files under app.asar.unpacked, as described by the packaging configuration.
