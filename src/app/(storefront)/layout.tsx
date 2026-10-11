import { StorefrontMotion } from "@/components/storefront/motion-provider";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { WhatsAppFAB } from "@/components/layout/whatsapp-fab";
import { UTMCaptureScript } from "@/components/attribution/utm-capture-script";
import { ScrollProgress } from "@/components/motion/scroll-progress";

export default function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StorefrontMotion>
      <ScrollProgress />
      <Navbar />
      <UTMCaptureScript />
      <main className="flex-1 overflow-x-hidden">{children}</main>
      <Footer />
      <WhatsAppFAB />
    </StorefrontMotion>
  );
}
