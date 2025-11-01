import Foundation

struct HubSpotSubmitResponse: Decodable {
    let ok: Bool
    let contactId: String?
    let taskId: String?
    let error: String?
    let details: String?
}

enum SubmitError: LocalizedError {
    case invalidInput(String)
    case server(String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .invalidInput(let msg): return msg
        case .server(let msg):       return msg
        case .badResponse:           return "Unexpected server response."
        }
    }
}

final class NetworkClient {
    static let shared = NetworkClient()
    private init() {}

    // your Render URL
    private let endpoint = URL(string: "https://hubspot-bff.onrender.com/api/hubspot/contacts")!

    func submitCheckout(draft: GMUCheckoutDraft) async throws -> HubSpotSubmitResponse {
        // 1. validate
        let email = draft.contact.email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else {
            throw SubmitError.invalidInput("Email is required.")
        }
        guard let start = draft.appointment.startDate,
              let end   = draft.appointment.endDate else {
            throw SubmitError.invalidInput("Appointment date & time are required.")
        }

        // 2. build location string for the task body
        var locationString = draft.appointment.location
        if locationString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var parts: [String] = []
            if !draft.location.address1.isEmpty { parts.append(draft.location.address1) }
            if !draft.location.address2.isEmpty { parts.append(draft.location.address2) }
            var cityLine = ""
            if !draft.location.city.isEmpty      { cityLine += draft.location.city }
            if !draft.location.state.isEmpty     { cityLine += cityLine.isEmpty ? draft.location.state : ", \(draft.location.state)" }
            if !draft.location.postalCode.isEmpty { cityLine += cityLine.isEmpty ? draft.location.postalCode : " \(draft.location.postalCode)" }
            if !cityLine.isEmpty { parts.append(cityLine) }
            locationString = parts.joined(separator: ", ")
        }

        // 3. ISO dates
        let iso = ISO8601DateFormatter()
        iso.timeZone = TimeZone(secondsFromGMT: 0)

        // 4. car object (clean)
        let carDetails: [String: Any] = [
            "make": draft.car.make,
            "model": draft.car.model,
            "year": draft.car.year ?? 0,
            "color": draft.car.color,
            "licensePlate": draft.car.licensePlate
        ]

        // 5. final payload
        let payload: [String: Any] = [
            "email":     email,
            "firstName": draft.contact.firstName,
            "lastName":  draft.contact.lastName,
            "phone":     draft.contact.phone,
            "carDetails": carDetails,
            "appointment": [
                "startISO": iso.string(from: start),
                "endISO":   iso.string(from: end),
                "location": locationString
            ]
        ]

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw SubmitError.badResponse
        }

        print("→ POST \(endpoint.absoluteString) = \(http.statusCode)")
        if let body = String(data: data, encoding: .utf8) {
            print("Response:", body)
        }

        if !(200...299).contains(http.statusCode) {
            throw SubmitError.server(String(data: data, encoding: .utf8) ?? "HubSpot error")
        }

        guard let decoded = try? JSONDecoder().decode(HubSpotSubmitResponse.self, from: data) else {
            throw SubmitError.badResponse
        }

        return decoded
    }
}
