<?php
/**
 * Synthetic company wiki for the wiki clone (BookStack on wiki.farm.test). No real people or policies.
 *   WIKI_PASS=... php wiki_seed.php            (run from anywhere; boots /dev/shm/clone-farm/wiki-www)
 * 25 users (editors), 4 shelves, 10 books, chapters, ~330 pages (policies, runbooks, onboarding, how-tos),
 * tags on most pages, ~300 comments. Every page has a "Key facts" list (<li><strong>Label:</strong> value</li>)
 * that read tasks ask about. Deterministic (mt_srand).
 */
$W = '/dev/shm/clone-farm/wiki-www';
chdir($W);
require "$W/vendor/autoload.php";
$app = require "$W/bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use BookStack\Users\Models\User;
use BookStack\Users\UserRepo;
use BookStack\Entities\Repos\{BookRepo, BookshelfRepo, ChapterRepo, PageRepo};
use BookStack\Activity\CommentRepo;

mt_srand(20261016);
function pick($a) { return $a[mt_rand(0, count($a) - 1)]; }
function chance($p) { return mt_rand() / mt_getrandmax() < $p; }
$PASS = getenv('WIKI_PASS') ?: 'farm';

// ---------- users ----------
$FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul', 'Leela', 'Aditya', 'Zoya', 'Farhan', 'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace'];
$LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali', 'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva'];
$repo = app(UserRepo::class);
$admin = User::query()->where('email', 'admin@admin.com')->first();
if ($admin) { $admin->name = 'Farm Admin'; $admin->email = 'farmadmin@farm.test'; $admin->password = Hash::make($PASS); $admin->save(); }
$admin = User::query()->where('email', 'farmadmin@farm.test')->first();
$users = [];
for ($i = 0; $i < 25; $i++) {
  $email = strtolower("{$FIRST[$i]}.{$LAST[$i]}@farm.test");
  $u = User::query()->where('email', $email)->first() ?: $repo->createWithoutActivity(['name' => "{$FIRST[$i]} {$LAST[$i]}", 'email' => $email, 'password' => $PASS, 'roles' => [2]], true);
  $users[] = $u;
}
echo "users: " . count($users) . "\n";
// Editors may comment (this BookStack version leaves comment permissions off the Editor role).
DB::statement("INSERT IGNORE INTO permission_role (permission_id, role_id) SELECT id, 2 FROM role_permissions WHERE name IN ('comment-create-all','comment-update-own','comment-delete-own')");
if (\BookStack\Entities\Models\Book::query()->count() > 0) { echo "content exists, skipping\n"; exit(0); }

// ---------- content ----------
$OWNERS = array_map(fn($u) => $u->name, $users);
$TEAMS = ['Platform', 'Payments', 'Mobile', 'Data', 'Support', 'Finance', 'People Ops', 'Security', 'Marketing', 'Sales'];
$TOOLS = ['Grafana', 'PagerDuty', 'Jira', 'Kanboard', 'Vault', 'Terraform', 'Postgres', 'Redis', 'Kafka', 'Nginx', 'Mattermost', 'Nextcloud'];
$FREQ = ['every week', 'every two weeks', 'every month', 'every quarter', 'every six months', 'once a year'];

$PLAN = [
  'Company Handbook' => [
    'Policies' => ['Leave Policy', 'Travel and Expense Policy', 'Remote Work Policy', 'Code of Conduct', 'Information Security Policy', 'Device Policy', 'Data Retention Policy', 'Procurement Policy', 'Gift and Hospitality Policy', 'Whistleblower Policy', 'Anti-Harassment Policy', 'Social Media Policy', 'Overtime Policy', 'Relocation Policy', 'Training Budget Policy', 'Parental Leave Policy', 'Holiday Calendar 2026', 'Expense Approval Matrix', 'Password Policy', 'Visitor Policy', 'Conflict of Interest Policy', 'Petty Cash Policy', 'Laptop Refresh Policy', 'Internet Reimbursement Policy', 'Notice Period Policy', 'Bonus Policy', 'Referral Policy', 'Sabbatical Policy', 'Wellness Allowance Policy', 'Clean Desk Policy', 'Acceptable Use Policy', 'Business Continuity Policy', 'Vendor Payment Policy', 'Health Insurance Policy'],
    'Office and Facilities' => ['Pune Office Guide', 'Bengaluru Office Guide', 'Meeting Room Booking', 'Parking Rules', 'Pantry and Lunch', 'Access Cards', 'Fire Safety Drill', 'Printer Setup', 'Guest Wi-Fi', 'Lost and Found', 'Office Hours', 'Courier and Mail', 'Housekeeping Schedule', 'First Aid Kits', 'Emergency Contacts', 'Air Conditioning Requests', 'Desk Booking', 'Shuttle Timings', 'Event Spaces', 'Locker Allocation'],
  ],
  'Engineering' => [
    'Runbooks' => array_merge(...array_map(fn($s) => ["$s: High CPU", "$s: Restart Procedure", "$s: Failover", "$s: Disk Full"], ['API Gateway', 'Payments Service', 'Search Cluster', 'Postgres Primary', 'Redis Cache', 'Kafka Brokers', 'Auth Service', 'Notification Worker', 'Image Resizer', 'Billing Cron'])),
    'Engineering Practices' => ['Code Review Guidelines', 'Branching Strategy', 'Release Process', 'Incident Severity Levels', 'Postmortem Template', 'On-call Handbook', 'API Versioning', 'Feature Flags', 'Testing Pyramid', 'Database Migrations', 'Logging Standards', 'Secrets Management', 'Dependency Upgrades', 'Performance Budgets', 'Accessibility Checklist', 'Mobile Release Train', 'Architecture Decision Records', 'Service Ownership', 'Error Budgets', 'Load Testing', 'Deploy Freeze Calendar', 'Pull Request Template', 'Monorepo Layout', 'Local Dev Setup', 'Observability Basics', 'Cost Monitoring', 'Data Backups', 'Disaster Recovery Plan', 'SLA Definitions', 'Third-party Integrations'],
    'How-to Guides' => ['How to Request VPN Access', 'How to Rotate an API Key', 'How to Add a Feature Flag', 'How to Run Migrations Locally', 'How to Read a Flame Graph', 'How to Restore a Backup', 'How to Page the On-call', 'How to Write a Runbook', 'How to Request a New Repo', 'How to Get Production Access', 'How to Debug a Slow Query', 'How to Tag a Release', 'How to Add a Grafana Panel', 'How to Rotate TLS Certificates', 'How to Clear the CDN Cache', 'How to Add a Cron Job', 'How to Request a Sandbox', 'How to Run Load Tests', 'How to Update Dependencies', 'How to Archive a Service', 'How to Add a Webhook', 'How to Change DNS', 'How to Invite a Contractor', 'How to File a Security Issue', 'How to Write a Postmortem', 'How to Set Up SSO', 'How to Use the Staging Data', 'How to Request a Laptop Upgrade', 'How to Profile the Mobile App', 'How to Add a Translation'],
    'Systems' => ['Payments Architecture', 'Search Architecture', 'Auth and SSO', 'Data Warehouse', 'Event Bus', 'Mobile App Architecture', 'Web Frontend', 'Admin Console', 'Notification Pipeline', 'Billing System', 'Reporting Jobs', 'CDN Setup', 'DNS Records', 'Kubernetes Clusters', 'CI Pipeline', 'Staging Environment', 'Feature Store', 'ML Ranking Service', 'Audit Logging', 'Rate Limiting'],
  ],
  'Operations' => [
    'Support Playbooks' => ['Refund Requests', 'Account Lockout', 'Password Reset Help', 'Order Not Delivered', 'Invoice Corrections', 'Escalation Matrix', 'VIP Customers', 'Chat Macros', 'Bug Report Triage', 'Outage Communication', 'GDPR and DPDP Requests', 'Chargebacks', 'Duplicate Payments', 'Subscription Cancellations', 'Coupon Issues', 'Shipping Delays', 'Address Changes', 'Data Export Requests', 'Phone Support Hours', 'Feedback Tagging', 'Satisfaction Surveys', 'Holiday Coverage', 'Language Support', 'Abuse Reports', 'Account Merges'],
    'Customer FAQs' => ['How do I change my plan?', 'How do I get an invoice?', 'Can I pay with UPI?', 'How do refunds work?', 'How do I delete my account?', 'How do I export my data?', 'Why was my card declined?', 'How do I add a team member?', 'How do I reset two-factor login?', 'What are the support hours?', 'Do you offer student discounts?', 'How do I update my GST number?', 'Can I pause my subscription?', 'How do I change the billing email?', 'Where is my order?', 'How do I report a bug?', 'Is my data stored in India?', 'How do I cancel an order?', 'What is the SLA for enterprise plans?', 'How do I apply a coupon?', 'How do I change my address?', 'Can I transfer my account?', 'How do I download receipts?', 'What payment methods do you accept?', 'How do I contact sales?', 'How do I upgrade to annual billing?', 'How do I get a refund for a duplicate charge?', 'How do I verify my email?', 'Can I use the app offline?', 'How do I join the beta?'],
    'Finance Procedures' => ['Month-end Close', 'Vendor Onboarding', 'Purchase Orders', 'GST Filing', 'TDS Deductions', 'Payroll Calendar', 'Expense Reimbursement', 'Corporate Cards', 'Budget Requests', 'Audit Preparation', 'Invoice Approval', 'Bank Reconciliation', 'Travel Advances', 'Asset Register', 'Insurance Renewals', 'Revenue Recognition', 'Foreign Payments', 'Cash Flow Forecast', 'Cost Centres', 'Year-end Checklist'],
  ],
  'People' => [
    'Onboarding' => ['Welcome to Northwind Labs', 'Your First Day', 'Your First Week', 'Accounts and Access', 'Laptop Setup', 'Meet the Teams', 'Buddy Programme', 'Benefits Overview', 'Payroll and Payslips', 'Tools We Use', 'How We Communicate', 'Glossary', 'Org Chart', 'Probation Review', 'Learning Resources', 'Engineering Onboarding', 'Sales Onboarding', 'Support Onboarding', 'Design Onboarding', 'Manager Onboarding', 'Intern Onboarding', 'Remote Onboarding', 'Security Training', 'Office Tour', 'FAQ for New Joiners'],
    'Hiring' => ['Interview Process', 'Interview Scorecards', 'Take-home Assignments', 'Offer Approval', 'Background Checks', 'Campus Hiring', 'Referral Process', 'Recruiter Agencies', 'Job Description Templates', 'Hiring Committee', 'Diversity Hiring', 'Candidate Experience', 'Salary Bands', 'Relocation Support', 'Rejection Emails', 'Interviewer Training', 'Hiring Metrics', 'Headcount Planning', 'Internship Programme', 'Contractor Hiring'],
    'Growth and Reviews' => ['Performance Review Cycle', 'Promotion Process', 'Career Ladder: Engineering', 'Career Ladder: Design', 'Career Ladder: Support', 'One-on-ones', 'Feedback Guidelines', 'Goal Setting', 'Mentorship', 'Learning Budget', 'Conference Policy', 'Internal Transfers', 'Exit Interviews', 'Recognition Awards', 'Engagement Survey'],
  ],
];
$SHELF_DESC = ['Company Handbook' => 'Policies, office guides and everyday rules.', 'Engineering' => 'Runbooks, practices and system docs.', 'Operations' => 'Support playbooks and finance procedures.', 'People' => 'Onboarding, hiring and growth.'];
$TAGS = ['policy', 'runbook', 'how-to', 'onboarding', 'finance', 'support', 'security', 'hr', 'office', 'architecture', 'process', 'checklist'];

function facts($title) {
  global $OWNERS, $TEAMS, $TOOLS, $FREQ;
  $f = [['Owner', pick($OWNERS)], ['Team', pick($TEAMS)], ['Last reviewed', date('F j, Y', strtotime('2026-10-01') - mt_rand(5, 300) * 86400)], ['Review cycle', pick($FREQ)]];
  if (stripos($title, 'policy') !== false || stripos($title, 'leave') !== false) $f[] = ['Applies to', pick(['all employees', 'full-time employees', 'employees and contractors', 'people managers', 'employees in India'])];
  if (preg_match('/High CPU|Restart|Failover|Disk Full/', $title)) { $f[] = ['Escalation', pick(['#oncall-platform', '#oncall-payments', '#oncall-data', 'PagerDuty: Platform primary'])]; $f[] = ['Dashboard', pick($TOOLS) . ' / ' . pick(['Service health', 'Latency', 'Saturation', 'Errors'])]; $f[] = ['Time to resolve', mt_rand(10, 90) . ' minutes']; }
  if (preg_match('/Expense|Reimburse|Allowance|Budget|Cash|Card|Advance/', $title)) $f[] = ['Limit', '₹' . number_format(mt_rand(5, 200) * 500)];
  if (preg_match('/Leave|Sabbatical|Parental/', $title)) $f[] = ['Days per year', (string) mt_rand(6, 30)];
  if (preg_match('/Office|Parking|Shuttle|Pantry|Room|Desk/', $title)) $f[] = ['Location', pick(['Pune, Baner', 'Pune, Kharadi', 'Bengaluru, Indiranagar', 'Bengaluru, HSR Layout'])];
  if (preg_match('/Onboarding|First|Welcome|Buddy/', $title)) $f[] = ['Contact', pick(['people@northwind.test', 'it-help@northwind.test', 'buddy@northwind.test'])];
  if (preg_match('/Hiring|Interview|Offer|Campus|Salary|Referral/', $title)) $f[] = ['Approver', pick(['Head of People', 'Hiring Manager', 'CFO', 'VP Engineering'])];
  if (count($f) < 6) $f[] = ['Tool', pick($TOOLS)];
  return $f;
}
function body($title, $facts) {
  global $TOOLS;
  $h = "<p>This page describes the <strong>$title</strong> at Northwind Labs. Read it before you start, and ask the owner if anything is unclear.</p>";
  $h .= '<h2>Key facts</h2><ul>';
  foreach ($facts as [$k, $v]) $h .= "<li><strong>$k:</strong> $v</li>";
  $h .= '</ul><h2>Overview</h2><p>' . pick(['The goal is to keep this simple and predictable for everyone.', 'We wrote this after several questions came up in the team channel.', 'This replaces the older version from last year.', 'Most of the steps can be done in under ten minutes.']) . ' ' . pick(['Changes are announced in the #announcements channel.', 'Exceptions need written approval from the owner.', 'Templates are linked at the end of this page.', 'Use ' . pick($TOOLS) . ' to track requests.']) . '</p>';
  $h .= '<h2>Steps</h2><ol>';
  foreach (array_slice(['Open a request in the ' . pick($TOOLS) . ' queue.', 'Fill in the form with the details listed above.', 'Tag the owner and wait for approval.', 'Follow the checklist and record each step.', 'Confirm with the requester and close the request.', 'Update this page if something changed.'], 0, mt_rand(3, 6)) as $s) $h .= "<li>$s</li>";
  $h .= '</ol><h2>Notes</h2><p>' . pick(['If you are blocked for more than a day, escalate.', 'Keep records for at least 8 years for audit.', 'This applies from April 1, 2026.', 'Contact the owner for anything not covered here.']) . '</p>';
  return $h;
}

$byEmail = fn($u) => $u;
$shelfRepo = app(BookshelfRepo::class); $bookRepo = app(BookRepo::class); $chapterRepo = app(ChapterRepo::class); $pageRepo = app(PageRepo::class); $commentRepo = app(CommentRepo::class);
$COMMENTS = ['Thanks, this is very helpful.', 'Is this still up to date?', 'Can we add an example here?', 'Updated the steps after last week\'s incident.', 'The link in step 2 is broken.', 'Who approves exceptions to this?', 'Great summary, sharing with my team.', 'Please add the new office address.'];
$nPages = 0; $nComments = 0;
foreach ($PLAN as $shelfName => $books) {
  auth()->login($admin);
  $bookIds = [];
  foreach ($books as $bookName => $titles) {
    $book = $bookRepo->create(['name' => $bookName, 'description_html' => "<p>$bookName for Northwind Labs.</p>", 'tags' => [['name' => 'area', 'value' => strtolower($shelfName)]]]);
    $bookIds[] = $book->id;
    // Group pages into chapters of ~8 (some pages stay at book level).
    $chunks = array_chunk($titles, 8);
    foreach ($chunks as $ci => $chunk) {
      $parent = $book;
      if ($ci > 0 || count($chunks) == 1) {
        $cname = pick(['Basics', 'Guides', 'Reference', 'Procedures', 'Checklists', 'Advanced', 'Templates', 'Archive notes']) . ' ' . ($ci + 1);
        $parent = $chapterRepo->create(['name' => $cname, 'description_html' => "<p>$cname.</p>"], $book);
      }
      foreach ($chunk as $title) {
        $author = pick($users); auth()->login($author);
        $f = facts($title);
        $draft = $pageRepo->getNewDraftPage($parent);
        $tags = [];
        foreach (array_slice(array_unique([pick($GLOBALS['TAGS']), pick($GLOBALS['TAGS'])]), 0, mt_rand(0, 2)) as $t) $tags[] = ['name' => $t, 'value' => ''];
        $page = $pageRepo->publishDraft($draft, ['name' => $title, 'html' => body($title, $f), 'tags' => $tags]);
        $nPages++;
        for ($k = pick([0, 0, 0, 1, 1, 2]); $k > 0; $k--) { auth()->login(pick($users)); $commentRepo->create($page, '<p>' . pick($COMMENTS) . '</p>', null, ''); $nComments++; }
      }
    }
  }
  auth()->login($admin);
  $shelfRepo->create(['name' => $shelfName, 'description_html' => '<p>' . $SHELF_DESC[$shelfName] . '</p>'], $bookIds);
}
// Default view settings: list view for books/shelves is easier to read in an accessibility tree.
setting()->put('app-name', 'Northwind Wiki');
// Some view history, so "popular" lists (home page, move dialog) are not empty: books first, then chapters and pages.
foreach (DB::table('entities')->whereIn('type', ['book', 'chapter', 'page'])->get(['id', 'type']) as $e) {
  if ($e->type === 'page' && !chance(0.3)) continue;
  DB::table('views')->insert(['user_id' => pick($users)->id, 'viewable_id' => $e->id, 'viewable_type' => $e->type, 'views' => $e->type === 'book' ? mt_rand(200, 400) : ($e->type === 'chapter' ? mt_rand(20, 120) : mt_rand(1, 60)), 'created_at' => now(), 'updated_at' => now()]);
}
Artisan::call('bookstack:regenerate-permissions');
Artisan::call('bookstack:regenerate-search');
echo "pages: $nPages comments: $nComments\n";
