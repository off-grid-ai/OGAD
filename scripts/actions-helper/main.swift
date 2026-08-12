import Foundation
import EventKit

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

func parseDate(_ value: Any?) -> Date? {
    guard let raw = value as? String else { return nil }
    return iso.date(from: raw)
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
default:
    fail("unknown command: \(command)")
}
