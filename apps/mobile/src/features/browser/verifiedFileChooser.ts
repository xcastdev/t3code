import { File, FileMode, Paths } from "expo-file-system";

import { uuidv4 } from "../../lib/uuid";
import { bytesFromBase64, requestVerifiedRoute } from "../../native/verifiedNetwork";

interface PickedFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
}

export function multipartFileHeader(boundary: string, file: PickedFile) {
  const name = file.name.replace(/[\u0000-\u001f\u007f]/g, "_").replace(/["\\]/g, "\\$&");
  const mime = file.mimeType;
  const type =
    mime && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime) ? mime : "application/octet-stream";
  return `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`;
}

export async function sendVerifiedChooserFiles(
  url: string,
  files: readonly PickedFile[],
  signal: AbortSignal,
) {
  const maxSize = 100 * 1024 * 1024;
  if (files.length > 20) throw new Error("Choose at most 20 files.");
  const boundary = `t3-${uuidv4()}`;
  const file = new File(Paths.cache, `${boundary}.multipart`);
  const encoder = new TextEncoder();
  try {
    file.create();
    const output = file.open(FileMode.WriteOnly);
    try {
      let size = 0;
      const write = async (bytes: Uint8Array) => {
        signal.throwIfAborted();
        size += bytes.length;
        if (size > maxSize) throw new Error("The selected files exceed 100 MB.");
        await output.writeBytes(bytes);
      };
      for (const asset of files) {
        const input = new File(asset.uri).open(FileMode.ReadOnly);
        try {
          await write(encoder.encode(multipartFileHeader(boundary, asset)));
          for (;;) {
            signal.throwIfAborted();
            const bytes = await input.readBytes(64 * 1024);
            if (bytes.length === 0) break;
            await write(bytes);
          }
          await write(encoder.encode("\r\n"));
        } finally {
          input.close();
        }
      }
      await write(encoder.encode(`--${boundary}--\r\n`));
    } finally {
      output.close();
    }
    const response = await requestVerifiedRoute(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      uploadFile: file.uri,
      signal,
    });
    if (!response || response.status < 200 || response.status >= 300) {
      const detail =
        response?.status === 409
          ? new TextDecoder().decode(bytesFromBase64(response.bodyBase64))
          : null;
      throw new Error(detail || "The verified upload was refused.");
    }
  } finally {
    if (file.exists) file.delete();
  }
}
