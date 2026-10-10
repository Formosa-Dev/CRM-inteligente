import { db } from "../src/db";
import { eq } from "drizzle-orm";

const days = ["Domingo", "Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado"];

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

async function main() {
  const config = await db.query.agentConfig.findFirst({ where: (c) => eq(c.id, 1) });
  if (!config?.businessHours) {
    console.log("No business hours configured");
    return;
  }

  const hours = config.businessHours as { day: string; open: boolean; openTime: string; closeTime: string }[];

  console.log("=== BUSINESS HOURS CONFIG ===");
  for (const h of hours) {
    console.log("  " + h.day + ": open=" + h.open + ", " + h.openTime + " -> " + h.closeTime);
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayName = days[now.getDay()];
  const today = hours.find((h) => h.day === todayName);

  console.log("\nNow: " + now.toISOString());
  console.log("Today (calendario): " + todayName);
  console.log("Now minutes: " + nowMin);
  console.log("now.getDay(): " + now.getDay());
  console.log("dayNames: " + JSON.stringify(days));

  // Step 1: check yesterday overnight
  const yesterdayIndex = (now.getDay() - 1 + 7) % 7;
  const yesterdayName = days[yesterdayIndex];
  const yesterday = hours.find((h) => h.day === yesterdayName);

  console.log("\n=== STEP 1: Check yesterday (" + yesterdayName + ") ===");
  let isOpenNow = false;
  let activeDayName = todayName;

  if (yesterday) {
    console.log("  yesterday.open=" + yesterday.open + ", openTime=" + yesterday.openTime + ", closeTime=" + yesterday.closeTime);
    if (yesterday.open) {
      const yc = toMin(yesterday.closeTime);
      const yo = toMin(yesterday.openTime);
      const crossMid = yc < yo;
      const beforeClose = nowMin < yc;
      console.log("  closeMin=" + yc + " < openMin=" + yo + " ? " + crossMid);
      console.log("  nowMin=" + nowMin + " < closeMin=" + yc + " ? " + beforeClose);
      if (crossMid && beforeClose) {
        isOpenNow = true;
        activeDayName = yesterdayName;
        console.log("  => ABIERTO (turno de ayer cubre madrugada)");
      } else {
        console.log("  => NOT covered by yesterday");
      }
    } else {
      console.log("  => yesterday not open");
    }
  } else {
    console.log("  => yesterday not found in config");
  }

  // Step 2: check today
  console.log("\n=== STEP 2: Check today (" + todayName + ") ===");
  if (!isOpenNow && today) {
    console.log("  today.open=" + today.open + ", openTime=" + today.openTime + ", closeTime=" + today.closeTime);
    if (today.open) {
      const om = toMin(today.openTime);
      const cm = toMin(today.closeTime);
      const cmid = cm < om;
      const afterOpen = nowMin >= om;
      console.log("  openMin=" + om + ", closeMin=" + cm + ", crossesMidnight=" + cmid);
      console.log("  nowMin=" + nowMin + " >= openMin=" + om + " ? " + afterOpen);
      if (afterOpen) {
        if (cmid) {
          isOpenNow = true;
          console.log("  => ABIERTO (dia actual con cruce medianoche)");
        } else {
          isOpenNow = nowMin < cm;
          console.log("  => " + (isOpenNow ? "ABIERTO" : "CERRADO") + " (hora normal)");
        }
      } else {
        console.log("  => CERRADO (antes de apertura)");
      }
    } else {
      console.log("  => today is closed");
    }
  } else if (!today) {
    console.log("  => today not found in config");
  } else if (isOpenNow) {
    console.log("  Already open from step 1");
  }

  console.log("\n=== FINAL: " + (isOpenNow ? "ABIERTO" : "CERRADO") + " ===");
  console.log("Active day: " + activeDayName);
}

main().catch(console.error);
