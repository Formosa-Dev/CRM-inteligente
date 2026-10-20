#!/usr/bin/env node
/**
 * scripts/migrate-uploads.mjs — mueve inbound media: public/uploads → MEDIA_UPLOADS_DIR.
 *
 * Round 2 movió el almacenamiento de medios entrantes fuera de public/ a un
 * directorio privado (default <cwd>/data/uploads) servido por la ruta
 * sesion-gated /api/media/[...path]. Este script hace la migración one-time de
 * los archivos que todavía viven bajo public/uploads/.
 *
 * Garantías:
 *   - NO toca la base de datos: no importa ni llama al DB.
 *   - DRY-RUN por defecto: sin --apply no se mueve nada.
 *   - No pisa archivos existentes en destino: los omite y los cuenta.
 *   - Sin dependencias: node:fs/promises + node:path + node:process.
 *
 * Uso:
 *   node scripts/migrate-uploads.mjs            # dry-run (default)
 *   node scripts/migrate-uploads.mjs --apply    # ejecuta los movimientos
 *
 * Env:
 *   MEDIA_UPLOADS_DIR (opcional) — destino; default <cwd>/data/uploads.
 */

import { readdir, rename, copyFile, unlink, stat, mkdir } from "node:fs/promises";
import path from "node:path";

const CWD = process.cwd();
const SOURCE_DIR = path.resolve(CWD, "public", "uploads");
const DEST_DIR = process.env.MEDIA_UPLOADS_DIR
  ? path.resolve(process.env.MEDIA_UPLOADS_DIR)
  : path.join(CWD, "data", "uploads");
const APPLY = process.argv.includes("--apply");

const stats = { moved: 0, skipped: 0, errors: 0, bytes: 0 };
const skippedFiles = [];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function moveFile(src, dest) {
  const destDir = path.dirname(dest);
  await mkdir(destDir, { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    // Cross-device (Render persistent disk vs. local app disk) → copiar + borrar.
    if (!err || err.code !== "EXDEV") throw err;
    await copyFile(src, dest);
    await unlink(src);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main() {
  console.log("═══ Migración de inbound media ═══");
  console.log(`  Modo    : ${APPLY ? "APPLY (ejecuta movimientos)" : "DRY-RUN (no mueve nada)"}`);
  console.log(`  Origen  : ${SOURCE_DIR}`);
  console.log(`  Destino : ${DEST_DIR}`);
  console.log("");
  if (!APPLY) {
    console.log("(Dry-run por defecto — reejecutá con --apply para mover los archivos.)\n");
  }

  for await (const file of walk(SOURCE_DIR)) {
    const rel = path.relative(SOURCE_DIR, file);
    const dest = path.join(DEST_DIR, rel);

    let destExists = false;
    try {
      const s = await stat(dest);
      destExists = s.isFile();
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    if (destExists) {
      stats.skipped++;
      skippedFiles.push(rel);
      continue;
    }

    const size = (await stat(file)).size;

    if (!APPLY) {
      stats.moved++;
      stats.bytes += size;
      console.log(`  movería  ${rel} (${formatBytes(size)})`);
      continue;
    }

    try {
      await moveFile(file, dest);
      stats.moved++;
      stats.bytes += size;
      console.log(`  movido   ${rel}`);
    } catch (err) {
      stats.errors++;
      console.error(`  error    ${rel}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("");
  console.log("═══ Resumen ═══");
  console.log(`  ${APPLY ? "movidos" : "a mover"} : ${stats.moved}`);
  console.log(`  omitidos (ya existen) : ${stats.skipped}`);
  console.log(`  errores               : ${stats.errors}`);
  if (stats.bytes) console.log(`  total bytes           : ${formatBytes(stats.bytes)}`);

  if (skippedFiles.length) {
    console.log("");
    console.log("Omitidos (el destino ya existe, no se pisan):");
    for (const f of skippedFiles.slice(0, 50)) console.log(`  - ${f}`);
    if (skippedFiles.length > 50) console.log(`  … y ${skippedFiles.length - 50} más`);
  }

  if (stats.errors) {
    console.error(`\nCompletado con ${stats.errors} error(es).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("ERR", err instanceof Error ? err.message : err);
  process.exit(1);
});
