"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Minus, ShoppingBag, Save } from "lucide-react";
import { updateOrder, type OrderRow } from "./actions";

interface OrderEditModalProps {
  order: OrderRow;
  open: boolean;
  onClose: () => void;
}

interface ProductOption {
  id: number;
  name: string;
  price: string | null;
  category: string;
  available: boolean;
}

interface EditItem {
  name: string;
  quantity: number;
  price: number;
}

interface RawOrderItem {
  name?: string;
  quantity?: number;
  price?: number | string;
  unitPrice?: number | string;
}

export function OrderEditModal({ order, open, onClose }: OrderEditModalProps) {
  const [customerName, setCustomerName] = useState(order.customerName || "");
  const [phoneNumber, setPhoneNumber] = useState(order.phoneNumber || "");
  const [address, setAddress] = useState(order.address || "");
  const [notes, setNotes] = useState(order.notes || "");
  const [deliveryFee, setDeliveryFee] = useState(Number(order.deliveryFee) || 0);
  const [paymentStatus, setPaymentStatus] = useState(order.paymentStatus || "pending");
  const [items, setItems] = useState<EditItem[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // Reset del formulario al abrir o cambiar de pedido (ajuste de estado en render)
  const [prevOpenOrder, setPrevOpenOrder] = useState<{ open: boolean; order: OrderRow } | null>(null);
  if (open !== prevOpenOrder?.open || order !== prevOpenOrder.order) {
    setPrevOpenOrder({ open, order });
    if (open) {
      const currentItems = Array.isArray(order.items) ? order.items.map((i: RawOrderItem) => ({
        name: i.name || "",
        quantity: i.quantity || 1,
        price: Number(i.price ?? i.unitPrice ?? 0),
      })) : [];
      setItems(currentItems);
      setCustomerName(order.customerName || "");
      setPhoneNumber(order.phoneNumber || "");
      setAddress(order.address || "");
      setNotes(order.notes || "");
      setDeliveryFee(Number(order.deliveryFee) || 0);
      setPaymentStatus(order.paymentStatus || "pending");
      setDone(false);
    }
  }

  useEffect(() => {
    if (!open) return;

    // Cargar productos disponibles
    fetch("/api/products?available=true")
      .then((r) => r.json())
      .then(setProducts)
      .catch(() => {});
  }, [open, order]);

  const addItem = (product: ProductOption) => {
    const price = Number(product.price) || 0;
    setItems((prev) => {
      const ex = prev.find((i) => i.name === product.name);
      if (ex) return prev.map((i) => (i.name === product.name ? { ...i, quantity: i.quantity + 1 } : i));
      return [...prev, { name: product.name, quantity: 1, price }];
    });
  };

  const updateQty = (name: string, qty: number) => {
    if (qty < 1) return setItems((prev) => prev.filter((i) => i.name !== name));
    setItems((prev) => prev.map((i) => (i.name === name ? { ...i, quantity: qty } : i)));
  };

  const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0) * i.quantity, 0);
  const total = subtotal + deliveryFee;

  const handleSave = async () => {
    setSaving(true);
    await updateOrder(order.id, {
      customerName,
      phoneNumber,
      address: address || null,
      notes: notes || null,
      deliveryFee,
      paymentStatus,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, unitPrice: i.price })),
    });
    setSaving(false);
    setDone(true);
    setTimeout(() => { onClose(); setDone(false); }, 1200);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
            className="fixed z-50 inset-2 sm:inset-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[680px] md:max-h-[90vh] bg-card border border-border rounded-2xl flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <ShoppingBag className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Editar Pedido #{order.id}</span>
              </div>
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted text-muted-foreground"><X className="h-4 w-4" /></button>
            </div>

            {done ? (
              <div className="flex-1 flex items-center justify-center py-16"><p className="text-emerald-400 font-medium">✅ Pedido actualizado</p></div>
            ) : (
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {/* Cliente */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Nombre</label>
                    <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full mt-1 px-3 py-2.5 sm:py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Teléfono</label>
                    <input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)}
                      className="w-full mt-1 px-3 py-2.5 sm:py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground" />
                  </div>
                </div>

                {/* Productos disponibles (solo para agregar) */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Agregar producto</label>
                  <div className="flex flex-wrap gap-1.5 mt-1 max-h-28 overflow-y-auto">
                    {products
                      .filter(p => order.orderType !== "pan_mayorista" || p.category === "pan_mayorista")
                      .filter(p => order.orderType === "pan_mayorista" || p.category !== "pan_mayorista")
                      .map((p) => (
                        <button key={p.id} onClick={() => addItem(p)}
                          className="px-3 py-2 sm:px-2.5 sm:py-1.5 rounded-lg bg-muted/40 border border-border text-xs sm:text-[11px] text-foreground/80 hover:border-primary/30 hover:bg-primary/5 transition-colors">
                          {p.name} (${(Number(p.price) || 0).toLocaleString("es-AR")})
                        </button>
                      ))}
                  </div>
                </div>

                {/* Items actuales */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Items ({items.length})</label>
                  {items.length === 0 ? (
                    <p className="text-xs text-foreground/40 mt-2 italic">Seleccioná productos arriba</p>
                  ) : (
                    <div className="space-y-1.5 mt-1">
                      {items.map((item) => (
                        <div key={item.name} className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                          <span className="flex-1 text-xs text-foreground truncate">{item.name}</span>
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => updateQty(item.name, item.quantity - 1)} className="p-0.5 rounded hover:bg-muted text-muted-foreground"><Minus className="h-3 w-3" /></button>
                            <span className="text-xs text-foreground w-5 text-center">{item.quantity}</span>
                            <button onClick={() => updateQty(item.name, item.quantity + 1)} className="p-0.5 rounded hover:bg-muted text-muted-foreground"><Plus className="h-3 w-3" /></button>
                          </div>
                          <span className="text-xs text-muted-foreground w-16 text-right">${((Number(item.price) || 0) * item.quantity).toLocaleString("es-AR")}</span>
                          <button onClick={() => setItems((prev) => prev.filter((i) => i.name !== item.name))} className="p-0.5 rounded hover:bg-red-500/20 text-foreground/40 hover:text-red-400" aria-label="Quitar item"><X className="h-3 w-3" aria-hidden="true" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between py-2 border-t border-border">
                  <span className="text-xs text-muted-foreground">Subtotal</span>
                  <span className="text-sm font-bold text-foreground">${subtotal.toLocaleString("es-AR")}</span>
                </div>

                {/* Delivery + Payment */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Costo delivery</label>
                    <input type="number" min="0" value={deliveryFee} onChange={(e) => setDeliveryFee(Number(e.target.value) || 0)}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Estado de pago</label>
                    <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground">
                      <option value="pending">Pendiente</option>
                      <option value="paid">Pagado</option>
                    </select>
                  </div>
                </div>

                {/* Total */}
                <div className="flex items-center justify-between py-2 border-t border-border">
                  <span className="text-xs text-muted-foreground">Total</span>
                  <span className="text-sm font-bold text-primary">${total.toLocaleString("es-AR")}</span>
                </div>

                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Dirección</label>
                  <input value={address} onChange={(e) => setAddress(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Notas</label>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground" />
                </div>
              </div>
            )}

            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
              <button onClick={onClose} className="px-5 py-2.5 sm:px-4 sm:py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted">Cancelar</button>
              <button onClick={handleSave} disabled={saving || !customerName || !phoneNumber}
                className="flex items-center gap-1.5 px-6 py-2.5 sm:px-5 sm:py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-gold-bright disabled:opacity-40">
                <Save className="h-3 w-3" />
                {saving ? "Guardando..." : "Guardar cambios"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
