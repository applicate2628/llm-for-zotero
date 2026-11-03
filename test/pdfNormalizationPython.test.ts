import { assert } from "chai";
import { spawnSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { PDF_NORMALIZATION_SCRIPT } from "../src/utils/pdfNormalizationScript";
import { createPdfFixture } from "./helpers/pdfFixture";

// Opt-in to an existing Python; never installs a package or invokes a model.
const python = process.env.LLM_FOR_ZOTERO_PDF_TEST_PYTHON;
describe("PDF preparation with installed pypdf", function () {
  this.timeout(30000);
  before(function () {
    if (!python) this.skip();
  });
  function run(script: string, input: Uint8Array, args: string[] = []) {
    return spawnSync(python!, ["-I", "-c", script, ...args], {
      input,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  const encrypt =
    "import io,sys\nfrom pypdf import PdfReader,PdfWriter\nw=PdfWriter(clone_from=PdfReader(io.BytesIO(sys.stdin.buffer.read())))\nw.encrypt(sys.argv[2],owner_password='fixture-owner',algorithm=sys.argv[1])\nw.write(sys.stdout.buffer)\n";
  for (const algorithm of ["RC4-40", "RC4-128", "AES-128", "AES-256"]) {
    it(`prepares empty-password ${algorithm} without dropping pages`, async function () {
      const generated = run(encrypt, createPdfFixture(3), [algorithm, ""]);
      assert.equal(generated.status, 0, generated.stderr.toString());
      const result = run(PDF_NORMALIZATION_SCRIPT, generated.stdout);
      assert.equal(result.status, 0, result.stderr.toString());
      const pdf = await PDFDocument.load(result.stdout);
      assert.equal(pdf.getPageCount(), 3);
      assert.isFalse(pdf.isEncrypted);
    });
  }
  it("does not remove a nonempty opening password", function () {
    const generated = run(encrypt, createPdfFixture(1), [
      "AES-128",
      "fixture-password",
    ]);
    assert.equal(generated.status, 0, generated.stderr.toString());
    const result = run(PDF_NORMALIZATION_SCRIPT, generated.stdout);
    assert.equal(result.status, 2);
    assert.include(result.stderr.toString(), "MINERU_PDF_PASSWORD_REQUIRED");
    assert.equal(result.stdout.length, 0);
  });
  it("preserves ordinary PDF bytes exactly and rejects malformed input", function () {
    const bytes = createPdfFixture(2);
    const result = run(PDF_NORMALIZATION_SCRIPT, bytes);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(new Uint8Array(result.stdout), bytes);
    const malformed = run(
      PDF_NORMALIZATION_SCRIPT,
      new TextEncoder().encode("not PDF"),
    );
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.stdout.length, 0);
  });
});
