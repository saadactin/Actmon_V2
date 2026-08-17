/**
 * Administration chapter. Grounded in pages/administration/* and
 * config/adminResources.jsx.
 */
import { DOCS, icon } from '../helpContent';

export const ADMIN_TOPICS = [
  ['adm-overview', 'Administration Overview'],
  ['adm-users-roles', 'Users, Roles & Organization Structure'],
  ['adm-catalog', 'Permissions, Modules & Pages Catalogue'],
  ['adm-role-page-permission', 'Granting Page Permissions'],
  ['adm-audit-security', 'Audit Logs & Security Tracking'],
  ['adm-ai-chat-sessions', 'AI Chat Sessions Audit'],
  ['adm-permissions', 'Permissions Required for Administration Itself'],
  ['adm-troubleshooting', 'Troubleshooting'],
  ['adm-reference', 'Administration Reference'],
];

DOCS['adm-overview'] = {
  title: 'Administration Overview',
  dek: 'What the Administration module manages, and its real resource list.',
  crumbs: ['ActMon Documentation', 'Administration', 'Overview'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>The Administration module (<code>/administration</code>) is ActMon's access-control and organizational
    hub — users, roles, page-level permissions, the org/department/designation/employee structure, and
    read-only audit trails. It's RBAC-filtered per signed-in user — you only see the resources your role has
    view access to.</p>
    <h2>Real resources</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Resource</th><th>Actions</th></tr>
      <tr><td>Roles</td><td>Add / Edit / Delete / View — organization-scoped</td></tr>
      <tr><td>Group Role Permissions</td><td>Grant/Edit/Delete page access, Clone to another role (its own bespoke page — see <button onclick="go('adm-role-page-permission')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Granting Page Permissions</button>)</td></tr>
      <tr><td>User Master</td><td>Add / Edit / Delete / View — shows Account Locked/OK badge</td></tr>
      <tr><td>Employees</td><td>Add / Edit / Delete / View; can offer to auto-create a linked login account</td></tr>
      <tr><td>Departments / Designations</td><td>Add / Edit / Delete / View — organization-scoped</td></tr>
      <tr><td>Permissions</td><td>Add / Edit / Delete / View — the global bitwise permission catalogue</td></tr>
      <tr><td>Modules / Pages</td><td>Add / Edit / Delete / View — the global navigation/RBAC catalogue</td></tr>
      <tr><td>Organizations</td><td>Add / Edit / Delete / View</td></tr>
      <tr><td>Audit Logs / Login History / User Sessions / Password History</td><td>Read-only — see <button onclick="go('adm-audit-security')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Audit Logs &amp; Security Tracking</button></td></tr>
      <tr><td>AI Chat Sessions</td><td>Read-only audit viewer — see <button onclick="go('adm-ai-chat-sessions')" style="all:unset;cursor:pointer;color:var(--accent-ink)">AI Chat Sessions Audit</button></td></tr>
    </table></div>
  `,
};

DOCS['adm-users-roles'] = {
  title: 'Users, Roles & Organization Structure',
  dek: 'The people/access side of Administration: Users, Roles, Employees, Departments, Designations, Organizations.',
  crumbs: ['ActMon Documentation', 'Administration', 'Users, Roles & Structure'],
  module: 'Administration', status: 'Complete',
  body: `
    <h2>User Master</h2>
    <p>Fields: Username (required), Role (select, required), Employee (select, required), Password (blank on
    edit means "keep current" — never pre-filled with a real value), Organization, Active toggle. The list shows
    an Account Locked / OK badge per user.</p>
    <h2>Roles</h2>
    <p>Organization, Role Name (required), Active toggle, Description. Organization-scoped — a role belongs to
    one organization.</p>
    <h2>Employees</h2>
    <p>Name (required), Code (auto-generated if left blank), Email, Mobile, Department, Designation, Joining
    Date, Reporting Manager, Organization, Active. After creating an employee, ActMon can offer to
    auto-create a linked User login for them in the same flow.</p>
    <h2>Departments &amp; Designations</h2>
    <p>Both are simple, organization-scoped catalogues: Name (required), Code, Description, Active.</p>
    <h2>Organizations</h2>
    <p>A full multi-tenant profile: Name, Code, Legal Name, GST No., PAN No., Registration No., Contact Person,
    Contact No., Alt. Contact, Email, Website, Logo URL, Country/State/City, Address lines, Pincode, Active.</p>
  `,
};

DOCS['adm-catalog'] = {
  title: 'Permissions, Modules & Pages Catalogue',
  dek: 'The three global catalogues that Role → Page Permission grants are built from.',
  crumbs: ['ActMon Documentation', 'Administration', 'Permissions/Modules/Pages Catalogue'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>Three global (not organization-scoped) catalogues underpin the entire access-control system:</p>
    <h2>Permissions</h2>
    <p>The bitwise permission catalogue — Name, Bit Value (auto-suggested as the next power of 2), Active. This
    is what "View," "Add," "Edit," "Delete," "Execute" and similar grant-able permissions actually are under the
    hood — a bitmask, summed across whichever permissions are granted on a page.</p>
    <h2>Modules</h2>
    <p>The top-level navigation entries — Name, Code, Description, Route, Icon name, Display Order, Active.</p>
    <h2>Pages</h2>
    <p>The full page/route tree — Module (select), Parent Page (select, optional), Name, URL, Code, Description,
    Icon name, Display Order, "Show in menu" checkbox, Active. Pages nest under a parent (module → parent page →
    sub-page), which is exactly the tree that
    <button onclick="go('adm-role-page-permission')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Granting Page Permissions</button>
    drills through.</p>
  `,
};

DOCS['adm-role-page-permission'] = {
  title: 'Granting Page Permissions',
  dek: 'The Module → Parent Page → Sub Page cascade, permission bitmask, and Clone-to-another-role.',
  crumbs: ['ActMon Documentation', 'Administration', 'Granting Page Permissions'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>Group Role Page Permission is its own dedicated page, drilling: <b>Organization → Role (within that org)
    → Module → granted pages</b> (a drillable tree by parent/sub-page).</p>
    <h2>Grant a Page wizard</h2>
    <ol class="steps">
      <li>Pick <b>Module → Parent Page → Sub Page</b>. The Sub Page list is a flattened, indented, depth-first
      walk of <em>every</em> descendant page (not just direct children), so a deeply-nested page tree stays
      individually reachable rather than collapsing after two levels.</li>
      <li>Pick permissions via a multi-select picker. The saved <code>permission</code> value is simply the sum
      of the selected permissions' bit values.</li>
    </ol>
    <h2>Cascading grants</h2>
    <p>Saving a grant on a page also writes the identical permission bitmask to <em>every</em> descendant of
    that page automatically — granting a parent page's access genuinely cascades down its whole subtree, it
    isn't just a display convenience.</p>
    <h2>Clone to…</h2>
    <p>Copies one role's entire permission set to another role, in one of two modes:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Mode</th><th>Behavior</th></tr>
      <tr><td>Merge</td><td>Adds/overwrites the target role's grants with the source's — the target's own extra grants are kept.</td></tr>
      <tr><td>Replace</td><td>An exact copy — any grant the target had that the source doesn't is removed.</td></tr>
    </table></div>
    <div class="warnbox"><b>Self-lockout guard</b>${icon('alerts', 14)}<span>Viewing or editing permissions for
    your <em>own</em> current role is blocked and shown read-only — even for a super-admin. This prevents
    accidentally revoking your own access.</span></div>
    <p>"Full Access" (bit value 255) is a catalog sentinel, not an individually-grantable permission — it's
    excluded from the permission picker's selectable list.</p>
  `,
};

DOCS['adm-audit-security'] = {
  title: 'Audit Logs & Security Tracking',
  dek: 'The four read-only audit resources: Audit Logs, Login History, User Sessions, Password History.',
  crumbs: ['ActMon Documentation', 'Administration', 'Audit Logs & Security Tracking'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>Four resources exist purely for audit visibility — none has an Add/Edit/Delete action.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Resource</th><th>What it captures</th></tr>
      <tr><td>Audit Logs</td><td>Every insert/update/delete the app has made — table name, action type (color-coded INSERT/UPDATE/DELETE badge), record id, user, IP address, timestamp, and full before/after JSON (<code>old_data</code>/<code>new_data</code>).</td></tr>
      <tr><td>Login History</td><td>Sign-in attempts — user, employee, status, IP, device, browser, OS.</td></tr>
      <tr><td>User Sessions</td><td>Active/past sessions — user, employee, IP, device. (The session token itself is never shown here — see the security note below.)</td></tr>
      <tr><td>Password History</td><td>Timestamps of password changes per user — never the password data itself.</td></tr>
    </table></div>
    <div class="tip"><b>Row-level change tracking is real</b>${icon('tip', 14)}<span>Audit Logs is not a
    generic activity feed — it captures the actual before/after JSON of every tracked database write, which is
    what makes it useful for reconstructing exactly what changed on a given record.</span></div>
  `,
};

DOCS['adm-ai-chat-sessions'] = {
  title: 'AI Chat Sessions Audit',
  dek: 'A permission-gated audit viewer over every ActMon AI conversation across users.',
  crumbs: ['ActMon Documentation', 'Administration', 'AI Chat Sessions Audit'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>A separate, permission-gated page (not a <code>config/adminResources.jsx</code> CRUD resource) listing
    every ActMon AI chat conversation across users the caller is allowed to see. Filters: search (title/message
    content), User, Organization, date range. Columns: User, Organization, Conversation title, Last Message,
    Created, Updated, and an <b>"Open"</b> button opening a read-only dialog with the full transcript.</p>
    <div class="warnbox"><b>Org-scoping is enforced server-side</b>${icon('alerts', 14)}<span>A non-super-admin
    with this permission only ever sees conversations from their own organization — only a true super-admin can
    cross organization boundaries here.</span></div>
    <p>See also <button onclick="go('ai-chat-usage')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Using the ActMon AI Chat Assistant</button>
    for what these conversations actually contain.</p>
  `,
};

DOCS['adm-permissions'] = {
  title: 'Permissions Required for Administration Itself',
  dek: 'What access is required to view or manage Administration resources.',
  crumbs: ['ActMon Documentation', 'Administration', 'Permissions'],
  module: 'Administration', status: 'Complete',
  body: `
    <p>Every resource under Administration is itself gated by the same Role → Page → Permission system
    documented in <button onclick="go('adm-role-page-permission')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Granting Page Permissions</button>
    — a role needs an explicit grant on the relevant page (e.g. "Users," "Roles," "Audit Logs") before its
    members can see or act on it. The Administration hub itself only lists modules the signed-in user's role has
    view access to; resources with no grant simply don't appear.</p>
  `,
};

DOCS['adm-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common Administration problems.',
  crumbs: ['ActMon Documentation', 'Administration', 'Troubleshooting'],
  module: 'Administration', status: 'Complete',
  body: `
    <h2>Permission Denied on an Administration page</h2>
    <p><b>Cause:</b> Your role doesn't have a grant for that specific page yet — RBAC in ActMon is per-page, per-
    permission, not a coarse "is admin" flag.</p>
    <p><b>Resolution:</b> Ask a user who does have Administration → Group Role Permissions access to grant your
    role View (and Edit/Delete/Execute as appropriate) on the specific page you need — see
    <button onclick="go('adm-role-page-permission')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Granting Page Permissions</button>.</p>

    <h2>I can't view/edit permissions for my own role</h2>
    <p><b>Cause:</b> This is the intentional self-lockout guard — even a super-admin cannot edit their own
    current role's permissions from the UI, to prevent accidentally revoking their own access.</p>
    <p><b>Resolution:</b> Have a different admin account (with permission-management access) make the change, or
    switch to a different role temporarily if your account has more than one.</p>

    <h2>A new user can't sign in / "Account Locked"</h2>
    <p><b>How to verify:</b> Check the User Master list — the Account Locked/OK badge shows the account's
    current lock state directly.</p>
    <p><b>Resolution:</b> Edit the user record to clear the locked state (if your role permits), and confirm
    their assigned Role has an actual page grant with the "View" permission on at least one module — a role with
    zero page grants can technically sign in but will see nothing.</p>
  `,
};

DOCS['adm-reference'] = {
  title: 'Administration Reference',
  dek: 'Consolidated reference — every resource and its route.',
  crumbs: ['ActMon Documentation', 'Administration', 'Reference'],
  module: 'Administration', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Resource</th></tr>
      <tr><td><code>/administration[/:orgId]</code></td><td>Hub</td></tr>
      <tr><td><code>/role-permissions[/:orgId[/:roleId]]</code></td><td>Group Role Page Permission</td></tr>
      <tr><td><code>/roles</code></td><td>Roles</td></tr>
      <tr><td><code>/permissions</code></td><td>Permissions catalogue</td></tr>
      <tr><td><code>/modules</code></td><td>Modules catalogue</td></tr>
      <tr><td><code>/pages</code></td><td>Pages catalogue</td></tr>
      <tr><td><code>/organizations</code></td><td>Organizations</td></tr>
      <tr><td><code>/departments</code>, <code>/designations</code></td><td>Departments, Designations</td></tr>
      <tr><td><code>/employees</code>, <code>/users</code></td><td>Employees, User Master</td></tr>
      <tr><td><code>/audit-logs</code>, <code>/login-history</code>, <code>/user-sessions</code>, <code>/password-history</code></td><td>Read-only audit resources</td></tr>
      <tr><td><code>/ai-chat-sessions</code></td><td>AI Chat Sessions Audit</td></tr>
    </table></div>
  `,
};
