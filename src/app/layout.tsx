import type { Metadata } from "next";
import { Poppins, Playfair_Display, Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { MetaPixelProvider } from "@/components/meta/meta-pixel-provider";
import { CartProvider } from "@/lib/cart/cart-context";
import { getBusinessInfo } from "@/lib/business";

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

export async function generateMetadata(): Promise<Metadata> {
  const biz = await getBusinessInfo();
  return {
    title: {
      default: biz.name,
      template: `%s — ${biz.name}`,
    },
    description:
      biz.description ||
      `${biz.name} — pedidos online por WhatsApp.`,
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
      </body>
    </html>
  );
}
