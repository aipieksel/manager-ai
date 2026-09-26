import DashboardShell from "../dashboard-shell";
import { requireChatGPTUser } from "../chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function RoutedDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ path }, query] = await Promise.all([params, searchParams]);
  const encodedPath = `/${(path ?? []).map(encodeURIComponent).join("/")}`;
  const encodedQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value ? [value] : []) encodedQuery.append(key, item);
  }
  const returnTo = `${encodedPath}${encodedQuery.size ? `?${encodedQuery}` : ""}`;
  const user = await requireChatGPTUser(returnTo);
  return <DashboardShell user={user} />;
}
