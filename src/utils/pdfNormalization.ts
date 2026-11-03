import { getMineruPdfPythonPath } from "./mineruConfig";
import { loadGeckoSubprocess } from "./geckoSubprocess";
import { PdfSplitterCancelledError } from "./pdfSplitter";
import {
  PDF_NORMALIZATION_SCRIPT,
  PDF_NORMALIZATION_MAX_BYTES,
} from "./pdfNormalizationScript";

type NativePdfProcess = {
  stdin: {
    write(data: ArrayBuffer): Promise<unknown>;
    close(force?: boolean): Promise<void>;
  };
  stdout: {
    read(): Promise<ArrayBuffer>;
    close(force?: boolean): Promise<void>;
  };
  stderr: {
    readString(): Promise<string>;
    close(force?: boolean): Promise<void>;
  };
  wait(): Promise<{ exitCode: number }>;
  kill(timeoutMs?: number): Promise<unknown>;
};

async function readPdf(pipe: NativePdfProcess["stdout"]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = new Uint8Array(await pipe.read());
    if (!chunk.length) break;
    length += chunk.length;
    if (length > PDF_NORMALIZATION_MAX_BYTES)
      throw new Error("Prepared PDF exceeds 256 MiB.");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readErrors(pipe: NativePdfProcess["stderr"]): Promise<string> {
  let text = "";
  while (true) {
    const chunk = await pipe.readString();
    if (!chunk) return text;
    text += chunk;
    if (text.length > 65536)
      throw new Error("PDF preparation produced excessive diagnostic output.");
  }
}

/** Local, opt-in empty-password preparation. No source path or file is modified. */
export async function normalizePdfBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
  timeoutMs = 120000,
): Promise<Uint8Array> {
  if (signal?.aborted) throw new PdfSplitterCancelledError();
  const python = getMineruPdfPythonPath();
  if (!python)
    throw new Error(
      "This PDF is encrypted. Configure the PDF preparation Python executable in MinerU settings, or save an unencrypted copy.",
    );
  if (
    !/^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\)/.test(python) ||
    /[\0\r\n]/.test(python)
  )
    throw new Error(
      "PDF preparation requires an absolute Python executable path, not a shell command.",
    );
  if (!bytes.length || bytes.length > PDF_NORMALIZATION_MAX_BYTES)
    throw new Error("PDF preparation accepts nonempty PDFs up to 256 MiB.");

  const process = (await loadGeckoSubprocess().call({
    command: python,
    arguments: ["-I", "-c", PDF_NORMALIZATION_SCRIPT],
    stderr: "pipe",
  })) as unknown as NativePdfProcess;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (signal?.aborted) throw new PdfSplitterCancelledError();
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new PdfSplitterCancelledError());
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("PDF preparation timed out.")),
        timeoutMs,
      );
    });
    const task = Promise.all([
      (async () => {
        await process.stdin.write(bytes.slice().buffer);
        await process.stdin.close();
      })(),
      readPdf(process.stdout),
      readErrors(process.stderr),
      process.wait(),
    ]);
    const [, output, diagnostic, status] = await Promise.race([task, stopped]);
    complete = true;
    if (signal?.aborted) throw new PdfSplitterCancelledError();
    if (status.exitCode !== 0) {
      if (diagnostic.includes("MINERU_PDF_PASSWORD_REQUIRED"))
        throw new Error(
          "This PDF requires a password. Open it with your password and save an unencrypted copy before parsing.",
        );
      if (diagnostic.includes("MINERU_PDF_DEPENDENCY_MISSING"))
        throw new Error(
          "The PDF preparation Python needs pypdf and its AES dependency. No packages were installed automatically.",
        );
      throw new Error(
        `PDF preparation failed (exit ${status.exitCode}): ${diagnostic.trim().slice(0, 800)}`,
      );
    }
    if (new TextDecoder().decode(output.subarray(0, 5)) !== "%PDF-")
      throw new Error("PDF preparation returned empty or invalid PDF data.");
    return output;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (!complete) await process.kill(0).catch(() => undefined);
    await Promise.allSettled([
      process.stdin.close(true),
      process.stdout.close(true),
      process.stderr.close(true),
    ]);
  }
}
