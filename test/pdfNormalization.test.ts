import { assert } from "chai";
import { normalizePdfBytes } from "../src/utils/pdfNormalization";
import { PdfSplitterCancelledError } from "../src/utils/pdfSplitter";
import { createPdfFixture } from "./helpers/pdfFixture";

const key = "extensions.zotero.llmforzotero.mineruPdfPythonPath";
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected failure");
}

describe("local PDF normalization lifecycle", function () {
  let calls: any[], writes: Uint8Array[], killed: number, closed: number;
  let output: Uint8Array, errorText: string, exitCode: number;
  let call: () => Promise<any>;
  beforeEach(function () {
    calls = [];
    writes = [];
    killed = 0;
    closed = 0;
    output = createPdfFixture(2);
    errorText = "";
    exitCode = 0;
    call = async () => {
      let emitted = false,
        errorEmitted = false;
      return {
        stdin: {
          write: async (data: ArrayBuffer) => {
            writes.push(new Uint8Array(data));
          },
          close: async () => {
            closed++;
          },
        },
        stdout: {
          read: async () => {
            if (emitted) return new ArrayBuffer(0);
            emitted = true;
            return output.slice().buffer;
          },
          close: async () => {
            closed++;
          },
        },
        stderr: {
          readString: async () => {
            if (errorEmitted) return "";
            errorEmitted = true;
            return errorText;
          },
          close: async () => {
            closed++;
          },
        },
        wait: async () => ({ exitCode }),
        kill: async () => {
          killed++;
          return { exitCode: -1 };
        },
      };
    };
    (globalThis as any).Zotero = {
      Prefs: {
        get: (name: string) =>
          name === key ? "C:\\Python\\python.exe" : undefined,
      },
    };
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async (options: any) => {
            calls.push(options);
            return call();
          },
        },
      }),
    };
  });
  afterEach(function () {
    delete (globalThis as any).Zotero;
    delete (globalThis as any).ChromeUtils;
  });

  it("uses an explicit executable and binary pipes without modifying input", async function () {
    const input = createPdfFixture(1),
      before = input.slice();
    const result = await normalizePdfBytes(input);
    assert.deepEqual(result, output);
    assert.deepEqual(input, before);
    assert.deepEqual(writes[0], before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "C:\\Python\\python.exe");
    assert.deepEqual(calls[0].arguments.slice(0, 2), ["-I", "-c"]);
    assert.equal(calls[0].stderr, "pipe");
    assert.isAtLeast(closed, 3);
  });
  it("does not discover or run executables unless configured", async function () {
    (globalThis as any).Zotero.Prefs.get = () => "";
    assert.include(
      (await failure(normalizePdfBytes(createPdfFixture(1)))).message,
      "Python",
    );
    assert.lengthOf(calls, 0);
  });
  it("rejects a relative executable instead of searching PATH", async function () {
    (globalThis as any).Zotero.Prefs.get = () => "python";
    assert.include(
      (await failure(normalizePdfBytes(createPdfFixture(1)))).message,
      "absolute",
    );
    assert.lengthOf(calls, 0);
  });
  it("reports password-required without retrying another password", async function () {
    exitCode = 2;
    output = new Uint8Array();
    errorText = "MINERU_PDF_PASSWORD_REQUIRED\n";
    const error = await failure(normalizePdfBytes(createPdfFixture(1)));
    assert.include(error.message, "password");
    assert.equal(calls.length, 1);
  });
  it("rejects success with invalid or empty output", async function () {
    output = new TextEncoder().encode("not a PDF");
    assert.include(
      (await failure(normalizePdfBytes(createPdfFixture(1)))).message,
      "PDF",
    );
  });
  it("preserves dependency errors instead of calling them password failures", async function () {
    exitCode = 3;
    output = new Uint8Array();
    errorText = "MINERU_PDF_DEPENDENCY_MISSING: pypdf\n";
    assert.include(
      (await failure(normalizePdfBytes(createPdfFixture(1)))).message,
      "pypdf",
    );
  });
  it("cancels before spawning", async function () {
    const controller = new AbortController();
    controller.abort();
    assert.instanceOf(
      await failure(normalizePdfBytes(createPdfFixture(1), controller.signal)),
      PdfSplitterCancelledError,
    );
    assert.lengthOf(calls, 0);
  });
  for (const reason of ["abort", "timeout"] as const) {
    it(`stops the owned process on ${reason}`, async function () {
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      call = async () => {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        ready();
        return {
          stdin: {
            write: async () => {},
            close: async () => {
              closed++;
            },
          },
          stdout: {
            read: async () => {
              await done;
              return new ArrayBuffer(0);
            },
            close: async () => {
              closed++;
            },
          },
          stderr: {
            readString: async () => {
              await done;
              return "";
            },
            close: async () => {
              closed++;
            },
          },
          wait: async () => {
            await done;
            return { exitCode: -1 };
          },
          kill: async () => {
            killed++;
            finish();
            return { exitCode: -1 };
          },
        };
      };
      const controller = new AbortController();
      const pending = normalizePdfBytes(
        createPdfFixture(1),
        controller.signal,
        reason === "timeout" ? 20 : 1000,
      );
      await started;
      if (reason === "abort") controller.abort();
      const error = await failure(pending);
      if (reason === "abort")
        assert.instanceOf(error, PdfSplitterCancelledError);
      else assert.include(error.message, "timed out");
      assert.isAtLeast(killed, 1);
      assert.isAtLeast(closed, 3);
    });
  }
});
