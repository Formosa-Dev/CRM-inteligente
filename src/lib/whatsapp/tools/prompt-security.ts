// Pattern detection for prompt injection attacks
// Based on ClinicForge's prompt_security.py

const INJECTION_PATTERNS_SPANISH = [
  /ignora.*instrucciones/i,
  /olvida.*reglas/i,
  /sos.*nuevo.*agente/i,
  /actuar.*como.*nuevo/i,
  /nuevo.*prompt/i,
  /cambiar.*personalidad/i,
  /ignorar.*reglas/i,
  /desactivar.*filtros/i,
  / режим.*разработчик/i, // russian dev mode
];

const INJECTION_PATTERNS_ENGLISH = [
  /ignore.*previous.*instructions/i,
  /new.*prompt/i,
  /jailbreak/i,
  /developer.*mode/i,
  /act as.*different/i,
  /you.*are.*now/i,
  /pretend.*to.*be/i,
  /override.*rules/i,
  /bypass.*safeguards/i,
];

// NOTA: NO incluimos patrones de backticks `` ` `` porque los clientes
// los usan naturalmente en WhatsApp argentino (ej: "las `doble carne`").
// Solo patrones EXPLICITOS de jailbreak.
const INJECTION_PATTERNS_CODE = [
  /ignora todo lo anterior/i,
  /ignore all previous/i,
  /eres un asistente nuevo/i,
  /you are now a new ai/i,
];

export interface InjectionResult {
  detected: boolean;
  sanitizedMessage: string;
  pattern?: string;
}

export function sanitizeInput(message: string): string {
  // Ya no removemos backticks (los clientes los usan naturalmente)
  // Solo removemos caracteres de control obvios
  const sanitized = message
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // solo chars de control
    .trim();
  
  return sanitized;
}

export function detectInjection(message: string): InjectionResult {
  const sanitized = sanitizeInput(message);
  
  // Check Spanish patterns
  for (const pattern of INJECTION_PATTERNS_SPANISH) {
    if (pattern.test(message)) {
      return {
        detected: true,
        sanitizedMessage: sanitized,
        pattern: pattern.source,
      };
    }
  }
  
  // Check English patterns
  for (const pattern of INJECTION_PATTERNS_ENGLISH) {
    if (pattern.test(message)) {
      return {
        detected: true,
        sanitizedMessage: sanitized,
        pattern: pattern.source,
      };
    }
  }
  
  // Check code patterns
  for (const pattern of INJECTION_PATTERNS_CODE) {
    if (pattern.test(message)) {
      return {
        detected: true,
        sanitizedMessage: sanitized,
        pattern: pattern.source,
      };
    }
  }
  
  return {
    detected: false,
    sanitizedMessage: sanitized,
  };
}

// Server-side version for agent
export function createPromptSecurityServer() {
  return {
    sanitizeInput,
    detectInjection,
  };
}