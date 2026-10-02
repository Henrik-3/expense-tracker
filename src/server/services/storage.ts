import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist the image before PostgreSQL is allowed to reference it. */
export async function writeDurableImage(path: string, bytes: Uint8Array) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  // Production is Linux. Windows does not expose directory fsync via node:fs.
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
