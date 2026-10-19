import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resolveAgentConfigId } from "@/lib/agent-config-scope";
import {
  getArgentinaMinutes,
  getArgentinaDayIndex,
  getArgentinaDayName,
} from "@/lib/argentina-time";

interface BusinessHourDay {
  day: string;
  open: boolean;
  openTime: string;
  closeTime: string;
}

// Convierte "HH:MM" a minutos desde medianoche
function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

export const getBusinessHoursTool = tool({
  description: "Consulta los horarios de atención. Cuando el cliente pregunte: 'hasta qué hora están?', 'abren los domingos?', 'a qué hora cierran?', 'trabajan los sábados?', 'a la tarde están?', 'qué días abren?', 'están ahora?'",
  inputSchema: z.object({}),
  execute: async () => {
    const [config] = await db
      .select({ businessHours: agentConfig.businessHours })
      .from(agentConfig)
      .where(eq(agentConfig.id, await resolveAgentConfigId()));

    if (!config?.businessHours) return "No tengo información de horarios configurada.";

    const hours = config.businessHours as BusinessHourDay[];
    const nowMin = getArgentinaMinutes();
    const days = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const todayName = getArgentinaDayName(days);

    const today = hours.find(h => h.day === todayName);

    // ─── PASO 1: Verificar si la madrugada está cubierta por el turno del día anterior ───
    let isOpenNow = false;
    let activeDayName = todayName;

    const yesterdayIndex = (getArgentinaDayIndex() - 1 + 7) % 7;
    const yesterdayName = days[yesterdayIndex];
    const yesterday = hours.find((h) => h.day === yesterdayName);
    if (yesterday?.open) {
      const yCloseMin = toMin(yesterday.closeTime);
      const yOpenMin = toMin(yesterday.openTime);
      if (yCloseMin < yOpenMin && nowMin < yCloseMin) {
        // El día anterior tenía turno nocturno que cubre esta madrugada
        isOpenNow = true;
        activeDayName = yesterdayName;
      }
    }

    // ─── PASO 2: Si no está cubierto por madrugada, verificar el día actual ───
    if (!isOpenNow && today?.open) {
      const openMin = toMin(today.openTime);
      const closeMin = toMin(today.closeTime);
      const crossesMidnight = closeMin < openMin;
      if (nowMin >= openMin) {
        if (crossesMidnight) {
          isOpenNow = true;
        } else {
          isOpenNow = nowMin < closeMin;
        }
      }
    }

    const schedule = hours
      .filter(h => h.open)
      .map(h => `${h.day}: ${h.openTime} – ${h.closeTime}`)
      .join("\n");

    const statusPrefix = isOpenNow ? "🟢 Estamos ABIERTOS ahora" : "🔴 Estamos CERRADOS en este momento";
    const daySuffix = activeDayName !== todayName ? ` (en turno de ${activeDayName})` : "";

    return `${statusPrefix}${daySuffix}.\n\nHorarios:\n${schedule}`;
  },
});
