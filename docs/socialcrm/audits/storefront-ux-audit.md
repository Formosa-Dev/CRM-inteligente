# Storefront & public-surface UX audit

Read-only audit of the public surface at `e053580`. No source files were modified.
Scope: `src/app/(storefront)/**`, `src/app/carta-digital/**`, `src/app/promo/**`,
`src/components/cart/**`, checkout UX, storefront components, public metadata and
`src/app/api/checkout`.

Method: traced the cart/checkout state machine end-to-end (add → persist → reprice →
reserve stock → insert → WhatsApp handoff), compared rendered copy with the data
sources, and checked public metadata, a11y and responsive rules against `DESIGN.MD`.
Leftover restaurant copy is inventoried separately as known/deferred de-branding work,
not counted as bugs.

Severity: `critical` = core flow impossible · `high` = wrong behavior users hit in a
normal session · `medium` = real defect with a narrower trigger or a workaround ·
`low` = cosmetic, copy, or best-practice gap.

---

## Findings

### F1 — Orphaned cart lines dead-end the cart on `/carta-digital` — `critical`

- **Area:** cart / recovery path
- **Location:** `src/app/carta-digital/menu-digital-client.tsx:98-102`, `:198-201`;
  `src/lib/cart/cart-context.tsx:74-100`
- **Symptom:** If a product is archived (`available = false`) or a promo is deactivated
  after it was added to the cart, the floating cart shows `Tu pedido 1` with a total of
  `$0`, the cart dialog shows "Hay productos que ya no están disponibles", and there is
  no way to remove the orphaned line or proceed to checkout. The page has no navbar
  cart drawer, so the only recovery is manually clearing `localStorage`.
- **Evidence:** `resolvedCart` is built only from the current `selections`
  (`:98-101`); the mismatch sets `hasUnavailable` (`:102`) which hides the form
  (`:201`). The cart lines render `resolvedCart` only (`:198`), so the orphan is not
  displayed. The "Quitarlos del pedido" handler iterates `resolvedCart` (`:199`), so it
  cannot remove a line that is missing from `resolvedCart`. `clearCart` is not
  destructured from `useCart` (`:79`). The floating button counts `cartItems` (`:104`)
  but totals `resolvedCart` (`:103`).
- **Fix direction:** Reconcile by key (`cartKey`) against `cartItems`; remove
  `cartItems` not present in `resolvedCart` (or render them as unavailable rows with a
  remove action); expose "Vaciar carrito" in this dialog; optionally reconcile the cart
  on load against `/api/products` + `/api/promotions`.

### F2 — Add/remove toasts never render on the public surface — `high`

- **Area:** feedback
- **Location:** `src/app/layout.tsx:58-60`, `src/app/(storefront)/layout.tsx:14-21`,
  `src/lib/cart/cart-context.tsx:148-151`, `:159-162`,
  `src/app/(admin)/layout.tsx:29`
- **Symptom:** Tapping "Agregar" on a landing card, promo card, product detail, or
  removing/clearing from the cart produces no visible confirmation. The cart updates
  silently, which is easy to miss on a long storefront page.
- **Evidence:** `CartProvider` calls `toast(...)` on add/remove, but the only
  `<Toaster>` in the repo is mounted in the admin layout. The root and storefront
  layouts mount `MetaPixelProvider`/`CartProvider` only. `DESIGN.MD:245` states the
  toaster is mounted at root; the code no longer matches.
- **Fix direction:** Mount `<Toaster richColors position="top-center" />` in the root
  layout (or the storefront layout) so both `(storefront)` and `/carta-digital` get
  feedback; keep the admin override if needed.

### F3 — The cart is an unvalidated price snapshot; catalog changes surface only at checkout — `high`

- **Area:** pricing / state
- **Location:** `src/lib/cart/cart-context.tsx:134-146`, `:189-192`;
  `src/components/cart/cart-drawer.tsx:90-92`, `:144-148`, `:169`;
  `src/lib/checkout/contract.ts:54-70`; `src/lib/checkout/service.ts:51-53`
- **Symptom:** The drawer on marketing pages shows the price captured when the item was
  added. If admin changes the price, the customer confirms a total that differs from
  the stored order total (the server re-prices from the live catalog). Deleted or
  unavailable products remain listed and pass through to the API, where they fail only
  after the customer presses "Confirmar". The same cart can also show a different total
  on `/carta-digital` (which re-prices from the current catalog) than in the home drawer.
- **Evidence:** `addItem` persists `product.price`; `total` sums the stored price.
  `submitCheckout` calls `priceCheckout` against fresh `listProducts()`/`listPromos()`
  and inserts the re-priced items. `/carta-digital` computes its total from the current
  `selections` (`menu-digital-client.tsx:103`), so the two surfaces disagree.
- **Fix direction:** Re-fetch the catalog when the drawer opens and before submit,
  compare stored vs current price/availability, and show a "precios actualizados" delta
  before confirming. Do not let a stale cart reach `/api/checkout` unreviewed.

### F4 — Sold-out / unavailable rejections are shown as "may already be registered" — `high`

- **Area:** checkout error handling
- **Location:** `src/lib/checkout/service.ts:5`, `:54`, `:68`;
  `src/lib/checkout/contract.ts:54`, `:59`, `:75`;
  `src/components/cart/checkout-outcome.ts:15-21`, `:42-43`;
  `src/components/cart/checkout-form.tsx:107`
- **Symptom:** A product that sold out, was archived, or whose promo component ran out
  makes the server return `CheckoutError` with the default 409. The client maps 409 to
  `ambiguous` and renders "…no tiene disponibilidad… Verificá el estado del pedido antes
  de volver a confirmar." The customer is told an order may exist and should not retry,
  even though nothing was created, and is not told how to fix the cart.
- **Evidence:** `CheckoutError` defaults to `status = 409`; `priceCheckout` throws on
  empty/inactive entries and stock; the conditional stock decrement also throws 409.
  `interpretCheckoutOutcome` puts every non-400/413/415/429 status in `ambiguous`, and
  `checkoutFailureMessage` appends `VERIFY_STATUS_HINT`.   `checkout-ux.test.ts:121-133`
  codifies 409 as ambiguous, so the regression is intentional in the test.
- **Fix direction:** Use a distinct status/code for catalog conflicts (e.g. 409 with
  `code: "catalog_changed"` or a 422), classify it as `rejected`, keep the cart editable,
  and show "Actualizá tu carrito" instead of the verify-order warning. Reserve 409/5xx
  ambiguity for the idempotency/replay path.

### F5 — Changing a quantity wipes the checkout form — `medium`

- **Area:** checkout UX / state
- **Location:** `src/components/cart/cart-drawer.tsx:169`;
  `src/app/carta-digital/menu-digital-client.tsx:201`
- **Symptom:** A customer types name, phone and address, then adjusts a quantity; the
  entire `CheckoutForm` unmounts and the fields reset to empty.
- **Evidence:** Both call sites key the form with a string that includes every line's
  quantity. Any `updateQuantity` changes the key, remounting the component and losing
  `useState` values.
- **Fix direction:** Key on line identity only (`type:id`), or keep the form mounted and
  reset the stored attempt inside `CheckoutForm` when the item signature changes.

### F6 — The success confirmation is unmounted before it can render — `medium`

- **Area:** checkout success state
- **Location:** `src/components/cart/checkout-form.tsx:110-119`;
  `src/components/cart/cart-drawer.tsx:63-70`;
  `src/app/carta-digital/menu-digital-client.tsx:197`
- **Symptom:** The "Pedido #N registrado" screen is effectively unreachable. On success
  `clearCart()` empties the parent's items, both parents switch to their empty-cart
  branch and unmount `CheckoutForm`, disposing `receipt` before it paints. If the
  `wa.me` navigation is blocked (in-app browser, policy, missing URL), the customer is
  left on an empty cart with no order number or confirmation link.
- **Evidence:** `clearCart()` runs before `setReceipt(...)`; `CartDrawer` renders the
  empty state when `items.length === 0`; the carta dialog renders its empty state when
  `count === 0`. Only the automatic `window.location.assign` normally hides this.
- **Fix direction:** Lift the completed order to the provider/dialog, render the
  confirmation outside the cart contents, or clear the cart after the redirect has
  started and keep an order-success surface as the fallback.

### F7 — Cart-add controls ignore stock and promo component availability — `medium`

- **Area:** availability / cart
- **Location:** `src/components/home/landing-product-card.tsx:48-62`;
  `src/components/home/promos-section.tsx:30-36`;
  `src/app/carta-digital/menu-digital-client.tsx:50`, `:108-112`
- **Symptom:** Landing cards only check `stock !== 0`, so repeated taps can add more than
  the remaining stock. Promos are addable whenever they have a positive price, even if
  their component products are archived or out of stock. The failure appears only at
  checkout (and is then mislabeled per F4).
- **Evidence:** `canOrder` uses `stock !== 0`; `addItem` is unconditional. In the carta,
  `available(promo)` ignores promo components, while the server checks every component
  in `priceCheckout` (`contract.ts:63-76`).
- **Fix direction:** Derive a max quantity from `stock` on every add control and disable
  promos whose components are unavailable; return component availability from the public
  promotions payload so the client can enforce it before checkout.

### F8 — `pan-mayorista` has no loading, error, empty or retry state — `medium`

- **Area:** data fetching / empty states
- **Location:** `src/app/(storefront)/pan-mayorista/page.tsx:70-86`, `:190-235`;
  `src/components/home/landing-menu.tsx:137-150`, `:237-249`
- **Symptom:** While the request is in flight and after it fails, the "Nuestras
  Variedades" section renders an empty grid with no message. A failed fetch is
  indistinguishable from a business with no bread products, and there is no retry. The
  landing menu has the same failure mode but labels it "Estamos actualizando la carta",
  which is also shown for network/API errors.
- **Evidence:** `pan-mayorista` initializes `products` to `[]`, keeps `loading` in a
  state that is never read, and only `console.error`s on failure. `landing-menu` maps
  any rejected fetch to `[]` and renders the "updating" copy.
- **Fix direction:** Add skeleton, error and empty branches with a retry action; keep
  "updating the menu" for a genuinely empty catalog, not for transport failures.

### F9 — The marketing navbar overflows at tablet widths — `medium`

- **Area:** responsive
- **Location:** `src/components/layout/navbar.tsx:21-30`, `:68-69`, `:83-97`, `:101`
- **Symptom:** At `md` (768px) the eight desktop links appear, while the compact "Pedir
  ahora" link only appears at `lg`. Logo + eight links + cart exceed the available width;
  there is no wrap, scroll container or breakpoint fallback, so links wrap/clip and can
  push the cart control out of the header.
- **Evidence:** `nav` is `hidden md:flex` with `gap-1` and non-wrapping `Link`s; the CTA
  is `hidden lg:inline-flex`. No `overflow-x-auto`/`flex-wrap` is defined on the desktop
  nav.
- **Fix direction:** Show the mobile menu until `xl`, drop low-priority links into an
  overflow menu, or make the link strip horizontally scrollable.

### F10 — Public SEO metadata is incomplete; no OpenGraph or per-page titles — `medium`

- **Area:** SEO / sharing
- **Location:** `src/app/layout.tsx:34-45`; `src/app/carta-digital/page.tsx:7-10`;
  `src/app/(storefront)/pan-mayorista/page.tsx:1`;
  `src/app/(storefront)/hamburguesas/[id]/page.tsx:1`;
  `src/app/(storefront)/pan-mayorista/[id]/page.tsx:1`;
  `src/app/(storefront)/promo/[slug]/page.tsx:48-67`
- **Symptom:** Every page except `/carta-digital` inherits the business-name title. There
  is no `openGraph`, `twitter`, `alternates.canonical`, `metadataBase`, or `og:image`,
  so WhatsApp/Meta shares have no preview image and product/promo links have no
  page-specific title. Product and market pages are client components that cannot export
  metadata; the server-rendered promo page defines none.
- **Evidence:** Root `generateMetadata` returns only `title` and `description`; the four
  storefront pages listed start with `"use client"` (or have no `generateMetadata`).
  `carta-digital` also provides only title/description.
- **Fix direction:** Add `metadataBase` and default `openGraph`/`twitter` to the root;
  add server-side `generateMetadata` (data fetched by id/slug) for product and promo
  routes with title, description, canonical and image; use a branded OG fallback.

### F11 — No robots/sitemap; login and setup are indexable — `medium`

- **Area:** SEO / indexing
- **Location:** `src/app/login/page.tsx:7-9`; `src/app/setup/page.tsx:8-10`; no
  `src/app/robots.ts` or `src/app/sitemap.ts`
- **Symptom:** Crawlers can index `/login` and the first-access `/setup` screen, and there
  is no sitemap or crawl policy for the storefront. Admin pages are auth-gated but the
  entry routes are not marked `noindex`.
- **Evidence:** Both pages export only a `title`; the app directory contains no
  `robots.ts`, `robots.txt`, or `sitemap.ts` (checked `src/app` and `public`).
- **Fix direction:** Add `robots.ts` disallowing `/admin`, `/api`, `/login`, `/setup` and
  a public sitemap; add `robots: { index: false }` to login/setup metadata.

### F12 — Small captions fail WCAG AA contrast — `medium`

- **Area:** a11y / color
- **Location:** `src/app/(storefront)/promo/[slug]/promo-page-client.tsx:94`;
  `src/components/home/delivery-cta.tsx:135`;
  `src/components/layout/footer.tsx:80`, `:83`;
  `src/components/home/promos-section.tsx:102`
- **Symptom:** Small text at `text-foreground/35`, `/40` and `/45` is hard to read on the
  near-black background.
- **Evidence:** Blending `#f5f5f5` over `#0a0a0a`: `/35` ≈ 2.96:1, `/40` ≈ 3.55:1,
  `/45` ≈ 4.24:1. AA requires 4.5:1 for normal text; `DESIGN.MD:273-274` only documents
  `#888` as secondary and does not sanction these alpha steps.
- **Fix direction:** Raise small text to `text-foreground/50` or higher (≥5:1), or use a
  dedicated muted token; reserve sub-AA values for decorative marks only.

### F13 — Several public touch targets are below 44px — `medium`

- **Area:** a11y / responsive
- **Location:** `src/components/layout/navbar.tsx:104-109`, `:129-132`;
  `src/components/home/landing-product-card.tsx:103-110`;
  `src/components/ui/sheet.tsx:65-76`; `src/app/globals.css:724`
- **Symptom:** The navbar cart button is ~36px, the mobile menu trigger ~38px, the
  landing "Agregar" button ~31px tall, the sheet close button 28px, and the mobile cart
  line steppers are 32px wide.
- **Evidence:** `p-2` + 20px icon, `p-2` + 22px icon, `px-3 py-2 text-[11px]`,
  `size="icon-sm"` (`size-7`), and the `@media(max-width:760px)` rule
  `.menu-cart-line .menu-quantity button{width:32px}`. `DESIGN.MD:187,272` promises
  ≥44px in storefront controls.
- **Fix direction:** Enforce `min-height/min-width: 44px` on these controls (or use the
  existing `size-11` mobile override consistently).

### F14 — Mixed English in Spanish-first UI — `low`

- **Area:** copy / i18n
- **Location:** `src/components/cart/cart-drawer.tsx:55-58`;
  `src/components/ui/sheet.tsx:73`
- **Symptom:** The cart header reads "(1 item / 2 items)" and the cart sheet's close
  control announces "Close" to screen readers.
- **Evidence:** Hardcoded `"item"`/`"items"` and `sr-only` `Close`; the rest of the public
  surface is es-AR.
- **Fix direction:** Use `producto/productos` and `Cerrar`.

### F15 — Cart stepper labels are attached to the SVG, not the button — `low`

- **Area:** a11y
- **Location:** `src/components/cart/cart-drawer.tsx:96-118`
- **Symptom:** The `+`/`-` icon-only buttons may have no reliable accessible name,
  depending on how the SVG is exposed.
- **Evidence:** `aria-label` is on the lucide `<Minus>`/`<Plus>` elements; the `<Button>`
  itself has no label. The carta steppers correctly put `aria-label` on the `<button>`
  (`menu-digital-client.tsx:58,60`), showing the intended pattern.
- **Fix direction:** Move `aria-label` to the `Button` and mark the icon `aria-hidden`.

### F16 — Definite failures are reported as "may have been registered" — `low`

- **Area:** checkout error handling
- **Location:** `src/components/cart/checkout-form.tsx:120-123`;
  `src/components/cart/checkout-outcome.ts:15-20`, `:28-33`;
  `src/lib/checkout/service.ts:42`
- **Symptom:** A pre-flight rejection (403 origin), a missing WhatsApp destination (503
  from `service.ts:42`), or an offline `fetch` all render the ambiguous message telling
  the customer not to retry and to check WhatsApp. None of these can have created an
  order, so the sale can stall unnecessarily.
- **Evidence:** The catch block always uses `"ambiguous"`; only 400/413/415/429 are
  `rejected`, and 403/503 fall through to ambiguous. The destination check runs before
  pricing/insert.
- **Fix direction:** Detect offline before submitting and say "sin conexión, reintentá";
  classify 403 as rejected; give the destination-not-configured 503 a distinct
  "consultá por WhatsApp" message with the business number.

### F17 — Business hours are hardcoded, not sourced from config — `low`

- **Area:** copy / data source
- **Location:** `src/components/home/delivery-cta.tsx:133-137`
- **Symptom:** The home page promises "Lunes a Sábado · 10:00 a 22:00" regardless of the
  configured business. A self-hosted installation with different hours shows false
  information.
- **Evidence:** The string is literal; `BusinessInfo` (`src/lib/business.ts:6-16`) has no
  hours field, so nothing can override it.
- **Fix direction:** Add hours to `BusinessInfo`/`agent_config` and render the configured
  value, or remove the line.

### F18 — Seller badge shows a hardcoded 5.0 rating — `medium`

- **Area:** trust copy
- **Location:** `src/components/ui/seller-badge.tsx:21-30`
- **Symptom:** The pan-mayorista hero displays "5.0" and five filled stars for every
  installation, with no reviews behind it. This is a false claim on a self-hosted product.
- **Evidence:** Literal `5.0` and `Array.from({ length: 5 })`; no data source or review
  model is involved.
- **Fix direction:** Remove the rating, source it from real reviews, or hide it when no
  rating data exists.

### F19 — No Spanish 404/error surface — `low`

- **Area:** error UX / i18n
- **Location:** `src/app/(storefront)/promo/[slug]/page.tsx:50-51`; no
  `src/app/not-found.tsx` or storefront `error.tsx`
- **Symptom:** An unknown promo slug (or any unmatched public URL) renders Next's default
  English "404 — This page could not be found", outside the storefront chrome.
- **Evidence:** `notFound()` has no custom boundary; the app directory has no
  `not-found.tsx` (only the admin `loading.tsx` exists).
- **Fix direction:** Add a branded `not-found.tsx` (es-AR copy, link back to the carta)
  and a storefront `error.tsx` with retry.

### F20 — Navbar category links never show an active state — `low`

- **Area:** navigation state
- **Location:** `src/components/layout/navbar.tsx:84-96`, `:153-165`
- **Symptom:** On pages where the navbar renders, the five `/carta-digital?category=…`
  links are never highlighted; only plain-path links can match.
- **Evidence:** The active check is `pathname === link.href`; `usePathname()` excludes the
  query string, so a link with `?category=…` can never equal it.
- **Fix direction:** Compare `pathname` plus the `category` search param (or use
  `aria-current` derived from the parsed URL).

### F21 — Product detail routes ignore category and duplicate content — `low`

- **Area:** routing / SEO
- **Location:** `src/app/(storefront)/hamburguesas/[id]/page.tsx:37-41`, `:68`;
  `src/app/(storefront)/pan-mayorista/[id]/page.tsx:37-42`, `:69`
- **Symptom:** `/hamburguesas/{id}` renders any product (including bread), tags it with a
  burger emoji, and creates a second URL for the same product already served at
  `/pan-mayorista/{id}`. With no canonical (F10), crawlers see duplicates.
- **Evidence:** Both routes fetch `/api/products`; the hamburguesas route does not filter
  by category, while the pan route does. Neither defines metadata or canonical.
- **Fix direction:** Gate each detail route on its category (404 or redirect otherwise),
  derive the emoji/type from data, and add canonicals.

### F22 — Repeated "Agregar" buttons lack product context for assistive tech — `low`

- **Area:** a11y
- **Location:** `src/components/home/landing-product-card.tsx:103-110`;
  `src/components/home/promos-section.tsx:120-127`
- **Symptom:** A screen-reader user hears many identical "Agregar" buttons with no way to
  tell which product they belong to.
- **Evidence:** Buttons render only the word `Agregar` plus a decorative icon; the
  enclosing card has the product name but no `aria-labelledby` relationship.
- **Fix direction:** Add `aria-label={`Agregar ${product.name}`}` (same for promos).

---

## DEBRANDING-INVENTORY (known/deferred — not counted as bugs)

Hardcoded restaurant/Muzzarella copy and assets still present on the generic product
surface. Grouped by file, with the strings/lines to replace in the P2 de-branding phase.

- `src/app/(storefront)/page.tsx:17-30` — marquee items ("Hamburguesas artesanales",
  "Pan de elaboración propia") and stats ("6+ Variedades de hamburguesa", "Pan
  Artesanal propio").
- `src/app/(storefront)/page.tsx:83-90` — "Más que una hamburguesa", own-bread paragraph
  and "proveemos pan artesanal a restaurantes…".
- `src/components/home/landing-hero.tsx:34` — badge "Hamburguesas Artesanales Premium";
  `:63` fallback tagline about "cada mordida".
- `src/components/home/bread-showcase.tsx:10-13` — "Pan de muzzarella artesanal",
  semillas/brioche features; `:60` "restaurantes, rotiserías…"; `:100-150` pan-mayorista
  image assets.
- `src/components/home/landing-menu.tsx:33-91` — fixed `CATEGORY_SECTIONS` for
  hamburguesa, pizzas, empanadas, pan_mayorista, tragos_vip and alcohol, plus section
  copy.
- `src/components/home/landing-product-card.tsx:22-30` — `CATEGORY_EMOJI` map
  (burger/fries/dumpling/drink/bread/cocktail/beer).
- `src/components/layout/navbar.tsx:24-29` — nav labels Hamburguesas, Pizzas,
  Empanadas, Alcohol, Tragos VIP, Pan Mayorista.
- `src/app/carta-digital/menu-digital-client.tsx:19-25` — fixed `CATEGORIES`
  (Promociones, Hamburguesas, Pizzas, Empanadas, Para acompañar, Bebidas, Alcohol,
  Tragos V.I.P., Pan mayorista).
- `src/app/(storefront)/pan-mayorista/page.tsx:93` — `/assets/images/pan-muzzarella.jpeg`;
  `:45-62` premium/bulk/delivery/direct-relationship benefits; `:98-115` wholesale bread
  hero and copy.
- `src/app/(storefront)/promo/[slug]/page.tsx:14-46` — `CAMPAIGN_META` for
  hamburguesas, mayorista, promo-muzza, 2x1-empanadas.
- `src/app/(storefront)/promo/[slug]/promo-page-client.tsx:30-34` — food trust items
  (calidad artesanal, sin conservantes).
- `src/lib/constants.ts:8-31` — `CAMPAIGNS` (hamburguesas, mayorista, promo-muzza,
  2x1-empanadas); `:38-41` WhatsApp messages; `:57-82` `LINEA_CARNE`; `:84-99` burger
  image maps; `:109-126` `BREAD_PRODUCTS`.
- `src/components/home/client-gallery.tsx:8-30` — burger/photo gallery and alt text.
- `src/components/ui/seller-badge.tsx:11` — burger emoji avatar.
- `src/app/(storefront)/hamburguesas/[id]/page.tsx:68` — burger emoji passed to the cart;
  the `/hamburguesas` route itself is food-specific.
- `src/app/(storefront)/pan-mayorista/[id]/page.tsx:69` — bread emoji passed to the cart.
- `src/app/(storefront)/hamburguesas/page.tsx:6` and
  `src/app/(storefront)/tragos-vip/page.tsx:6` — food-specific redirect aliases.
- `src/lib/checkout/contract.ts:42`, `:74`, `:82` — `burgersUnavailable` and
  `hamburguesas`/`pan_mayorista` order types embedded in generic checkout pricing;
  `src/lib/checkout/store.ts:19`, `:28`, `:77-79` — `hamburguesasSinStock` config.
- `src/lib/catalog-images.ts:18-19` plus `src/lib/constants.ts` — bundled burger/bread
  image fallbacks keyed by food names.
- Unused storefront components carrying brand copy (not currently rendered):
  `src/components/hero/hero-section.tsx:34-58`,
  `src/components/products/featured-products-section.tsx:76-82`,
  `src/components/products/product-card.tsx`, `src/components/home/empanadas-showcase.tsx`,
  `src/components/products/upsell-modal.tsx:24-28`.

---

## Checked and OK

- Checkout double-submit and idempotency: `inFlight`/`completed` refs, a stable
  requestId per semantic signature, conditional insert and replay fingerprint checks.
- Cart persistence is hydration-safe, validates `localStorage` with Zod, purges the
  legacy per-menu key, and persists `clearCart` synchronously.
- Empty-cart states exist in both the drawer and the carta dialog; zero-quantity removal
  is handled.
- Dialog/sheet semantics: native `<dialog>` focus containment, Escape/backdrop dismiss,
  Base UI sheet, focus-visible rings in the editorial/checkout scopes.
- Reduced-motion: `MotionConfig reducedMotion="user"` on the storefront, explicit
  `useReducedMotion` branches, and keyframe coverage in `globals.css`.
- Currency uses `toLocaleString("es-AR")` and prices use `tabular-nums`; no public date
  formatting is rendered.
- Product images have alt text plus a broken-image fallback; WhatsApp CTAs/FAB hide when
  no business number is configured.
- Delivery address validation is mirrored client/server; the fulfillment radio group is
  labeled and required.
- `/carta-digital` category aliases, deep-link scroll and search/empty/loading branches
  work; `/hamburguesas` and `/tragos-vip` redirect intentionally.
