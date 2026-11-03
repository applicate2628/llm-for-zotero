# Readable encrypted PDFs in MinerU

Some PDFs are encrypted but open without asking for a password. The PDF splitter (`pdf-lib`) rejects these files before they reach MinerU.

In MinerU's local settings, **PDF preparation Python (optional)** accepts the absolute path to an existing Python executable with `pypdf` and an AES implementation (`cryptography` or `pycryptodome`). Leave the field empty to disable automatic preparation. The preference key is `extensions.zotero.llmforzotero.mineruPdfPythonPath`.

Only an explicit encrypted-PDF error starts the helper. It tries the empty password once; it does not guess passwords, read saved passwords, install packages, or use a shell. A document requiring a nonempty password is rejected with a separate message. No document paths are passed to the helper: PDF bytes travel through local binary pipes and the prepared copy stays in memory. Short prepared documents use the existing chunk uploader too, so the encrypted original is never uploaded by mistake.

Original attachments, filenames, and bytes are unchanged. Provenance hashes and checkpoint identities use the original bytes, not a rewritten copy. The helper verifies that the prepared PDF has the same page count and no encryption. Its input/output limit is 256 MiB and its processing timeout is 120 seconds. Cancellation stops the owned helper process. Existing chunk cleanup remains unchanged.

## Checks

Run the PDF splitter, recovery, configuration, and normalization tests with the repository's Mocha/tsx runner. For optional native Python integration tests, set `LLM_FOR_ZOTERO_PDF_TEST_PYTHON` to an already installed Python and run `test/pdfNormalizationPython.test.ts`. This tests RC4 and AES empty-password PDFs, refusal of nonempty passwords, exact preservation of unencrypted input, and malformed data. It makes no network/model calls.

A successful preparation check does not prove that full OCR or formula recognition has completed. Rendering comparisons and native Zotero tests are recorded separately from unit tests.
