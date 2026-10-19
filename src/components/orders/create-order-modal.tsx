"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Minus, Trash2, ShoppingBag, Search, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { createManualOrder } from "@/app/(admin)/admin/orders/create-order-action";

interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

interface CreateOrderModalProps {
  open: boolean;
  onClose: () => void;
  clientName?: string;
  clientPhone?: string;
}

type ProductoDisponible = {
  id: number;
  name: string;
  price: string | null;
  category: string;
};

type PromoOption = {
  id: number;
  name: string;
  description: string;
  customPrice: string | null;
  imageUrl: string | null;
};

type LeadOption = {
  name: string;
  phone: string;
  status: string;
  hasOrders: boolean;
};

export function CreateOrderModal({ open, onClose, clientName, clientPhone }: CreateOrderModalProps) {
  const [customerName, setCustomerName] = useState(clientName || "");
  const [customerPhone, setCustomerPhone] = useState(clientPhone || "");
  const [orderType, setOrderType] = useState<"hamburguesas" | "pan_mayorista">("hamburguesas");
  const [items, setItems] = useState<OrderItem[]>([]);
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [deliveryFee, setDeliveryFee] = useState(0);
  const [products, setProducts] = useState<ProductoDisponible[]>([]);
  const [promos, setPromos] = useState<PromoOption[]>([]);
  const [selectedTab, setSelectedTab] = useState<"hamburguesas" | "pan_mayorista" | "promos">("hamburguesas");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [, setLoadingLeads] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Sincronizar nombre/teléfono cuando cambian las props (ajuste de estado en render)
  const [prevClient, setPrevClient] = useState<{ name?: string; phone?: string } | null>(null);
  if (prevClient === null || prevClient.name !== clientName || prevClient.phone !== clientPhone) {
    setPrevClient({ name: clientName, phone: clientPhone });
    setCustomerName(clientName || "");
    setCustomerPhone(clientPhone || "");
  }

  useEffect(() => {
    fetch("/api/products?available=true")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setProducts)
      .catch(() => toast.error("No se pudieron cargar los productos"));
    fetch("/api/promotions?active=true")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setPromos)
      .catch(() => toast.error("No se pudieron cargar las promos"));
  }, []);

  // Buscar leads con search term (server-side, sin limite de 100)
  const searchLeads = useCallback(async (term: string) => {
    setLoadingLeads(true);
    try {
      const url = term ? `/api/leads?search=${encodeURIComponent(term)}` : "/api/leads?limit=50";
      const res = await fetch(url);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.leads || []);
      setLeads(list.map((l: LeadOption & { totalOrders?: number }) => ({
        name: l.name || "Sin nombre",
        phone: l.phone || "",
        status: l.status || "new",
        hasOrders: (l.totalOrders || 0) > 0,
      })));
    } catch {
      // silent
    } finally {
      setLoadingLeads(false);
    }
  }, []);

  // Cargar leads al abrir
  useEffect(() => {
    if (!open) return;
    // Async: searchLeads actualiza estado de carga, no debe correr sincrónico en el efecto
    const t = window.setTimeout(() => searchLeads(""), 0);
    return () => window.clearTimeout(t);
  }, [open, searchLeads]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Reset del formulario al cerrar (ajuste de estado en render)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setItems([]);
      setAddress("");
      setNotes("");
      setDone(false);
      setOrderType("hamburguesas");
      setSearchTerm("");
    }
  }

  // Búsqueda con debounce (server-side)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchLeads(searchTerm);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchTerm, searchLeads]);

  const filteredLeads = leads;

  const selectClient = (lead: LeadOption) => {
    setCustomerName(lead.name);
    setCustomerPhone(lead.phone);
    setSearchTerm(lead.name);
    setShowDropdown(false);
  };

  const addItem = (name: string, price: string | null) => {
    // El precio viene como numeric del DB ("4500.50") — nunca strippear el
    // punto decimal: "4500.50" → 450050 rompía los totales.
    const p = price ? Number(price) : 0;
    const unitPrice = Number.isFinite(p) ? p : 0;
    setItems((prev) => {
      const ex = prev.find((i) => i.name === name);
      if (ex) return prev.map((i) => (i.name === name ? { ...i, quantity: i.quantity + 1 } : i));
      return [...prev, { name, quantity: 1, unitPrice }];
    });
  };

  const updateQty = (name: string, qty: number) => {
    if (qty < 1) {
      setItems((prev) => prev.filter((i) => i.name !== name));
      return;
    }
    setItems((prev) => prev.map((i) => (i.name === name ? { ...i, quantity: qty } : i)));
  };

  const removeItem = (name: string) => {
    setItems((prev) => prev.filter((i) => i.name !== name));
  };

  const total = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0) + deliveryFee;

  const handleSave = async () => {
    if (!customerName || items.length === 0) return;
    setSaving(true);
    const result = await createManualOrder({
      customerName,
      customerPhone,
      orderType,
      items,
      address: address || null,
      notes: notes || null,
      deliveryFee: deliveryFee || 0,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(result.error ?? "No se pudo crear el pedido");
      return;
    }
    setDone(true);
    setTimeout(() => { onClose(); setDone(false); }, 1500);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="fixed z-50 inset-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[640px] md:max-h-[90vh] bg-card border border-border rounded-2xl flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <ShoppingBag className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Nuevo Pedido</span>
              </div>
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {done ? (
              <div className="flex-1 flex items-center justify-center py-16">
                <p className="text-emerald-400 font-medium">✅ Pedido creado</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {/* Buscador de Clientes / Leads */}
                <div ref={searchRef} className="relative">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Cliente / Lead</label>
                  <div className="relative mt-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      value={searchTerm}
                      onChange={(e) => { setSearchTerm(e.target.value); setShowDropdown(true); }}
                      onFocus={() => setShowDropdown(true)}
                      placeholder="Buscá por nombre o teléfono..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40"
                    />
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground/40" />
                  </div>

                  {showDropdown && (
                    <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-xl">
                      {filteredLeads.length === 0 ? (
                        <p className="px-3 py-3 text-xs text-muted-foreground">Sin resultados</p>
                      ) : (
                        filteredLeads.map((lead) => (
                          <button
                            key={lead.phone}
                            onClick={() => selectClient(lead)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted transition-colors ${
                              customerPhone === lead.phone ? "bg-primary/10" : ""
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-medium text-foreground truncate block">
                                {lead.name}
                                {lead.hasOrders && <span className="ml-1.5 text-[10px] text-emerald-400">🟢 cliente</span>}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">{lead.phone}</span>
                            </div>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              lead.status === "new" ? "bg-blue-500/10 text-blue-300" :
                              lead.status === "contacted" ? "bg-amber-500/10 text-amber-300" :
                              lead.status === "converted" ? "bg-green-500/10 text-green-300" : "bg-muted text-muted-foreground"
                            }`}>
                              {lead.status}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Cliente seleccionado */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Nombre</label>
                    <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Teléfono</label>
                    <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
                  </div>
                </div>

                {/* Tabs: Hamburguesas | Pan Mayorista | Promos */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Productos / Promos</label>
                  <div className="flex gap-2 mt-1">
                    <button onClick={() => { setSelectedTab("hamburguesas"); setOrderType("hamburguesas"); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${selectedTab === "hamburguesas" ? "bg-primary/20 text-primary border border-primary/30" : "bg-muted/40 text-muted-foreground border border-border"}`}>
                      🍔 Hamburguesas
                    </button>
                    <button onClick={() => { setSelectedTab("pan_mayorista"); setOrderType("pan_mayorista"); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${selectedTab === "pan_mayorista" ? "bg-primary/20 text-primary border border-primary/30" : "bg-muted/40 text-muted-foreground border border-border"}`}>
                      🍞 Pan Mayorista
                    </button>
                    <button onClick={() => setSelectedTab("promos")}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${selectedTab === "promos" ? "bg-primary/20 text-primary border border-primary/30" : "bg-muted/40 text-muted-foreground border border-border"}`}>
                      🔥 Promos
                    </button>
                  </div>
                </div>

                {/* Contenido según tab */}
                <div>
                  {selectedTab === "promos" ? (
                    <div className="flex flex-col gap-2 mt-1 max-h-48 overflow-y-auto">
                      {promos.length === 0 ? (
                        <p className="text-xs text-foreground/40 italic mt-1">No hay promos activas</p>
                      ) : (
                        promos.map((promo) => (
                          <button
                            key={promo.id}
                            onClick={() => addItem(promo.name, promo.customPrice)}
                            className="flex items-start gap-3 w-full rounded-lg bg-muted/40 hover:bg-primary/5 border border-border hover:border-primary/30 px-3 py-2.5 text-left transition-colors"
                          >
                            {promo.imageUrl && (
                              // eslint-disable-next-line @next/next/no-img-element -- thumbnail de URL externa arbitraria; next/image requeriría remotePatterns y cambia el layout
                              <img src={promo.imageUrl} alt={promo.name}
                                className="w-12 h-12 rounded-lg object-cover shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-medium text-foreground block">{promo.name}</span>
                              {promo.description && (
                                <span className="text-[10px] text-muted-foreground block mt-0.5 line-clamp-2">{promo.description}</span>
                              )}
                            </div>
                            <span className="text-xs font-semibold text-primary shrink-0">
                              ${Number(promo.customPrice || 0).toLocaleString("es-AR")}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 mt-1 max-h-32 overflow-y-auto">
                      {products
                        .filter(p => selectedTab === "pan_mayorista" ? p.category === "pan_mayorista" : p.category !== "pan_mayorista")
                        .map((p) => (
                        <button key={p.id} onClick={() => addItem(p.name, p.price)}
                          className="px-2.5 py-1.5 rounded-lg bg-muted/40 border border-border text-[11px] text-foreground/80 hover:border-primary/30 hover:bg-primary/5 transition-colors">
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Items */}
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
                          <span className="text-xs text-muted-foreground w-16 text-right">${(item.quantity * item.unitPrice).toLocaleString("es-AR")}</span>
                          <button onClick={() => removeItem(item.name)} className="p-0.5 rounded hover:bg-red-500/20 text-foreground/40 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between py-2 border-t border-border">
                  <span className="text-xs text-muted-foreground">Total</span>
                  <span className="text-sm font-bold text-primary">${total.toLocaleString("es-AR")}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Dirección</label>
                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Opcional"
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Costo delivery</label>
                    <input type="number" min="0" value={deliveryFee || ""} onChange={(e) => setDeliveryFee(Number(e.target.value) || 0)} placeholder="0 = sin delivery"
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Notas</label>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional"
                    className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
                </div>
              </div>
            )}

            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors">Cancelar</button>
              <button onClick={handleSave} disabled={saving || !customerName || items.length === 0}
                className="px-5 py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-gold-bright transition-colors disabled:opacity-40">
                {saving ? "Creando..." : "Crear Pedido"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
