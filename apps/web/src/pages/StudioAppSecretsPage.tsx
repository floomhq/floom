// /studio/:slug/secrets — Studio chrome around MeAppSecretsPage.
// Zero duplication: the underlying page accepts a `chrome="studio"`
// flag that swaps the layout shell + skips the TabBar.

import { MeAppSecretsPage } from './MeAppSecretsPage';

export function StudioAppSecretsPage() {
  return <MeAppSecretsPage chrome="studio" notFoundPath="/studio" />;
}
