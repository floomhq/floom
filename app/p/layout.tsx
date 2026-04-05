import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "../ConvexClientProvider";

export default function PublishedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <ConvexClientProvider>
        <div className="min-h-screen bg-background flex flex-col">
          {/* Minimal header */}
          <header className="px-4 py-3 border-b flex items-center justify-between">
            <a
              href="https://floom.dev"
              className="text-sm font-medium text-foreground hover:opacity-80"
            >
              Floom
            </a>
          </header>

          {/* Content */}
          <main className="flex-1">{children}</main>

          {/* Footer */}
          <footer className="py-4 text-center text-xs text-muted-foreground">
            Powered by Floom
          </footer>
        </div>
      </ConvexClientProvider>
    </ClerkProvider>
  );
}
