import { redirect } from "next/navigation";

export default async function InviteAliasPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  redirect(`/join?invite=${encodeURIComponent(token)}`);
}
