import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
/** Local storage locks are in-process, so a profile can have only one backend owner. */
export async function acquireProfileLock(profile: string) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const path = join(profile, "backend.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("The workspace lock is invalid. Inspect backend.lock in the local profile.");
      let running = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        running = (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (running) throw new Error("This local workspace is already open in another OntoLab backend.");
      await unlink(path);
    }
  }
  throw new Error("Could not acquire the local workspace lock.");
}
