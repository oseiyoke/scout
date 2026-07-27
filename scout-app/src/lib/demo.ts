import type { ConnectorClient } from "./connectors";
import type { McpTool } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Demo mode fixture: "Acme Workspace". Serves MCP calls from local JSON so a
// sweep reliably yields ~5 varied proposals. Only the connector data is fake —
// sweeps, prompts and K3 calls are 100% real.
// ─────────────────────────────────────────────────────────────────────────────

const MEETINGS = `=== Transcript: Weekly Product Sync (yesterday, 45 min) ===
Attendees: you, Ada (eng lead), Marcus (design), Priya (PM)
[09:04] Priya: Where are we on the onboarding revamp?
[09:05] You: Designs are done. I'll send Marcus the annotated pricing doc by Thursday EOD so he can spec the paywall screens. That's on me.
[09:31] Ada: Reminder the v2.4 release branch cuts Monday. Anything not reviewed by then slips.
[09:32] You: I'll review Ada's PR #412 (auth token rotation) before the weekend. Promise.
[09:44] Marcus: Can we move Friday's design crit? I have a dentist appointment at 2.
[09:45] You: Works for me, propose a new time and I'll make it happen.

=== Transcript: 1:1 with Dana (your manager) (yesterday, 30 min) ===
[14:02] Dana: Board deck is due next Wednesday. I need your metrics section by Monday morning, latest.
[14:03] You: Monday morning, you'll have it.
[14:15] Dana: Also — how's the intern search? We lose the budget if we don't hire by end of month.
[14:16] You: I owe Rita in recruiting a shortlist. I'll get it to her this week.

=== Transcript: Standup (today, 15 min) ===
[10:01] Ada: Still blocked on PR #412 review — the token rotation touches prod auth so I don't want to merge blind.
[10:03] You: On it today, sorry Ada.
[10:12] Priya: Launch checklist for the 30th is in #launch-prep. Owners please confirm by Friday.`;

const EMAILS = `From: Rita Okafor <rita@acme.com> — Subject: Intern shortlist?? — 2 days ago — UNREAD
"Hi! Following up again — hiring committee meets Thursday and I need your top 3 intern candidates before then or we lose the req. 10 min is all I need. — Rita"

From: sam@northwind.com — Subject: Re: Partnership terms — 3 days ago — UNREAD
"Thanks for the call last week. Legal has signed off on our side — just waiting on your countersigned MSA to kick off onboarding. Can you send it this week? — Sam"

From: newsletter@techroundup.io — Subject: This week in AI infrastructure — 1 day ago — UNREAD
"Top stories: vector DB price war heats up, a new agent framework drops..."

From: Dana Whitfield <dana@acme.com> — Subject: Board metrics — 1 day ago — READ
"Reminder: metrics section Monday morning. Last quarter's format is fine, just update the numbers."

From: Marcus Lee <marcus@acme.com> — Subject: Design crit moved to Thu 3pm — 4 hours ago — UNREAD
"Moved it per your ok. Can you confirm the room? Calendar still shows the old slot too, you may want to delete it."

From: Ada Chen <ada@acme.com> — Subject: PR #412 ping — 3 hours ago — UNREAD
"Gentle ping — if this doesn't merge before the Monday branch cut, auth rotation slips a full release. Happy to pair on the review."

From: calendar-noreply@acme.com — Subject: Invitation: Q3 Planning @ Fri 2:00 PM — 2 hours ago — UNREAD
"Priya invited you to Q3 Planning (Fri 2:00–3:30 PM). Note: conflicts with Design Crit (Fri 2:00–3:00 PM) on your calendar."

From: travel@acme.com — Subject: Itinerary: NYC offsite — 5 days ago — READ
"Flight confirmed: UA 1182, departing Aug 4..."

From: Priya Nair <priya@acme.com> — Subject: Launch checklist owners — 6 hours ago — UNREAD
"Reminder to confirm your launch checklist items in #launch-prep by Friday. You own: pricing page, analytics dashboard, and the status-page update."

From: oss-contributor@github.dev — Subject: Question on your RFC — 4 days ago — UNREAD
"Hi! I implemented your RFC-88 proposal for webhook retries and have a design question before opening the PR..."

From: it-admin@acme.com — Subject: Password rotation policy update — 1 week ago — READ
"Starting next month, SSO passwords rotate every 90 days..."

From: jorge@acme.com — Subject: Coffee next week? — 3 days ago — UNREAD
"Back from sabbatical! Would love 20 min to catch up and hear what I missed."`;

const TASKS = `OPEN TASKS (6):
1. [overdue, due yesterday] Send Marcus annotated pricing doc (from Product Sync)
2. [due Monday 9am] Board deck: metrics section for Dana
3. [due Thursday] Intern shortlist top-3 for Rita
4. [due Friday] Confirm launch checklist ownership in #launch-prep
5. [no date] Review RFC-88 follow-up questions
6. [done] Book flights for NYC offsite`;

const SLACK = `#eng (recent):
Ada: "PR #412 still waiting on review — branch cut Monday, getting nervous 🙏"
Tolu: "can someone rubber-duck webhook retries with me after lunch?"

#launch-prep (recent):
Priya: "Checklist owners please confirm by Friday — still missing 3 confirmations."
Priya: "Launch is locked for the 30th, 10am PT. War room opens 9am."

#random (recent):
Marcus: "dentist survived. design crit officially Thu 3pm"
Dana: "reminder board pre-read goes out Tuesday"`;

const PRS = `OPEN PULL REQUESTS:
- PR #412 "auth: rotate session tokens" by Ada — opened 6 days ago, 0 reviews, touches src/auth/**, labeled release-blocker. CI green.
- PR #418 "dashboard: new usage chart" by Tolu — opened 2 days ago, 1 approval, mergeable.
- PR #390 "chore: bump deps" by bot — opened 3 weeks ago, stale, conflicts.`;

const DEMO_TOOLS: McpTool[] = [
  { name: "read_meetings", description: "Read recent meeting transcripts", inputSchema: { type: "object", properties: { range: { type: "string" } } } },
  { name: "search_gmail", description: "Search emails", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "task_my_open", description: "List my open tasks", inputSchema: { type: "object", properties: {} } },
  { name: "read_slack_messages", description: "Read recent Slack messages", inputSchema: { type: "object", properties: { channel: { type: "string" } } } },
  { name: "list_prs", description: "List open GitHub pull requests", inputSchema: { type: "object", properties: {} } },
  { name: "task_create", description: "Create a task for the user", inputSchema: { type: "object", properties: { title: { type: "string" }, due: { type: "string" } }, required: ["title"] } },
  { name: "send_email", description: "Send an email", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "post_slack_message", description: "Post a Slack message", inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } }, required: ["channel", "text"] } },
  { name: "comment_pr", description: "Comment on a pull request", inputSchema: { type: "object", properties: { pr: { type: "number" }, body: { type: "string" } }, required: ["pr", "body"] } },
];

export class DemoConnectorClient implements ConnectorClient {
  readonly createdArtifacts: { tool: string; args: Record<string, unknown> }[] = [];

  async listTools(): Promise<McpTool[]> {
    return DEMO_TOOLS;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    switch (name) {
      case "read_meetings":
        return { text: MEETINGS, isError: false };
      case "search_gmail":
        return { text: EMAILS, isError: false };
      case "task_my_open":
        return { text: TASKS, isError: false };
      case "read_slack_messages":
        return { text: SLACK, isError: false };
      case "list_prs":
        return { text: PRS, isError: false };
      case "task_create":
      case "send_email":
      case "post_slack_message":
      case "comment_pr":
        this.createdArtifacts.push({ tool: name, args });
        return {
          text: `[demo] ${name} executed successfully.\nArguments:\n${JSON.stringify(args, null, 2)}`,
          isError: false,
        };
      default:
        return { text: `Unknown demo tool: ${name}`, isError: true };
    }
  }
}
