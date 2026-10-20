// ─── Exporta todas las tools del Agente Interno ───
// Arquitectura de tools maestras con sub-tools

import { queryOrderTools } from "./toolsQuery";
import { manageClientTools } from "./toolsClient";
import { manageProductTools } from "./toolsProduct";
import { manageOrderTools } from "./toolsOrder";
import { managementTools } from "./toolsManagement";
import { analyticsTools } from "./toolsAnalytics";
import { whatsAppTools } from "./toolsWhatsApp";
import { memoryTools } from "./toolsMemory";
import { cashTools } from "./toolsCash";
import { salesCoachTools } from "./toolsSalesCoach";
import {
  confirmActionTool,
  withAuditLog,
  withOperatorConfirmation,
} from "./tool-confirmations";

// ─── Tools Maestras (Delegantes) ───────────────────────────────────────
// Cada Tool Maestra es un grupo de sub-tools relacionadas

// queryOrder: Consultas de pedidos
export const queryOrder = {
  name: "queryOrder",
  description:
    "Grupo de herramientas para consultar pedidos. Incluye búsqueda por ID, estado, historial, fecha, y pedidos pendientes.",
  tools: queryOrderTools,
};

// manageClient: Gestión de clientes
export const manageClient = {
  name: "manageClient",
  description:
    "Grupo de herramientas para gestionar clientes. Crear, buscar, actualizar clientes y ver historial de pedidos.",
  tools: manageClientTools,
};

// manageProduct: Gestión de productos
export const manageProduct = {
  name: "manageProduct",
  description:
    "Grupo de herramientas para consultar productos. Listar, buscar, filtrar por categoría y verificar disponibilidad.",
  tools: manageProductTools,
};

// manageOrder: Gestión de pedidos
export const manageOrder = {
  name: "manageOrder",
  description:
    "Grupo de herramientas para crear y gestionar pedidos. Crear, agregar items, cambiar estado, cancelar y confirmar.",
  tools: manageOrderTools,
};

// manageManagement: Gestión interna (clientes, analytics, horarios)
export const manageManagement = {
  name: "manageManagement",
  description:
    "Grupo de herramientas de gestión interna. Listar clientes, buscar por nombre/teléfono/email, ver detalle, actualizar estado de pedidos, analytics por período y horarios de atención.",
  tools: managementTools,
};

// analytics: Métricas de negocio (ventas, top productos, top clientes, ticket promedio)
export const analytics = {
  name: "analytics",
  description:
    "Grupo de herramientas de analytics de negocio. Ventas por rango de fechas, productos más vendidos, mejores clientes, ticket promedio. Específico para rotisería.",
  tools: analyticsTools,
};

// ─── Export Completo: Todas las tools como un ToolSet ────────────────────
//
// F6 — postura de seguridad del toolset del operador:
// - Tools de alto impacto/irreversibles NO ejecutan directo: pasan por
//   withOperatorConfirmation → acción pendiente + token que solo
//   confirmAction efectiviza (estado server-side, no lenguaje natural).
// - El resto de las mutaciones quedan auditadas vía withAuditLog
//   (log estructurado sin PII — solo ids).
// - Reads (get*/search*/query*/calculate*/recall*/analyze*/propose*)
//   no se tocan.

export const internalAgentTools = {
  // confirmación de acciones pendientes (único camino para ejecutar
  // las tools gated de abajo)
  confirmAction: confirmActionTool,

  // queryOrder (~6 tools)
  getOrderById: queryOrderTools.getOrderById,
  getOrderStatus: queryOrderTools.getOrderStatus,
  getOrderHistory: queryOrderTools.getOrderHistory,
  searchOrdersByDate: queryOrderTools.searchOrdersByDate,
  getPendingOrders: queryOrderTools.getPendingOrders,
  getTodaysOrders: queryOrderTools.getTodaysOrders,

  // manageClient (~6 tools)
  getClientByPhone: manageClientTools.getClientByPhone,
  createClient: withAuditLog("createClient", manageClientTools.createClient),
  updateClient: withAuditLog("updateClient", manageClientTools.updateClient),
  getClientHistory: manageClientTools.getClientHistory,
  suggestProducts: manageClientTools.suggestProducts,
  setClientAlias: withAuditLog("setClientAlias", manageClientTools.setClientAlias),

  // manageProduct (~8 tools)
  getAllProducts: manageProductTools.getAllProducts,
  getProductsByCategory: manageProductTools.getProductsByCategory,
  getProductById: manageProductTools.getProductById,
  searchProducts: manageProductTools.searchProducts,
  getProductAvailability: manageProductTools.getProductAvailability,
  createProduct: withAuditLog("createProduct", manageProductTools.createProduct),
  updateProduct: withAuditLog("updateProduct", manageProductTools.updateProduct),
  deleteProduct: withAuditLog("deleteProduct", manageProductTools.deleteProduct),

  // manageOrder (~10 tools)
  createOrder: withAuditLog("createOrder", manageOrderTools.createOrder),
  addItemToOrder: withAuditLog("addItemToOrder", manageOrderTools.addItemToOrder),
  removeItemFromOrder: withAuditLog("removeItemFromOrder", manageOrderTools.removeItemFromOrder),
  updateOrderStatus: withAuditLog("updateOrderStatus", manageOrderTools.updateOrderStatus),
  updateOrder: withAuditLog("updateOrder", manageOrderTools.updateOrder),
  cancelOrder: withOperatorConfirmation("cancelOrder", manageOrderTools.cancelOrder),
  calculateTotal: manageOrderTools.calculateTotal,
  confirmOrder: withAuditLog("confirmOrder", manageOrderTools.confirmOrder),
  markAsPaid: withAuditLog("markAsPaid", manageOrderTools.markAsPaid),
  markPaymentMethod: withAuditLog("markPaymentMethod", manageOrderTools.markPaymentMethod),
  createDeliveredOrder: withAuditLog("createDeliveredOrder", manageOrderTools.createDeliveredOrder),

  // manageManagement (14 tools)
  getClients: managementTools.getClients,
  getClientDetail: managementTools.getClientDetail,
  searchClient: managementTools.searchClient,
  deleteLead: withOperatorConfirmation("deleteLead", managementTools.deleteLead),
  updateOrderStatusNew: withAuditLog("updateOrderStatusNew", managementTools.updateOrderStatusNew),
  getAnalytics: managementTools.getAnalytics,
  getBusinessHours: managementTools.getBusinessHours,
  updateBusinessHours: withAuditLog("updateBusinessHours", managementTools.updateBusinessHours),
  getConversations: managementTools.getConversations,
  updateAgentConfig: withAuditLog("updateAgentConfig", managementTools.updateAgentConfig),
  queryData: managementTools.queryData,
  getBusinessSummary: managementTools.getBusinessSummary,
  getConversationMessages: managementTools.getConversationMessages,
  getActivePromotions: managementTools.getActivePromotions,
  getCustomerFullProfile: managementTools.getCustomerFullProfile,
  getConversationContext: managementTools.getConversationContext,
  setHumanOverride: withAuditLog("setHumanOverride", managementTools.setHumanOverride),
  sendMessageAsOperator: withOperatorConfirmation(
    "sendMessageAsOperator",
    managementTools.sendMessageAsOperator,
  ),
  injectCustomerNote: withAuditLog("injectCustomerNote", managementTools.injectCustomerNote),

  // analytics (4 tools)
  getSalesByDateRange: analyticsTools.getSalesByDateRange,
  getTopProducts: analyticsTools.getTopProducts,
  getTopClients: analyticsTools.getTopClients,
  getAverageTicket: analyticsTools.getAverageTicket,

  // whatsApp (2 tools) — envío a clientes: gated; dryRun de broadcast pasa directo
  sendWhatsAppMessage: withOperatorConfirmation(
    "sendWhatsAppMessage",
    whatsAppTools.sendWhatsAppMessage,
  ),
  broadcastWhatsApp: withOperatorConfirmation(
    "broadcastWhatsApp",
    whatsAppTools.broadcastWhatsApp,
    { skip: (args) => args.dryRun === true },
  ),

  // memory + reconcile (5 tools)
  rememberThis: withAuditLog("rememberThis", memoryTools.rememberThis),
  forgetThis: withAuditLog("forgetThis", memoryTools.forgetThis),
  recallMemories: memoryTools.recallMemories,
  getReconcileCandidates: memoryTools.getReconcileCandidates,
  resolveReconcileCandidate: withAuditLog(
    "resolveReconcileCandidate",
    memoryTools.resolveReconcileCandidate,
  ),

  // cash (5 tools) — mutaciones auditadas; el cierre queda gated (financiero)
  ...cashTools,
  openCash: withAuditLog("openCash", cashTools.openCash),
  registerCashMovement: withAuditLog("registerCashMovement", cashTools.registerCashMovement),
  updateCashMovement: withAuditLog("updateCashMovement", cashTools.updateCashMovement),
  deleteCashMovement: withAuditLog("deleteCashMovement", cashTools.deleteCashMovement),
  closeCash: withOperatorConfirmation("closeCash", cashTools.closeCash),
  correctCashSession: withAuditLog("correctCashSession", cashTools.correctCashSession),

  // sales coach: loop de aprendizaje operador → agente (3 tools)
  ...salesCoachTools,
  applySalesGuidance: withAuditLog("applySalesGuidance", salesCoachTools.applySalesGuidance),
};

// whatsApp: Comunicación por WhatsApp
export const whatsApp = {
  name: "whatsApp",
  description:
    "Grupo de herramientas para enviar mensajes de WhatsApp a clientes.",
  tools: whatsAppTools,
};

// Total real: Object.keys(internalAgentTools).length (ver log de boot)
export const toolGroups = {
  queryOrder,
  manageClient,
  manageProduct,
  manageOrder,
  manageManagement,
  analytics,
  whatsApp,
};

console.log(
  "[internal-agent] Loaded with",
  Object.keys(internalAgentTools).length,
  "tools"
);