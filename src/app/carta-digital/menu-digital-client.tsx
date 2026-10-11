"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ArrowLeft, ArrowUpRight, Minus, Plus, Search, ShoppingBag } from "lucide-react";
import { CatalogImage } from "@/components/products/catalog-image";
import { CatalogDialog } from "@/components/storefront/catalog-dialog";
import { EditorialHeading, editorialEase, editorialSpring, useEditorialMotion } from "@/components/storefront/motion";
import { CheckoutForm } from "@/components/cart/checkout-form";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { cartKey, useCart } from "@/lib/cart/cart-context";
import { useBusiness } from "@/lib/hooks/use-business";

type Product = { id: number; name: string; price: string | null; promoPrice?: string | null; isPromo?: boolean; imageUrl: string | null; category: string; description: string | null; comingSoon?: boolean; stock?: number | null };
type Promo = { id: number; name: string; description: string | null; imageUrl: string | null; customPrice: string | null; items: { productId: number; productName: string; quantity: number }[] | null };
type Selection = { type: "product"; data: Product } | { type: "promo"; data: Promo };
const CATEGORIES = [
  { key: "promos", label: "Promociones" }, { key: "hamburguesa", label: "Hamburguesas" },
  { key: "acompanamiento", label: "Para acompañar" }, { key: "bebidas", label: "Bebidas" },
  { key: "alcohol", label: "Alcohol" }, { key: "empanadas", label: "Empanadas" },
  { key: "tragos_vip", label: "Tragos V.I.P." }, { key: "pan_mayorista", label: "Pan mayorista" },
];
// Legacy / marketing deep-link values mapped onto the canonical category keys.
const CATEGORY_ALIASES: Record<string, string> = {
  hamburguesas: "hamburguesa", hamburguesa: "hamburguesa", burgers: "hamburguesa",
  promo: "promos", promos: "promos", promociones: "promos",
  acompanamientos: "acompanamiento", acompanar: "acompanamiento", "para_acompanar": "acompanamiento",
  bebida: "bebidas", bebidas: "bebidas",
  empanada: "empanadas", empanadas: "empanadas",
  trago: "tragos_vip", tragos: "tragos_vip", vip: "tragos_vip",
  pan: "pan_mayorista", mayorista: "pan_mayorista", "pan_mayorista": "pan_mayorista",
  alcoholes: "alcohol", alcohol: "alcohol",
};
function canonicalCategory(value: string | null): string | null {
  if (!value) return null;
  const slug = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const canonical = CATEGORY_ALIASES[slug] ?? slug;
  return CATEGORIES.some(category => category.key === canonical) ? canonical : null;
}
const money = (value: number) => `$${value.toLocaleString("es-AR")}`;
const keyOf = (item: Selection) => `${item.type}-${item.data.id}`;
function priceOf(item: Selection) {
  const value = item.type === "promo" ? item.data.customPrice : item.data.isPromo && item.data.promoPrice != null ? item.data.promoPrice : item.data.price;
  const price = Number(value); return Number.isFinite(price) && price > 0 ? price : 0;
}
function available(item: Selection) { return priceOf(item) > 0 && (item.type === "promo" || (!item.data.comingSoon && item.data.stock !== 0)); }
function imageOf(item: Selection) { return item.type === "product" ? getCatalogProductImage(item.data) : item.data.imageUrl; }

function QuantityControl({ quantity, onAdd, onRemove, max = 99 }: { quantity: number; onAdd: () => void; onRemove: () => void; max?: number }) {
  const { reduced } = useEditorialMotion();
  return <motion.div layout={!reduced} className="menu-quantity-wrap">
    <AnimatePresence mode="wait" initial={false}>
      {quantity ? <motion.div key="stepper" className="menu-quantity" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .12 }}>
        <button type="button" onClick={onRemove} aria-label="Quitar una unidad"><Minus size={15} /></button>
        <motion.span key={quantity} initial={reduced ? false : { y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} aria-live="polite">{quantity}</motion.span>
        <button type="button" onClick={onAdd} disabled={quantity >= max} aria-label="Agregar una unidad"><Plus size={15} /></button>
      </motion.div> : <motion.button key="add" type="button" className="menu-add-button" onClick={onAdd} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .12 }}><Plus size={16} /> Agregar</motion.button>}
    </AnimatePresence>
  </motion.div>;
}

export function MenuDigitalClient({ products, promos }: { products: Product[]; promos: Promo[] }) {
  const { reduced, reveal } = useEditorialMotion();
  const business = useBusiness();
  const brandName = business?.name || "";
  const brandTagline = business?.tagline || "cocina propia";
  const searchParams = useSearchParams();
  // Derived straight from the URL so a deep link renders the right category on
  // the first paint (no post-mount flash) and stays shareable.
  const requestedCategory = useMemo(() => canonicalCategory(searchParams.get("category")), [searchParams]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Selection | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const { items: cartItems, addItem, removeItem, updateQuantity } = useCart();

  const selections = useMemo<Selection[]>(() => [...promos.map(data => ({ type: "promo" as const, data })), ...products.map(data => ({ type: "product" as const, data }))], [products, promos]);
  const categories = CATEGORIES.filter(c => c.key === "promos" ? promos.length : products.some(p => p.category === c.key));
  const fallbackCategory = promos.length ? "promos" : products[0]?.category ?? "hamburguesa";
  const activeCategory = selectedCategory ?? requestedCategory ?? fallbackCategory;

  // A deep link should land on its category, not the hero.
  useEffect(() => {
    if (!requestedCategory) return;
    const target = document.getElementById("carta");
    if (!target) return;
    const id = window.setTimeout(() => target.scrollIntoView({ block: "start" }), 120);
    return () => window.clearTimeout(id);
  }, [requestedCategory]);

  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visible = selections.filter(item => query.trim() ? normalize(`${item.data.name} ${item.data.description ?? ""}`).includes(normalize(query.trim())) : item.type === "promo" ? activeCategory === "promos" : item.data.category === activeCategory);
  const resolvedCart = useMemo(() => cartItems.flatMap(line => {
    const selected = selections.find(s => s.type === line.type && String(s.data.id) === line.product.id);
    return selected ? [{ selected, quantity: line.quantity }] : [];
  }), [cartItems, selections]);
  const hasUnavailable = resolvedCart.length !== cartItems.length || resolvedCart.some(item => !available(item.selected));
  const total = resolvedCart.reduce((sum, item) => sum + Math.round(priceOf(item.selected) * 100) * item.quantity, 0) / 100;
  const count = cartItems.reduce((sum, line) => sum + line.quantity, 0);
  const quantity = (item: Selection) => cartItems.find(line => line.type === item.type && line.product.id === String(item.data.id))?.quantity ?? 0;
  function updateItem(item: Selection, delta: number) {
    const current = quantity(item);
    const max = item.type === "product" ? Math.min(99, item.data.stock ?? 99) : 99;
    const key = cartKey(item.type, item.data.id);
    if (delta > 0) {
      if (!available(item) || current >= max) return;
      addItem({ id: String(item.data.id), name: item.data.name.trim(), price: priceOf(item) }, 1, { type: item.type, imageUrl: imageOf(item), toast: false });
    } else if (current > 1) {
      updateQuantity(key, current - 1);
    } else if (current === 1) {
      removeItem(key);
    }
  }
  const controls = (item: Selection) => available(item) ? <QuantityControl quantity={quantity(item)} onAdd={() => updateItem(item, 1)} onRemove={() => updateItem(item, -1)} max={item.type === "product" ? Math.min(99, item.data.stock ?? 99) : 99} /> : <span className="menu-unavailable">{item.type === "product" && item.data.comingSoon ? "Próximamente" : priceOf(item) ? "No disponible" : "Precio a consultar"}</span>;
  const heading = query.trim() ? "Tu búsqueda" : CATEGORIES.find(c => c.key === activeCategory)?.label ?? "La carta";
  const hero = products.find(p => p.category === "hamburguesa" && getCatalogProductImage(p)) ?? products.find(p => getCatalogProductImage(p));
  const checkoutLines = resolvedCart.filter(item => available(item.selected)).map(item => ({ type: item.selected.type, id: item.selected.data.id, quantity: item.quantity }));

  return <LayoutGroup id="digital-menu"><div className="digital-menu">
    <div className="paint-veil" aria-hidden="true" />
    <header className="digital-menu-header">
      <Link href="/" className="menu-back-link" aria-label="Volver al sitio principal"><ArrowLeft size={18} /><span>Inicio</span></Link>
      <Link href="/" className="menu-brand">{brandName}<small>{brandTagline}</small></Link>
      <button type="button" className="menu-cart-icon" onClick={() => setCartOpen(true)} aria-label={`Ver pedido, ${count} productos`}><ShoppingBag size={20} />{count > 0 && <b className="orb-chip">{count}</b>}</button>
    </header>
    <main>
      <section className={`digital-menu-hero ${hero ? "has-photo" : ""}`}>
        <div className="menu-hero-copy"><p className="menu-eyebrow">La carta / Hecho a nuestra manera</p>
          <h1><EditorialHeading>El gusto de</EditorialHeading><EditorialHeading><em>elegir bien.</em></EditorialHeading></h1>
          <motion.p variants={reveal} initial="hidden" animate="visible" className="menu-hero-description">Tu próxima favorita está acá. Elegí, armá tu pedido y coordinamos el resto por WhatsApp.</motion.p>
          <a href="#carta" className="menu-text-link">Explorá la carta <ArrowUpRight size={17} /></a>
        </div>
        {hero && <motion.figure className="menu-hero-photo" initial={reduced ? false : { opacity: 0, clipPath: "inset(12% 8% 12% 8%)" }} animate={{ opacity: 1, clipPath: "inset(0% 0% 0% 0%)" }} transition={{ duration: 1.1, ease: editorialEase }}>
          <CatalogImage src={getCatalogProductImage(hero)} alt={hero.name} eager sizes="(max-width: 760px) 90vw, 45vw" />
          <figcaption><span>De nuestra cocina</span><strong>{hero.name}</strong></figcaption>
        </motion.figure>}
      </section>
      <nav className="menu-category-nav" aria-label="Categorías de la carta" id="carta"><div>{categories.map((category, i) => <button type="button" key={category.key} style={{ "--i": i } as CSSProperties} aria-pressed={activeCategory === category.key && !query} onClick={(event) => { setSelectedCategory(category.key); setQuery(""); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "instant" : "smooth" }); }}>
        {category.label}{activeCategory === category.key && !query && <motion.span className="menu-category-indicator" layoutId="category-indicator" transition={reduced ? { duration: 0 } : editorialSpring} />}
      </button>)}</div></nav>
      <section className="menu-content">
        <div className="menu-section-heading"><div><p className="menu-eyebrow">Elegí tu momento</p><h2>{heading}</h2></div><label className="menu-search"><Search size={17} /><span className="sr-only">Buscar en toda la carta</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar en la carta" /></label></div>
        <p className="menu-results" role="status">{visible.length} {visible.length === 1 ? "opción" : "opciones"}</p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={query.trim() ? "search" : activeCategory} className="menu-grid" initial="hidden" animate="visible" exit={{ opacity: 0, y: reduced ? 0 : -8 }} variants={{ visible: { transition: { staggerChildren: reduced ? 0 : .055 } } }} transition={{ duration: reduced ? 0 : .16 }}>
            {visible.map(item => <motion.article key={keyOf(item)} className="menu-item-card" variants={reveal}>
              <button type="button" className="menu-item-preview" onClick={() => setDetail(item)} aria-label={`Ver ${item.data.name}`}><CatalogImage src={imageOf(item)} alt={item.data.name} /><span className="menu-preview-arrow"><ArrowUpRight size={20} /></span></button>
              <div className="menu-item-body"><div><h3><button type="button" onClick={() => setDetail(item)}>{item.data.name.trim()}</button></h3>{item.data.description && <p>{item.data.description}</p>}</div>
                {item.type === "promo" && item.data.items?.length ? <p className="menu-includes">{item.data.items.map(i => `${i.quantity}× ${i.productName}`).join(" · ")}</p> : null}
                <div className="menu-item-action"><strong>{priceOf(item) ? money(priceOf(item)) : "Consultar"}</strong>{controls(item)}</div>
              </div>
            </motion.article>)}
          </motion.div>
        </AnimatePresence>
        {!visible.length && <div className="menu-empty"><p>{query ? "No encontramos esa opción." : "Estamos preparando nuevas opciones."}</p>{query && <button className="menu-text-link" onClick={() => setQuery("")}>Volver a la carta</button>}</div>}
      </section>
      <footer className="menu-editorial-footer"><span>{brandName}</span><p>{brandTagline}</p><Link href="/">Conocé nuestros espacios <ArrowUpRight size={16} /></Link></footer>
    </main>
    <AnimatePresence>{count > 0 && <motion.button type="button" className="menu-floating-cart" onClick={() => setCartOpen(true)} initial={{ opacity: 0, y: reduced ? 0 : 80 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 80 }} transition={reduced ? { duration: 0 } : editorialSpring}><span><ShoppingBag size={19} />Tu pedido <b>{count}</b></span><strong>{money(total)}</strong><ArrowUpRight size={20} /></motion.button>}</AnimatePresence>
    <AnimatePresence>{detail && <CatalogDialog key="detail" title={detail.data.name} onDismiss={() => setDetail(null)} wide>
      <div className="menu-detail-layout"><div className="menu-detail-photo"><CatalogImage src={imageOf(detail)} alt={detail.data.name} contain sizes="(max-width: 760px) 100vw, 50vw" /></div><div className="menu-detail-content"><p className="menu-eyebrow">{detail.type === "promo" ? "Para compartir" : "De nuestra cocina"}</p><h2>{detail.data.name}</h2><p>{detail.data.description}</p>
        {detail.type === "promo" && <div className="menu-detail-includes">{detail.data.items?.map(i => <p key={i.productId}><span>{i.quantity}×</span> {i.productName}</p>)}</div>}
        <div className="menu-detail-footer"><strong>{priceOf(detail) ? money(priceOf(detail)) : "Consultar"}</strong>{controls(detail)}</div>
      </div></div>
    </CatalogDialog>}</AnimatePresence>
    <AnimatePresence>{cartOpen && <CatalogDialog key="cart" title="Tu pedido" onDismiss={() => setCartOpen(false)}>
      <div className="menu-cart-content"><p className="menu-eyebrow">Un buen momento empieza acá</p><h2>Tu pedido.</h2>
        {!count ? <div className="menu-empty"><ShoppingBag size={30} /><p>¿Qué te gustaría probar?</p><button className="menu-add-button" onClick={() => setCartOpen(false)}>Explorar la carta</button></div> : <>
          <div className="menu-cart-lines"><AnimatePresence initial={false}>{resolvedCart.map(({ selected, quantity: qty }) => <motion.div layout={!reduced} key={keyOf(selected)} className="menu-cart-line" exit={{ opacity: 0, height: 0, margin: 0, paddingTop: 0, paddingBottom: 0 }} transition={{ duration: reduced ? 0 : .2 }}><div className="menu-cart-thumb"><CatalogImage src={imageOf(selected)} alt={selected.data.name} sizes="64px" /></div><div className="menu-cart-line-copy"><h3>{selected.data.name}</h3><p>{money(priceOf(selected) * qty)}</p></div><QuantityControl quantity={qty} onAdd={() => updateItem(selected, 1)} onRemove={() => updateItem(selected, -1)} /></motion.div>)}</AnimatePresence></div>
          {hasUnavailable && <p role="alert" className="checkout-error">Hay productos que ya no están disponibles. <button type="button" onClick={() => resolvedCart.filter(item => !available(item.selected)).forEach(item => removeItem(cartKey(item.selected.type, item.selected.data.id)))}>Quitarlos del pedido</button></p>}
          <div className="menu-cart-total"><div><span>Subtotal</span><small>Envío a coordinar</small></div><motion.strong key={total} initial={reduced ? false : { opacity: .3, y: 8 }} animate={{ opacity: 1, y: 0 }}>{money(total)}</motion.strong></div>
          {!hasUnavailable && <CheckoutForm key={cartItems.map(line => `${cartKey(line.type, line.product.id)}:${line.quantity}`).join(",")} items={checkoutLines} />}
        </>}
      </div>
    </CatalogDialog>}</AnimatePresence>
  </div></LayoutGroup>;
}
