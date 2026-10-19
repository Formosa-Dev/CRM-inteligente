// ─── Campaign Registry ────────────────────────────────────────────────────────

export interface Campaign {
  slug: string;
  name: string;
  whatsappMessage: string;
  active: boolean;
}

export const CAMPAIGNS: Campaign[] = [
  {
    slug: "hamburguesas",
    name: "Menu Hamburguesas (Orgánico)",
    whatsappMessage: "Hola! Me gustaría hacer un pedido de hamburguesas",
    active: true,
  },
  {
    slug: "mayorista",
    name: "Pan Mayorista (Orgánico)",
    whatsappMessage: "Hola! Me interesa información sobre pan mayorista",
    active: true,
  },
  {
    slug: "promo-muzza",
    name: "Promo Muzzarella - Meta Ads",
    whatsappMessage: "Hola! Vi la promo de muzza y me interesa",
    active: true,
  },
  {
    slug: "2x1-empanadas",
    name: "2x1 Empanadas - Meta Ads",
    whatsappMessage: "Hola! Vi la promo de 2x1 empanadas",
    active: true,
  },
];

export interface Product {
  id: string;
  name: string;
  price: number | null;
  originalPrice?: number;
  ingredients: string;
  emoji: string;
  imageUrl?: string | null;
  comingSoon?: boolean;
  stock?: number | null;
  discountPercentage?: number;
  hasFreeShipping?: boolean;
  soldCount?: number;
}

export const LINEA_CARNE: Product[] = [
  {
    id: "carne-1",
    name: "La Clásica",
    price: null,
    ingredients: "Próximamente — receta secreta en desarrollo",
    emoji: "🥩",
    comingSoon: true,
  },
  {
    id: "carne-2",
    name: "La Doble",
    price: null,
    ingredients: "Próximamente — doble burguer de autor",
    emoji: "🍔",
    comingSoon: true,
  },
  {
    id: "carne-3",
    name: "La Especial",
    price: null,
    ingredients: "Próximamente — sorpresa que te va a volar la cabeza",
    emoji: "⭐",
    comingSoon: true,
  },
];

export const PRODUCT_IMAGE_MAP: Record<string, string> = {
  genesis: "/assets/images/products/hamburguesa-genesis.png",
  "deli-deli": "/assets/images/products/hamburguesa-deli-float.png",
  mamita: "/assets/images/products/hamburguesa-mamita.png",
  bookbinder: "/assets/images/products/hamburguesa-bookbinder.png",
  "toro-asado": "/assets/images/products/hamburguesa-toro-asado.png",
};

// Map por nombre (para productos de API que tienen IDs numéricos)
export const PRODUCT_IMAGE_BY_NAME: Record<string, string> = {
  genesis: "/assets/images/products/hamburguesa-genesis.png",
  "deli deli": "/assets/images/products/hamburguesa-deli-float.png",
  mamita: "/assets/images/products/hamburguesa-mamita.png",
  bookbinder: "/assets/images/products/hamburguesa-bookbinder.png",
  "toro asado": "/assets/images/products/hamburguesa-toro-asado.png",
};

export const BG_IMAGES = [
  "/assets/images/background/1.png",
  "/assets/images/background/2.png",
  "/assets/images/background/3.png",
  "/assets/images/background/b4.png",
];

