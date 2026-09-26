"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatGPTUser } from "./chatgpt-auth";
import Documentation from "./documentation";
import { AgentChatWorkspace, ManagedAgentsWorkspace, ProjectsWorkspace, RunsWorkspace } from "./operations-workspace";
import { ApprovalsWorkspace, McpWorkspace, WebhookWorkspace } from "./operational-controls";
import { SlackWorkspace } from "./slack-workspace";
import SetupPage from "./setup-page";

type View = "overview" | "projects" | "inbox" | "agents" | "runs" | "approvals" | "connections" | "webhooks" | "slack" | "audit" | "setup" | "docs";
type WorkspaceMode = "browse" | "chat";
type RouteState = { view: View; mode: WorkspaceMode; projectSlug?: string; agentSlug?: string; tab?: string; conversationId?: string; threadId?: string; agentModal?: string };
type SidebarAgent = { id: string; name: string; slug: string; lifecycle_status: string; role: string; activeRunCount: number };
type Ticket = { id: string; title: string; source: string; priority: "Critical" | "High" | "Normal" | "Low"; status: "New" | "Triaged" | "Running" | "Blocked" | "Resolved"; assignee: string; age: string };
type Agent = { name: string; role: string; status: "Online" | "Idle" | "Offline"; task: string; trust: "Observe" | "Suggest" | "Execute" };
type AuditEvent = { id: string; actor: string; action: string; objectType: string; objectId: string; result: string; occurredAt: number };
type ConfigStatus = {
  portal: { authenticated: boolean; ownerAllowlistConfigured: boolean; persistenceConfigured: boolean; access: string };
  managerRuntime: { configured: boolean; urlConfigured: boolean; tokenConfigured: boolean; source?: string };
  webhook: { handlerBuilt: boolean; secretConfigured: boolean; externallyReachable: boolean; reason: string };
  mcp: { configured: boolean; reason: string };
};
type SetupStatus = {
  connected: boolean;
  health: { codexAuthenticated?: boolean } | null;
};
type IconName = "grid" | "inbox" | "nodes" | "shield" | "plug" | "webhook" | "log" | "setup" | "book" | "search" | "plus" | "arrow" | "check" | "close" | "pause" | "play" | "key" | "lock";

const seedTickets: Ticket[] = [];
const seedAgents: Agent[] = [
  { name: "Manager", role: "Triage, plan and delegate", status: "Offline", task: "Manager runtime not connected", trust: "Suggest" },
  { name: "Codex", role: "Repository diagnosis and changes", status: "Offline", task: "Codex runtime not connected", trust: "Suggest" },
  { name: "Infrastructure", role: "Health checks and runbooks", status: "Offline", task: "No MCP server configured", trust: "Observe" },
  { name: "Knowledge", role: "Documentation and retrieval", status: "Offline", task: "No MCP server configured", trust: "Observe" },
];

const nav: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "projects", label: "Projects", icon: "book" },
  { id: "inbox", label: "Issue inbox", icon: "inbox" },
  { id: "agents", label: "Agents", icon: "nodes" },
  { id: "runs", label: "Runs & results", icon: "play" },
  { id: "approvals", label: "Approvals", icon: "shield" },
  { id: "connections", label: "MCP connections", icon: "plug" },
  { id: "webhooks", label: "Webhooks", icon: "webhook" },
  { id: "slack", label: "Slack & Assistant", icon: "nodes" },
  { id: "audit", label: "Audit log", icon: "log" },
  { id: "setup", label: "Setup", icon: "setup" },
  { id: "docs", label: "Documentation", icon: "book" },
];

const viewPaths: Record<View, string> = {
  overview: "/", projects: "/projects", inbox: "/inbox", agents: "/agents", runs: "/runs", approvals: "/approvals",
  connections: "/connections", webhooks: "/webhooks", slack: "/slack", audit: "/audit", setup: "/setup", docs: "/documentation",
};

function readRoute(): RouteState {
  if (typeof window === "undefined") return { view: "overview", mode: "browse" };
  const parts = window.location.pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(window.location.search);
  if (parts[0] === "chat") return { view: "projects", mode: "chat", agentSlug: parts[1], threadId: params.get("thread") || params.get("conversation") || undefined };
  const pathView = (Object.entries(viewPaths).find(([, path]) => path !== "/" && path === `/${parts[0] || ""}`)?.[0] || "overview") as View;
  return { view: pathView, mode: "browse", projectSlug: parts[0] === "projects" ? parts[1] : undefined, tab: params.get("tab") || undefined, agentModal: params.get("modal") || undefined };
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    inbox: <><path d="M4 5h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z"/><path d="M4 14h4l2 2h4l2-2h4"/></>,
    nodes: <><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="m10.8 7.2-4.5 8M13.2 7.2l4.5 8M7.5 18h9"/></>,
    shield: <path d="M12 3 5 6v5c0 4.5 2.7 8.4 7 10 4.3-1.6 7-5.5 7-10V6l-7-3Z"/>,
    plug: <><path d="M8 3v5M16 3v5M7 8h10v2a5 5 0 0 1-10 0V8ZM12 15v6"/></>,
    webhook: <><path d="M7.5 14.5a4 4 0 1 1 3-6.7L12 10"/><path d="M16.5 14.5a4 4 0 1 1-3 6.7L12 19"/><path d="M9 19h6M15 10h-3"/></>,
    log: <><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    setup: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.18.38.43.71.76.96.32.25.72.4 1.13.4H21v4h-.09c-.4 0-.8.15-1.1.4-.2.13-.3.16-.41.24Z"/></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z"/></>,
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>, plus: <path d="M12 5v14M5 12h14"/>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>, check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    pause: <path d="M8 5v14M16 5v14"/>, play: <path d="m8 5 11 7-11 7V5Z"/>, key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function StatusDot({ status }: { status: Agent["status"] }) { return <span className={`status-dot ${status.toLowerCase()}`}><i />{status}</span>; }
function Priority({ value }: { value: Ticket["priority"] }) { return <span className={`priority priority-${value.toLowerCase()}`}><i />{value}</span>; }
function formatAge(createdAt: number) {
  const elapsed = Math.max(0, Date.now() - createdAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function DashboardShell({ user }: { user: ChatGPTUser }) {
  const [view, setView] = useState<View>("overview");
  const [route, setRoute] = useState<RouteState>({ view: "overview", mode: "browse" });
  const [sidebarAgents, setSidebarAgents] = useState<SidebarAgent[]>([]);
  const [tickets, setTickets] = useState(seedTickets);
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState<"new" | "detail" | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [toast, setToast] = useState("");
  const [approvals, setApprovals] = useState<string[]>([]);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const agents = useMemo<Agent[]>(() => [
    { ...seedAgents[0], status: config?.managerRuntime.configured ? "Online" : "Offline", task: config?.managerRuntime.configured ? "Ready to triage and delegate" : "Manager runtime not connected" },
    { ...seedAgents[1], status: setup?.connected && setup.health?.codexAuthenticated ? "Idle" : "Offline", task: setup?.connected && setup.health?.codexAuthenticated ? "Authenticated; waiting for scoped work" : "Codex runtime not connected" },
    { ...seedAgents[2], task: config?.mcp.configured ? "MCP connection detected; agent policy not assigned" : "No MCP server configured" },
    { ...seedAgents[3], task: config?.mcp.configured ? "MCP connection detected; agent policy not assigned" : "No MCP server configured" },
  ], [config, setup]);
  useEffect(() => {
    let cancelled = false;
    const titleCase = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
    void Promise.all([
      fetch("/api/tickets"),
      fetch("/api/config/status"),
      fetch("/api/setup/status", { cache: "no-store" }),
      fetch("/api/audit"),
      fetch("/api/approvals", { cache: "no-store" }),
    ]).then(async ([ticketsResponse, configResponse, setupResponse, auditResponse, approvalsResponse]) => {
      if (cancelled) return;
      if (ticketsResponse.ok) {
        const data = await ticketsResponse.json() as { tickets?: Array<{ id: string; title: string; source: string; priority: string; status: string; assignee: string; createdAt: number }> };
        const persisted = (data.tickets ?? []).map((item) => ({ id: item.id, title: item.title, source: item.source, priority: titleCase(item.priority) as Ticket["priority"], status: titleCase(item.status) as Ticket["status"], assignee: item.assignee, age: formatAge(item.createdAt) }));
        setTickets(persisted);
      }
      if (configResponse.ok) setConfig(await configResponse.json() as ConfigStatus);
      if (setupResponse.ok) setSetup(await setupResponse.json() as SetupStatus);
      if (auditResponse.ok) {
        const data = await auditResponse.json() as { events?: AuditEvent[] };
        setAuditEvents(data.events ?? []);
      }
      if (approvalsResponse.ok) {
        const data = await approvalsResponse.json() as { approvals?: Array<{ id: string }> };
        setApprovals((data.approvals ?? []).map((item) => item.id));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const sync = () => { const next = readRoute(); setRoute(next); setView(next.view); };
    sync(); window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/agents").then(async (response) => response.ok ? response.json() as Promise<{ agents?: SidebarAgent[] }> : { agents: [] }).then((data) => { if (!cancelled) setSidebarAgents((data.agents ?? []).filter((agent) => agent.lifecycle_status === "active")); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const filtered = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? tickets.filter((ticket) => `${ticket.id} ${ticket.title} ${ticket.source} ${ticket.status}`.toLowerCase().includes(needle)) : tickets; }, [query, tickets]);
  const activeChatAgent = useMemo(() => route.mode === "chat" && route.agentSlug ? sidebarAgents.find((agent) => agent.slug === route.agentSlug) : undefined, [route.mode, route.agentSlug, sidebarAgents]);
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); }, []);
  const updateApprovalCount = useCallback((count: number) => setApprovals(Array.from({ length: count }, (_, index) => String(index))), []);
  const navigate = useCallback((path: string, replace = false) => {
    if (typeof window === "undefined") return;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    const next = readRoute(); setRoute(next); setView(next.view);
  }, []);
  const navigateView = useCallback((next: View) => navigate(viewPaths[next]), [navigate]);
  const navigateProject = useCallback((slug?: string, tab = "chat", conversationId?: string, replace = false) => {
    const params = new URLSearchParams();
    if (tab !== "chat") params.set("tab", tab);
    if (conversationId) params.set("conversation", conversationId);
    const queryString = params.toString();
    navigate(`${slug ? `/chat/${encodeURIComponent(slug)}` : "/chat"}${queryString ? `?${queryString}` : ""}`, replace);
  }, [navigate]);
  const navigateAgentChat = useCallback((slug?: string, threadId?: string, replace = false) => {
    const params = new URLSearchParams();
    if (threadId) params.set("thread", threadId);
    const queryString = params.toString();
    navigate(`${slug ? `/chat/${encodeURIComponent(slug)}` : "/chat"}${queryString ? `?${queryString}` : ""}`, replace);
  }, [navigate]);
  function openTicket(ticket: Ticket) { setSelected(ticket); setDrawer("detail"); }
  async function submitTicket(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get("title") || "").trim(); const priority = String(form.get("priority") || "Normal") as Ticket["priority"]; if (!title) return; const response = await fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, priority, details: String(form.get("details") || ""), assignee: String(form.get("assignee") || "Manager") }) }); if (!response.ok) { notify("Issue could not be saved"); return; } const data = await response.json() as { ticket: { id: string } }; const ticket: Ticket = { id: data.ticket.id, title, source: "manual.intake", priority, status: "New", assignee: "Manager", age: "now" }; setTickets((current) => [ticket, ...current]); setDrawer(null); navigateView("inbox"); notify(`${ticket.id} securely queued for triage`); }
  function recordControl(action: string, objectType: string, objectId: string, value?: string) { void fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, objectType, objectId, value }) }); }
  async function runManager(ticket: Ticket) { const response = await fetch("/api/manager/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticketId: ticket.id }) }); if (response.ok) { setTickets((current) => current.map((item) => item.id === ticket.id ? { ...item, status: "Running" } : item)); notify("Manager runtime accepted the task"); } else notify("Manager runtime is unavailable or rejected the task"); }

  return <div className="command-center">
    <aside className="sidebar">
      <div className="workspace-mode" role="radiogroup" aria-label="Workspace mode"><button role="radio" aria-checked={route.mode === "browse"} className={route.mode === "browse" ? "selected" : ""} onClick={() => navigateView("overview")}><Icon name="grid" size={15}/>Browse</button><button role="radio" aria-checked={route.mode === "chat"} className={route.mode === "chat" ? "selected" : ""} onClick={() => navigateAgentChat()}><Icon name="nodes" size={15}/>Chat</button></div>
      {route.mode === "chat" ? <nav className="chat-project-nav" aria-label="Agent chats"><p>Agents</p>{sidebarAgents.map((agent) => <button key={agent.id} className={route.agentSlug === agent.slug ? "active" : ""} onClick={() => navigateAgentChat(agent.slug)}><span className="sidebar-agent-mark">{agent.name.slice(0, 2).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.role}</small></span><i className={`sidebar-status ${agent.lifecycle_status}`}/></button>)}</nav> : <nav aria-label="Primary navigation"><p>Workspace</p>{nav.map((item) => { const count = item.id === "inbox" ? tickets.length : item.id === "approvals" ? approvals.length : null; return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigateView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{count ? <b>{count}</b> : null}</button>; })}</nav>}
      <div className="security-posture"><div><Icon name="lock" size={16}/><span><strong>Portal protected</strong><small>{config?.managerRuntime.configured ? "Runtime connected" : "Runtime setup incomplete"}</small></span></div><div className={`posture-bar ${config?.managerRuntime.configured ? "" : "partial"}`}><i/><i/><i/><i/><i/></div></div>
      <div className="environment"><span><i />Production</span></div>
      <div className="account"><span className="avatar">{user.displayName.slice(0, 2).toUpperCase()}</span><span><strong>{user.fullName ?? "Workspace owner"}</strong><small>{user.email}</small></span><a href={user.signOutPath} aria-label="Sign out">↗</a></div>
    </aside>
    <main className="workspace">
      <header className={`topbar ${activeChatAgent ? "project-topbar" : ""}`}>{activeChatAgent && <button className="ops-back topbar-back" onClick={() => navigateAgentChat()} aria-label="Back to agent chats">←</button>}<div className="breadcrumbs"><span>{activeChatAgent ? "Chat" : "Workspace"}</span><b>/</b><strong>{activeChatAgent?.name || nav.find((item) => item.id === view)?.label}</strong></div>{activeChatAgent && <div className="project-kicker topbar-project-kicker"><span className={`ops-state state-${activeChatAgent.lifecycle_status}`}>{activeChatAgent.lifecycle_status}</span><span>{activeChatAgent.slug}</span></div>}<label className="global-search"><Icon name="search" size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tickets"/><kbd>⌘ K</kbd></label>{!activeChatAgent && <><div className={`system-state ${config?.managerRuntime.configured ? "ready" : "incomplete"}`}><span><i/>{config?.managerRuntime.configured ? "Runtime connected" : "Setup incomplete"}</span><small>{config ? "Configuration checked" : "Checking configuration"}</small></div><button className="primary-button" onClick={() => setDrawer("new")}><Icon name="plus" size={17}/>New issue</button></>}</header>
      <div className={`content ${activeChatAgent ? "agent-chat-content" : ""}`}>
        {view === "overview" && <Overview tickets={filtered} agents={agents} approvals={approvals} events={auditEvents} config={config} openTicket={openTicket} setView={navigateView}/>}
        {view === "projects" && (route.mode === "chat" ? <AgentChatWorkspace notify={notify} agentSlug={route.agentSlug} threadId={route.threadId} onNavigate={navigateAgentChat}/> : <ProjectsWorkspace notify={notify} mode="browse" projectSlug={route.projectSlug} initialTab={route.tab} conversationId={route.conversationId} onNavigate={navigateProject}/>)}
        {view === "inbox" && <Inbox tickets={filtered} openTicket={openTicket}/>} 
        {view === "agents" && <ManagedAgentsWorkspace notify={notify} initialAgentSlug={route.agentModal} onAgentModalChange={(slug) => navigate(`/agents${slug ? `?modal=${encodeURIComponent(slug)}` : ""}`)}/>}
        {view === "runs" && <RunsWorkspace notify={notify}/>}
        {view === "approvals" && <ApprovalsWorkspace notify={notify} onCount={updateApprovalCount}/>}
        {view === "connections" && <McpWorkspace notify={notify}/>}
        {view === "webhooks" && <WebhookWorkspace notify={notify}/>}
        {view === "slack" && <SlackWorkspace notify={notify}/>}
        {view === "audit" && <Audit events={auditEvents}/>} 
        {view === "setup" && <SetupPage notify={notify}/>} 
        {view === "docs" && <Documentation openConnections={() => navigateView("connections")} openWebhooks={() => navigateView("webhooks")} openSetup={() => navigateView("setup")}/>}
      </div>
    </main>
    {drawer && <div className="drawer-backdrop" onMouseDown={() => setDrawer(null)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>{drawer === "new" ? <NewTicketForm submit={submitTicket} close={() => setDrawer(null)} runtimeReady={Boolean(config?.managerRuntime.configured)}/> : selected ? <TicketDetail ticket={selected} close={() => setDrawer(null)} runtimeReady={Boolean(config?.managerRuntime.configured)} run={() => runManager(selected)} update={(status) => { setTickets((current) => current.map((ticket) => ticket.id === selected.id ? {...ticket, status} : ticket)); setSelected({...selected, status}); recordControl("update_ticket", "ticket", selected.id, status.toLowerCase()); notify(`${selected.id} moved to ${status}`); }}/> : null}</aside></div>}
    {toast && <div className="toast"><Icon name="check" size={17}/>{toast}</div>}
  </div>;
}

function Overview({ tickets, agents, approvals, events, config, openTicket, setView }: { tickets: Ticket[]; agents: Agent[]; approvals: string[]; events: AuditEvent[]; config: ConfigStatus | null; openTicket: (ticket: Ticket) => void; setView: (view: View) => void }) {
  const active = config?.managerRuntime.configured ? agents.filter((agent) => agent.status !== "Offline").length : 0;
  const date = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toUpperCase();
  return <><section className="page-heading"><div><span className="eyebrow">{date}</span><h1>{config?.managerRuntime.configured ? "The manager runtime is connected." : "The control portal is ready. The agent runtime is not connected."}</h1><p>{config?.managerRuntime.configured ? "New work can be sent to the manager within the configured policy." : "Open Setup to install and connect the trusted runtime."}</p></div><button className="secondary-button" onClick={() => setView(config?.managerRuntime.configured ? "audit" : "setup")}>{config?.managerRuntime.configured ? "View activity" : "Open setup"} <Icon name="arrow" size={16}/></button></section>
    <section className="metrics" aria-label="Operational metrics"><article><span>Open issues</span><strong>{tickets.filter((ticket) => ticket.status !== "Resolved").length}</strong><small>{tickets.length ? `${tickets.length} total saved issues` : "No issues received yet"}</small></article><article><span>Agents active</span><strong>{active}<em>/ {agents.length}</em></strong><small>{config?.managerRuntime.configured ? "Runtime connected" : "Runtime not configured"}</small></article><article><span>Awaiting approval</span><strong>{approvals.length}</strong><small>{config?.managerRuntime.configured ? "From connected runtime" : "Approval workflow inactive"}</small></article><article><span>Configuration</span><strong>{config?.managerRuntime.configured ? "Ready" : "Setup"}</strong><small>{config?.managerRuntime.configured ? "Manager bridge configured" : "Open Setup to continue"}</small></article></section>
    <div className="overview-grid">
      <section className="panel queue-panel"><div className="panel-head"><div><h2>Issue queue</h2><span>Persistent records from manual and verified intake</span></div><button onClick={() => setView("inbox")}>Open inbox <Icon name="arrow" size={15}/></button></div>{tickets.length ? <TicketTable tickets={tickets.slice(0, 4)} openTicket={openTicket}/> : <EmptyState title="No issues yet" text="Create an issue manually or finish the webhook setup."/>}</section>
      <section className="panel approvals-panel"><div className="panel-head"><div><h2>Approval gate</h2><span>Consequential requests require an attributed owner decision</span></div><span className="count-badge">{approvals.length}</span></div>{approvals.length ? <div className="approval-card"><div className="risk-row"><span className="risk high">ACTION REQUIRED</span></div><h3>{approvals.length} request{approvals.length === 1 ? "" : "s"} awaiting review</h3><p>Open the durable approval queue to inspect scope, risk, arguments and expiry before deciding.</p><button className="primary-button" onClick={() => setView("approvals")}>Review approvals</button></div> : <EmptyState title="No approval requests" text={config?.managerRuntime.configured ? "The connected runtime has not requested an action." : "Connect the manager runtime before approvals can arrive."}/>}</section>
      <section className="panel agent-panel"><div className="panel-head"><div><h2>Agent availability</h2><span>Live runtime status and configured specialist roles</span></div><button onClick={() => setView("agents")}>View agents <Icon name="arrow" size={15}/></button></div><div className="agent-list">{agents.map((agent) => <div className="agent-row" key={agent.name}><span className="agent-glyph">{agent.name.slice(0,2).toUpperCase()}</span><span className="agent-copy"><strong>{agent.name}</strong><small>{agent.task}</small></span><StatusDot status={agent.status}/><span className="trust">{agent.trust}</span></div>)}</div></section>
      <section className="panel activity-panel"><div className="panel-head"><div><h2>Recorded activity</h2><span>Database-backed portal events</span></div><button onClick={() => setView("audit")}>Open audit <Icon name="arrow" size={15}/></button></div>{events.length ? <div className="timeline">{events.slice(0,4).map((event) => <div key={event.id}><span className="timeline-dot"/><p><strong>{event.actor}</strong> {event.action.toLowerCase()}<small>{new Date(event.occurredAt).toLocaleString()} · {event.objectId}</small></p><b>{event.result}</b></div>)}</div> : <EmptyState title="No activity recorded" text="Real portal actions will appear here."/>}</section>
    </div></>;
}

function TicketTable({ tickets, openTicket }: { tickets: Ticket[]; openTicket: (ticket: Ticket) => void }) { return <div className="table-wrap"><table><thead><tr><th>Issue</th><th>Priority</th><th>Status</th><th>Owner</th><th>Age</th></tr></thead><tbody>{tickets.map((ticket) => <tr key={ticket.id} onClick={() => openTicket(ticket)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && openTicket(ticket)}><td><strong>{ticket.title}</strong><small>{ticket.id} · {ticket.source}</small></td><td><Priority value={ticket.priority}/></td><td><span className={`ticket-status status-${ticket.status.toLowerCase()}`}>{ticket.status}</span></td><td>{ticket.assignee}</td><td>{ticket.age}</td></tr>)}</tbody></table></div>; }
function Inbox({ tickets, openTicket }: { tickets: Ticket[]; openTicket: (ticket: Ticket) => void }) {
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const visible = tickets.filter((ticket) => filter === "all" || (filter === "resolved" ? ticket.status === "Resolved" : ticket.status !== "Resolved"));
  return <section className="page-section"><div className="section-title"><div><span className="eyebrow">INTAKE AND TRIAGE</span><h1>Issue inbox</h1><p>Persistent manual issues and verified intake events appear here.</p></div><div className="filter-tabs"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All</button><button className={filter === "open" ? "selected" : ""} onClick={() => setFilter("open")}>Open</button><button className={filter === "resolved" ? "selected" : ""} onClick={() => setFilter("resolved")}>Resolved</button></div></div><div className="panel">{visible.length ? <TicketTable tickets={visible} openTicket={openTicket}/> : <EmptyState title="No matching issues" text="Change the filter or create a new issue."/>}</div></section>;
}
function Audit({ events }: { events: AuditEvent[] }) {
  function exportEvents() {
    const header = ["time", "actor", "action", "object_type", "object_id", "result"];
    const rows = events.map((event) => [new Date(event.occurredAt).toISOString(), event.actor, event.action, event.objectType, event.objectId, event.result]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "agent-command-center-audit.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return <section className="page-section"><div className="section-title"><div><span className="eyebrow">DATABASE-BACKED ACTIVITY</span><h1>Audit log</h1><p>Real portal actions are attributed and timestamped. This is not an immutable ledger.</p></div><button className="secondary-button" onClick={exportEvents} disabled={!events.length}>Export activity</button></div><div className="panel audit-table">{events.length ? <table><thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Object</th><th>Control result</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td><code>{new Date(event.occurredAt).toLocaleString()}</code></td><td><strong>{event.actor}</strong></td><td>{event.action}</td><td><code>{event.objectType}:{event.objectId}</code></td><td><span className={event.result.includes("approval") ? "audit-result approval" : "audit-result"}>{event.result}</span></td></tr>)}</tbody></table> : <EmptyState title="No activity recorded" text="Create or update a real issue to generate an audit event."/>}</div></section>;
}
function NewTicketForm({ submit, close, runtimeReady }: { submit: (event: React.FormEvent<HTMLFormElement>) => void; close: () => void; runtimeReady: boolean }) { return <form onSubmit={submit}><div className="drawer-head"><div><span className="eyebrow">MANUAL INTAKE</span><h2>Create an issue</h2></div><button type="button" onClick={close}><Icon name="close"/></button></div><p className="drawer-intro">The issue is saved immediately. {runtimeReady ? "You can then send it to the connected manager runtime." : "No agent will act on it until the manager runtime is configured."}</p><label>Issue title<input name="title" required placeholder="Describe the problem clearly" autoFocus/></label><label>Priority<select name="priority" defaultValue="Normal"><option>Critical</option><option>High</option><option>Normal</option><option>Low</option></select></label><label>Context<textarea name="details" rows={7} placeholder="Add symptoms, links, systems affected or the expected outcome"/></label><label>Planned assignee<select name="assignee"><option>Manager</option><option>Codex</option><option>Infrastructure</option><option>Knowledge</option></select></label><div className="form-notice"><Icon name="shield" size={18}/><span><strong>Safe intake</strong>Creating a record does not execute tools or change external systems.</span></div><div className="drawer-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-button" type="submit">Create issue <Icon name="arrow" size={16}/></button></div></form>; }
function TicketDetail({ ticket, close, update, run, runtimeReady }: { ticket: Ticket; close: () => void; update: (status: Ticket["status"]) => void; run: () => void; runtimeReady: boolean }) { return <div><div className="drawer-head"><div><span className="eyebrow">{ticket.id}</span><h2>{ticket.title}</h2></div><button onClick={close}><Icon name="close"/></button></div><div className="detail-meta"><Priority value={ticket.priority}/><span className={`ticket-status status-${ticket.status.toLowerCase()}`}>{ticket.status}</span><span>{ticket.source}</span></div><section className="detail-block"><h3>Manager assessment</h3><p>{runtimeReady ? "No assessment has been returned yet. Send the issue to the manager to begin triage." : "Unavailable because the external manager runtime is not configured."}</p></section><section className="detail-block"><h3>Intended workflow</h3><ol><li><span>1</span>Manager validates the request and selects allowed tools</li><li><span>2</span>Codex or another specialist works inside its configured boundary</li><li><span>3</span>Consequential actions create an approval request</li><li><span>4</span>Results and decisions are written to the audit history</li></ol></section><section className="detail-block"><h3>Current control boundary</h3><p>{runtimeReady ? "The bridge is configured. Runtime-side sandbox and MCP policies still determine what can execute." : "No runtime credentials are present, so this portal cannot start Codex or call an MCP server."}</p></section><div className="drawer-actions"><button onClick={() => update("Blocked")}>Block</button><button onClick={run} disabled={!runtimeReady} title={runtimeReady ? "Send this issue to the manager" : "Configure the manager runtime first"}>Send to manager</button><button className="primary-button" onClick={() => update(ticket.status === "Resolved" ? "Triaged" : "Resolved")}>{ticket.status === "Resolved" ? "Reopen" : "Mark resolved"}</button></div></div>; }
function EmptyState({ title, text }: { title: string; text: string }) { return <div className="empty-state"><span><Icon name="check"/></span><h3>{title}</h3><p>{text}</p></div>; }
