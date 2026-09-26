import DashboardShell from "./dashboard-shell";
import { requireChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <DashboardShell user={user} />;
}
