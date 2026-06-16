// /brain is the legacy route — redirect to /library.
import { redirect } from "next/navigation";

export default function BrainRedirectPage() {
  redirect("/library");
}
