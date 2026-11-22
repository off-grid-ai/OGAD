"""Seed the sandbox mail and Nextcloud with fake data for the paid-agent tasks.

Runs inside the compose network (./sandbox.sh seed). Dates are relative to today, so re-run it
(./sandbox.sh reset) when the tasks' "tomorrow" and "next week" have drifted.
"""
import base64
import re
import imaplib
import io
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid

DOMAIN = "offgrid-mail.test"
ME = f"alex@{DOMAIN}"
NOW = datetime.now(timezone.utc).replace(microsecond=0)
TODAY = date.today()


# ---------------------------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------------------------
def msg(sender, to, subject, body, days_ago, hours=0):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = sender, to, subject
    when = NOW - timedelta(days=days_ago, hours=hours)
    m["Date"] = format_datetime(when)
    m["Message-ID"] = make_msgid(domain=DOMAIN)
    m.set_content(body)
    return m, when


def mail_items():
    thursday = (TODAY + timedelta(days=(3 - TODAY.weekday()) % 7 or 7)).strftime("%A %d %B")
    I = []  # (folder, message, when, seen, flagged)

    def add(folder, sender, subject, body, days_ago, hours=0, seen=True, to=ME):
        m, when = msg(sender, to, subject, body, days_ago, hours)
        I.append((folder, m, when, seen))

    # Unread, most recent first (paid-email-01)
    add("INBOX", f"Jordan Lee <jordan@{DOMAIN}>", "Office keys",
        "Hi Alex,\n\nI left the spare office keys at reception. Pick them up any time before Friday.\n\nJordan", 0, 2, seen=False)
    add("INBOX", f"Priya Shah <priya.shah@{DOMAIN}>", "Can we meet this week?",
        f"Hi Alex,\n\nCould we go through the Northwind proposal this week? Would {thursday} at 3pm work for you?\n\nThanks,\nPriya", 0, 5, seen=False)
    add("INBOX", f"Facilities <facilities@{DOMAIN}>", "Fire drill on Wednesday",
        "There will be a fire drill on Wednesday at 10:00. Please leave by the nearest exit.", 0, 9, seen=False)
    add("INBOX", f"Lena Novak <lena@{DOMAIN}>", "Slides for the board pack",
        "Hi Alex, the board slides are in Files under Board. Can you check page 4 before Monday?", 1, 3, seen=False)
    add("INBOX", f"Priya Shah <priya.shah@{DOMAIN}>", "Re: Northwind proposal draft",
        "Thanks, the draft reads well. One question: did you include the delivery costs?\n\nPriya", 4)

    # Q3 offsite thread (paid-email-03)
    add("INBOX", f"Sam Okafor <sam@{DOMAIN}>", "Q3 offsite: venue shortlist",
        "Three venues for the Q3 offsite: Lakeside Lodge, The Old Mill and Harbour House. Votes by Friday please.", 9)
    add("INBOX", f"Lena Novak <lena@{DOMAIN}>", "Re: Q3 offsite: venue shortlist", "The Old Mill gets my vote.", 8)
    add("INBOX", f"Sam Okafor <sam@{DOMAIN}>", "Q3 offsite agenda",
        "Draft agenda for the Q3 offsite attached in Files. Day 1 strategy, day 2 team sessions.", 6)
    add("INBOX", f"Travel Desk <travel@{DOMAIN}>", "Travel bookings for the Q3 offsite",
        "Please send your train preferences for the Q3 offsite by the 20th.", 3)

    # Unanswered questions (paid-email-04)
    add("INBOX", f"Marco Rossi <marco@{DOMAIN}>", "Budget sign-off",
        "Alex, can you approve the revised budget by Wednesday? It is in Files as Budget v3.", 2)
    add("INBOX", f"Lena Novak <lena@{DOMAIN}>", "Team photo",
        "Are you free for the team photo on the 28th at noon?", 5)

    # Northwind invoice (paid-email-05)
    add("INBOX", f"Northwind Supplies <billing@northwind.{DOMAIN}>", "Invoice NW-2291 for October supplies",
        "Dear Alex,\n\nPlease find invoice NW-2291 for $1,284.50, due in 30 days.\n\nNorthwind Supplies, Accounts", 3)

    # Vendor who has not replied in a week (paid-email-06): our ask in Sent, no reply
    add("Sent", f"Alex Rivera <{ME}>", "Quote for 40 office chairs",
        "Hi Dana,\n\nCould you send a quote for 40 ergonomic office chairs, delivered by the end of the month?\n\nThanks,\nAlex",
        8, to=f"Dana Fox, Brightline Furniture <dana@brightline.{DOMAIN}>")
    add("Sent", f"Alex Rivera <{ME}>", "Re: Can we meet?", "Tuesday works, see you then.", 12, to=f"Priya Shah <priya.shah@{DOMAIN}>")

    # Newsletters, old and new (paid-email-07)
    for days, name, subj in [(15, "The Weekly Brew", "Five new single-origin beans"),
                             (11, "Product Digest", "This week in product"),
                             (9, "The Weekly Brew", "Cold brew season"),
                             (2, "Product Digest", "Roadmaps that work"),
                             (1, "City Events", "What is on this weekend")]:
        add("INBOX", f"{name} <newsletter@news.{DOMAIN}>", f"[Newsletter] {subj}",
            f"{name}\n\n{subj}.\n\nYou receive this newsletter because you subscribed. Unsubscribe any time.", days)

    # Shipping confirmation (paid-email-08)
    add("INBOX", f"Larder & Co. <orders@shop.{DOMAIN}>", "Your order LC-10482 has shipped",
        "Good news: order LC-10482 is on its way.\n\nCarrier: Parcelwise\nTracking number: PW-7731-4402-9918\nExpected: in 2 days.", 1)
    return I


def seed_mail(password):
    imap = imaplib.IMAP4("mailserver", 143)
    imap.login(ME, password)
    for folder in ("Sent", "Drafts", "Archive"):
        imap.create(folder)
        imap.subscribe(folder)
    for folder in ("INBOX", "Sent", "Drafts", "Archive"):
        imap.select(folder)
        imap.store("1:*", "+FLAGS", "\\Deleted") if imap.search(None, "ALL")[1][0] else None
        imap.expunge()
    # Drop any folder the agent made last run (e.g. Offsite).
    for line in imap.list()[1]:
        name = re.search(r'\) "." (.*)$', line.decode()).group(1).strip('"')
        if name not in ("INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"):
            imap.delete(name)
    for folder, m, when, seen in mail_items():
        flags = "\\Seen" if seen else ""
        imap.append(folder, flags, imaplib.Time2Internaldate(when.timestamp()), m.as_bytes())
    imap.logout()
    print(f"mail: {len(mail_items())} messages")


# ---------------------------------------------------------------------------------------------
# Nextcloud
# ---------------------------------------------------------------------------------------------
BASE = "http://nextcloud"


def dav(method, path, user, password, body=None, ctype=None, ok=(200, 201, 204, 207, 404, 405)):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode())
    req.add_header("Host", "offgrid-cloud.test")
    req.add_header("X-Forwarded-Proto", "https")
    req.add_header("OCS-APIRequest", "true")
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        if e.code in ok:
            return e.code
        raise SystemExit(f"{method} {path}: {e.code} {e.read()[:300]!r}")


def docx(paragraphs):
    from docx import Document
    doc = Document()
    for p in paragraphs:
        doc.add_heading(p[2:], level=1) if p.startswith("# ") else doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def xlsx(rows, total_row=False):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(list(r))
    if total_row:
        n = len(rows)
        ws.append(["Total", f"=SUM(B2:B{n})"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def pdf(lines):
    text = "BT /F1 14 Tf 60 760 Td 18 TL " + " ".join(f"({l}) '" for l in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(text)} >>\nstream\n{text}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


FILES = {
    "Q3 plan.docx": lambda: docx([
        "# Q3 plan", "Goal: grow Northwind Supplies revenue 15% while holding costs flat.",
        "Launch the self-serve ordering portal by the end of July.", "Hire two account managers for the north region.",
        "Cut delivery times from five days to three by consolidating warehouses.",
        "Run the Q3 offsite at The Old Mill to set the H2 roadmap.",
        "Risks: supplier price rises and a slow portal launch."]),
    "Budget v1.xlsx": lambda: xlsx([("Item", "Cost"), ("Venue", 4200), ("Travel", 2600), ("Catering", 1900)], True),
    "Budget v2.xlsx": lambda: xlsx([("Item", "Cost"), ("Venue", 3900), ("Travel", 2600), ("Catering", 1700), ("AV hire", 450)], True),
    "Budget v3 final.xlsx": lambda: xlsx([("Item", "Cost"), ("Venue", 3900), ("Travel", 2450), ("Catering", 1750),
                                          ("AV hire", 450), ("Contingency", 600)], True),
    "Sales 2026.xlsx": lambda: xlsx([("Month", "Revenue"), ("January", 31200), ("February", 28900), ("March", 35400),
                                     ("April", 38750), ("May", 36100)]),
    "Roadmap.pdf": lambda: pdf(["Northwind portal roadmap", "Q3: self-serve ordering", "Q4: invoicing and returns",
                                "Q1: mobile app", "Q2: supplier marketplace"]),
    "Week 19/notes.md": lambda: (
        "# Week 19 notes\n\n- Portal: checkout flow done, payments in test.\n- Hiring: two account manager offers out.\n"
        "- Warehouse move slipped one week (lease signing).\n- Northwind asked for a delivery cost breakdown.\n"
        "- Next: QA on the portal, finalise offsite agenda.\n").encode(),
    "Board/Board pack.pdf": lambda: pdf(["Board pack", "Page 1: summary", "Page 4: cash flow"]),
}


def ics(summary, start, minutes, description="", attendees=(), location=""):
    end = start + timedelta(minutes=minutes)
    f = "%Y%m%dT%H%M%S"
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Offgrid sandbox//EN", "BEGIN:VEVENT",
             f"UID:{uuid.uuid4()}", f"DTSTAMP:{NOW.strftime('%Y%m%dT%H%M%SZ')}",
             f"DTSTART;TZID=UTC:{start.strftime(f)}", f"DTEND;TZID=UTC:{end.strftime(f)}", f"SUMMARY:{summary}"]
    if description:
        lines.append("DESCRIPTION:" + description.replace("\n", "\\n"))
    if location:
        lines.append(f"LOCATION:{location}")
    if attendees:
        lines.append(f"ORGANIZER;CN=Alex Rivera:mailto:{ME}")
        lines += [f"ATTENDEE;CN={a};PARTSTAT=ACCEPTED:mailto:{a.split()[0].lower()}@{DOMAIN}" for a in attendees]
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(lines).encode()


def at(day, hh, mm=0):
    return datetime(day.year, day.month, day.day, hh, mm)


def next_wd(wd, weeks=0):
    return TODAY + timedelta(days=(wd - TODAY.weekday() - 1) % 7 + 1 + 7 * weeks)


def events():
    team = ["Priya Shah", "Sam Okafor", "Lena Novak", "Marco Rossi", "Jordan Lee", "Dana Fox", "Chen Wu"]
    E = []
    for i in range(1, 11):
        day = TODAY + timedelta(days=i)
        if day.weekday() < 5:
            E.append(ics("Standup", at(day, 9, 30), 15, attendees=team[:4]))
    mon = next_wd(0)
    E += [ics("Sprint planning", at(mon, 10), 60, attendees=team[:3]),
          ics("All-hands", at(next_wd(1), 16), 60, attendees=team),
          ics("Lunch with Sam", at(next_wd(2), 12, 30), 60, attendees=["Sam Okafor"], location="Corner Cafe"),
          ics("Northwind quarterly review", at(next_wd(3), 14), 90, attendees=team[:6]),
          ics("1:1 Lena", at(next_wd(1), 13), 30, attendees=["Lena Novak"]),
          ics("Customer call: Brightline", at(TODAY + timedelta(days=1), 11), 45, attendees=["Dana Fox", "Marco Rossi"]),
          ics("Budget review", at(TODAY + timedelta(days=1), 15), 30, attendees=["Marco Rossi"]),
          # Friday afternoon: 13:00-14:00 and 16:00-17:00 busy, 14:00-16:00 free
          ics("Vendor demo", at(next_wd(4), 13), 60, attendees=["Dana Fox"]),
          ics("Weekly wrap-up", at(next_wd(4), 16), 60, attendees=team[:5]),
          ics("Team meeting", datetime(2026, 5, 12, 10), 60, attendees=team[:4],
              description="Agenda:\n1. Portal launch status\n2. Hiring update\n3. Warehouse move\n4. Q3 offsite planning\n5. AOB")]
    return E


def seed_cloud(user, password):
    dav("PROPFIND", f"/remote.php/dav/files/{user}/", user, password, ctype="application/xml")
    for name in FILES:
        dav("DELETE", f"/remote.php/dav/files/{user}/{urllib.request.quote(name.split('/')[0])}", user, password)
    for name, make in FILES.items():
        if "/" in name:
            dav("MKCOL", f"/remote.php/dav/files/{user}/{urllib.request.quote(name.split('/')[0])}", user, password)
        dav("PUT", f"/remote.php/dav/files/{user}/{urllib.request.quote(name)}", user, password, make())
    cal = f"/remote.php/dav/calendars/{user}/personal/"
    dav("DELETE", cal, user, password)
    mk = (b'<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>'
          b'<d:displayname>Personal</d:displayname></d:prop></d:set></c:mkcalendar>')
    dav("MKCALENDAR", cal, user, password, mk, "application/xml")
    ev = events()
    for body in ev:
        dav("PUT", f"{cal}{uuid.uuid4()}.ics", user, password, body, "text/calendar")
    print(f"cloud: {len(FILES)} files, {len(ev)} events")


if __name__ == "__main__":
    what = sys.argv[1:] or ["mail", "cloud"]
    if "mail" in what:
        for _ in range(30):
            try:
                seed_mail(os.environ["MAIL_PASSWORD"])
                break
            except (OSError, imaplib.IMAP4.error) as e:
                print("mail not ready:", e)
                time.sleep(5)
        else:
            raise SystemExit("mail never came up")
    if "cloud" in what:
        seed_cloud("alex", os.environ["CLOUD_PASSWORD"])
