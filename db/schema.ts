import { sql } from "drizzle-orm";
import { check, primaryKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  details: text("details").notNull().default(""),
  source: text("source").notNull(),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("new"),
  assignee: text("assignee").notNull().default("Manager"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  agentId: text("agent_id").notNull(),
  sourceId: text("source_id"),
  externalEventId: text("external_event_id"),
  eventType: text("event_type").notNull(),
  signatureStatus: text("signature_status").notNull().default("verified"),
  payloadHash: text("payload_hash").notNull(),
  payloadSize: integer("payload_size").notNull().default(0),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  normalizedAt: integer("normalized_at", { mode: "timestamp_ms" }),
  deliveryStatus: text("delivery_status").notNull().default("delivered"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  ticketId: text("ticket_id"),
  runId: text("run_id"),
  lastErrorCode: text("last_error_code"),
}, (table) => [uniqueIndex("webhook_events_idempotency_idx").on(table.idempotencyKey)]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  result: text("result").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
});

export const executionRequests = sqliteTable("execution_requests", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull(),
  runId: text("run_id"),
  agentId: text("agent_id"),
  agentVersionId: text("agent_version_id"),
  projectId: text("project_id"),
  requestedBy: text("requested_by").notNull(),
  action: text("action").notNull(),
  actionClass: text("action_class"),
  toolConnectionId: text("tool_connection_id"),
  toolName: text("tool_name"),
  argumentsSummary: text("arguments_summary"),
  argumentsHash: text("arguments_hash"),
  risk: text("risk").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  decisionNote: text("decision_note"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const runtimeSettings = sqliteTable("runtime_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const setupJobRuns = sqliteTable("setup_job_runs", {
  id: text("id").primaryKey(),
  job: text("job").notNull(),
  status: text("status").notNull().default("queued"),
  requestedBy: text("requested_by").notNull(),
  runnerStatus: integer("runner_status"),
  output: text("output").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("person"),
  displayName: text("display_name").notNull(),
  email: text("email"),
  roleTitle: text("role_title"),
  timezone: text("timezone").notNull().default("Africa/Johannesburg"),
  availability: text("availability").notNull().default("unknown"),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("identities_email_idx").on(table.email)]);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull().default(""),
  objective: text("objective").notNull().default(""),
  successDefinition: text("success_definition").notNull().default(""),
  status: text("status").notNull().default("proposed"),
  accountableOwnerId: text("accountable_owner_id"),
  defaultAgentId: text("default_agent_id"),
  clientName: text("client_name"),
  timezone: text("timezone").notNull().default("Africa/Johannesburg"),
  startAt: integer("start_at", { mode: "timestamp_ms" }),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  sourceType: text("source_type").notNull().default("manual"),
  sourceRef: text("source_ref"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("projects_slug_idx").on(table.slug),
  index("projects_status_updated_idx").on(table.status, table.updatedAt),
]);

export const projectWorkspaces = sqliteTable("project_workspaces", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  repositoryRef: text("repository_ref").notNull(),
  checkoutPath: text("checkout_path").notNull(),
  launcherAlias: text("launcher_alias"),
  tmuxSession: text("tmux_session"),
  codeServerUrl: text("code_server_url"),
  vncUrl: text("vnc_url"),
  handoffUrl: text("handoff_url"),
  instructionPaths: text("instruction_paths").notNull().default("[]"),
  skillsPaths: text("skills_paths").notNull().default("[]"),
  runtimeStatus: text("runtime_status").notNull().default("registered"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("project_workspaces_project_idx").on(table.projectId),
  uniqueIndex("project_workspaces_checkout_idx").on(table.checkoutPath),
]);

export const projectResources = sqliteTable("project_resources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  resourceType: text("resource_type").notNull(),
  label: text("label").notNull(),
  value: text("value").notNull(),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("project_resources_identity_idx").on(table.projectId, table.resourceType, table.label),
  index("project_resources_project_type_idx").on(table.projectId, table.resourceType),
]);

export const projectVariables = sqliteTable("project_variables", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  owningService: text("owning_service").notNull().default(""),
  secretRef: text("secret_ref"),
  configuredStatus: text("configured_status").notNull().default("unknown"),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  description: text("description").notNull().default(""),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("project_variables_name_idx").on(table.projectId, table.name)]);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("active"),
  defaultAgentId: text("default_agent_id"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
}, (table) => [index("conversations_project_updated_idx").on(table.projectId, table.updatedAt)]);

export const conversationMessages = sqliteTable("conversation_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  projectId: text("project_id").notNull(),
  authorType: text("author_type").notNull(),
  authorRef: text("author_ref").notNull(),
  body: text("body").notNull(),
  deliveryStatus: text("delivery_status").notNull().default("stored"),
  runId: text("run_id"),
  replyToMessageId: text("reply_to_message_id"),
  sourceType: text("source_type").notNull().default("owner_chat"),
  sourceRef: text("source_ref"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("conversation_messages_conversation_idx").on(table.conversationId, table.createdAt),
  index("conversation_messages_project_idx").on(table.projectId, table.createdAt),
]);

export const codexThreads = sqliteTable("codex_threads", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  threadId: text("thread_id").notNull(),
  workspaceRef: text("workspace_ref").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("codex_threads_conversation_agent_idx").on(table.conversationId, table.agentId),
  uniqueIndex("codex_threads_thread_idx").on(table.threadId),
]);

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  currentVersionId: text("current_version_id"),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("plans_project_status_idx").on(table.projectId, table.status)]);

export const planVersions = sqliteTable("plan_versions", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  objective: text("objective").notNull().default(""),
  successDefinition: text("success_definition").notNull().default(""),
  context: text("context").notNull().default(""),
  scopeIn: text("scope_in").notNull().default("[]"),
  scopeOut: text("scope_out").notNull().default("[]"),
  assumptions: text("assumptions").notNull().default("[]"),
  decisions: text("decisions").notNull().default("[]"),
  deliverables: text("deliverables").notNull().default("[]"),
  risks: text("risks").notNull().default("[]"),
  openQuestions: text("open_questions").notNull().default("[]"),
  sourceSnapshotId: text("source_snapshot_id"),
  generatedByAgentId: text("generated_by_agent_id"),
  agentVersionId: text("agent_version_id"),
  agentRunId: text("agent_run_id"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  reviewDecision: text("review_decision"),
  reviewNote: text("review_note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("plan_versions_number_idx").on(table.planId, table.versionNumber)]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  originPlanVersionId: text("origin_plan_version_id"),
  parentTaskId: text("parent_task_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  expectedOutcome: text("expected_outcome").notNull().default(""),
  acceptanceCriteria: text("acceptance_criteria").notNull().default("[]"),
  status: text("status").notNull().default("backlog"),
  priority: text("priority").notNull().default("normal"),
  accountableOwnerId: text("accountable_owner_id"),
  assignmentState: text("assignment_state").notNull().default("unassigned"),
  startAt: integer("start_at", { mode: "timestamp_ms" }),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  dateState: text("date_state").notNull().default("proposed"),
  estimateMinutes: integer("estimate_minutes"),
  milestone: text("milestone"),
  blockedReason: text("blocked_reason"),
  completionSummary: text("completion_summary"),
  completionEvidenceRef: text("completion_evidence_ref"),
  externalSystem: text("external_system"),
  externalId: text("external_id"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => [
  index("tasks_project_status_idx").on(table.projectId, table.status),
  index("tasks_owner_due_idx").on(table.accountableOwnerId, table.dueAt),
]);

export const taskAssignees = sqliteTable("task_assignees", {
  taskId: text("task_id").notNull(),
  identityId: text("identity_id").notNull(),
  role: text("role").notNull().default("contributor"),
  assignmentState: text("assignment_state").notNull().default("proposed"),
  assignedBy: text("assigned_by").notNull(),
  assignedAt: integer("assigned_at", { mode: "timestamp_ms" }).notNull(),
  respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("task_assignees_pair_idx").on(table.taskId, table.identityId)]);

export const taskDependencies = sqliteTable("task_dependencies", {
  taskId: text("task_id").notNull(),
  dependsOnTaskId: text("depends_on_task_id").notNull(),
  dependencyType: text("dependency_type").notNull().default("finish_to_start"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("task_dependencies_pair_idx").on(table.taskId, table.dependsOnTaskId)]);

export const taskAgentAssignments = sqliteTable("task_agent_assignments", {
  taskId: text("task_id").notNull(),
  agentId: text("agent_id").notNull(),
  assignmentState: text("assignment_state").notNull().default("assigned"),
  latestRunId: text("latest_run_id"),
  assignedBy: text("assigned_by").notNull(),
  assignedAt: integer("assigned_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("task_agent_assignments_pair_idx").on(table.taskId, table.agentId)]);

export const sourceReferences = sqliteTable("source_references", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref").notNull(),
  sourceUrl: text("source_url"),
  label: text("label").notNull().default(""),
  quotedExcerpt: text("quoted_excerpt"),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  contentHash: text("content_hash"),
}, (table) => [index("source_references_object_idx").on(table.objectType, table.objectId)]);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull().default(""),
  lifecycleStatus: text("lifecycle_status").notNull().default("draft"),
  currentVersionId: text("current_version_id"),
  ownerIdentityId: text("owner_identity_id"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("agents_name_idx").on(table.name), uniqueIndex("agents_slug_idx").on(table.slug)]);

export const agentVersions = sqliteTable("agent_versions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  role: text("role").notNull(),
  objective: text("objective").notNull(),
  successDefinition: text("success_definition").notNull().default(""),
  systemInstructions: text("system_instructions").notNull(),
  boundaryInstructions: text("boundary_instructions").notNull().default(""),
  inputSchemaName: text("input_schema_name").notNull().default("work-request"),
  outputSchemaName: text("output_schema_name").notNull().default("planning-result"),
  outputSchemaVersion: integer("output_schema_version").notNull().default(1),
  modelProvider: text("model_provider").notNull().default("openai"),
  modelName: text("model_name").notNull().default("default"),
  reasoningEffort: text("reasoning_effort").notNull().default("medium"),
  sandboxMode: text("sandbox_mode").notNull().default("read_only"),
  timeoutSeconds: integer("timeout_seconds").notNull().default(1800),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  maxInputChars: integer("max_input_chars").notNull().default(64000),
  workspaceRef: text("workspace_ref"),
  changeReason: text("change_reason").notNull().default("Initial configuration"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("agent_versions_number_idx").on(table.agentId, table.versionNumber)]);

export const agentProjectAccess = sqliteTable("agent_project_access", {
  agentVersionId: text("agent_version_id").notNull(),
  projectId: text("project_id").notNull(),
  accessLevel: text("access_level").notNull().default("propose"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("agent_project_access_pair_idx").on(table.agentVersionId, table.projectId)]);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  agentVersionId: text("agent_version_id").notNull(),
  projectId: text("project_id"),
  ticketId: text("ticket_id"),
  triggerType: text("trigger_type").notNull().default("manual"),
  triggerRef: text("trigger_ref"),
  inputSnapshot: text("input_snapshot").notNull().default("{}"),
  runnerJobId: text("runner_job_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("queued"),
  attemptNumber: integer("attempt_number").notNull().default(1),
  retryOfRunId: text("retry_of_run_id"),
  requestedBy: text("requested_by").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  approvalRequestId: text("approval_request_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("agent_runs_idempotency_idx").on(table.idempotencyKey),
  index("agent_runs_status_updated_idx").on(table.status, table.updatedAt),
]);

export const agentRunEvents = sqliteTable("agent_run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  stage: text("stage"),
  message: text("message").notNull().default(""),
  progressPercent: integer("progress_percent"),
  metadata: text("metadata").notNull().default("{}"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  contentHash: text("content_hash"),
}, (table) => [uniqueIndex("agent_run_events_sequence_idx").on(table.runId, table.sequence)]);

export const agentResults = sqliteTable("agent_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  schemaName: text("schema_name").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  summary: text("summary").notNull().default(""),
  structuredData: text("structured_data").notNull().default("{}"),
  validationStatus: text("validation_status").notNull().default("valid"),
  validationErrors: text("validation_errors").notNull().default("[]"),
  confidence: text("confidence"),
  contentHash: text("content_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("agent_results_run_idx").on(table.runId)]);

export const mcpConnections = sqliteTable("mcp_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  transport: text("transport").notNull().default("streamable_http"),
  endpointOrigin: text("endpoint_origin").notNull(),
  endpointPath: text("endpoint_path").notNull().default("/mcp"),
  authType: text("auth_type").notNull().default("bearer"),
  secretRef: text("secret_ref"),
  lifecycleStatus: text("lifecycle_status").notNull().default("draft"),
  healthStatus: text("health_status").notNull().default("unknown"),
  protocolVersion: text("protocol_version"),
  serverName: text("server_name"),
  serverVersion: text("server_version"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  lastConnectedAt: integer("last_connected_at", { mode: "timestamp_ms" }),
  lastErrorCode: text("last_error_code"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("mcp_connections_name_idx").on(table.name), uniqueIndex("mcp_connections_slug_idx").on(table.slug)]);

export const mcpTools = sqliteTable("mcp_tools", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  toolName: text("tool_name").notNull(),
  description: text("description").notNull().default(""),
  inputSchema: text("input_schema").notNull().default("{}"),
  schemaHash: text("schema_hash").notNull(),
  riskClass: text("risk_class").notNull().default("unknown"),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  discoveredAt: integer("discovered_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("mcp_tools_name_idx").on(table.connectionId, table.toolName)]);

export const agentMcpPermissions = sqliteTable("agent_mcp_permissions", {
  agentVersionId: text("agent_version_id").notNull(),
  mcpToolId: text("mcp_tool_id").notNull(),
  permission: text("permission").notNull().default("deny"),
  argumentPolicy: text("argument_policy").notNull().default("{}"),
  rateLimit: integer("rate_limit").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("agent_mcp_permissions_pair_idx").on(table.agentVersionId, table.mcpToolId)]);

export const mcpToolCalls = sqliteTable("mcp_tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  agentVersionId: text("agent_version_id").notNull(),
  connectionId: text("connection_id").notNull(),
  toolId: text("tool_id").notNull(),
  argumentsRedacted: text("arguments_redacted").notNull().default("{}"),
  argumentsHash: text("arguments_hash").notNull(),
  approvalRequestId: text("approval_request_id"),
  status: text("status").notNull().default("queued"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  resultSummary: text("result_summary"),
  errorCode: text("error_code"),
  auditEventId: text("audit_event_id"),
});

export const webhookSources = sqliteTable("webhook_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull().default("generic_hmac"),
  externalWorkspaceId: text("external_workspace_id"),
  secretRef: text("secret_ref").notNull(),
  status: text("status").notNull().default("active"),
  allowedEventTypes: text("allowed_event_types").notNull().default("[]"),
  allowedAgentIds: text("allowed_agent_ids").notNull().default("[]"),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(30),
  lastReceivedAt: integer("last_received_at", { mode: "timestamp_ms" }),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const webhookDeliveryAttempts = sqliteTable("webhook_delivery_attempts", {
  id: text("id").primaryKey(),
  webhookEventId: text("webhook_event_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  httpStatus: integer("http_status"),
  result: text("result").notNull().default(""),
  errorCode: text("error_code"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("webhook_delivery_attempts_number_idx").on(table.webhookEventId, table.attemptNumber)]);

export const slackInstallations = sqliteTable("slack_installations", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  enterpriseId: text("enterprise_id"),
  workspaceName: text("workspace_name").notNull(),
  botUserId: text("bot_user_id"),
  botTokenSecretRef: text("bot_token_secret_ref").notNull(),
  appTokenSecretRef: text("app_token_secret_ref").notNull(),
  status: text("status").notNull().default("draft"),
  installedBy: text("installed_by").notNull(),
  installedAt: integer("installed_at", { mode: "timestamp_ms" }).notNull(),
  lastConnectedAt: integer("last_connected_at", { mode: "timestamp_ms" }),
  lastErrorCode: text("last_error_code"),
}, (table) => [uniqueIndex("slack_installations_team_idx").on(table.teamId)]);

export const slackChannelRules = sqliteTable("slack_channel_rules", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull(),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  allowed: integer("allowed", { mode: "boolean" }).notNull().default(false),
  defaultProjectId: text("default_project_id"),
  allowedAgentIds: text("allowed_agent_ids").notNull().default("[]"),
  allowThreadHistory: integer("allow_thread_history", { mode: "boolean" }).notNull().default(true),
  allowFileMetadata: integer("allow_file_metadata", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("slack_channel_rules_pair_idx").on(table.installationId, table.channelId)]);

export const slackNotificationRoutes = sqliteTable("slack_notification_routes", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull(),
  displayName: text("display_name").notNull(),
  eventType: text("event_type").notNull().default("social.post.published"),
  triggerKey: text("trigger_key").notNull().default("social_post_published"),
  eventFamily: text("event_family").notNull().default("marketing.social"),
  description: text("description").notNull().default(""),
  slackChannelId: text("slack_channel_id").notNull(),
  allowedPlatforms: text("allowed_platforms").notNull().default("[\"linkedin\",\"x\"]"),
  variableNames: text("variable_names").notNull().default("[]"),
  messageTemplate: text("message_template").notNull().default("{agent} published {title} on {platform}: {url}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("slack_notification_routes_principal_trigger_idx").on(table.principalId, table.triggerKey)]);

export const externalIdentityLinks = sqliteTable("external_identity_links", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  externalWorkspaceId: text("external_workspace_id").notNull(),
  externalUserId: text("external_user_id").notNull(),
  internalIdentityId: text("internal_identity_id").notNull(),
  displayNameSnapshot: text("display_name_snapshot").notNull().default(""),
  linkStatus: text("link_status").notNull().default("pending"),
  linkedBy: text("linked_by").notNull(),
  linkedAt: integer("linked_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("external_identity_links_idx").on(table.sourceType, table.externalWorkspaceId, table.externalUserId)]);

export const sourceContextSnapshots = sqliteTable("source_context_snapshots", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  workspaceRef: text("workspace_ref"),
  channelRef: text("channel_ref"),
  threadRef: text("thread_ref"),
  messageRefs: text("message_refs").notNull().default("[]"),
  capturedContent: text("captured_content").notNull(),
  contentHash: text("content_hash").notNull(),
  capturedBy: text("captured_by").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  retentionUntil: integer("retention_until", { mode: "timestamp_ms" }),
  redactionStatus: text("redaction_status").notNull().default("not_required"),
});

export const reportConfigurations = sqliteTable("report_configurations", {
  reportKey: text("report_key").primaryKey(),
  projectId: text("project_id").notNull(),
  installationId: text("installation_id").notNull(),
  apiAppId: text("api_app_id").notNull(),
  executorId: text("executor_id").notNull(),
  executorVersionId: text("executor_version_id").notNull(),
  referenceId: text("reference_id").notNull(),
  referenceSha256: text("reference_sha256").notNull(),
  sourceConfigId: text("source_config_id").notNull(),
  revision: integer("revision").notNull().default(1),
  enabled: integer("enabled").notNull().default(0),
  preflightVerifiedAt: integer("preflight_verified_at"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [check("report_key_fixed", sql`${table.reportKey}='site.ai_referrals'`), check("report_configurations_enabled", sql`${table.enabled} IN (0,1)`)]);

export const reportGrants = sqliteTable("report_grants", {
  installationId: text("installation_id").notNull(),
  userId: text("user_id").notNull(),
  reportKey: text("report_key").notNull(),
  projectId: text("project_id").notNull(),
  active: integer("active").notNull().default(0),
  reviewedBy: text("reviewed_by").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.installationId, table.userId, table.reportKey, table.projectId] }), check("report_grants_active", sql`${table.active} IN (0,1)`)]);

export const reportChannelPolicies = sqliteTable("report_channel_policies", {
  installationId: text("installation_id").notNull(),
  channelId: text("channel_id").notNull(),
  reportKey: text("report_key").notNull(),
  enabled: integer("enabled").notNull().default(0),
  reviewedBy: text("reviewed_by").notNull(),
  reviewedAt: integer("reviewed_at").notNull(),
}, (table) => [primaryKey({ columns: [table.installationId, table.channelId, table.reportKey] }), check("report_channel_policies_enabled", sql`${table.enabled} IN (0,1)`)]);

export const reportJobs = sqliteTable("report_jobs", {
  runId: text("run_id").primaryKey(),
  invocationKey: text("invocation_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  installationId: text("installation_id").notNull(),
  projectId: text("project_id").notNull(),
  requesterId: text("requester_id").notNull(),
  channelId: text("channel_id").notNull(),
  configRevision: integer("config_revision").notNull(),
  requestJson: text("request_json").notNull(),
  configJson: text("config_json").notNull(),
  stage: text("stage").notNull().default("preflight"),
  attempt: integer("attempt").notNull().default(1),
  sequence: integer("sequence").notNull().default(0),
  fence: integer("fence").notNull().default(0),
  leaseUntil: integer("lease_until").notNull().default(0),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull().default(0),
  resultJson: text("result_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("report_jobs_invocation_key_idx").on(table.invocationKey)]);

export const slackReportDeliveries = sqliteTable("slack_report_deliveries", {
  runId: text("run_id").primaryKey(),
  installationId: text("installation_id").notNull(),
  channelId: text("channel_id").notNull(),
  rootThreadTs: text("root_thread_ts"),
  state: text("state").notNull().default("pending"),
  fileId: text("file_id"),
  artifactId: text("artifact_id"),
  fence: integer("fence").notNull().default(0),
  leaseUntil: integer("lease_until").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
