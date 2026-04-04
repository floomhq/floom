import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "floom - Deploy Python automations instantly",
  description:
    "AI writes it. You paste it. floom deploys it. Live app with UI, API, and a link you can share.",
  openGraph: {
    title: "floom - Deploy Python automations instantly",
    description:
      "AI writes it. You paste it. floom deploys it. Live app with UI, API, and a link you can share.",
    images: ["/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "floom - Deploy Python automations instantly",
    description:
      "AI writes it. You paste it. floom deploys it. Live app with UI, API, and a link you can share.",
    images: ["/og-image.png"],
  },
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "floom",
            description:
              "AI writes it. You paste it. floom deploys it. Live app with UI, API, and a link you can share.",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Web",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
            },
            url: "https://floom.dev",
          }),
        }}
      />
      {children}
    </>
  );
}
