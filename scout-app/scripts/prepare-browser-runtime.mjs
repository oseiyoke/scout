import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const extension = process.platform === "win32" ? ".exe" : "";
const binaryDir = join(projectRoot, "src-tauri", "binaries");
const runtimeDir = join(projectRoot, "src-tauri", "browser-runtime");
const targetBinary = join(binaryDir, `scout-node-${target}${extension}`);
const nodeLicense = join(dirname(process.execPath), "..", "LICENSE");
const targetLicense = join(runtimeDir, "NODE-LICENSE");

mkdirSync(binaryDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const copyIfChanged = (source, targetPath) => {
  if (!existsSync(targetPath) || statSync(source).size !== statSync(targetPath).size) {
    copyFileSync(source, targetPath);
  }
};

copyIfChanged(process.execPath, targetBinary);
if (process.platform !== "win32") chmodSync(targetBinary, 0o755);
if (existsSync(nodeLicense)) copyIfChanged(nodeLicense, targetLicense);

console.log(`Prepared bundled Chrome runtime for ${target}.`);
