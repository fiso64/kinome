import { $ } from "bun";
import { parseArgs } from "util";
import path from "path";
import fs from "fs/promises";

// 1. Parse Arguments
const { values } = parseArgs({
    args: Bun.argv,
    options: {
        target: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
});

const rawTarget = values.target; // e.g. 'windows-x64'
if (!rawTarget) {
    console.error("❌ Error: --target is required (e.g., linux-arm64, windows-x64)");
    process.exit(1);
}

// Ensure the target passed to Bun starts with 'bun-'
// But keep rawTarget for folder naming to look nicer (dist/windows-x64 instead of dist/bun-windows-x64)
const bunTarget = rawTarget.startsWith("bun-") ? rawTarget : `bun-${rawTarget}`;

// 2. Setup Paths
const isWinTarget = rawTarget.includes("windows");
const ext = isWinTarget ? ".exe" : "";
const distRoot = path.resolve("dist");
const buildDir = path.join(distRoot, rawTarget); // dist/windows-x64
const outFile = path.join(buildDir, "media-browser" + ext);
const zipPath = path.join(distRoot, `media-browser-${rawTarget}.zip`);

console.log(`\n🚀 Starting build for: ${rawTarget} (Compiler target: ${bunTarget})`);

// 3. Clean & Prep
await fs.rm(buildDir, { recursive: true, force: true });
await fs.rm(zipPath, { force: true });
await fs.mkdir(buildDir, { recursive: true });

// 4. Build Frontend
console.log("🎨 Building Frontend...");
await $`bun run build`;

// 5. Compile Backend
// We pass bunTarget here (e.g. bun-windows-x64)
console.log("⚙️  Compiling Backend...");
try {
    await $`bun build --compile --target=${bunTarget} --minify --sourcemap --define "process.env.NODE_ENV='production'" ./src/main/server.ts --outfile ${outFile}`;
} catch (e) {
    console.error("❌ Backend Compilation Failed");
    process.exit(1);
}

// 6. Copy Assets
console.log("📂 Copying Assets...");
// Ensure parent directory exists before copying
const outDest = path.join(buildDir, "out");
await fs.mkdir(outDest, { recursive: true });
await fs.cp(path.resolve("out"), outDest, { recursive: true });

// 7. Zip Artifact
console.log("📦 Zipping artifact...");

try {
    if (process.platform === "win32") {
        // Powershell requires a full path or relative path logic that can be finicky.
        // We use the full path to the build dir contents.
        await $`powershell Compress-Archive -Path "${buildDir}\\*" -DestinationPath "${zipPath}" -Force`;
    } else {
        const cwd = process.cwd();
        process.chdir(buildDir);
        await $`zip -r ${zipPath} .`;
        process.chdir(cwd);
    }
    console.log(`\n✅ Build Complete!`);
    console.log(`   Artifact: ${zipPath}`);
} catch (e) {
    console.error("❌ Zipping Failed:", e);
}