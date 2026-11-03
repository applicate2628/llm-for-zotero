/** Trusted helper: input/output are PDF bytes, never paths or executable commands. */
export const PDF_NORMALIZATION_MAX_BYTES = 256 * 1024 * 1024;
export const PDF_NORMALIZATION_SCRIPT = String.raw`
import io, sys
LIMIT = 268435456

def fail(code, text, status):
    sys.stderr.write(code + ': ' + text + '\n')
    raise SystemExit(status)

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    fail('MINERU_PDF_DEPENDENCY_MISSING', 'The configured Python needs pypdf and its AES dependency.', 3)

try:
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if not raw or len(raw) > LIMIT:
        fail('MINERU_PDF_SIZE', 'PDF preparation accepts at most 256 MiB.', 4)
    reader = PdfReader(io.BytesIO(raw))
    if reader.is_encrypted and not reader.decrypt(''):
        fail('MINERU_PDF_PASSWORD_REQUIRED', 'This PDF requires a non-empty password. Open it with your password and save a readable copy.', 2)
    count = len(reader.pages)
    if count < 1:
        fail('MINERU_PDF_INVALID', 'PDF contains no pages.', 4)
    if not reader.is_encrypted:
        result = raw
    else:
        writer = PdfWriter(clone_from=reader)
        output = io.BytesIO()
        writer.write(output)
        result = output.getvalue()
    if len(result) > LIMIT:
        fail('MINERU_PDF_SIZE', 'Prepared PDF exceeds 256 MiB.', 4)
    verified = PdfReader(io.BytesIO(result))
    if verified.is_encrypted or len(verified.pages) != count:
        fail('MINERU_PDF_INVALID', 'Prepared PDF did not preserve the page count.', 4)
    sys.stdout.buffer.write(result)
except Exception as error:
    fail('MINERU_PDF_PREPARATION_FAILED', str(error), 4)
`;
