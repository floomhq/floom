/**
 * Home route group — bare layout so V3Shell handles its own nav + footer.
 * No SiteHeader / SiteFooter here.
 */
export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
