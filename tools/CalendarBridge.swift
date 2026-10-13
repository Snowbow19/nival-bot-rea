import Foundation
import EventKit

struct BridgeError: Error { let code: String; let message: String }
func failure(_ code: String, _ message: String) -> BridgeError { BridgeError(code: code, message: message) }
func status() -> [String: Any] {
    let raw = EKEventStore.authorizationStatus(for: .event)
    let name: String
    switch raw {
    case .notDetermined: name = "not_determined"
    case .restricted: name = "restricted"
    case .denied: name = "denied"
    case .fullAccess: name = "full_access"
    case .writeOnly: name = "write_only"
    @unknown default: name = "unknown"
    }
    return ["ok": true, "authorization": name, "configured": raw == .fullAccess, "canRead": raw == .fullAccess, "canWrite": raw == .fullAccess, "supportedOperations": ["listCalendars", "listEvents", "createEvent"]]
}
func string(_ input: [String: Any], _ key: String, required: Bool = true, max: Int = 4000) throws -> String {
    guard let value = input[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.count <= max else {
        if !required && input[key] == nil { return "" }
        throw failure("invalid_arguments", "Invalid \(key).")
    }
    return value
}
func parseDate(_ value: String) throws -> Date {
    guard value.range(of: #"(?:Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil else { throw failure("invalid_arguments", "Dates must be ISO 8601 timestamps with an explicit timezone offset.") }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = f.date(from: value) { return date }
    f.formatOptions = [.withInternetDateTime]
    guard let date = f.date(from: value) else { throw failure("invalid_arguments", "Invalid ISO 8601 timestamp.") }
    return date
}
func iso(_ date: Date, _ zone: TimeZone) -> String {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime]; formatter.timeZone = zone
    return formatter.string(from: date)
}
func eventRow(_ event: EKEvent, zone: TimeZone) -> [String: Any] {
    return ["id": event.eventIdentifier ?? "", "calendarId": event.calendar.calendarIdentifier, "title": event.title ?? "", "start": iso(event.startDate, zone), "end": iso(event.endDate, zone), "timeZone": zone.identifier, "allDay": event.isAllDay, "location": event.location ?? "", "notes": event.notes ?? "", "isRecurring": event.hasRecurrenceRules]
}
@main struct CalendarBridge {
    static func main() async {
        var output: [String: Any]
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 256000, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("invalid_arguments", "Expected a JSON request on stdin.") }
            output = try await handle(input)
        } catch let error as BridgeError { output = ["ok": false, "status": error.code, "message": error.message] }
        catch { output = ["ok": false, "status": "calendar_error", "message": "Calendar operation failed."] }
        let data = (try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"status\":\"serialization_error\"}".utf8)
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
    }
    static func handle(_ input: [String: Any]) async throws -> [String: Any] {
        let operation = try string(input, "operation", max: 50)
        if operation == "status" { return status() }
        guard ["authorize", "listCalendars", "listEvents", "createEvent"].contains(operation) else { throw failure("unsupported", "Only calendar listing, event search and creation are supported; update and deletion are not implemented.") }
        let store = EKEventStore()
        if operation == "authorize" {
            guard input["userInitiated"] as? Bool == true else { throw failure("requires_user_action", "Calendar authorization must be initiated by the user.") }
            do { _ = try await store.requestFullAccessToEvents() } catch { throw failure("authorization_failed", "Calendar authorization did not complete.") }
            return status()
        }
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw failure("needs_authorization", "Use the calendar connection button to grant access first.") }
        let calendars = store.calendars(for: .event)
        if operation == "listCalendars" {
            return ["ok": true, "calendars": calendars.map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title, "canWrite": $0.allowsContentModifications, "isSubscribed": $0.isSubscribed] as [String: Any] }]
        }
        let zoneName = (input["timeZone"] as? String) ?? "Asia/Shanghai"
        guard let zone = TimeZone(identifier: zoneName) else { throw failure("invalid_arguments", "Invalid timeZone.") }
        let start = try parseDate(string(input, "start", max: 80)), end = try parseDate(string(input, "end", max: 80))
        guard end > start, end.timeIntervalSince(start) <= 366 * 86400 else { throw failure("invalid_arguments", "Date range must be positive and no longer than 366 days.") }
        let calendarID = try string(input, "calendarId", required: operation == "createEvent", max: 500)
        var selected = calendars
        if !calendarID.isEmpty {
            guard let calendar = calendars.first(where: {$0.calendarIdentifier == calendarID}) else { throw failure("calendar_not_found", "The selected calendar is not accessible.") }
            selected = [calendar]
        }
        if operation == "listEvents" {
            let query = try string(input, "query", required: false, max: 500)
            let limit = min(max((input["limit"] as? Int) ?? 100, 1), 500)
            let matches = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: selected)).filter { query.isEmpty || (($0.title ?? "") + " " + ($0.notes ?? "") + " " + ($0.location ?? "")).localizedCaseInsensitiveContains(query) }.sorted { $0.startDate < $1.startDate }
            return ["ok": true, "events": Array(matches.prefix(limit)).map { eventRow($0, zone: zone) }, "truncated": matches.count > limit, "totalMatches": matches.count, "timeZone": zoneName]
        }
        guard input["allowWrite"] as? Bool == true else { throw failure("requires_confirmation", "Explicit approval is required before creating an event.") }
        guard let calendar = selected.first, calendar.allowsContentModifications else { throw failure("read_only_calendar", "The selected calendar cannot be changed.") }
        let title = try string(input, "title", max: 1000)
        // Check all visible calendars, including recurring instances, immediately before writing.
        let conflicts = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars)).filter { $0.startDate < end && $0.endDate > start }
        if let duplicate = conflicts.first(where: { $0.calendar.calendarIdentifier == calendarID && $0.title == title && abs($0.startDate.timeIntervalSince(start)) < 1 && abs($0.endDate.timeIntervalSince(end)) < 1 }) {
            return ["ok": false, "status": "duplicate", "event": eventRow(duplicate, zone: zone), "message": "An event with this title and time already exists. No event was created."]
        }
        if !conflicts.isEmpty && input["allowConflicts"] as? Bool != true {
            return ["ok": false, "status": "conflicts_require_confirmation", "conflicts": Array(conflicts.prefix(100)).map { eventRow($0, zone: zone) }, "truncated": conflicts.count > 100, "message": "Review overlapping events before confirming creation. No event was created."]
        }
        let event = EKEvent(eventStore: store); event.calendar = calendar; event.title = title; event.startDate = start; event.endDate = end; event.timeZone = zone; event.isAllDay = (input["allDay"] as? Bool) ?? false
        let notes = try string(input, "notes", required: false, max: 16000), location = try string(input, "location", required: false, max: 2000)
        if !notes.isEmpty { event.notes = notes }; if !location.isEmpty { event.location = location }
        do { try store.save(event, span: .thisEvent, commit: true) } catch { return ["ok": false, "status": "write_failed", "outcome": "unknown", "readBeforeRetry": true, "message": "EventKit could not confirm the save. Read the calendar before retrying."] }
        guard let eventID = event.eventIdentifier, let readback = store.event(withIdentifier: eventID) else {
            return ["ok": true, "status": "created", "verified": false, "message": "EventKit accepted the event but readback is unavailable. Do not repeat the write blindly."]
        }
        return ["ok": true, "status": "created", "verified": readback.title == title && abs(readback.startDate.timeIntervalSince(start)) < 1 && abs(readback.endDate.timeIntervalSince(end)) < 1, "event": eventRow(readback, zone: zone)]
    }
}
