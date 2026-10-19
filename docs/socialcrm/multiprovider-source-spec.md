# **Especificación Técnica de Arquitectura: Abstracción Multiproveedor de Mensajería y Redes Sociales**

## **Documento Técnico para el Equipo de Desarrollo | Proyecto: Integración Omnicanal (yCloud \+ Zernio \+ Kapso)**

# **1\. Contexto y Objetivos del Proyecto**

Actualmente, nuestro sistema utiliza **yCloud** como tubería y proveedor principal de infraestructura para el envío, recepción e interacción a través del canal oficial de WhatsApp Business API.

Para escalar nuestras capacidades omnicanal y ofrecer mayor flexibilidad operativa, el sistema debe evolucionar hacia un Patrón Proveedor Adaptativo (Messaging Service Bus / Channel Gateway). Este cambio permitirá incorporar dos nuevos proveedores clave:

* Zernio: Meta Partner enfocado en mensajería unificada, redes sociales (Instagram, Facebook, Twitter/X, LinkedIn, Telegram, etc.) y gestión multicanal mediante una API simplificada sin lidiar directamente con la complejidad del Graph API.  
* Kapso: Meta Business Solution Provider (BSP) especializado en WhatsApp para desarrolladores y proveedores tecnológicos (Tech Providers), ofreciendo embedded signups, pools de números pre-verificados, soporte MCP, flujos de handoff humano y facturación unificada (Managed Billing).

El objetivo fundamental para el desarrollador es refactorizar el código existente para abstraer la conexión con yCloud, permitiendo intercalar o convivir con Zernio y Kapso según el tipo de canal, el cliente o la cuenta configurada.

# **2\. Análisis Comparativo de Proveedores y Capacidades de Canales**

| Característica / Canal | yCloud | Zernio | Kapso |
| :---- | :---- | :---- | :---- |
| **Rol Principal** | Infraestructura oficial WhatsApp / SMS | API Omnicanal Social & Mensajería | BSP WhatsApp Infra & Tech Provider |
| **WhatsApp API** | Oficial WABA / Cloud API | Mensajería directa \+ Direct (Unified) | Especializado (Embedded Signup, WABA) |
| **Instagram (DM, Comentarios, Reels)** | No disponible | Extenso (DMs, Posts, Reels, Stories, Comment-to-DM) | No disponible |
| **Facebook Messenger & Meta Ads** | No disponible | Direct DMs, comentarios y Meta Ads API | No disponible |
| **Otros Canales** | SMS / MMS | Twitter/X, Telegram, LinkedIn, TikTok, YouTube, Bluesky, Reddit, etc. | Enfoque exclusivo e hiperespecializado en WhatsApp |
| **Gestión de Onboarding Clientela** | Manual / WABA individual | OAuth unificado en Dashboard/API | Multi-Partner Solution (MPS) & Embedded Signup links |
| **Webhooks Inbound** | Eventos nativos WhatsApp | Webhook firmado HMAC-SHA256 (`message.received`, `comment.received`) | Webhook nativo por Phone Number (message.received) |
| **Herramientas AI / Agentic** | Básica / API REST | MCP Server oficial \+ SDKs (`@zernio/node`, etc.) | MCP Server nativo, OpenClaw plugin, Handoff Humano |

# **3\. Arquitectura del Sistema: Pattern Interface & Router Unificado**

Para abstraer la infraestructura de comunicación, el desarrollador deberá crear un modelo de diseño Provider Factory / Adapter Pattern.

## **3.1 Modelo de Datos Core (ChannelAccount & MessagePayload)**

En lugar de vincular una cuenta o sesión directamente a un ID de yCloud, se debe estructurar una entidad ChannelAccount:type ProviderType \= 'ycloud' | 'zernio' | 'kapso';

type ChannelType \= 'whatsapp' | 'instagram' | 'facebook' | 'telegram' | 'sms';

interface ChannelAccount {

  id: string;

  tenantId: string;

  provider: ProviderType;

  channel: ChannelType;

  providerAccountId: string; // Ej: ID de cuenta en Zernio, WABA ID en Kapso/yCloud

  phoneNumberId?: string;    // Para WhatsApp

  credentials: {

    apiKey?: string;

    accessToken?: string;

    webhookSecret?: string;

  };

  status: 'active' | 'disconnected' | 'error';

}

interface OutboundMessage {

  tenantId: string;

  channelAccountId: string;

  to: string; // Número telefónico E.164 o ID de usuario de red social

  type: 'text' | 'image' | 'template' | 'document' | 'interactive';

  content: {

    text?: string;

    mediaUrl?: string;

    templateName?: string;

    templateLanguage?: string;

    components?: any\[\];

  };

}

# **4\. Estrategia de Implementación para el Desarrollador**

## **4.1 Definición de la Interfaz Estándar (IMessagingProvider)**

Todo adaptador de canal debe implementar la siguiente interfaz unificada:export interface IMessagingProvider {

  sendMessage(account: ChannelAccount, message: OutboundMessage): Promise\<{ messageId: string; status: string }\>;

  sendTemplate?(account: ChannelAccount, message: OutboundMessage): Promise\<{ messageId: string; status: string }\>;

  parseInboundWebhook(headers: Record\<string, string\>, body: any): {

    eventType: 'message.received' | 'message.status' | 'comment.received';

    senderId: string;

    channelAccountId: string;

    text?: string;

    mediaUrl?: string;

    raw: any;

  };

}

## **4.2 Implementación de Adaptadores**

## **Adaptador yCloud (YCloudAdapter)**

Mantiene la lógica existente encapsulada bajo la interfaz IMessagingProvider, mapeando los envíos directos a la API REST de yCloud.

## **Adaptador Zernio (ZernioAdapter)**

* Propósito: Manejar WhatsApp, pero especialmente canales sociales como Instagram DMs, comentarios de posts/reels y Facebook Messenger mediante una API unificada.  
* Webhooks: Validar la firma HMAC-SHA256 enviada por Zernio en las cabeceras HTTP usando el ZERNIO\_WEBHOOK\_SECRET configurado.

import Zernio from '@zernio/node';

export class ZernioAdapter implements IMessagingProvider {

  async sendMessage(account: ChannelAccount, message: OutboundMessage) {

    // Implementación usando el SDK de Zernio o llamadas REST HTTP

    return { messageId: 'zernio-msg-id', status: 'sent' };

  }

  parseInboundWebhook(headers: Record\<string, string\>, body: any) {

    return {

      eventType: body.event,

      senderId: body.data.sender.id,

      channelAccountId: body.data.accountId,

      text: body.data.message?.text || body.data.comment?.text,

      raw: body

    };

  }

}

## **Adaptador Kapso (KapsoAdapter)**

* Propósito: Gestión avanzada de infraestructura de WhatsApp, onboarding automatizado vía Embedded Signup y escalabilidad multi-inquilino (Tech Provider).  
* Onboarding del Cliente (Tech Provider): Permite generar enlaces dinámicos de onboarding donde el cliente final conecta su cuenta de Meta Business.  
* Gestión de Créditos/Línea de Crédito: Kapso se encarga de abonar a Meta el consumo del cliente unificando el saldo comercial.

export class KapsoAdapter implements IMessagingProvider {

  async sendMessage(account: ChannelAccount, message: OutboundMessage) {

    // Implementación utilizando el SDK/API de Kapso

    return { messageId: 'kapso-msg-id', status: 'sent' };

  }

  parseInboundWebhook(headers: Record\<string, string\>, body: any) {

    return {

      eventType: 'message.received',

      senderId: body.entry?.\[0\]?.changes?.\[0\]?.value?.messages?.\[0\]?.from,

      channelAccountId: body.entry?.\[0\]?.changes?.\[0\]?.value?.metadata?.phone\_number\_id,

      text: body.entry?.\[0\]?.changes?.\[0\]?.value?.messages?.\[0\]?.text?.body,

      raw: body

    };

  }

}

# **5\. Webhook Ingress & Normalización**

Para evitar múltiples endpoints dispares, se recomienda implementar un endpoint unificado de entrada de Webhooks:

`POST /api/v1/webhooks/ingress/:provider`

## **Flujo de Ingesta**

1. **Identificación del Proveedor:** Determina el adaptador leyendo `:provider` (`/ycloud`, `/zernio`, `/kapso`).  
2. **Validación de Firma:** Verifica la autenticidad de la petición con el secreto del proveedor correspondiente.  
3. **Mapeo al Bus Interno:** Transforma el payload nativo del proveedor a un evento estándar del sistema (`SystemInboundEvent`).  
4. **Despacho a Agentes/Workflows:** Envía el mensaje normalizado al motor de agentes IA o al sistema de tickets/inbox existente.

# **6\. Lógica de Enrutamiento (Channel Routing Strategy)**

El sistema elegirá automáticamente el proveedor adecuado según la siguiente matriz de reglas:

1. Si el canal solicitado es Instagram, Facebook u otra Red Social:  
   Redireccionar automáticamente hacia el adaptador de Zernio.  
2. Si el canal es WhatsApp:  
   * Opción A (Inquilino corporativo / Embedded Signup en el SaaS): Usar Kapso.  
   * Opción B (Números administrados o WABA previa propia): Usar yCloud.  
   * Opción C (Integración unificada Omnicanal con Inbox Zernio): Usar Zernio.

# **7\. Pasos de Ejecución Recomendados**

1. Crear el módulo messaging-core: Implementar las interfaces IMessagingProvider, ChannelAccount y los esquemas DTO de entrada/salida.  
2. Refactorizar el conector yCloud: Mover el código actual de yCloud a YCloudAdapter cumpliendo con la interfaz IMessagingProvider.  
3. Desplegar ZernioAdapter: Configurar autenticación con Zernio API Key, habilitar recepción de webhooks firmados (message.received, comment.received) y probar interacción con Instagram DMs/comentarios.  
4. Desplegar KapsoAdapter: Crear módulo para registrar clientes, generar setup links de Meta Embedded Signup y configurar escucha de webhooks para nuevos números.  
5. Configurar la Ingesta de Webhooks: Implementar la ruta /webhooks/ingress/:provider que procese, valide y redirija los eventos de cada proveedor hacia el bus principal del sistema.

