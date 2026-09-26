# Corresponding source and licenses

The application does not modify the distributed Python, LibreOffice, Python library, or font source code. `manifest.json` identifies the exact binary/wheel versions and SHA-256 digests; `files.json` identifies the installed runtime files. Original copyright and license notices remain present alongside each component.

## LibreOffice 26.2.6.3

The official corresponding source is freely available at:

- Core: https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/libreoffice-26.2.6.3.tar.xz
- Dictionaries: https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/libreoffice-dictionaries-26.2.6.3.tar.xz
- Help: https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/libreoffice-help-26.2.6.3.tar.xz
- Translations: https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/libreoffice-translations-26.2.6.3.tar.xz
- Source directory, signatures and mirror hashes: https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/
- Build instructions: https://wiki.documentfoundation.org/Development/BuildingOnWindows
- License terms and bundled third-party components: `libreoffice/license.txt`, `libreoffice/LICENSE.html`, `libreoffice/NOTICE`, https://www.libreoffice.org/licenses/

The MSI is extracted without system installation. Its x64 Microsoft runtime files from `System64/` are copied unchanged next to `program/soffice.com` for application-local loading. No Microsoft runtime DLL is copied from the development machine's Windows directory. The original distribution's notices and the app's Microsoft runtime notices remain applicable. The application does not claim that LibreOffice or Microsoft binaries are covered by the application's MIT license.

## Python and libraries

- CPython 3.13.15 source and release metadata: https://www.python.org/downloads/release/python-31315/
- CPython license: `python/LICENSE.txt`
- Python wheels: every package and version has a pinned official `files.pythonhosted.org` URL in `manifest.json`. Original metadata and licenses remain in `python/Lib/site-packages/*.dist-info/`. The corresponding release source is available from `https://pypi.org/project/<package>/<version>/#files`.
- Python libraries: python-docx, openpyxl, python-pptx, pypdf, ReportLab, defusedxml, lxml, Pillow, XlsxWriter, typing_extensions, et_xmlfile and charset_normalizer. Their individual MIT/BSD/other notices apply; no commercial ReportLab PLUS component is included.

## Chinese font

Noto Sans SC uses the SIL Open Font License. The unchanged font and license are in `fonts/NotoSansSC.ttf` and `fonts/OFL.txt`. Source: https://github.com/google/fonts/tree/main/ofl/notosanssc and https://github.com/notofonts/noto-cjk . The archive SHA-256 is pinned in `manifest.json`.
