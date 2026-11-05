import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface PackageInfo {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
}
interface LockedPackage extends PackageInfo {
  dev?: boolean;
  resolved?: string;
}

/** Preserve the notices supplied by installed packages, including browser documentation bundles. */
export async function buildNotices(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const inventory = [];
  for (const root of [".", "website"]) {
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, LockedPackage> };
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || entry.dev) continue;
      const directory = resolve(root, path);
      let info: PackageInfo;
      try {
        info = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Optional packages for other platforms.
        throw error;
      }
      if (info.version !== entry.version) throw new Error(`Dependency version differs from lockfile: ${root}/${path}`);
      if (info.name?.startsWith("@img/sharp-libvips-") && info.version !== "1.3.4")
        throw new Error("Update the libvips component notices and source references for this new version before packaging.");
      const id = `${root === "." ? "app" : "docs"}/${path.replaceAll("node_modules/", "")}`;
      const target = join(destination, id);
      await mkdir(target, { recursive: true });
      const names = await readdir(directory);
      const licenses = names.filter((name) => /^(licen[cs]e|copying|notice|third[-_]party)/i.test(name));
      const files = licenses.length ? licenses : names.filter((name) => /^readme/i.test(name));
      for (const file of files)
        await cp(join(directory, file), join(target, file), { recursive: (await stat(join(directory, file))).isDirectory() });
      inventory.push({
        name: info.name,
        version: info.version,
        license: info.license ?? entry.license ?? "See upstream",
        source: typeof info.repository === "string" ? info.repository : (info.repository?.url ?? info.homepage),
        package: entry.resolved,
        location: id,
        notices: files,
        ...(!licenses.length
          ? { note: "Upstream package omits a separate license file; consult README/source and root third-party notices." }
          : {}),
      });
    }
  }
  await writeFile(join(destination, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  console.info(`Preserved notices and provenance for ${inventory.length} installed dependency packages.`);
}
