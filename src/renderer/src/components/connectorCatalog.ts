// Curated connector catalog — the "just hit Connect" gallery, tuned for tech
// knowledge workers (software engineering, design, product). Most major tools now
// ship HOSTED remote MCP endpoints with OAuth, so an entry is mostly a URL + auth
// type; a few are local (stdio) servers that need a token. Endpoints are
// best-known as of June 2026 and each stays editable after adding — this is a
// plain data file, trivial to correct/extend.
//
// auth:  'oauth' — hosted MCP runs OAuth in the browser on connect (no secret to paste)
//        'token' — local stdio server; we ask for the listed secrets → Keychain
//        'none'  — open endpoint, just connect
// ready: false = endpoint/flow still being verified (shown as "preview")

export interface CatalogSecret {
  key: string;
  label: string;
  placeholder?: string;
}

export type CatalogCategory =
  | 'Communication'
  | 'Docs & Knowledge'
  | 'Project & Issues'
  | 'Engineering'
  | 'Design'
  | 'Product & Analytics'
  | 'CRM & Sales'
  | 'Files & Storage'
  | 'Automation';

export interface CatalogEntry {
  id: string;
  name: string;
  blurb: string;
  category: CatalogCategory;
  color: string;
  letter: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  auth: 'oauth' | 'token' | 'none';
  secrets?: CatalogSecret[];
  docsUrl?: string;
  ready: boolean;
}

export const CATEGORY_ORDER: CatalogCategory[] = [
  'Communication',
  'Docs & Knowledge',
  'Project & Issues',
  'Engineering',
  'Design',
  'Product & Analytics',
  'CRM & Sales',
  'Files & Storage',
  'Automation',
];

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  // ---------- Communication ----------
  { id: 'gmail', name: 'Gmail', blurb: 'Read, draft, send email', category: 'Communication', color: '#EA4335', letter: 'M', transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth', docsUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers', ready: true },
  { id: 'google-calendar', name: 'Google Calendar', blurb: 'Events, availability, scheduling', category: 'Communication', color: '#4285F4', letter: 'C', transport: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'oauth', docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server', ready: true },
  { id: 'outlook', name: 'Outlook / 365', blurb: 'Microsoft mail + calendar', category: 'Communication', color: '#0078D4', letter: 'O', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://learn.microsoft.com/', ready: false },
  { id: 'slack', name: 'Slack', blurb: 'Channels, DMs, search', category: 'Communication', color: '#4A154B', letter: 'S', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], auth: 'token', secrets: [{ key: 'SLACK_BOT_TOKEN', label: 'Bot token', placeholder: 'xoxb-…' }, { key: 'SLACK_TEAM_ID', label: 'Team ID', placeholder: 'T0…' }], docsUrl: 'https://api.slack.com/', ready: false },
  { id: 'discord', name: 'Discord', blurb: 'Servers, channels, messages', category: 'Communication', color: '#5865F2', letter: 'D', transport: 'stdio', command: 'npx', args: ['-y', 'discord-mcp'], auth: 'token', secrets: [{ key: 'DISCORD_TOKEN', label: 'Bot token' }], docsUrl: 'https://discord.com/developers', ready: false },
  { id: 'zoom', name: 'Zoom', blurb: 'Meetings + recordings', category: 'Communication', color: '#2D8CFF', letter: 'Z', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://developers.zoom.us/', ready: false },
  { id: 'whatsapp', name: 'WhatsApp', blurb: 'Messages (local bridge)', category: 'Communication', color: '#25D366', letter: 'W', transport: 'stdio', command: 'npx', args: ['-y', 'whatsapp-mcp'], auth: 'token', secrets: [{ key: 'WHATSAPP_SESSION', label: 'Session / config' }], docsUrl: 'https://github.com/lharries/whatsapp-mcp', ready: false },

  // ---------- Docs & Knowledge ----------
  { id: 'notion', name: 'Notion', blurb: 'Pages, databases, docs', category: 'Docs & Knowledge', color: '#FFFFFF', letter: 'N', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', docsUrl: 'https://developers.notion.com/', ready: true },
  { id: 'confluence', name: 'Confluence', blurb: 'Atlassian wiki pages', category: 'Docs & Knowledge', color: '#172B4D', letter: 'C', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', docsUrl: 'https://www.atlassian.com/blog/announcements/remote-mcp-server', ready: false },
  { id: 'coda', name: 'Coda', blurb: 'Docs, tables, automations', category: 'Docs & Knowledge', color: '#F46A54', letter: 'C', transport: 'stdio', command: 'npx', args: ['-y', 'coda-mcp'], auth: 'token', secrets: [{ key: 'CODA_API_KEY', label: 'API key' }], docsUrl: 'https://coda.io/developers', ready: false },
  { id: 'obsidian', name: 'Obsidian', blurb: 'Local markdown vault', category: 'Docs & Knowledge', color: '#7C3AED', letter: 'O', transport: 'stdio', command: 'npx', args: ['-y', 'obsidian-mcp'], auth: 'token', secrets: [{ key: 'OBSIDIAN_VAULT_PATH', label: 'Vault path' }], docsUrl: 'https://obsidian.md/', ready: false },

  // ---------- Project & Issues ----------
  { id: 'linear', name: 'Linear', blurb: 'Issues, projects, cycles', category: 'Project & Issues', color: '#5E6AD2', letter: 'L', transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth', docsUrl: 'https://linear.app/docs', ready: true },
  { id: 'jira', name: 'Jira', blurb: 'Atlassian issues + boards', category: 'Project & Issues', color: '#0052CC', letter: 'J', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', docsUrl: 'https://www.atlassian.com/blog/announcements/remote-mcp-server', ready: true },
  { id: 'asana', name: 'Asana', blurb: 'Tasks, projects, portfolios', category: 'Project & Issues', color: '#F06A6A', letter: 'A', transport: 'http', url: 'https://mcp.asana.com/sse', auth: 'oauth', docsUrl: 'https://developers.asana.com/', ready: false },
  { id: 'clickup', name: 'ClickUp', blurb: 'Tasks, docs, goals', category: 'Project & Issues', color: '#7B68EE', letter: 'C', transport: 'stdio', command: 'npx', args: ['-y', '@clickup/mcp-server'], auth: 'token', secrets: [{ key: 'CLICKUP_API_KEY', label: 'API token' }], docsUrl: 'https://clickup.com/api', ready: true },
  { id: 'trello', name: 'Trello', blurb: 'Boards, cards, lists', category: 'Project & Issues', color: '#0079BF', letter: 'T', transport: 'stdio', command: 'npx', args: ['-y', 'trello-mcp'], auth: 'token', secrets: [{ key: 'TRELLO_API_KEY', label: 'API key' }, { key: 'TRELLO_TOKEN', label: 'Token' }], docsUrl: 'https://developer.atlassian.com/cloud/trello/', ready: true },
  { id: 'monday', name: 'Monday.com', blurb: 'Boards, items, workflows', category: 'Project & Issues', color: '#FF3D57', letter: 'M', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://developer.monday.com/', ready: false },
  { id: 'shortcut', name: 'Shortcut', blurb: 'Stories, epics, iterations', category: 'Project & Issues', color: '#3A2EFF', letter: 'S', transport: 'stdio', command: 'npx', args: ['-y', '@shortcut/mcp'], auth: 'token', secrets: [{ key: 'SHORTCUT_API_TOKEN', label: 'API token' }], docsUrl: 'https://developer.shortcut.com/', ready: false },

  // ---------- Engineering ----------
  { id: 'github', name: 'GitHub', blurb: 'Repos, issues, PRs, actions', category: 'Engineering', color: '#181717', letter: 'G', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], auth: 'token', secrets: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal access token', placeholder: 'github_pat_… or ghp_…' }], docsUrl: 'https://github.com/settings/tokens', ready: true },
  { id: 'gitlab', name: 'GitLab', blurb: 'Repos, MRs, pipelines', category: 'Engineering', color: '#FC6D26', letter: 'G', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], auth: 'token', secrets: [{ key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'Access token' }], docsUrl: 'https://docs.gitlab.com/', ready: true },
  { id: 'sentry', name: 'Sentry', blurb: 'Errors, issues, traces', category: 'Engineering', color: '#362D59', letter: 'S', transport: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', docsUrl: 'https://docs.sentry.io/product/sentry-mcp/', ready: true },
  { id: 'vercel', name: 'Vercel', blurb: 'Deploys, projects, logs', category: 'Engineering', color: '#FFFFFF', letter: 'V', transport: 'http', url: 'https://mcp.vercel.com', auth: 'oauth', docsUrl: 'https://vercel.com/docs/mcp', ready: true },
  { id: 'cloudflare', name: 'Cloudflare', blurb: 'Workers, DNS, observability', category: 'Engineering', color: '#F38020', letter: 'C', transport: 'http', url: 'https://observability.mcp.cloudflare.com/sse', auth: 'oauth', docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/', ready: false },
  { id: 'stripe', name: 'Stripe', blurb: 'Payments, customers, invoices', category: 'Engineering', color: '#635BFF', letter: 'S', transport: 'http', url: 'https://mcp.stripe.com', auth: 'oauth', docsUrl: 'https://docs.stripe.com/mcp', ready: false },
  { id: 'pagerduty', name: 'PagerDuty', blurb: 'Incidents, on-call, alerts', category: 'Engineering', color: '#06AC38', letter: 'P', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://developer.pagerduty.com/', ready: false },
  { id: 'postgres', name: 'PostgreSQL', blurb: 'Query a database (read-only)', category: 'Engineering', color: '#336791', letter: 'P', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], auth: 'token', secrets: [{ key: 'POSTGRES_CONNECTION_STRING', label: 'Connection string', placeholder: 'postgres://…' }], docsUrl: 'https://www.postgresql.org/', ready: false },

  // ---------- Design ----------
  { id: 'figma', name: 'Figma', blurb: 'Designs, dev mode, components', category: 'Design', color: '#F24E1E', letter: 'F', transport: 'http', url: 'http://127.0.0.1:3845/sse', auth: 'none', docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559', ready: false },
  { id: 'canva', name: 'Canva', blurb: 'Designs, brand, exports', category: 'Design', color: '#00C4CC', letter: 'C', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://www.canva.dev/', ready: false },

  // ---------- Product & Analytics ----------
  { id: 'posthog', name: 'PostHog', blurb: 'Product analytics, flags', category: 'Product & Analytics', color: '#1D4AFF', letter: 'P', transport: 'http', url: 'https://mcp.posthog.com/sse', auth: 'oauth', docsUrl: 'https://posthog.com/docs', ready: false },
  { id: 'amplitude', name: 'Amplitude', blurb: 'Events, funnels, cohorts', category: 'Product & Analytics', color: '#1F6FFF', letter: 'A', transport: 'stdio', command: 'npx', args: ['-y', 'amplitude-mcp'], auth: 'token', secrets: [{ key: 'AMPLITUDE_API_KEY', label: 'API key' }], docsUrl: 'https://amplitude.com/docs', ready: false },
  { id: 'mixpanel', name: 'Mixpanel', blurb: 'Events, reports, insights', category: 'Product & Analytics', color: '#7856FF', letter: 'M', transport: 'stdio', command: 'npx', args: ['-y', 'mixpanel-mcp'], auth: 'token', secrets: [{ key: 'MIXPANEL_SERVICE_ACCOUNT', label: 'Service account' }], docsUrl: 'https://developer.mixpanel.com/', ready: false },
  { id: 'intercom', name: 'Intercom', blurb: 'Conversations, users, help', category: 'Product & Analytics', color: '#1F8DED', letter: 'I', transport: 'http', url: 'https://mcp.intercom.com/sse', auth: 'oauth', docsUrl: 'https://developers.intercom.com/', ready: false },

  // ---------- CRM & Sales ----------
  { id: 'hubspot', name: 'HubSpot', blurb: 'CRM, contacts, deals', category: 'CRM & Sales', color: '#FF7A59', letter: 'H', transport: 'http', url: 'https://mcp.hubspot.com/anthropic', auth: 'oauth', docsUrl: 'https://developers.hubspot.com/mcp', ready: false },
  { id: 'salesforce', name: 'Salesforce', blurb: 'CRM objects, reports', category: 'CRM & Sales', color: '#00A1E0', letter: 'S', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://developer.salesforce.com/', ready: false },
  { id: 'attio', name: 'Attio', blurb: 'CRM records, lists, notes', category: 'CRM & Sales', color: '#111111', letter: 'A', transport: 'http', url: 'https://mcp.attio.com/mcp', auth: 'oauth', docsUrl: 'https://developers.attio.com/', ready: true },

  // ---------- Files & Storage ----------
  { id: 'google-drive', name: 'Google Drive', blurb: 'Files, docs, sheets', category: 'Files & Storage', color: '#1FA463', letter: 'D', transport: 'http', url: 'https://workspacemcp.googleapis.com', auth: 'oauth', docsUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers', ready: false },
  { id: 'airtable', name: 'Airtable', blurb: 'Bases, tables, records', category: 'Files & Storage', color: '#18BFFF', letter: 'A', transport: 'stdio', command: 'npx', args: ['-y', 'airtable-mcp-server'], auth: 'token', secrets: [{ key: 'AIRTABLE_API_KEY', label: 'Personal access token', placeholder: 'pat…' }], docsUrl: 'https://airtable.com/developers', ready: false },
  { id: 'dropbox', name: 'Dropbox', blurb: 'Files and folders', category: 'Files & Storage', color: '#0061FF', letter: 'D', transport: 'http', url: 'https://', auth: 'oauth', docsUrl: 'https://www.dropbox.com/developers', ready: false },

  // ---------- Automation ----------
  { id: 'zapier', name: 'Zapier', blurb: '8,000+ apps via one connector', category: 'Automation', color: '#FF4F00', letter: 'Z', transport: 'http', url: 'https://mcp.zapier.com/api/mcp/mcp', auth: 'oauth', docsUrl: 'https://zapier.com/mcp', ready: false },
];
