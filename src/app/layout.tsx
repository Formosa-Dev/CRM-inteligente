import type { Metadata } from "next";
import { Poppins, Playfair_Display, Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { MetaPixelProvider } from "@/components/meta/meta-pixel-provider";
import { CartProvider } from "@/lib/cart/cart-context";
import { PublicToaster } from "@/components/layout/public-toaster";
import { getBusinessInfo, type BusinessInfo } from "@/lib/business";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const OG_FALLBACK_IMAGE = "/assets/images/logo.png";

function resolveMetadataBase(biz: BusinessInfo): URL {
  const raw = process.env.NEXT_PUBLIC_APP_URL || biz.website || "";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return new URL("http://localhost:3000");
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const biz = await getBusinessInfo();
  const description =
    biz.description || `${biz.name} — pedidos online por WhatsApp.`;
  return {
    metadataBase: resolveMetadataBase(biz),
    title: {
      default: biz.name,
      template: `%s — ${biz.name}`,
    },
    description,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      locale: "es_AR",
      siteName: biz.name,
      title: biz.name,
      description,
      images: [{ url: OG_FALLBACK_IMAGE, alt: biz.name }],
    },
    twitter: {
      card: "summary_large_image",
      title: biz.name,
      description,
      images: [OG_FALLBACK_IMAGE],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${poppins.variable} ${playfair.variable} ${inter.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground overflow-x-hidden">
        <MetaPixelProvider />
        <CartProvider>{children}</CartProvider>
        <PublicToaster />
      </body>
    </html>
  );
}
