// ─── Generador del perfil de estilo de venta ────────────────────────────────
// Construye el texto que va a `agent_config.whatsapp_style_profile` — la capa
// de negocio que se inyecta en el system prompt del agente de WhatsApp.
//
// Fuentes (en orden de preferencia):
//   1. <dir>/style-profile.md  → usa el bloque <!-- STYLE-PROFILE:BEGIN/END -->
//   2. <dir>/*.md              → concatena las secciones "## REGLAS PARA EL
//      AGENTE DE VENTAS" de cada reporte (fallback si no hay síntesis).
//
// Uso:
//   npx tsx scripts/learn-style.ts --from docs/chat-analysis --print
//   npx tsx scripts/learn-style.ts --from docs/chat-analysis --write
//   npx tsx scripts/learn-style.ts --profile-file ruta/perfil.txt --write
//
// Para otro despliegue: generar reportes del chat real (mismo formato
// docs/chat-analysis/*.md con sección REGLAS) o escribir el perfil a mano y
// pasarlo con --profile-file. El repo no trae datos del negocio — eso vive
// en la DB de cada instalación.

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";

const PROFILE_MARKER_BEGIN = "<!-- STYLE-PROFILE:BEGIN -->";
const PROFILE_MARKER_END = "<!-- STYLE-PROFILE:END -->";
const RULES_HEADER = /##\s+REGLAS PARA EL AGENTE DE VENTAS/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function extractBlock(text: string): string | null {
  const a = text.indexOf(PROFILE_MARKER_BEGIN);
  const b = text.indexOf(PROFILE_MARKER_END);
  if (a < 0 || b <= a) return null;
  return text.slice(a + PROFILE_MARKER_BEGIN.length, b).trim();
}

function extractRules(text: string): string | null {
  const m = text.match(RULES_HEADER);
  if (!m || m.index === undefined) return null;
  return text.slice(m.index + m[0].length).trim();
}

function buildProfile(fromDir: string): { profile: string; source: string } {
  const styleFile = join(fromDir, "style-profile.md");
  try {
    const block = extractBlock(readFileSync(styleFile, "utf8"));
    if (block) return { profile: block, source: styleFile };
  } catch {
    /* no hay síntesis: fallback a reportes */
  }

  const files = readdirSync(fromDir).filter((f) => f.endsWith(".md") && f !== "style-profile.md");
  const sections: string[] = [];
  for (const f of files.sort()) {
    const rules = extractRules(readFileSync(join(fromDir, f), "utf8"));
    if (rules) sections.push(`── ${f.replace(/\.md$/, "").toUpperCase()} ──\n${rules}`);
  }
  if (sections.length === 0) {
    throw new Error(`Sin perfil en ${fromDir}: falta style-profile.md y ningún *.md tiene sección REGLAS PARA EL AGENTE DE VENTAS`);
  }
  return { profile: sections.join("\n\n"), source: `${files.length} reportes en ${fromDir}` };
}

async function main() {
  const profileFile = arg("profile-file");
  const fromDir = arg("from");

  let profile: string;
  let source: string;
  if (profileFile) {
    profile = readFileSync(profileFile, "utf8").trim();
    source = profileFile;
  } else if (fromDir) {
    ({ profile, source } = buildProfile(fromDir));
  } else {
    console.error("Uso: --from <dir-de-reportes> | --profile-file <archivo> [--print|--write]");
    process.exit(1);
  }

  console.log(`Fuente: ${source}`);
  console.log(`Perfil: ${profile.length} chars, ${profile.split("\n").length} líneas`);
  if (has("print")) {
    console.log("\n" + profile);
  }

  if (has("write")) {
    await db
      .insert(agentConfig)
      .values({ id: 1, whatsappStyleProfile: profile })
      .onConflictDoUpdate({ target: agentConfig.id, set: { whatsappStyleProfile: profile } });
    console.log("✓ whatsapp_style_profile actualizado en agent_config (id=1)");
  } else {
    console.log("(dry-run — pasá --write para persistir en agent_config)");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
