import Foundation
import EventKit
import Contacts
import AppKit

// Off Grid AI Desktop - native actions helper (macOS), the backend of the computer-use
// semantic rail. One-shot CLI: reads a single JSON command argument, performs one
// scoped native action (EventKit today; Reminders / Contacts / Photos next), prints
// ONE compact JSON line to stdout, and exits 0.
//
// Handled errors are reported as {"ok":false,"error":...} inside that JSON, not via
// the exit code, so the Node invoker always reads the result from stdout and a
// permission denial is a normal result rather than a crash. Invoked as a child of the
// signed .app, the helper inherits the app's TCC identity, so the Info.plist usage
// strings (NSCalendarsFullAccessUsageDescription and friends) drive the OS prompts.

func emit(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"error\":\"failed to serialize response\"}")
    }
    exit(0)
}

func fail(_ message: String) -> Never { emit(["ok": false, "error": message]) }
func ok(_ result: [String: Any]) -> Never { emit(["ok": true, "result": result]) }

let iso = ISO8601DateFormatter()

// Accept a full ISO 8601 string (with timezone) first, then fall back to the
// timezone-less local forms a model commonly emits (2026-08-13T15:00:00,
// 2026-08-13T15:00, 2026-08-13) interpreted in the user's local timezone.
func parseDate(_ value: Any?) -> Date? {
    guard let raw = value as? String else { return nil }
    if let date = iso.date(from: raw) { return date }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone.current
    for pattern in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
        formatter.dateFormat = pattern
        if let date = formatter.date(from: raw) { return date }
    }
    return nil
}

// Request EventKit access synchronously. The completion handler runs off the calling
// thread, so block on it - this one-shot tool must have a decision before it can act.
func requestEventAccess(_ store: EKEventStore) -> (granted: Bool, error: String?) {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var errorMessage: String?
    let handler: (Bool, Error?) -> Void = { allowed, err in
        granted = allowed
        if let err = err { errorMessage = err.localizedDescription }
        semaphore.signal()
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: handler)
    } else {
        store.requestAccess(to: .event, completion: handler)
    }
    semaphore.wait()
    return (granted, errorMessage)
}

func createEvent(_ args: [String: Any]) -> Never {
    guard let title = args["title"] as? String, !title.isEmpty else {
        fail("createEvent requires a non-empty title")
    }
    guard let start = parseDate(args["start"]) else {
        fail("createEvent requires an ISO8601 start date")
    }
    let allDay = (args["allDay"] as? Bool) ?? false
    let end = parseDate(args["end"]) ?? start.addingTimeInterval(3600)

    let store = EKEventStore()
    let access = requestEventAccess(store)
    if !access.granted { fail(access.error ?? "calendar access was not granted") }

    let event = EKEvent(eventStore: store)
    event.title = title
    event.startDate = start
    event.endDate = end
    event.isAllDay = allDay
    if let notes = args["notes"] as? String { event.notes = notes }
    if let calName = args["calendar"] as? String,
       let cal = store.calendars(for: .event).first(where: { $0.title == calName }) {
        event.calendar = cal
    } else {
        event.calendar = store.defaultCalendarForNewEvents
    }
    do {
        try store.save(event, span: .thisEvent)
        ok(["id": event.eventIdentifier ?? ""])
    } catch {
        fail("failed to save event: \(error.localizedDescription)")
    }
}

// Reminders share EKEventStore with calendar but need their own access grant.
func requestReminderAccess(_ store: EKEventStore) -> (granted: Bool, error: String?) {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var errorMessage: String?
    let handler: (Bool, Error?) -> Void = { allowed, err in
        granted = allowed
        if let err = err { errorMessage = err.localizedDescription }
        semaphore.signal()
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToReminders(completion: handler)
    } else {
        store.requestAccess(to: .reminder, completion: handler)
    }
    semaphore.wait()
    return (granted, errorMessage)
}

func createReminder(_ args: [String: Any]) -> Never {
    guard let title = args["title"] as? String, !title.isEmpty else {
        fail("createReminder requires a non-empty title")
    }
    let store = EKEventStore()
    let access = requestReminderAccess(store)
    if !access.granted { fail(access.error ?? "reminders access was not granted") }

    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    reminder.calendar = store.defaultCalendarForNewReminders()
    if let notes = args["notes"] as? String { reminder.notes = notes }
    if let due = parseDate(args["due"]) {
        reminder.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute], from: due)
    }
    do {
        try store.save(reminder, commit: true)
        ok(["id": reminder.calendarItemIdentifier])
    } catch {
        fail("failed to save reminder: \(error.localizedDescription)")
    }
}

func listReminders(_ args: [String: Any]) -> Never {
    let store = EKEventStore()
    let access = requestReminderAccess(store)
    if !access.granted { fail(access.error ?? "reminders access was not granted") }

    let predicate = store.predicateForIncompleteReminders(
        withDueDateStarting: nil, ending: nil, calendars: nil)
    let semaphore = DispatchSemaphore(value: 0)
    var out: [[String: Any]] = []
    store.fetchReminders(matching: predicate) { reminders in
        for reminder in reminders ?? [] {
            var item: [String: Any] = ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? ""]
            if let due = reminder.dueDateComponents, let date = Calendar.current.date(from: due) {
                item["due"] = iso.string(from: date)
            }
            out.append(item)
        }
        semaphore.signal()
    }
    semaphore.wait()
    ok(["reminders": out])
}

func listEvents(_ args: [String: Any]) -> Never {
    guard let start = parseDate(args["start"]), let end = parseDate(args["end"]) else {
        fail("listEvents requires ISO8601 start and end dates")
    }
    let store = EKEventStore()
    let access = requestEventAccess(store)
    if !access.granted { fail(access.error ?? "calendar access was not granted") }

    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate).map { event -> [String: Any] in
        [
            "id": event.eventIdentifier ?? "",
            "title": event.title ?? "",
            "start": iso.string(from: event.startDate),
            "end": iso.string(from: event.endDate),
            "allDay": event.isAllDay,
            "calendar": event.calendar?.title ?? ""
        ]
    }
    ok(["events": events])
}

func requestContactsAccess(_ store: CNContactStore) -> (granted: Bool, error: String?) {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var errorMessage: String?
    store.requestAccess(for: .contacts) { allowed, err in
        granted = allowed
        if let err = err { errorMessage = err.localizedDescription }
        semaphore.signal()
    }
    semaphore.wait()
    return (granted, errorMessage)
}

func searchContacts(_ args: [String: Any]) -> Never {
    guard let query = args["query"] as? String, !query.isEmpty else {
        fail("searchContacts requires a non-empty query")
    }
    let store = CNContactStore()
    let access = requestContactsAccess(store)
    if !access.granted { fail(access.error ?? "contacts access was not granted") }

    let keys: [CNKeyDescriptor] = [
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor
    ]
    let predicate = CNContact.predicateForContacts(matchingName: query)
    do {
        let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: keys)
        let out = contacts.map { contact -> [String: Any] in
            let name = CNContactFormatter.string(from: contact, style: .fullName)
                ?? "\(contact.givenName) \(contact.familyName)"
            return [
                "name": name,
                "phones": contact.phoneNumbers.map { $0.value.stringValue },
                "emails": contact.emailAddresses.map { $0.value as String }
            ]
        }
        ok(["contacts": out])
    } catch {
        fail("failed to search contacts: \(error.localizedDescription)")
    }
}

// AppleScript backs the send actions (Messages, Mail). User-supplied values are
// escaped before interpolation so a quote or backslash cannot break the script or
// inject extra statements.
func escapeForAppleScript(_ value: String) -> String {
    return value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}

func runAppleScript(_ source: String) -> String? {
    var errorDict: NSDictionary?
    let script = NSAppleScript(source: source)
    _ = script?.executeAndReturnError(&errorDict)
    if let errorDict = errorDict {
        return (errorDict[NSAppleScript.errorMessage] as? String) ?? "AppleScript error"
    }
    return nil
}

func sendMessage(_ args: [String: Any]) -> Never {
    guard let to = args["to"] as? String, !to.isEmpty else {
        fail("sendMessage requires a 'to' recipient")
    }
    guard let text = args["text"] as? String, !text.isEmpty else {
        fail("sendMessage requires non-empty 'text'")
    }
    let script = """
    tell application "Messages"
        send "\(escapeForAppleScript(text))" to participant "\(escapeForAppleScript(to))" of (1st account whose service type = iMessage)
    end tell
    """
    if let err = runAppleScript(script) { fail("failed to send message: \(err)") }
    ok(["sent": true])
}

func sendMail(_ args: [String: Any]) -> Never {
    guard let to = args["to"] as? String, !to.isEmpty else {
        fail("sendMail requires a 'to' recipient")
    }
    let subject = (args["subject"] as? String) ?? ""
    let body = (args["body"] as? String) ?? ""
    let script = """
    tell application "Mail"
        set newMessage to make new outgoing message with properties {subject:"\(escapeForAppleScript(subject))", content:"\(escapeForAppleScript(body))", visible:false}
        tell newMessage
            make new to recipient at end of to recipients with properties {address:"\(escapeForAppleScript(to))"}
            send
        end tell
    end tell
    """
    if let err = runAppleScript(script) { fail("failed to send mail: \(err)") }
    ok(["sent": true])
}

func openURL(_ args: [String: Any]) -> Never {
    guard let urlString = args["url"] as? String, let url = URL(string: urlString) else {
        fail("openURL requires a valid 'url'")
    }
    if NSWorkspace.shared.open(url) {
        ok(["opened": true])
    } else {
        fail("failed to open URL: \(urlString)")
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("no command provided") }
guard let data = arguments[1].data(using: .utf8),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let command = payload["command"] as? String else {
    fail("invalid command JSON")
}
let commandArgs = (payload["args"] as? [String: Any]) ?? [:]

switch command {
case "calendar.createEvent":
    createEvent(commandArgs)
case "calendar.listEvents":
    listEvents(commandArgs)
case "reminders.create":
    createReminder(commandArgs)
case "reminders.list":
    listReminders(commandArgs)
case "contacts.search":
    searchContacts(commandArgs)
case "messages.send":
    sendMessage(commandArgs)
case "mail.send":
    sendMail(commandArgs)
case "system.openURL":
    openURL(commandArgs)
default:
    fail("unknown command: \(command)")
}
