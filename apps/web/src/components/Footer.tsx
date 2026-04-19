// Audit 2026-04-18, bug #7: unified footer.
//
// Before: two different footers shipped side by side. The landing +
// /apps + /404 used PublicFooter (capitalized, Built in SF,
// GitHub, Imprint, Privacy, Terms, Cookies). The signed-in shell
// (PageShell -> Footer) used a lowercase variant with `apps · protocol
// · github · imprint · privacy · terms · cookies`, and pointed "protocol"
// at /protocol instead of /docs. Same layout, same links, different
// casing and targets. That was a consistency bug.
//
// After: Footer is a thin re-export of PublicFooter, so every page
// that imports Footer now renders the exact same capitalized,
// Docs-linking footer as the landing page. No styling, markup, or
// anchor changes required in the pages that consumed the old Footer
// (PageShell, AppPermalinkPage, ProtocolPage).
export { PublicFooter as Footer } from './public/PublicFooter';
