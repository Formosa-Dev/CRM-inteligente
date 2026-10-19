import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { mediaUploadsDir, saveMediaLocally } from "./downloader";

/**
 * F2 — inbound customer media must live outside public/ and be reachable
 * only through the session-gated /api/media route. saveMediaLocally writes
 * under mediaUploadsDir() and returns an /api/media URL.
 */

let previous: string | undefined;
let tmp: string | undefined;

function useTmp() {
  previous = process.env.MEDIA_UPLOADS_DIR;
  tmp = mkdtempSync(path.join(os.tmpdir(), "media-uploads-"));
  process.env.MEDIA_UPLOADS_DIR = tmp;
}

afterEach(() => {
  if (previous === undefined) delete process.env.MEDIA_UPLOADS_DIR;
  else process.env.MEDIA_UPLOADS_DIR = previous;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  previous = undefined;
});

describe("mediaUploadsDir", () => {
  it("honors MEDIA_UPLOADS_DIR", () => {
    useTmp();
    assert.equal(mediaUploadsDir(), path.resolve(tmp!));
  });
});

describe("saveMediaLocally (F2)", () => {
  it("writes outside public/ and returns an /api/media URL", async () => {
    useTmp();
    const url = await saveMediaLocally(
      Buffer.from("synthetic-media-bytes"),
      42,
      "voice note.ogg",
      "audio/ogg"
    );
    assert.ok(url.startsWith("/api/media/42/"), `unexpected url: ${url}`);
    assert.ok(url.endsWith(".ogg"));
    const stored = path.join(tmp!, "42", url.split("/").pop()!);
    assert.ok(existsSync(stored), `file not written under private dir: ${stored}`);
    assert.ok(!stored.includes(`${path.sep}public${path.sep}`));
  });
});
